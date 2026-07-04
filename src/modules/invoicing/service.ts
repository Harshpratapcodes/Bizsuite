import type { Tx } from "../../shared/db.js";
import { withTransaction } from "../../shared/db.js";
import { AppError, fromPgError } from "../../shared/errors.js";
import { makeLifecycle } from "../../core/document-engine.js";
import { postJournal, reverseJournal, type JournalLine } from "../accounting/service.js";
import { lockStock, issueStock, receiveStock, type StockLine } from "../inventory/service.js";
import { toDecimalString, toPaise } from "../../shared/money.js";
import { computeGst, type TaxableLineInput } from "./tax.js";

// ---------------------------------------------------------------------------
// Draft creation: compute GST totals and persist header + lines.
// ---------------------------------------------------------------------------
export interface CreateInvoiceInput {
  customerId: string;
  warehouseId: string;
  placeOfSupply: string;        // buyer state code
  dueDate?: string;
  lines: {
    itemId: string;
    description: string;
    hsn: string;
    qty: string;
    rate: string;               // "1500.00"
    discountPct?: number;
    gstRate: number;
  }[];
}

export async function createDraftInvoice(input: CreateInvoiceInput, userId: string): Promise<{ id: string }> {
  return withTransaction(userId, async (tx) => {
    const { rows: [settings] } = await tx.query<{ state_code: string; gstin: string | null }>(
      `SELECT state_code, gstin FROM company_settings WHERE id = 1`,
    );
    if (!settings) throw new AppError("NOT_CONFIGURED", "Company settings missing", 500);
    const isInterState = settings.state_code !== input.placeOfSupply;

    const taxInput: TaxableLineInput[] = input.lines.map((l) => ({
      qty: l.qty, ratePaise: toPaise(l.rate), discountPct: l.discountPct ?? 0, gstRate: l.gstRate,
    }));
    const t = computeGst(taxInput, isInterState);

    const { rows: [customer] } = await tx.query<{ gstin: string | null }>(
      `SELECT gstin FROM companies WHERE id = $1 AND is_customer`, [input.customerId]);
    if (!customer) throw new AppError("NOT_FOUND", "Customer not found", 404);

    const { rows: [inv] } = await tx.query<{ id: string }>(
      `INSERT INTO invoices
         (kind, customer_id, source_warehouse_id, company_gstin, customer_gstin,
          place_of_supply, is_inter_state, due_date,
          subtotal, discount_total, taxable_total, cgst_total, sgst_total, igst_total,
          rounding_adjustment, grand_total, created_by)
       VALUES ('invoice', $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING id`,
      [input.customerId, input.warehouseId, settings.gstin, customer.gstin,
       input.placeOfSupply, isInterState, input.dueDate ?? null,
       toDecimalString(t.subtotal), toDecimalString(t.discountTotal), toDecimalString(t.taxableTotal),
       toDecimalString(t.cgstTotal), toDecimalString(t.sgstTotal), toDecimalString(t.igstTotal),
       toDecimalString(t.roundingAdjustment), toDecimalString(t.grandTotal), userId],
    );

    for (let i = 0; i < input.lines.length; i++) {
      const l = input.lines[i]!; const c = t.lines[i]!;
      await tx.query(
        `INSERT INTO invoice_lines
           (invoice_id, item_id, description, hsn_sac_code, qty, rate, discount_pct,
            taxable_value, gst_rate, cgst_amount, sgst_amount, igst_amount, line_total, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [inv!.id, l.itemId, l.description, l.hsn, l.qty, l.rate, l.discountPct ?? 0,
         toDecimalString(c.taxableValue), l.gstRate,
         toDecimalString(c.cgst), toDecimalString(c.sgst), toDecimalString(c.igst),
         toDecimalString(c.lineTotal), i],
      );
    }
    return { id: inv!.id };
  }).catch((e) => { throw fromPgError(e); });
}

// ---------------------------------------------------------------------------
// Lifecycle: the reference onSubmit/onCancel — THE most important code path.
// ---------------------------------------------------------------------------
interface LoadedInvoice {
  id: string; status: string;
  customer_id: string; source_warehouse_id: string; doc_date: string;
  taxable_total: string; cgst_total: string; sgst_total: string;
  igst_total: string; rounding_adjustment: string; grand_total: string;
  is_inter_state: boolean; journal_entry_id: string | null;
  stockLines: (StockLine & { invQty: string })[];
}

async function loadInvoice(tx: Tx, id: string): Promise<LoadedInvoice> {
  const { rows: [inv] } = await tx.query<LoadedInvoice>(
    `SELECT id, status, customer_id, source_warehouse_id, doc_date::text,
            taxable_total::text, cgst_total::text, sgst_total::text, igst_total::text,
            rounding_adjustment::text, grand_total::text, is_inter_state, journal_entry_id
       FROM invoices WHERE id = $1`, [id]);
  if (!inv) throw new AppError("NOT_FOUND", `Invoice ${id} not found`, 404);

  const { rows: stock } = await tx.query<{ item_id: string; qty: string }>(
    `SELECT il.item_id, il.qty::text
       FROM invoice_lines il JOIN items i ON i.id = il.item_id
      WHERE il.invoice_id = $1 AND i.is_stock_item`, [id]);
  inv.stockLines = stock.map((s) => ({
    itemId: s.item_id, warehouseId: inv.source_warehouse_id, qty: s.qty, invQty: s.qty,
  }));
  return inv;
}

export const invoiceLifecycle = makeLifecycle<LoadedInvoice>({
  table: "invoices",
  series: () => "INV-2026",
  load: loadInvoice,

  /** Submission, in the canonical order (see system-design.md §5.1):
   *  lock stock -> sales journal -> stock issues -> COGS journal. */
  async onSubmit(tx, inv, docNo, userId) {
    // 1. Serialize on stock rows BEFORE any writes (deadlock-safe ordering inside)
    const locked = await lockStock(tx, inv.stockLines);

    // 2. Sales journal: Dr Debtors[customer] / Cr Sales, Cr GST Output, rounding
    const lines: JournalLine[] = [
      { accountKey: "debtors", debit: toPaise(inv.grand_total),
        party: { type: "customer", id: inv.customer_id }, remarks: docNo },
      { accountKey: "sales", credit: toPaise(inv.taxable_total) },
    ];
    if (toPaise(inv.cgst_total) > 0) lines.push({ accountKey: "gst_output_cgst", credit: toPaise(inv.cgst_total) });
    if (toPaise(inv.sgst_total) > 0) lines.push({ accountKey: "gst_output_sgst", credit: toPaise(inv.sgst_total) });
    if (toPaise(inv.igst_total) > 0) lines.push({ accountKey: "gst_output_igst", credit: toPaise(inv.igst_total) });
    const rounding = toPaise(inv.rounding_adjustment);
    if (rounding > 0) lines.push({ accountKey: "rounding", credit: rounding });
    if (rounding < 0) lines.push({ accountKey: "rounding", debit: -rounding });

    const salesJe = await postJournal(tx, {
      postingDate: inv.doc_date, voucherType: "sales_invoice", voucherId: inv.id,
      narration: `Sales invoice ${docNo}`, lines,
    }, userId);

    // 3. Stock issues at current valuation (negative-stock guard fires here)
    if (inv.stockLines.length > 0) {
      const cogsValue = await issueStock(tx, locked, inv.stockLines,
        { type: "sales_invoice", id: inv.id }, userId);

      // 4. COGS journal: Dr COGS / Cr Stock in Hand
      if (cogsValue > 0) {
        await postJournal(tx, {
          postingDate: inv.doc_date, voucherType: "sales_invoice", voucherId: inv.id,
          narration: `COGS for ${docNo}`,
          lines: [
            { accountKey: "cogs", debit: cogsValue },
            { accountKey: "stock_in_hand", credit: cogsValue },
          ],
        }, userId);
      }
    }
    return { journal_entry_id: salesJe.id };
  },

  /** Cancellation = reversal, never deletion: reverse all journals for this
   *  voucher, return stock at the rates it was issued. */
  async onCancel(tx, inv, userId) {
    const { rows: journals } = await tx.query<{ id: string }>(
      `SELECT id FROM journal_entries
        WHERE voucher_type = 'sales_invoice' AND voucher_id = $1 AND status = 'posted'`,
      [inv.id]);
    for (const j of journals) {
      await reverseJournal(tx, j.id, userId, `Reversal on cancellation of invoice ${inv.id}`);
    }
    if (inv.stockLines.length > 0) {
      // return stock at the valuation it left with (read from the issue SLEs)
      const { rows: issued } = await tx.query<{ item_id: string; qty: string; rate: string }>(
        `SELECT item_id, (-qty_change)::text AS qty, valuation_rate::text AS rate
           FROM stock_ledger_entries
          WHERE voucher_type = 'sales_invoice' AND voucher_id = $1 AND qty_change < 0`,
        [inv.id]);
      const returns = issued.map((r) => ({
        itemId: r.item_id, warehouseId: inv.source_warehouse_id,
        qty: r.qty, ratePaise: toPaise(r.rate),
      }));
      const locked = await lockStock(tx, returns);
      await receiveStock(tx, locked, returns, { type: "sales_invoice", id: inv.id }, userId);
    }
  },
});
