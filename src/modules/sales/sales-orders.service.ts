import type { Tx } from "../../shared/db.js";
import { pool, withTransaction } from "../../shared/db.js";
import { AppError, fromPgError } from "../../shared/errors.js";
import { makeLifecycle } from "../../core/document-engine.js";
import { toDecimalString, toPaise } from "../../shared/money.js";
import { computeGst, type TaxableLineInput } from "../invoicing/tax.js";
import { createDraftInvoice, type CreateInvoiceInput } from "../invoicing/service.js";

/**
 * Sales Orders — the confirmed order between quotation and invoice, ported from
 * the ERPNext/Odoo standard chain (quotation → sales_order → invoice). Like the
 * quotation it is NON-POSTING (no journal, no stock) and immutable after submit;
 * unlike the quotation it rounds to the whole rupee (a confirmed order must
 * match the invoice it becomes). Billing status is DERIVED from the invoices
 * raised against it — never a stored counter (schema principle 3).
 */

export interface CreateSalesOrderInput {
  customerId: string;
  placeOfSupply: string;
  docDate?: string;             // order date; never in the future
  deliveryDate?: string;
  poNo?: string;                // customer's purchase order reference
  poDate?: string;
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
    quotationLineId?: string;   // provenance when created from a quotation
  }[];
}

async function prepareSalesOrder(tx: Tx, input: CreateSalesOrderInput) {
  if (input.docDate && input.docDate > new Date().toISOString().slice(0, 10)) {
    throw new AppError("INVALID_DATE", "Order date cannot be in the future", 422);
  }
  const { rows: [settings] } = await tx.query<{ state_code: string }>(
    `SELECT state_code FROM company_settings WHERE id = 1`);
  if (!settings) throw new AppError("NOT_CONFIGURED", "Company settings missing", 500);
  const isInterState = settings.state_code !== input.placeOfSupply;

  const taxInput: TaxableLineInput[] = input.lines.map((l) => ({
    qty: l.qty, ratePaise: toPaise(l.rate), discountPct: l.discountPct ?? 0, gstRate: l.gstRate,
  }));
  const t = computeGst(taxInput, isInterState);   // rounds grand total to the rupee

  const { rows: [customer] } = await tx.query<{ id: string }>(
    `SELECT id FROM companies WHERE id = $1 AND is_customer`, [input.customerId]);
  if (!customer) throw new AppError("NOT_FOUND", "Customer not found", 404);

  return { isInterState, t };
}

