/**
 * End-to-end integration test against a REAL PostgreSQL running schema.sql.
 * Exercises the full quote-to-cash spine: setup masters -> stock in ->
 * draft invoice (GST math) -> submit (journals + stock + COGS) ->
 * verify ledgers/views -> oversell rejection -> cancel (reversals) -> verify.
 */
import { pool, withTransaction } from "../src/shared/db.js";
import { lockStock, receiveStock } from "../src/modules/inventory/service.js";
import { createDraftInvoice, invoiceLifecycle } from "../src/modules/invoicing/service.js";
import { toPaise } from "../src/shared/money.js";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${detail}`); }
}
const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await pool.query<T>(sql, params)).rows;

async function main() {
  console.log("== SETUP: masters ==");
  const [user] = await q<{ id: string }>(
    `INSERT INTO users (email, full_name, password_hash, role_id)
     VALUES ('it@test.com','Integration Tester','x',(SELECT id FROM roles WHERE name='admin'))
     ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name RETURNING id`);
  const userId = user!.id;

  await q(`INSERT INTO company_settings (id, legal_name, gstin, state_code)
           VALUES (1,'Harsh Trading Co','09ABCDE1234F1Z5','09')
           ON CONFLICT (id) DO UPDATE SET state_code='09', gstin=EXCLUDED.gstin`);

  const [customer] = await q<{ id: string }>(
    `INSERT INTO companies (name, gstin, gst_treatment, state_code)
     VALUES ('Acme Industries ' || substr(gen_random_uuid()::text,1,8),
             '07AAACA1234A1Z5','registered','07') RETURNING id`); // Delhi: inter-state
  const [wh] = await q<{ id: string }>(
    `INSERT INTO warehouses (name) VALUES ('IT-Main-' || gen_random_uuid()) RETURNING id`);
  const [item] = await q<{ id: string }>(
    `INSERT INTO items (sku, name, hsn_sac_code, gst_rate)
     VALUES ('IT-' || substr(gen_random_uuid()::text,1,8), 'Steel Bracket', '7326', 18) RETURNING id`);

  console.log("== STEP 1: receive stock — 10 @ ₹100, then 5 @ ₹130 (moving average) ==");
  await withTransaction(userId, async (tx) => {
    const lines = [{ itemId: item!.id, warehouseId: wh!.id, qty: "10.000", ratePaise: toPaise("100.00") }];
    const locked = await lockStock(tx, lines);
    await receiveStock(tx, locked, lines, { type: "purchase_receipt", id: crypto.randomUUID() }, userId);
  });
  await withTransaction(userId, async (tx) => {
    const lines = [{ itemId: item!.id, warehouseId: wh!.id, qty: "5.000", ratePaise: toPaise("130.00") }];
    const locked = await lockStock(tx, lines);
    await receiveStock(tx, locked, lines, { type: "purchase_receipt", id: crypto.randomUUID() }, userId);
  });
  const [stock1] = await q<{ qty_on_hand: string; valuation_rate: string }>(
    `SELECT qty_on_hand::text, valuation_rate::text FROM item_warehouse WHERE item_id=$1 AND warehouse_id=$2`,
    [item!.id, wh!.id]);
  check("qty on hand = 15", stock1!.qty_on_hand === "15.000", `got ${stock1!.qty_on_hand}`);
  check("moving avg = ₹110 ((10×100+5×130)/15)", stock1!.valuation_rate === "110.00", `got ${stock1!.valuation_rate}`);

  console.log("== STEP 2: draft invoice — 12 units @ ₹250, 5% discount, GST 18%, INTER-state ==");
  const { id: invId } = await createDraftInvoice({
    customerId: customer!.id, warehouseId: wh!.id, placeOfSupply: "07",
    // +30 days, computed — a hardcoded date rotted into 'overdue' once CURRENT_DATE passed it
    dueDate: new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10),
    lines: [{ itemId: item!.id, description: "Steel Bracket", hsn: "7326",
              qty: "12.000", rate: "250.00", discountPct: 5, gstRate: 18 }],
  }, userId);
  const [draft] = await q<Record<string, string>>(`SELECT * FROM invoices WHERE id=$1`, [invId]);
  // 12×250=3000; −5%=2850 taxable; IGST 18% = 513; total 3363 → no rounding needed
  check("taxable = 2850.00", draft!.taxable_total === "2850.00", draft!.taxable_total!);
  check("IGST = 513.00 (inter-state)", draft!.igst_total === "513.00", draft!.igst_total!);
  check("CGST/SGST = 0", draft!.cgst_total === "0.00" && draft!.sgst_total === "0.00");
  check("grand total = 3363.00", draft!.grand_total === "3363.00", draft!.grand_total!);

  console.log("== STEP 3: submit — journals + stock issue + COGS in ONE transaction ==");
  const { docNo } = await invoiceLifecycle.submit(invId, userId);
  check("doc number issued", /^INV-2026-\d{5}$/.test(docNo), docNo);

  const [inv] = await q<Record<string, string>>(`SELECT * FROM invoices WHERE id=$1`, [invId]);
  check("status = submitted", inv!.status === "submitted");
  check("journal_entry_id set (submitted_is_booked)", !!inv!.journal_entry_id);

  const journals = await q<{ narration: string; dr: string; cr: string }>(
    `SELECT je.narration, sum(jl.debit)::text AS dr, sum(jl.credit)::text AS cr
       FROM journal_entries je JOIN journal_lines jl ON jl.journal_entry_id = je.id
      WHERE je.voucher_id = $1 AND je.status='posted' GROUP BY je.id, je.narration`, [invId]);
  check("two posted journals (sales + COGS)", journals.length === 2, String(journals.length));
  for (const j of journals) check(`balanced: ${j.narration}`, j.dr === j.cr, `${j.dr} vs ${j.cr}`);
  const [cogs] = journals.filter((j) => j.narration.startsWith("COGS"));
  check("COGS = 1320.00 (12 × ₹110 avg)", cogs?.dr === "1320.00", cogs?.dr ?? "missing");

  const [stock2] = await q<{ qty_on_hand: string }>(
    `SELECT qty_on_hand::text FROM item_warehouse WHERE item_id=$1 AND warehouse_id=$2`, [item!.id, wh!.id]);
  check("stock reduced to 3", stock2!.qty_on_hand === "3.000", stock2!.qty_on_hand!);

  const [recv] = await q<{ balance: string }>(
    `SELECT balance::text FROM v_party_balances WHERE party_id=$1`, [customer!.id]);
  check("customer owes 3363.00 (sub-ledger)", recv!.balance === "3363.00", recv!.balance!);

  const [out] = await q<{ outstanding: string; payment_status: string }>(
    `SELECT outstanding::text, payment_status FROM v_invoice_outstanding WHERE id=$1`, [invId]);
  check("outstanding view = 3363.00 / unpaid", out!.outstanding === "3363.00" && out!.payment_status === "unpaid");

  console.log("== STEP 4: oversell — only 3 left, try to invoice 50 (expect clean failure) ==");
  const { id: bigId } = await createDraftInvoice({
    customerId: customer!.id, warehouseId: wh!.id, placeOfSupply: "07",
    lines: [{ itemId: item!.id, description: "Steel Bracket", hsn: "7326",
              qty: "50.000", rate: "250.00", gstRate: 18 }],
  }, userId);
  let overselError = "";
  try { await invoiceLifecycle.submit(bigId, userId); }
  catch (e) { overselError = (e as { code?: string }).code ?? ""; }
  check("oversell rejected with INSUFFICIENT_STOCK", overselError === "INSUFFICIENT_STOCK", overselError);
  const [bigInv] = await q<{ status: string; doc_no: string | null }>(
    `SELECT status, doc_no FROM invoices WHERE id=$1`, [bigId]);
  check("failed submit fully rolled back (still draft, no number)",
        bigInv!.status === "draft" && bigInv!.doc_no === null);

  console.log("== STEP 5: cancel the good invoice — reversals, never deletion ==");
  await invoiceLifecycle.cancel(invId, userId);
  const [cstat] = await q<{ status: string }>(`SELECT status FROM invoices WHERE id=$1`, [invId]);
  check("invoice cancelled", cstat!.status === "cancelled");
  const [stock3] = await q<{ qty_on_hand: string }>(
    `SELECT qty_on_hand::text FROM item_warehouse WHERE item_id=$1 AND warehouse_id=$2`, [item!.id, wh!.id]);
  check("stock restored to 15", stock3!.qty_on_hand === "15.000", stock3!.qty_on_hand!);
  const [recv2] = await q<{ balance: string }>(
    `SELECT COALESCE(balance,0)::text AS balance FROM v_party_balances WHERE party_id=$1`, [customer!.id]);
  check("customer balance back to 0", recv2!.balance === "0.00" || recv2 === undefined, recv2?.balance ?? "0");

  console.log("== STEP 6: system-wide integrity ==");
  const gl = await q<{ check_name: string; ok: boolean }>(`SELECT * FROM fn_verify_gl()`);
  for (const c of gl) check(`integrity: ${c.check_name}`, c.ok);
  const mism = await q(`SELECT * FROM fn_verify_stock_cache()`);
  check("stock cache matches ledger", mism.length === 0, `${mism.length} mismatches`);
  const [audit] = await q<{ n: string }>(`SELECT count(*)::text AS n FROM audit_log WHERE actor_id=$1`, [userId]);
  check("audit trail attributed to actor", Number(audit!.n) > 0, audit!.n!);

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
