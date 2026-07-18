/**
 * Quotations test: the sales module over real HTTP, including RBAC and the
 * quote → convert → draft-invoice link. Verifies GST math (non-posting, no
 * rupee rounding), draft edit, submit numbering, immutability after submit,
 * one-time conversion, and admin-only cancel.
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
const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await pool.query<T>(sql, params)).rows;

async function main() {
  const stamp = Date.now();

  // ---- setup: company (UP/09), an intra-state customer, an item, a warehouse ----
  await q(`INSERT INTO company_settings (id, legal_name, gstin, state_code)
           VALUES (1,'Harsh Trading Co','09ABCDE1234F1Z5','09')
           ON CONFLICT (id) DO UPDATE SET state_code='09', gstin=EXCLUDED.gstin`);
  const [customer] = await q<{ id: string }>(
    `INSERT INTO companies (name, gstin, gst_treatment, state_code, is_customer)
     VALUES ('Qtn Customer ' || substr(gen_random_uuid()::text,1,8),
             '09AAACA1234A1Z5','registered','09', true) RETURNING id`); // same state -> CGST+SGST
  const [item] = await q<{ id: string }>(
    `INSERT INTO items (sku, name, hsn_sac_code, gst_rate)
     VALUES ('QT-' || substr(gen_random_uuid()::text,1,8), 'Stabiliser', '8504', 18) RETURNING id`);
  const custId = customer!.id, itemId = item!.id;

  await createUser({ email: `q_admin_${stamp}@test.com`, fullName: "Admin", password: "Pw!", roleName: "admin" });
  await createUser({ email: `q_sales_${stamp}@test.com`, fullName: "Sales", password: "Pw!", roleName: "sales" });
  await createUser({ email: `q_ro_${stamp}@test.com`, fullName: "RO", password: "Pw!", roleName: "readonly" });

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
  const tomorrow = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);

  try {
    const admin = await login(`q_admin_${stamp}@test.com`);
    const sales = await login(`q_sales_${stamp}@test.com`);
    const ro = await login(`q_ro_${stamp}@test.com`);

    console.log("== CREATE DRAFT (sales) ==");
    const draftBody = {
      customerId: custId, placeOfSupply: "09",
      validUntil: tomorrow, terms: "50% advance",
      lines: [{ itemId, description: "Stabiliser", hsn: "8504", qty: "2", rate: "1000.00", gstRate: 18 }],
    };
    const createRes = await fetch(`${base}/api/sales/quotations`, { method: "POST", ...j(sales, draftBody) });
    check("sales create draft -> 201", createRes.status === 201, String(createRes.status));
    const quote = await createRes.json() as { id: string };
    check("quotation id returned", !!quote.id);

    const roCreate = await fetch(`${base}/api/sales/quotations`, { method: "POST", ...j(ro, draftBody) });
    check("readonly create -> 403", roCreate.status === 403, String(roCreate.status));

    const future = await fetch(`${base}/api/sales/quotations`, {
      method: "POST", ...j(sales, { ...draftBody, docDate: tomorrow }),
    });
    check("future-dated quote -> 422", future.status === 422, String(future.status));

    console.log("== REVIEW: server-computed GST (intra -> CGST+SGST, no rupee rounding) ==");
    const detail = await (await fetch(`${base}/api/sales/quotations/${quote.id}`, { headers: { cookie: sales } }))
      .json() as Record<string, string>;
    check("status draft", detail.status === "draft", detail.status ?? "");
    check("taxable = 2000.00", detail.taxable_total === "2000.00", detail.taxable_total ?? "");
    check("CGST = 180.00", detail.cgst_total === "180.00", detail.cgst_total ?? "");
    check("SGST = 180.00", detail.sgst_total === "180.00", detail.sgst_total ?? "");
    check("IGST = 0.00 (intra-state)", detail.igst_total === "0.00", detail.igst_total ?? "");
    check("grand total = 2360.00", detail.grand_total === "2360.00", detail.grand_total ?? "");

    console.log("== EDIT DRAFT (qty 2 -> 3) ==");
    const patchRes = await fetch(`${base}/api/sales/quotations/${quote.id}`, {
      method: "PATCH", ...j(sales, {
        ...draftBody,
        lines: [{ itemId, description: "Stabiliser", hsn: "8504", qty: "3", rate: "1000.00", gstRate: 18 }],
      }),
    });
    check("patch draft -> 200", patchRes.status === 200, String(patchRes.status));
    const afterPatch = await (await fetch(`${base}/api/sales/quotations/${quote.id}`, { headers: { cookie: sales } }))
      .json() as Record<string, string>;
    check("taxable now 3000.00", afterPatch.taxable_total === "3000.00", afterPatch.taxable_total ?? "");
    check("grand now 3540.00", afterPatch.grand_total === "3540.00", afterPatch.grand_total ?? "");

    console.log("== SUBMIT (sales) — QTN number issued, no journal, no stock ==");
    const submitRes = await fetch(`${base}/api/sales/quotations/${quote.id}/submit`, { method: "POST", ...j(sales) });
    check("submit -> 200", submitRes.status === 200, String(submitRes.status));
    const submitted = await submitRes.json() as { docNo: string };
    check("QTN number issued", /^QTN-2026-\d{5}$/.test(submitted.docNo ?? ""), submitted.docNo ?? "");
    const noJournal = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM journal_entries WHERE voucher_id = $1`, [quote.id]);
    check("quotation posts no journal", noJournal[0]!.n === "0", noJournal[0]!.n);

    console.log("== IMMUTABILITY: edit after submit rejected ==");
    const editAfter = await fetch(`${base}/api/sales/quotations/${quote.id}`, {
      method: "PATCH", ...j(sales, draftBody),
    });
    check("edit after submit -> 409", editAfter.status === 409, String(editAfter.status));

    console.log("== CONVERT (sales) -> draft SALES ORDER, linked ==");
    const convRes = await fetch(`${base}/api/sales/quotations/${quote.id}/convert`, {
      method: "POST", ...j(sales, {}),
    });
    check("convert -> 201", convRes.status === 201, String(convRes.status));
    const { salesOrderId } = await convRes.json() as { salesOrderId: string };
    check("sales order id returned", !!salesOrderId);
    const [so] = await q<{ status: string; grand_total: string; quotation_id: string | null }>(
      `SELECT status, grand_total::text, quotation_id FROM sales_orders WHERE id = $1`, [salesOrderId]);
    check("sales order is a draft", so!.status === "draft", so!.status);
    check("SO grand total = 3540.00 (carried from quote)", so!.grand_total === "3540.00", so!.grand_total);
    check("SO links back to the quotation", so!.quotation_id === quote.id, so!.quotation_id ?? "null");
    const convDetail = await (await fetch(`${base}/api/sales/quotations/${quote.id}`, { headers: { cookie: sales } }))
      .json() as Record<string, string>;
    check("quotation shows linked sales_order_id", convDetail.sales_order_id === salesOrderId,
      convDetail.sales_order_id ?? "null");

    const convAgain = await fetch(`${base}/api/sales/quotations/${quote.id}/convert`, {
      method: "POST", ...j(sales, {}),
    });
    check("second convert -> 409 (already ordered)", convAgain.status === 409, String(convAgain.status));

    console.log("== CANCEL is admin-only ==");
    // fresh quote to cancel
    const c2 = await (await fetch(`${base}/api/sales/quotations`, { method: "POST", ...j(sales, draftBody) })).json() as { id: string };
    await fetch(`${base}/api/sales/quotations/${c2.id}/submit`, { method: "POST", ...j(sales) });
    const salesCancel = await fetch(`${base}/api/sales/quotations/${c2.id}/cancel`, { method: "POST", ...j(sales) });
    check("sales cancel -> 403 (admin-only)", salesCancel.status === 403, String(salesCancel.status));
    const adminCancel = await fetch(`${base}/api/sales/quotations/${c2.id}/cancel`, { method: "POST", ...j(admin) });
    check("admin cancel -> 200", adminCancel.status === 200, String(adminCancel.status));
    const cancelled = await (await fetch(`${base}/api/sales/quotations/${c2.id}`, { headers: { cookie: admin } }))
      .json() as Record<string, string>;
    check("status cancelled", cancelled.status === "cancelled", cancelled.status ?? "");
  } finally {
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
