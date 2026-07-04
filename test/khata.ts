/**
 * Khata rail test — the week-1/2 slice from the eng review:
 * opening balances (D3) -> khata report -> payments (on-account + allocated)
 * -> invoice list -> payment cancel reversal -> Friday digest.
 * HTTP-level against the real server + PostgreSQL; sales-role cookie exercises
 * the D4 grant (counter staff submits) on the payments rail.
 */
import type { AddressInfo } from "node:net";
import { app } from "../src/server.js";
import { createUser } from "../src/core/auth.js";
import { pool, withTransaction } from "../src/shared/db.js";
import { lockStock, receiveStock } from "../src/modules/inventory/service.js";
import { fridayDigest } from "../src/modules/accounting/reports.js";
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
  console.log("== SETUP: users, customer, stock ==");
  await q(`INSERT INTO company_settings (id, legal_name, gstin, state_code)
           VALUES (1,'Harsh Trading Co','09ABCDE1234F1Z5','09')
           ON CONFLICT (id) DO UPDATE SET state_code='09', gstin=EXCLUDED.gstin`);

  const admin = { email: `kh_admin_${stamp}@test.com`, password: "Pw!" };
  const sales = { email: `kh_sales_${stamp}@test.com`, password: "Pw!" };
  const { id: adminId } = await createUser({ email: admin.email, fullName: "Admin", password: admin.password, roleName: "admin" });
  await createUser({ email: sales.email, fullName: "Counter", password: sales.password, roleName: "sales" });

  const [customer] = await q<{ id: string; name: string }>(
    `INSERT INTO companies (name, gstin, gst_treatment, state_code)
     VALUES ('Khata Traders ' || substr(gen_random_uuid()::text,1,8),
             '07AAACA1234A1Z5','registered','07') RETURNING id, name`);
  const [wh] = await q<{ id: string }>(
    `INSERT INTO warehouses (name) VALUES ('KH-Main-' || gen_random_uuid()) RETURNING id`);
  const [item] = await q<{ id: string }>(
    `INSERT INTO items (sku, name, hsn_sac_code, gst_rate)
     VALUES ('KH-' || substr(gen_random_uuid()::text,1,8), 'Servo Stabilizer 5kVA', '8504', 18) RETURNING id`);
  await withTransaction(adminId, async (tx) => {
    const lines = [{ itemId: item!.id, warehouseId: wh!.id, qty: "20.000", ratePaise: toPaise("2000.00") }];
    const locked = await lockStock(tx, lines);
    await receiveStock(tx, locked, lines, { type: "purchase_receipt", id: crypto.randomUUID() }, adminId);
  });

  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const J = { "content-type": "application/json" };

  async function loginCookie(email: string, password: string): Promise<string> {
    const res = await fetch(`${base}/api/auth/login`, { method: "POST", headers: J, body: JSON.stringify({ email, password }) });
    return sidFrom(res.headers.get("set-cookie"))!;
  }
  const khataBalance = async (): Promise<string | null> => {
    const res = await fetch(`${base}/api/accounting/reports/khata`, { headers: { cookie: adminCookie } });
    const body = await res.json() as { rows: { partyId: string; balance: string }[] };
    return body.rows.find((r) => r.partyId === customer!.id)?.balance ?? null;
  };

  const adminCookie = await loginCookie(admin.email, admin.password);
  const salesCookie = await loginCookie(sales.email, sales.password);

  try {
    console.log("== OPENING BALANCES (D3) ==");
    const obZero = await fetch(`${base}/api/accounting/opening-balances`, {
      method: "POST", headers: { ...J, cookie: adminCookie },
      body: JSON.stringify({ customerId: customer!.id, amount: "0.00" }),
    });
    check("zero opening -> 422", obZero.status === 422, String(obZero.status));

    const obStaff = await fetch(`${base}/api/accounting/opening-balances`, {
      method: "POST", headers: { ...J, cookie: salesCookie },
      body: JSON.stringify({ customerId: customer!.id, amount: "40000.00" }),
    });
    check("sales role opening -> 403 (accounting.submit denied)", obStaff.status === 403, String(obStaff.status));

    const ob = await fetch(`${base}/api/accounting/opening-balances`, {
      method: "POST", headers: { ...J, cookie: adminCookie },
      body: JSON.stringify({ customerId: customer!.id, amount: "40000.00" }),
    });
    check("admin opening -> 201", ob.status === 201, String(ob.status));
    check("khata shows 40000.00", (await khataBalance()) === "40000.00", String(await khataBalance()));

    const obDup = await fetch(`${base}/api/accounting/opening-balances`, {
      method: "POST", headers: { ...J, cookie: adminCookie },
      body: JSON.stringify({ customerId: customer!.id, amount: "41000.00" }),
    });
    check("duplicate opening -> 409 OPENING_EXISTS", obDup.status === 409, String(obDup.status));

    console.log("== ON-ACCOUNT PAYMENT (sales role end-to-end, D4) ==");
    const payRes = await fetch(`${base}/api/invoicing/payments`, {
      method: "POST", headers: { ...J, cookie: salesCookie },
      body: JSON.stringify({ customerId: customer!.id, amount: "15000.00", mode: "cash", depositAccountKey: "cash" }),
    });
    check("sales creates draft payment -> 201", payRes.status === 201, String(payRes.status));
    const { id: payId } = await payRes.json() as { id: string };

    const paySubmit = await fetch(`${base}/api/invoicing/payments/${payId}/submit`, {
      method: "POST", headers: { cookie: salesCookie },
    });
    check("sales submits payment -> 200 (D4 grant)", paySubmit.status === 200, String(paySubmit.status));
    const payDoc = await paySubmit.json() as { docNo: string };
    check("payment doc number PAY-2026-*", /^PAY-2026-\d{5}$/.test(payDoc.docNo), payDoc.docNo);
    check("khata after on-account: 25000.00", (await khataBalance()) === "25000.00", String(await khataBalance()));

    const payDouble = await fetch(`${base}/api/invoicing/payments/${payId}/submit`, {
      method: "POST", headers: { cookie: salesCookie },
    });
    check("double-submit payment -> 409", payDouble.status === 409, String(payDouble.status));

    console.log("== INVOICE + ALLOCATED PAYMENT ==");
    // 12 x 2500 (5% disc, 18% GST, inter-state 09->07): taxable 28500, IGST 5130, total 33630.00
    const invRes = await fetch(`${base}/api/invoicing/invoices`, {
      method: "POST", headers: { ...J, cookie: adminCookie },
      body: JSON.stringify({
        customerId: customer!.id, warehouseId: wh!.id, placeOfSupply: "07",
        lines: [{ itemId: item!.id, description: "Servo Stabilizer 5kVA", hsn: "8504",
                  qty: "12.000", rate: "2500.00", discountPct: 5, gstRate: 18 }],
      }),
    });
    check("draft invoice -> 201", invRes.status === 201, String(invRes.status));
    const { id: invId } = await invRes.json() as { id: string };
    const invSubmit = await fetch(`${base}/api/invoicing/invoices/${invId}/submit`, {
      method: "POST", headers: { cookie: adminCookie },
    });
    check("invoice submit -> 200", invSubmit.status === 200, String(invSubmit.status));
    check("khata includes invoice: 58630.00 (25000 opening-net + 33630 invoice)",
      (await khataBalance()) === "58630.00", String(await khataBalance()));

    const overAlloc = await fetch(`${base}/api/invoicing/payments`, {
      method: "POST", headers: { ...J, cookie: adminCookie },
      body: JSON.stringify({ customerId: customer!.id, amount: "1000.00", mode: "upi", depositAccountKey: "bank",
        allocations: [{ invoiceId: invId, amount: "1500.00" }] }),
    });
    check("allocations > payment amount -> 422", overAlloc.status === 422, String(overAlloc.status));

    const badInv = await fetch(`${base}/api/invoicing/payments`, {
      method: "POST", headers: { ...J, cookie: adminCookie },
      body: JSON.stringify({ customerId: customer!.id, amount: "1000.00", mode: "upi", depositAccountKey: "bank",
        allocations: [{ invoiceId: crypto.randomUUID(), amount: "1000.00" }] }),
    });
    check("allocation to unknown invoice -> 422", badInv.status === 422, String(badInv.status));

    const alloc = await fetch(`${base}/api/invoicing/payments`, {
      method: "POST", headers: { ...J, cookie: adminCookie },
      body: JSON.stringify({ customerId: customer!.id, amount: "1000.00", mode: "upi", depositAccountKey: "bank",
        referenceNo: "UTR123", allocations: [{ invoiceId: invId, amount: "1000.00" }] }),
    });
    check("allocated payment draft -> 201", alloc.status === 201, String(alloc.status));
    const { id: allocPayId } = await alloc.json() as { id: string };
    const allocSubmit = await fetch(`${base}/api/invoicing/payments/${allocPayId}/submit`, {
      method: "POST", headers: { cookie: adminCookie },
    });
    check("allocated payment submit -> 200", allocSubmit.status === 200, String(allocSubmit.status));

    const invAfter = await fetch(`${base}/api/invoicing/invoices/${invId}`, { headers: { cookie: adminCookie } });
    const invBody = await invAfter.json() as { payment_status: string; amount_paid: string; outstanding: string };
    check("invoice partially_paid", invBody.payment_status === "partially_paid", invBody.payment_status);
    check("invoice amount_paid = 1000.00", invBody.amount_paid === "1000.00", invBody.amount_paid);
    check("khata after allocated payment: 57630.00", (await khataBalance()) === "57630.00", String(await khataBalance()));

    console.log("== INVOICE LIST ENDPOINT ==");
    const list = await fetch(`${base}/api/invoicing/invoices?status=submitted&customer=${customer!.id}`, {
      headers: { cookie: salesCookie },
    });
    check("list -> 200 (sales can read)", list.status === 200, String(list.status));
    const listBody = await list.json() as { id: string; payment_status: string; customer_name: string }[];
    const listed = listBody.find((r) => r.id === invId);
    check("list contains the invoice with payment_status", listed?.payment_status === "partially_paid", JSON.stringify(listed ?? null));
    const listAnon = await fetch(`${base}/api/invoicing/invoices`, {});
    check("list unauthenticated -> 401", listAnon.status === 401, String(listAnon.status));

    console.log("== PAYMENT CANCEL = REVERSAL ==");
    const cancelStaff = await fetch(`${base}/api/invoicing/payments/${allocPayId}/cancel`, {
      method: "POST", headers: { cookie: salesCookie },
    });
    check("sales cancel payment -> 403 (admin-only)", cancelStaff.status === 403, String(cancelStaff.status));
    const cancel = await fetch(`${base}/api/invoicing/payments/${allocPayId}/cancel`, {
      method: "POST", headers: { cookie: adminCookie },
    });
    check("admin cancel payment -> 200", cancel.status === 200, String(cancel.status));

    const [net] = await q<{ net: string }>(
      `SELECT COALESCE(sum(jl.debit) - sum(jl.credit), 0)::text AS net
         FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journal_entry_id
        WHERE je.voucher_type = 'payment_in' AND je.voucher_id = $1 AND je.status = 'posted'`,
      [allocPayId]);
    check("cancelled payment journals net to zero", net!.net === "0.00", net!.net);

    const invAfterCancel = await fetch(`${base}/api/invoicing/invoices/${invId}`, { headers: { cookie: adminCookie } });
    const invBody2 = await invAfterCancel.json() as { payment_status: string };
    check("invoice back to unpaid after cancel", invBody2.payment_status === "unpaid", invBody2.payment_status);
    check("khata restored: 58630.00", (await khataBalance()) === "58630.00", String(await khataBalance()));

    console.log("== FRIDAY DIGEST ==");
    const dig = await fetch(`${base}/api/accounting/reports/digest`, { headers: { cookie: adminCookie } });
    check("digest -> 200", dig.status === 200, String(dig.status));
    const digest = await dig.json() as { text: string; data: { weekSalesCount: number; weekPaymentsCount: number; totalReceivable: string } };
    check("digest text has header", digest.text.includes("Friday ka hisaab"), digest.text.slice(0, 40));
    check("digest text lists our customer", digest.text.includes(customer!.name), customer!.name);
    check("digest counts this week's sale", digest.data.weekSalesCount >= 1, String(digest.data.weekSalesCount));
    check("digest counts this week's payment", digest.data.weekPaymentsCount >= 1, String(digest.data.weekPaymentsCount));

    // Empty-week window (service level): a week in 2001 has no documents.
    const empty = await fridayDigest(new Date("2001-01-05T12:00:00Z"));
    check("empty week: zero sales", empty.data.weekSalesCount === 0, String(empty.data.weekSalesCount));
    check("empty week: text renders", empty.text.includes("Is hafte ki sale: ₹0.00"), empty.text);
  } finally {
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
