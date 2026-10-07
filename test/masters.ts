/**
 * Masters test: items & customers CRUD over real HTTP, including RBAC.
 * Verifies create/list/get/update, duplicate guards, GST/GSTIN validation,
 * and that a readonly role cannot write while an admin can.
 */
import type { AddressInfo } from "node:net";
import { app } from "../src/server.js";
import { createUser } from "../src/core/auth.js";
import { pool } from "../src/shared/db.js";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${detail}`); }
}
function sidFrom(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const m = /(?:^|,\s*)sid=([^;]+)/.exec(setCookie);
  return m ? `sid=${m[1]}` : null;
}

async function main() {
  const stamp = Date.now();
  await createUser({ email: `m_admin_${stamp}@test.com`, fullName: "Admin", password: "Pw!", roleName: "admin" });
  await createUser({ email: `m_ro_${stamp}@test.com`, fullName: "RO", password: "Pw!", roleName: "readonly" });

  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  async function login(email: string): Promise<string> {
    const res = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "Pw!" }),
    });
    return sidFrom(res.headers.get("set-cookie"))!;
  }
  const j = (cookie: string, body?: unknown) => ({
    headers: { cookie, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  try {
    const admin = await login(`m_admin_${stamp}@test.com`);
    const ro = await login(`m_ro_${stamp}@test.com`);

    console.log("== ITEMS ==");
    const sku = `SKU-${stamp}`;
    const createItemRes = await fetch(`${base}/api/inventory/items`, {
      method: "POST", ...j(admin, { sku, name: "Test Widget", hsnSacCode: "8471", gstRate: 18, standardSellingRate: "999.00" }),
    });
    check("create item 201", createItemRes.status === 201, String(createItemRes.status));
    const item = await createItemRes.json() as { id: string };
    check("item id returned", !!item.id);

    const dup = await fetch(`${base}/api/inventory/items`, {
      method: "POST", ...j(admin, { sku, name: "Dupe", hsnSacCode: "8471", gstRate: 18 }),
    });
    check("duplicate SKU -> 409", dup.status === 409, String(dup.status));

    const badGst = await fetch(`${base}/api/inventory/items`, {
      method: "POST", ...j(admin, { sku: `${sku}-x`, name: "Bad GST", hsnSacCode: "8471", gstRate: 17 }),
    });
    check("invalid gstRate -> 422", badGst.status === 422, String(badGst.status));

    const roItem = await fetch(`${base}/api/inventory/items`, {
      method: "POST", ...j(ro, { sku: `${sku}-ro`, name: "RO Item", hsnSacCode: "8471", gstRate: 18 }),
    });
    check("readonly create item -> 403", roItem.status === 403, String(roItem.status));

    const getItem = await fetch(`${base}/api/inventory/items/${item.id}`, { headers: { cookie: admin } });
    const gotItem = await getItem.json() as Record<string, string>;
    check("get item by id", gotItem.sku === sku);
    check("selling rate stored as 999.00", gotItem.standard_selling_rate === "999.00", gotItem.standard_selling_rate ?? "");

    const patchItem = await fetch(`${base}/api/inventory/items/${item.id}`, {
      method: "PATCH", ...j(admin, { standardSellingRate: "1250.00", isActive: false }),
    });
    check("patch item 200", patchItem.status === 200, String(patchItem.status));
    const after = await (await fetch(`${base}/api/inventory/items/${item.id}`, { headers: { cookie: admin } })).json() as Record<string, unknown>;
    check("item rate updated to 1250.00", after.standard_selling_rate === "1250.00");
    check("item deactivated", after.is_active === false);

    const list = await (await fetch(`${base}/api/inventory/items?active=true`, { headers: { cookie: admin } })).json() as unknown[];
    check("active list excludes the deactivated item", Array.isArray(list) && !list.some((x) => (x as { id: string }).id === item.id));

    console.log("== CUSTOMERS (companies) ==");
    const custRes = await fetch(`${base}/api/crm/companies`, {
      method: "POST", ...j(admin, { name: `Cust ${stamp}`, gstin: "07AAACA1234A1Z5", gstTreatment: "registered", stateCode: "07", isCustomer: true }),
    });
    check("create customer 201", custRes.status === 201, String(custRes.status));
    const cust = await custRes.json() as Record<string, unknown> & { id: string };

    // The picker selects a freshly created customer straight into a document
    // builder, so POST must return the WHOLE row. When it returned only
    // id+name, place of supply fell back to the seller's state and produced
    // CGST/SGST on interstate sales (eng review T2).
    check("create returns the full row (state_code present)", cust.state_code === "07", JSON.stringify(cust.state_code));
    check("create returns the full row (gstin present)", cust.gstin === "07AAACA1234A1Z5");
    check("create returns the full row (is_active present)", cust.is_active === true);

    // REGRESSION GUARD: this payload used to be `{ name }` alone, which now
    // fails the state-code rule and 422s BEFORE the duplicate check runs — so
    // the assertion below silently stopped testing duplicates (eng review T5).
    const dupName = await fetch(`${base}/api/crm/companies`, {
      method: "POST", ...j(admin, { name: `Cust ${stamp}`, stateCode: "07" }),
    });
    check("duplicate company name -> 409", dupName.status === 409, String(dupName.status));

    // stateCode supplied so this isolates the GSTIN rule and nothing else.
    const regNoGstin = await fetch(`${base}/api/crm/companies`, {
      method: "POST", ...j(admin, { name: `RegNoGstin ${stamp}`, gstTreatment: "registered", stateCode: "07" }),
    });
    check("registered without GSTIN -> 422", regNoGstin.status === 422, String(regNoGstin.status));

    // --- state code rules: the place of supply, and therefore the GST split ---
    const unregNoState = await fetch(`${base}/api/crm/companies`, {
      method: "POST", ...j(admin, { name: `NoState ${stamp}`, gstTreatment: "unregistered" }),
    });
    check("unregistered without state code -> 422", unregNoState.status === 422, String(unregNoState.status));

    const defaultNoState = await fetch(`${base}/api/crm/companies`, {
      method: "POST", ...j(admin, { name: `NoStateDefault ${stamp}` }),
    });
    check("no treatment (defaults unregistered) without state code -> 422", defaultNoState.status === 422, String(defaultNoState.status));

    const regNoState = await fetch(`${base}/api/crm/companies`, {
      method: "POST", ...j(admin, { name: `RegNoState ${stamp}`, gstTreatment: "registered", gstin: "07AAACA1234A1Z6" }),
    });
    check("registered without state code -> 422", regNoState.status === 422, String(regNoState.status));

    // Overseas/SEZ have no Indian state, so the rule must not apply to them.
    const overseas = await fetch(`${base}/api/crm/companies`, {
      method: "POST", ...j(admin, { name: `Overseas ${stamp}`, gstTreatment: "overseas" }),
    });
    check("overseas without state code -> 201", overseas.status === 201, String(overseas.status));

    const getCust = await (await fetch(`${base}/api/crm/companies/${cust.id}`, { headers: { cookie: admin } })).json() as Record<string, unknown>;
    check("customer is_customer true", getCust.is_customer === true);
    check("customer gst_treatment registered", getCust.gst_treatment === "registered");

    const custList = await (await fetch(`${base}/api/crm/companies?role=customer`, { headers: { cookie: admin } })).json() as unknown[];
    check("customer appears in customer list", custList.some((x) => (x as { id: string }).id === cust.id));

    // --- search by GSTIN, not just name ---
    const byGstin = await (await fetch(`${base}/api/crm/companies?q=07AAACA1234A1Z5`, { headers: { cookie: admin } })).json() as unknown[];
    check("search finds the customer by GSTIN", byGstin.some((x) => (x as { id: string }).id === cust.id));

    // --- exact-name lookup: what quick-add uses to recover from a 409 ---
    const exact = await (await fetch(`${base}/api/crm/companies?name=${encodeURIComponent(`cust ${stamp}`)}`, { headers: { cookie: admin } })).json() as { id: string }[];
    check("exact name lookup is case-insensitive and returns one row", exact.length === 1 && exact[0]!.id === cust.id, JSON.stringify(exact.length));
    const exactMiss = await (await fetch(`${base}/api/crm/companies?name=${encodeURIComponent(`nope ${stamp}`)}`, { headers: { cookie: admin } })).json() as unknown[];
    check("exact name lookup returns [] when there is no match", Array.isArray(exactMiss) && exactMiss.length === 0);

    // --- promote a supplier-only company to also being a customer ---
    const supRes = await fetch(`${base}/api/crm/companies`, {
      method: "POST", ...j(admin, { name: `Supp ${stamp}`, stateCode: "09", isCustomer: false, isSupplier: true }),
    });
    check("create supplier-only company 201", supRes.status === 201, String(supRes.status));
    const supp = await supRes.json() as { id: string };

    const suppInCustList = await (await fetch(`${base}/api/crm/companies?role=customer`, { headers: { cookie: admin } })).json() as { id: string }[];
    check("supplier-only company is NOT in the customer list", !suppInCustList.some((x) => x.id === supp.id));

    const dupAsSupplier = await fetch(`${base}/api/crm/companies`, {
      method: "POST", ...j(admin, { name: `Supp ${stamp}`, stateCode: "09" }),
    });
    check("creating a name held by a supplier -> 409 (not 500)", dupAsSupplier.status === 409, String(dupAsSupplier.status));

    const promote = await fetch(`${base}/api/crm/companies/${supp.id}`, {
      method: "PATCH", ...j(admin, { isCustomer: true }),
    });
    check("promote supplier to customer 200", promote.status === 200, String(promote.status));
    const promoted = await promote.json() as Record<string, unknown>;
    check("patch returns the full row (state_code present)", promoted.state_code === "09", JSON.stringify(promoted.state_code));
    check("patch returns the full row (is_customer flipped)", promoted.is_customer === true);

    const afterPromote = await (await fetch(`${base}/api/crm/companies?role=customer`, { headers: { cookie: admin } })).json() as { id: string }[];
    check("promoted company now appears in the customer list", afterPromote.some((x) => x.id === supp.id));

    // --- renaming onto an existing name is a typed 409, never a bare 500 ---
    const renameClash = await fetch(`${base}/api/crm/companies/${supp.id}`, {
      method: "PATCH", ...j(admin, { name: `Cust ${stamp}` }),
    });
    check("rename onto an existing name -> 409 (not 500)", renameClash.status === 409, String(renameClash.status));
    const renameBody = await renameClash.json() as { error?: { code?: string } };
    check("rename clash carries DUPLICATE_NAME", renameBody.error?.code === "DUPLICATE_NAME", JSON.stringify(renameBody.error?.code));

    // --- deactivate, and confirm the active filter honours it ---
    const deact = await fetch(`${base}/api/crm/companies/${supp.id}`, {
      method: "PATCH", ...j(admin, { isActive: false }),
    });
    check("deactivate customer 200", deact.status === 200, String(deact.status));
    const activeList = await (await fetch(`${base}/api/crm/companies?role=customer&active=true`, { headers: { cookie: admin } })).json() as { id: string }[];
    check("active customer list excludes the deactivated one", !activeList.some((x) => x.id === supp.id));
    const stillExact = await (await fetch(`${base}/api/crm/companies?name=${encodeURIComponent(`Supp ${stamp}`)}`, { headers: { cookie: admin } })).json() as unknown[];
    check("exact lookup still finds a deactivated company", stillExact.length === 1);
  } finally {
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