async function insertSalesOrderLines(
  tx: Tx, salesOrderId: string, input: CreateSalesOrderInput, t: ReturnType<typeof computeGst>,
): Promise<void> {
  for (let i = 0; i < input.lines.length; i++) {
    const l = input.lines[i]!; const c = t.lines[i]!;
    await tx.query(
      `INSERT INTO sales_order_lines
         (sales_order_id, item_id, quotation_line_id, description, hsn_sac_code, qty, uom, rate,
          discount_pct, taxable_value, gst_rate, cgst_amount, sgst_amount, igst_amount, line_total, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'Nos'),$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [salesOrderId, l.itemId, l.quotationLineId ?? null, l.description, l.hsn, l.qty, l.uom ?? null,
       l.rate, l.discountPct ?? 0, toDecimalString(c.taxableValue), l.gstRate,
       toDecimalString(c.cgst), toDecimalString(c.sgst), toDecimalString(c.igst),
       toDecimalString(c.lineTotal), i],
    );
  }
}

async function insertSalesOrder(
  tx: Tx, input: CreateSalesOrderInput, quotationId: string | null, userId: string,
): Promise<{ id: string }> {
  const { isInterState, t } = await prepareSalesOrder(tx, input);
  const { rows: [so] } = await tx.query<{ id: string }>(
    `INSERT INTO sales_orders
       (customer_id, quotation_id, place_of_supply, is_inter_state, doc_date, delivery_date,
        po_no, po_date, terms, notes,
        subtotal, discount_total, taxable_total, cgst_total, sgst_total, igst_total,
        rounding_adjustment, grand_total, created_by)
     VALUES ($1,$2,$3,$4,COALESCE($5,CURRENT_DATE),$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     RETURNING id`,
    [input.customerId, quotationId, input.placeOfSupply, isInterState, input.docDate ?? null,
     input.deliveryDate ?? null, input.poNo ?? null, input.poDate ?? null,
     input.terms ?? null, input.notes ?? null,
     toDecimalString(t.subtotal), toDecimalString(t.discountTotal), toDecimalString(t.taxableTotal),
     toDecimalString(t.cgstTotal), toDecimalString(t.sgstTotal), toDecimalString(t.igstTotal),
     toDecimalString(t.roundingAdjustment), toDecimalString(t.grandTotal), userId],
  );
  await insertSalesOrderLines(tx, so!.id, input, t);
  return { id: so!.id };
}

export async function createDraftSalesOrder(input: CreateSalesOrderInput, userId: string): Promise<{ id: string }> {
  return withTransaction(userId, (tx) => insertSalesOrder(tx, input, null, userId))
    .catch((e) => { throw fromPgError(e); });
}

/** Full replace of a DRAFT order (resume a mid-entry draft). Draft-only. */
export async function updateDraftSalesOrder(
  id: string, input: CreateSalesOrderInput, userId: string,
): Promise<{ id: string }> {
  return withTransaction(userId, async (tx) => {
    const { rows: [existing] } = await tx.query<{ status: string; quotation_id: string | null }>(
      `SELECT status, quotation_id FROM sales_orders WHERE id = $1 FOR UPDATE`, [id]);
    if (!existing) throw new AppError("NOT_FOUND", "Sales order not found", 404);
    if (existing.status !== "draft") {
      throw new AppError("INVALID_STATE", `sales order is ${existing.status}, expected draft`, 409);
    }
    const { isInterState, t } = await prepareSalesOrder(tx, input);

    await tx.query(`DELETE FROM sales_order_lines WHERE sales_order_id = $1`, [id]);
    await tx.query(
      `UPDATE sales_orders SET
         customer_id = $2, place_of_supply = $3, is_inter_state = $4,
         doc_date = COALESCE($5, doc_date), delivery_date = $6, po_no = $7, po_date = $8,
         terms = $9, notes = $10,
         subtotal = $11, discount_total = $12, taxable_total = $13, cgst_total = $14,
         sgst_total = $15, igst_total = $16, rounding_adjustment = $17, grand_total = $18
       WHERE id = $1`,
      [id, input.customerId, input.placeOfSupply, isInterState, input.docDate ?? null,
       input.deliveryDate ?? null, input.poNo ?? null, input.poDate ?? null,
       input.terms ?? null, input.notes ?? null,
       toDecimalString(t.subtotal), toDecimalString(t.discountTotal), toDecimalString(t.taxableTotal),
       toDecimalString(t.cgstTotal), toDecimalString(t.sgstTotal), toDecimalString(t.igstTotal),
       toDecimalString(t.roundingAdjustment), toDecimalString(t.grandTotal)],
    );
    await insertSalesOrderLines(tx, id, input, t);
    return { id };
  }).catch((e) => { throw fromPgError(e); });
}

// ---------------------------------------------------------------------------
// Lifecycle: non-posting. Submit confirms the order & issues the SO number;
// cancel is blocked once an invoice has been raised against it (ERPNext rule).
// ---------------------------------------------------------------------------
interface LoadedSalesOrder { id: string; status: string; }

export const salesOrderLifecycle = makeLifecycle<LoadedSalesOrder>({
  table: "sales_orders",
  series: () => "SO-2026",
  async load(tx, id) {
    const { rows: [so] } = await tx.query<LoadedSalesOrder>(
      `SELECT id, status FROM sales_orders WHERE id = $1`, [id]);
    if (!so) throw new AppError("NOT_FOUND", `Sales order ${id} not found`, 404);
    return so;
  },
  async onSubmit() { return {}; },      // confirms the order; nothing hits the books
  async onCancel(tx, so) {
    const { rows: [b] } = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM invoices
        WHERE sales_order_id = $1 AND status <> 'cancelled'`, [so.id]);
    if (b!.n !== "0") {
      throw new AppError("HAS_INVOICES", "Cancel the invoices raised against this order first", 409);
    }
  },
});

