import type { Tx } from "../../shared/db.js";
import { pool, withTransaction } from "../../shared/db.js";
import { AppError, fromPgError } from "../../shared/errors.js";
import { makeLifecycle } from "../../core/document-engine.js";
import { toDecimalString, toPaise } from "../../shared/money.js";
import { computeGst, type TaxableLineInput } from "../invoicing/tax.js";
import { createDraftInvoice, type CreateInvoiceInput } from "../invoicing/service.js";

/**
 * Quotations — the sales module. A quotation is a NON-POSTING document: it
 * moves no stock and posts no journal, so its submit/cancel lifecycle hooks are
 * no-ops (the engine still issues the QTN number, freezes the lines, and flips
 * status). The one business effect is "convert": a submitted quotation spawns a
 * DRAFT invoice, linked both ways, with no re-entry of lines.
 *
 * GST math is the same as invoices — we reuse computeGst (a pure function),
 * exactly as invoicing reuses accounting.postJournal and inventory.lockStock.
 * Quotations have no rounding-adjustment column: grand_total is the exact sum
 * (a quote is an estimate; rupee-rounding happens on the invoice).
 */

export interface CreateQuotationInput {
  customerId: string;
  placeOfSupply: string;        // buyer state code
  docDate?: string;             // never in the future
  validUntil?: string;
  terms?: string;
  notes?: string;
  lines: {
    itemId: string;
    description: string;
    hsn: string;
    qty: string;
    uom?: string;
    rate: string;
    discountPct?: number;
    gstRate: number;
  }[];
}

/** Shared by create + update: company/customer lookups, GST math, future-date guard. */
async function prepareQuotation(tx: Tx, input: CreateQuotationInput) {
  if (input.docDate && input.docDate > new Date().toISOString().slice(0, 10)) {
    throw new AppError("INVALID_DATE", "Quotation date cannot be in the future", 422);
  }
  const { rows: [settings] } = await tx.query<{ state_code: string }>(
    `SELECT state_code FROM company_settings WHERE id = 1`,
  );
  if (!settings) throw new AppError("NOT_CONFIGURED", "Company settings missing", 500);
  const isInterState = settings.state_code !== input.placeOfSupply;

  const taxInput: TaxableLineInput[] = input.lines.map((l) => ({
    qty: l.qty, ratePaise: toPaise(l.rate), discountPct: l.discountPct ?? 0, gstRate: l.gstRate,
  }));
  const t = computeGst(taxInput, isInterState);
  const grandExact = t.taxableTotal + t.cgstTotal + t.sgstTotal + t.igstTotal;

  const { rows: [customer] } = await tx.query<{ id: string }>(
    `SELECT id FROM companies WHERE id = $1 AND is_customer`, [input.customerId]);
  if (!customer) throw new AppError("NOT_FOUND", "Customer not found", 404);

  return { isInterState, t, grandExact };
}

