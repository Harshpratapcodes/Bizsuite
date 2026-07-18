import { Router } from "express";
import { z } from "zod";
import { CreateSalesOrder, MakeInvoiceFromSalesOrder } from "@bizsuite/contracts";
import { requireAuth, actorId } from "../../core/middleware.js";
import { requirePermission } from "../../core/rbac.js";
import {
  createDraftSalesOrder, updateDraftSalesOrder, salesOrderLifecycle, createInvoiceFromSalesOrder,
} from "./sales-orders.service.js";
import { pool } from "../../shared/db.js";
import { AppError } from "../../shared/errors.js";

/**
 * Sales Order routes — the middle of the ERPNext/Odoo chain
 * (quotation → sales order → invoice). Same router-per-module shape and `sales`
 * permission matrix as quotations. billing_status is DERIVED from the invoices
 * raised against the order (schema principle 3).
 */

const ListQuery = z.object({
  status: z.enum(["draft", "submitted", "cancelled"]).optional(),
  customer: z.string().uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// billing_status derived from submitted invoices raised against the order.
const BILLING_STATUS = `
  CASE WHEN billed.total = 0 THEN 'Not Billed'
       WHEN billed.total >= so.grand_total THEN 'Fully Billed'
       ELSE 'Partly Billed' END`;
const BILLED_JOIN = `
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(grand_total), 0) AS total
      FROM invoices WHERE sales_order_id = so.id AND status = 'submitted'
  ) billed ON true`;

export const salesOrdersRouter = Router();

salesOrdersRouter.post("/", requireAuth, requirePermission("sales", "write"), async (req, res, next) => {
  try {
    const input = CreateSalesOrder.parse(req.body);
    res.status(201).json(await createDraftSalesOrder(input, actorId(req)));
  } catch (e) { next(e); }
});

salesOrdersRouter.get("/", requireAuth, requirePermission("sales", "read"), async (req, res, next) => {
  try {
    const q = ListQuery.parse(req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.status)   { params.push(q.status);   where.push(`so.status = $${params.length}`); }
    if (q.customer) { params.push(q.customer); where.push(`so.customer_id = $${params.length}`); }
    if (q.from)     { params.push(q.from);     where.push(`so.doc_date >= $${params.length}`); }
    if (q.to)       { params.push(q.to);       where.push(`so.doc_date <= $${params.length}`); }
    params.push(q.limit, q.offset);
    const { rows } = await pool.query(
      `SELECT so.id, so.doc_no, so.doc_date, so.status, so.customer_id,
              c.name AS customer_name, so.delivery_date, so.grand_total,
              ${BILLING_STATUS} AS billing_status,
              so.created_by, so.created_at
         FROM sales_orders so
         JOIN companies c ON c.id = so.customer_id
         ${BILLED_JOIN}
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY so.doc_date DESC, so.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params);
    res.json(rows);
  } catch (e) { next(e); }
});

salesOrdersRouter.patch("/:id", requireAuth, requirePermission("sales", "write"), async (req, res, next) => {
  try {
    const input = CreateSalesOrder.parse(req.body);
    res.json(await updateDraftSalesOrder(req.params.id!, input, actorId(req)));
  } catch (e) { next(e); }
});

salesOrdersRouter.post("/:id/submit", requireAuth, requirePermission("sales", "submit"), async (req, res, next) => {
  try { res.json(await salesOrderLifecycle.submit(req.params.id!, actorId(req))); }
  catch (e) { next(e); }
});

salesOrdersRouter.post("/:id/cancel", requireAuth, requirePermission("sales", "cancel"), async (req, res, next) => {
  try { res.json(await salesOrderLifecycle.cancel(req.params.id!, actorId(req))); }
  catch (e) { next(e); }
});

// Raise a draft invoice from a submitted order — gated on invoice-write (the
// tangible effect lives in the invoicing module).
salesOrdersRouter.post("/:id/invoice", requireAuth, requirePermission("invoicing", "write"), async (req, res, next) => {
  try {
    const input = MakeInvoiceFromSalesOrder.parse(req.body);
    res.status(201).json(await createInvoiceFromSalesOrder(req.params.id!, input, actorId(req)));
  } catch (e) { next(e); }
});

salesOrdersRouter.get("/:id", requireAuth, requirePermission("sales", "read"), async (req, res, next) => {
  try {
    const { rows: [so] } = await pool.query(
      `SELECT so.id, so.doc_no, so.doc_date::text, so.status,
              ${BILLING_STATUS} AS billing_status,
              so.customer_id, so.quotation_id, qt.doc_no AS quotation_no,
              so.place_of_supply, so.is_inter_state, so.delivery_date::text,
              so.po_no, so.po_date::text, so.terms, so.notes,
              so.subtotal, so.discount_total, so.taxable_total,
              so.cgst_total, so.sgst_total, so.igst_total,
              so.rounding_adjustment, so.grand_total,
              so.submitted_at, so.created_at,
              jsonb_build_object(
                'name', c.name, 'gstin', c.gstin, 'state_code', c.state_code,
                'billing_address', c.billing_address
              ) AS customer,
              (SELECT jsonb_build_object(
                        'legal_name', s.legal_name, 'gstin', s.gstin,
                        'state_code', s.state_code, 'address', s.address,
                        'invoice_terms', s.invoice_terms)
                 FROM company_settings s WHERE s.id = 1) AS company
         FROM sales_orders so
         JOIN companies c ON c.id = so.customer_id
         LEFT JOIN quotations qt ON qt.id = so.quotation_id
         ${BILLED_JOIN}
        WHERE so.id = $1`, [req.params.id]);
    if (!so) throw new AppError("NOT_FOUND", "Sales order not found", 404);
    const { rows: lines } = await pool.query(
      `SELECT id, item_id, description, hsn_sac_code, qty::text, uom, rate,
              discount_pct, taxable_value, gst_rate, cgst_amount, sgst_amount,
              igst_amount, line_total, sort_order
         FROM sales_order_lines WHERE sales_order_id = $1 ORDER BY sort_order`, [req.params.id]);
    const { rows: invoices } = await pool.query(
      `SELECT id, doc_no, status, grand_total
         FROM invoices WHERE sales_order_id = $1 ORDER BY created_at`, [req.params.id]);
    res.json({ ...so, lines, invoices });
  } catch (e) { next(e); }
});
