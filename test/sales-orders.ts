/**
 * Sales order test: the middle of the ERPNext/Odoo chain over real HTTP.
 * Verifies non-posting GST (rounded), draft edit, SO numbering, immutability,
 * SO → draft invoice link, DERIVED billing status (Not/Fully Billed from
 * submitted invoices), one-time billing, cancel-blocked-when-invoiced, and
 * admin-only cancel.
 */
import type { AddressInfo } from "node:net";
import { app } from "../src/server.js";
import { createUser } from "../src/core/auth.js";
import { pool, withTransaction } from "../src/shared/db.js";
import { lockStock, receiveStock } from "../src/modules/inventory/service.js";
import { toPaise } from "../src/shared/money.js";

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

  await q(`INSERT INTO company_settings (id, legal_name, gstin, state_code)
           VALUES (1,'Harsh Trading Co','09ABCDE1234F1Z5','09')
           ON CONFLICT (id) DO UPDATE SET state_code='09', gstin=EXCLUDED.gstin`);
  const [customer] = await q<{ id: string }>(
    `INSERT INTO companies (name, gstin, gst_treatment, state_code, is_customer)
     VALUES ('SO Customer ' || substr(gen_random_uuid()::text,1,8),
             '09AAACA1234A1Z5','registered','09', true) RETURNING id`);
  const [item] = await q<{ id: string }>(
    `INSERT INTO items (sku, name, hsn_sac_code, gst_rate)
     VALUES ('SOI-' || substr(gen_random_uuid()::text,1,8), 'Stabiliser', '8504', 18) RETURNING id`);
  const [wh] = await q<{ id: string }>(
    `INSERT INTO warehouses (name) VALUES ('SO-WH-' || gen_random_uuid()) RETURNING id`);
  const custId = customer!.id, itemId = item!.id, whId = wh!.id;

  const [seed] = await q<{ id: string }>(`SELECT id FROM users WHERE role_id=(SELECT id FROM roles WHERE name='admin') LIMIT 1`);
  const stockActor = seed?.id ?? (await createUser({ email: `so_seed_${stamp}@test.com`, fullName: "Seed", password: "Pw!", roleName: "admin" })).id;
  await withTransaction(stockActor, async (tx) => {   // stock so the invoice can submit
    const lines = [{ itemId, warehouseId: whId, qty: "100.000", ratePaise: toPaise("100.00") }];
    const locked = await lockStock(tx, lines);
    await receiveStock(tx, locked, lines, { type: "purchase_receipt", id: crypto.randomUUID() }, stockActor);
  });

  await createUser({ email: `so_admin_${stamp}@test.com`, fullName: "Admin", password: "Pw!", roleName: "admin" });
  await createUser({ email: `so_sales_${stamp}@test.com`, fullName: "Sales", password: "Pw!", roleName: "sales" });
  await createUser({ email: `so_ro_${stamp}@test.com`, fullName: "RO", password: "Pw!", roleName: "readonly" });

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
    const admin = await login(`so_admin_${stamp}@test.com`);
    const sales = await login(`so_sales_${stamp}@test.com`);
    const ro = await login(`so_ro_${stamp}@test.com`);

    console.log("== CREATE DRAFT (sales) ==");
    const body = {
      customerId: custId, placeOfSupply: "09", deliveryDate: tomorrow, poNo: "PO-77",
      lines: [{ itemId, description: "Stabiliser", hsn: "8504", qty: "2", rate: "1000.00", gstRate: 18 }],
    };
    const createRes = await fetch(`${base}/api/sales/sales-orders`, { method: "POST", ...j(sales, body) });
    check("sales create draft -> 201", createRes.status === 201, String(createRes.status));
    const order = await createRes.json() as { id: string };

    const roCreate = await fetch(`${base}/api/sales/sales-orders`, { method: "POST", ...j(ro, body) });
    check("readonly create -> 403", roCreate.status === 403, String(roCreate.status));
    const future = await fetch(`${base}/api/sales/sales-orders`, {
      method: "POST", ...j(sales, { ...body, docDate: tomorrow }) });
    check("future-dated order -> 422", future.status === 422, String(future.status));

    console.log("== REVIEW: server-computed GST (intra, rounded) ==");
    const detail = await (await fetch(`${base}/api/sales/sales-orders/${order.id}`, { headers: { cookie: sales } }))
      .json() as Record<string, string>;
    check("status draft", detail.status === "draft", detail.status ?? "");
    check("billing Not Billed", detail.billing_status === "Not Billed", detail.billing_status ?? "");
    check("taxable = 2000.00", detail.taxable_total === "2000.00", detail.taxable_total ?? "");
    check("CGST = 180.00", detail.cgst_total === "180.00", detail.cgst_total ?? "");
    check("SGST = 180.00", detail.sgst_total === "180.00", detail.sgst_total ?? "");
    check("grand = 2360.00", detail.grand_total === "2360.00", detail.grand_total ?? "");
    check("delivery date stored", detail.delivery_date === tomorrow, detail.delivery_date ?? "");
    check("PO number stored", detail.po_no === "PO-77", detail.po_no ?? "");

    console.log("== EDIT DRAFT (qty 2 -> 3) ==");
    const patchRes = await fetch(`${base}/api/sales/sales-orders/${order.id}`, {
      method: "PATCH", ...j(sales, {
        ...body, lines: [{ itemId, description: "Stabiliser", hsn: "8504", qty: "3", rate: "1000.00", gstRate: 18 }],
      }) });
    check("patch draft -> 200", patchRes.status === 200, String(patchRes.status));
    const afterPatch = await (await fetch(`${base}/api/sales/sales-orders/${order.id}`, { headers: { cookie: sales } }))
      .json() as Record<string, string>;
    check("grand now 3540.00", afterPatch.grand_total === "3540.00", afterPatch.grand_total ?? "");

    console.log("== SUBMIT (sales) — SO number issued, no journal ==");
    const submitRes = await fetch(`${base}/api/sales/sales-orders/${order.id}/submit`, { method: "POST", ...j(sales) });
    check("submit -> 200", submitRes.status === 200, String(submitRes.status));
    const submitted = await submitRes.json() as { docNo: string };
    check("SO number issued", /^SO-2026-\d{5}$/.test(submitted.docNo ?? ""), submitted.docNo ?? "");
    const noJournal = await q<{ n: string }>(`SELECT count(*)::text AS n FROM journal_entries WHERE voucher_id = $1`, [order.id]);
    check("order posts no journal", noJournal[0]!.n === "0", noJournal[0]!.n);

    console.log("== IMMUTABILITY: edit after submit rejected ==");
    const editAfter = await fetch(`${base}/api/sales/sales-orders/${order.id}`, { method: "PATCH", ...j(sales, body) });
    check("edit after submit -> 409", editAfter.status === 409, String(editAfter.status));

    console.log("== MAKE INVOICE (sales) -> draft invoice, linked ==");
    const invRes = await fetch(`${base}/api/sales/sales-orders/${order.id}/invoice`, {
      method: "POST", ...j(sales, { warehouseId: whId }) });
    check("make invoice -> 201", invRes.status === 201, String(invRes.status));
    const { invoiceId } = await invRes.json() as { invoiceId: string };
    const [inv] = await q<{ status: string; grand_total: string; sales_order_id: string | null }>(
      `SELECT status, grand_total::text, sales_order_id FROM invoices WHERE id = $1`, [invoiceId]);
    check("invoice is a draft", inv!.status === "draft", inv!.status);
    check("invoice grand = 3540.00", inv!.grand_total === "3540.00", inv!.grand_total);
    check("invoice links back to the order", inv!.sales_order_id === order.id, inv!.sales_order_id ?? "null");

    const beforeSubmit = await (await fetch(`${base}/api/sales/sales-orders/${order.id}`, { headers: { cookie: sales } }))
      .json() as { billing_status: string; invoices: unknown[] };
    check("billing still Not Billed (invoice is draft)", beforeSubmit.billing_status === "Not Billed", beforeSubmit.billing_status);
    check("SO lists the linked invoice", beforeSubmit.invoices.length === 1, String(beforeSubmit.invoices.length));

    console.log("== BILLING STATUS derives from the SUBMITTED invoice ==");
    const invSubmit = await fetch(`${base}/api/invoicing/invoices/${invoiceId}/submit`, { method: "POST", ...j(sales) });
    check("invoice submit -> 200", invSubmit.status === 200, String(invSubmit.status));
    const afterBill = await (await fetch(`${base}/api/sales/sales-orders/${order.id}`, { headers: { cookie: sales } }))
      .json() as { billing_status: string };
    check("billing now Fully Billed", afterBill.billing_status === "Fully Billed", afterBill.billing_status);

    const billAgain = await fetch(`${base}/api/sales/sales-orders/${order.id}/invoice`, {
      method: "POST", ...j(sales, { warehouseId: whId }) });
    check("second make-invoice -> 409 (already billed)", billAgain.status === 409, String(billAgain.status));

    console.log("== CANCEL blocked once invoiced; cancel is admin-only ==");
    const cancelBilled = await fetch(`${base}/api/sales/sales-orders/${order.id}/cancel`, { method: "POST", ...j(admin) });
    check("cancel invoiced order -> 409", cancelBilled.status === 409, String(cancelBilled.status));

    const c2 = await (await fetch(`${base}/api/sales/sales-orders`, { method: "POST", ...j(sales, body) })).json() as { id: string };
    await fetch(`${base}/api/sales/sales-orders/${c2.id}/submit`, { method: "POST", ...j(sales) });
    const salesCancel = await fetch(`${base}/api/sales/sales-orders/${c2.id}/cancel`, { method: "POST", ...j(sales) });
    check("sales cancel -> 403 (admin-only)", salesCancel.status === 403, String(salesCancel.status));
    const adminCancel = await fetch(`${base}/api/sales/sales-orders/${c2.id}/cancel`, { method: "POST", ...j(admin) });
    check("admin cancel (no invoices) -> 200", adminCancel.status === 200, String(adminCancel.status));
    const cancelled = await (await fetch(`${base}/api/sales/sales-orders/${c2.id}`, { headers: { cookie: admin } }))
      .json() as { status: string };
    check("status cancelled", cancelled.status === "cancelled", cancelled.status ?? "");
  } finally {
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