// ---------------------------------------------------------------------------
// Quotation → Sales Order (ERPNext make_sales_order): carry lines + provenance,
// produce a DRAFT order the staff completes (delivery date, PO) and submits.
// ---------------------------------------------------------------------------
export async function createSalesOrderFromQuotation(
  quotationId: string, opts: { deliveryDate?: string; poNo?: string; poDate?: string }, userId: string,
): Promise<{ salesOrderId: string }> {
  return withTransaction(userId, async (tx) => {
    const { rows: [q] } = await tx.query<{
      status: string; customer_id: string; place_of_supply: string; valid_until: string | null; terms: string | null;
    }>(
      `SELECT status, customer_id, place_of_supply, valid_until::text, terms
         FROM quotations WHERE id = $1 FOR UPDATE`, [quotationId]);
    if (!q) throw new AppError("NOT_FOUND", "Quotation not found", 404);
    if (q.status !== "submitted") {
      throw new AppError("INVALID_STATE", `quotation is ${q.status}, expected submitted`, 409);
    }
    const { rows: [existing] } = await tx.query<{ id: string }>(
      `SELECT id FROM sales_orders WHERE quotation_id = $1 AND status <> 'cancelled' LIMIT 1`, [quotationId]);
    if (existing) throw new AppError("ALREADY_ORDERED", "This quotation already has a sales order", 409);

    const { rows: lines } = await tx.query<{
      id: string; item_id: string; description: string; hsn_sac_code: string;
      qty: string; uom: string; rate: string; discount_pct: string; gst_rate: string;
    }>(
      `SELECT id, item_id, description, hsn_sac_code, qty::text, uom, rate::text,
              discount_pct::text, gst_rate::text
         FROM quotation_lines WHERE quotation_id = $1 ORDER BY sort_order`, [quotationId]);

    const input: CreateSalesOrderInput = {
      customerId: q.customer_id,
      placeOfSupply: q.place_of_supply,
      ...(opts.deliveryDate ? { deliveryDate: opts.deliveryDate } : {}),
      ...(opts.poNo ? { poNo: opts.poNo } : {}),
      ...(opts.poDate ? { poDate: opts.poDate } : {}),
      ...(q.terms ? { terms: q.terms } : {}),
      lines: lines.map((l) => ({
        itemId: l.item_id,
        description: l.description,
        hsn: l.hsn_sac_code,
        qty: l.qty,
        uom: l.uom,
        rate: l.rate,
        ...(Number(l.discount_pct) > 0 ? { discountPct: Number(l.discount_pct) } : {}),
        gstRate: Number(l.gst_rate),
        quotationLineId: l.id,
      })),
    };
    const { id } = await insertSalesOrder(tx, input, quotationId, userId);
    return { salesOrderId: id };
  }).catch((e) => { throw fromPgError(e); });
}

// ---------------------------------------------------------------------------
// Sales Order → draft Invoice (ERPNext make_sales_invoice). Full-order billing:
// one invoice per order (partial billing is a future enhancement). The invoice
// links back via invoices.sales_order_id, set inside the invoicing service.
// ---------------------------------------------------------------------------
export async function createInvoiceFromSalesOrder(
  salesOrderId: string, opts: { warehouseId: string; dueDate?: string }, userId: string,
): Promise<{ invoiceId: string }> {
  const { rows: [so] } = await pool.query<{
    status: string; customer_id: string; place_of_supply: string;
  }>(
    `SELECT status, customer_id, place_of_supply FROM sales_orders WHERE id = $1`, [salesOrderId]);
  if (!so) throw new AppError("NOT_FOUND", "Sales order not found", 404);
  if (so.status !== "submitted") {
    throw new AppError("INVALID_STATE", `sales order is ${so.status}, expected submitted`, 409);
  }
  const { rows: [billed] } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM invoices WHERE sales_order_id = $1 AND status <> 'cancelled'`,
    [salesOrderId]);
  if (billed!.n !== "0") {
    throw new AppError("ALREADY_BILLED", "This sales order has already been invoiced", 409);
  }

  const { rows: lines } = await pool.query<{
    item_id: string; description: string; hsn_sac_code: string; qty: string;
    uom: string; rate: string; discount_pct: string; gst_rate: string;
  }>(
    `SELECT item_id, description, hsn_sac_code, qty::text, uom, rate::text,
            discount_pct::text, gst_rate::text
       FROM sales_order_lines WHERE sales_order_id = $1 ORDER BY sort_order`, [salesOrderId]);

  const input: CreateInvoiceInput = {
    customerId: so.customer_id,
    warehouseId: opts.warehouseId,
    placeOfSupply: so.place_of_supply,
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
  const { id: invoiceId } = await createDraftInvoice(input, userId, { salesOrderId });
  return { invoiceId };
}