async function insertQuotationLines(
  tx: Tx, quotationId: string, input: CreateQuotationInput, t: ReturnType<typeof computeGst>,
): Promise<void> {
  for (let i = 0; i < input.lines.length; i++) {
    const l = input.lines[i]!; const c = t.lines[i]!;
    await tx.query(
      `INSERT INTO quotation_lines
         (quotation_id, item_id, description, hsn_sac_code, qty, uom, rate, discount_pct,
          taxable_value, gst_rate, cgst_amount, sgst_amount, igst_amount, line_total, sort_order)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,'Nos'),$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [quotationId, l.itemId, l.description, l.hsn, l.qty, l.uom ?? null, l.rate, l.discountPct ?? 0,
       toDecimalString(c.taxableValue), l.gstRate,
       toDecimalString(c.cgst), toDecimalString(c.sgst), toDecimalString(c.igst),
       toDecimalString(c.lineTotal), i],
    );
  }
}

export async function createDraftQuotation(input: CreateQuotationInput, userId: string): Promise<{ id: string }> {
  return withTransaction(userId, async (tx) => {
    const { isInterState, t, grandExact } = await prepareQuotation(tx, input);

    const { rows: [q] } = await tx.query<{ id: string }>(
      `INSERT INTO quotations
         (customer_id, place_of_supply, is_inter_state, doc_date, valid_until, terms, notes,
          subtotal, discount_total, taxable_total, cgst_total, sgst_total, igst_total,
          grand_total, created_by)
       VALUES ($1,$2,$3,COALESCE($4,CURRENT_DATE),$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING id`,
      [input.customerId, input.placeOfSupply, isInterState, input.docDate ?? null,
       input.validUntil ?? null, input.terms ?? null, input.notes ?? null,
       toDecimalString(t.subtotal), toDecimalString(t.discountTotal), toDecimalString(t.taxableTotal),
       toDecimalString(t.cgstTotal), toDecimalString(t.sgstTotal), toDecimalString(t.igstTotal),
       toDecimalString(grandExact), userId],
    );

    await insertQuotationLines(tx, q!.id, input, t);
    return { id: q!.id };
  }).catch((e) => { throw fromPgError(e); });
}

/** Full replace of a DRAFT quotation (resume a mid-entry draft, fix a line).
 *  Submitted/cancelled quotations are never editable (status check + trigger). */
export async function updateDraftQuotation(
  id: string, input: CreateQuotationInput, userId: string,
): Promise<{ id: string }> {
  return withTransaction(userId, async (tx) => {
    const { rows: [existing] } = await tx.query<{ status: string }>(
      `SELECT status FROM quotations WHERE id = $1 FOR UPDATE`, [id]);
    if (!existing) throw new AppError("NOT_FOUND", "Quotation not found", 404);
    if (existing.status !== "draft") {
      throw new AppError("INVALID_STATE", `quotation is ${existing.status}, expected draft`, 409);
    }

    const { isInterState, t, grandExact } = await prepareQuotation(tx, input);

    await tx.query(`DELETE FROM quotation_lines WHERE quotation_id = $1`, [id]);
    await tx.query(
      `UPDATE quotations SET
         customer_id = $2, place_of_supply = $3, is_inter_state = $4,
         doc_date = COALESCE($5, doc_date), valid_until = $6, terms = $7, notes = $8,
         subtotal = $9, discount_total = $10, taxable_total = $11, cgst_total = $12,
         sgst_total = $13, igst_total = $14, grand_total = $15
       WHERE id = $1`,
      [id, input.customerId, input.placeOfSupply, isInterState, input.docDate ?? null,
       input.validUntil ?? null, input.terms ?? null, input.notes ?? null,
       toDecimalString(t.subtotal), toDecimalString(t.discountTotal), toDecimalString(t.taxableTotal),
       toDecimalString(t.cgstTotal), toDecimalString(t.sgstTotal), toDecimalString(t.igstTotal),
       toDecimalString(grandExact)],
    );

    await insertQuotationLines(tx, id, input, t);
    return { id };
  }).catch((e) => { throw fromPgError(e); });
}

// ---------------------------------------------------------------------------
// Lifecycle: non-posting. Submit issues the number & freezes; cancel just flips
// status. No journal, no stock — hence the empty hooks.
// ---------------------------------------------------------------------------
interface LoadedQuotation { id: string; status: string; }

export const quotationLifecycle = makeLifecycle<LoadedQuotation>({
  table: "quotations",
  series: () => "QTN-2026",
  async load(tx, id) {
    const { rows: [q] } = await tx.query<LoadedQuotation>(
      `SELECT id, status FROM quotations WHERE id = $1`, [id]);
    if (!q) throw new AppError("NOT_FOUND", `Quotation ${id} not found`, 404);
    return q;
  },
  async onSubmit() { return {}; },   // nothing hits the books
  async onCancel() { /* nothing to reverse */ },
});

// ---------------------------------------------------------------------------
// Convert a submitted quotation -> a draft invoice (Phase 4: no re-entry).
// The invoice is created via the invoicing service (which sets invoices.
// quotation_id); we only stamp our own converted_invoice_id back.
// ---------------------------------------------------------------------------
export async function convertQuotationToInvoice(
  id: string, opts: { warehouseId: string; dueDate?: string }, userId: string,
): Promise<{ invoiceId: string }> {
  const { rows: [q] } = await pool.query<{
    status: string; customer_id: string; place_of_supply: string; converted_invoice_id: string | null;
  }>(
    `SELECT status, customer_id, place_of_supply, converted_invoice_id
       FROM quotations WHERE id = $1`, [id]);
  if (!q) throw new AppError("NOT_FOUND", "Quotation not found", 404);
  if (q.status !== "submitted") {
    throw new AppError("INVALID_STATE", `quotation is ${q.status}, expected submitted`, 409);
  }
  if (q.converted_invoice_id) {
    throw new AppError("ALREADY_CONVERTED", "This quotation was already converted to an invoice", 409);
  }

  const { rows: lines } = await pool.query<{
    item_id: string; description: string; hsn_sac_code: string; qty: string;
    uom: string; rate: string; discount_pct: string; gst_rate: string;
  }>(
    `SELECT item_id, description, hsn_sac_code, qty::text, uom, rate::text,
            discount_pct::text, gst_rate::text
       FROM quotation_lines WHERE quotation_id = $1 ORDER BY sort_order`, [id]);

  const input: CreateInvoiceInput = {
    customerId: q.customer_id,
    warehouseId: opts.warehouseId,
    placeOfSupply: q.place_of_supply,
    ...(opts.dueDate ? { dueDate: opts.dueDate } : {}),
    lines: lines.map((l) => ({
      itemId: l.item_id,
      description: l.description,
      hsn: l.hsn_sac_code,
      qty: l.qty,
      uom: l.uom,
      rate: l.rate,
      ...(Number(l.discount_pct) > 0 ? { discountPct: Number(l.discount_pct) } : {}),
      gstRate: Number(l.gst_rate),
    })),
  };

  const { id: invoiceId } = await createDraftInvoice(input, userId, { quotationId: id });

  // Stamp the link on our own table (converted_invoice_id is whitelisted for
  // update even on a submitted quotation). withTransaction sets app.user_id.
  await withTransaction(userId, (tx) =>
    tx.query(`UPDATE quotations SET converted_invoice_id = $2 WHERE id = $1`, [id, invoiceId]),
  ).catch((e) => { throw fromPgError(e); });

  return { invoiceId };
}
