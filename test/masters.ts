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
    const cust = await custRes.json() as { id: string };

    const dupName = await fetch(`${base}/api/crm/companies`, {
      method: "POST", ...j(admin, { name: `Cust ${stamp}` }),
    });
    check("duplicate company name -> 409", dupName.status === 409, String(dupName.status));

    const regNoGstin = await fetch(`${base}/api/crm/companies`, {
      method: "POST", ...j(admin, { name: `RegNoGstin ${stamp}`, gstTreatment: "registered" }),
    });
    check("registered without GSTIN -> 422", regNoGstin.status === 422, String(regNoGstin.status));

    const getCust = await (await fetch(`${base}/api/crm/companies/${cust.id}`, { headers: { cookie: admin } })).json() as Record<string, unknown>;
    check("customer is_customer true", getCust.is_customer === true);
    check("customer gst_treatment registered", getCust.gst_treatment === "registered");

    const custList = await (await fetch(`${base}/api/crm/companies?role=customer`, { headers: { cookie: admin } })).json() as unknown[];
    check("customer appears in customer list", custList.some((x) => (x as { id: string }).id === cust.id));
  } finally {
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
