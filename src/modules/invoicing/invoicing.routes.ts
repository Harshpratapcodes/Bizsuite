import { Router } from "express";
import { z } from "zod";
import { CreateInvoice } from "@bizsuite/contracts";
import { requireAuth, actorId } from "../../core/middleware.js";
import { requirePermission } from "../../core/rbac.js";
import { createDraftInvoice, updateDraftInvoice, invoiceLifecycle } from "./service.js";
import { pool } from "../../shared/db.js";
import { AppError } from "../../shared/errors.js";

/**
 * Invoicing routes — draft → submit → cancel lifecycle plus list/detail reads.
 * Moved out of server.ts (eng review D6) so every module follows the same
 * router-per-module pattern; server.ts is mount-only. Request shapes live in
 * @bizsuite/contracts (D7) — the SPA validates with the same objects.
 */

const ListQuery = z.object({
  status: z.enum(["draft", "submitted", "cancelled"]).optional(),
  customer: z.string().uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const invoicingRouter = Router();

invoicingRouter.post("/", requireAuth, requirePermission("invoicing", "write"), async (req, res, next) => {
  try {
    const input = CreateInvoice.parse(req.body);
    res.status(201).json(await createDraftInvoice(input, actorId(req)));
  } catch (e) { next(e); }
});

invoicingRouter.get("/", requireAuth, requirePermission("invoicing", "read"), async (req, res, next) => {
  try {
    const q = ListQuery.parse(req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.status)   { params.push(q.status);   where.push(`i.status = $${params.length}`); }
    if (q.customer) { params.push(q.customer); where.push(`i.customer_id = $${params.length}`); }
    if (q.from)     { params.push(q.from);     where.push(`i.doc_date >= $${params.length}`); }
    if (q.to)       { params.push(q.to);       where.push(`i.doc_date <= $${params.length}`); }
    params.push(q.limit, q.offset);
    const { rows } = await pool.query(
      `SELECT i.id, i.kind, i.doc_no, i.doc_date, i.status, i.customer_id,
              c.name AS customer_name, i.grand_total,
              o.amount_paid, o.outstanding, o.payment_status,
              i.created_by, i.created_at
         FROM invoices i
         JOIN companies c ON c.id = i.customer_id
         LEFT JOIN v_invoice_outstanding o ON o.id = i.id
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY i.doc_date DESC, i.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params);
    res.json(rows);
  } catch (e) { next(e); }
});

// Full replace of a draft (edit-and-retry after INSUFFICIENT_STOCK; resume a
// mid-entry draft). Same contract as create; service enforces draft-only.
invoicingRouter.patch("/:id", requireAuth, requirePermission("invoicing", "write"), async (req, res, next) => {
  try {
    const input = CreateInvoice.parse(req.body);
    res.json(await updateDraftInvoice(req.params.id!, input, actorId(req)));
  } catch (e) { next(e); }
});

invoicingRouter.post("/:id/submit", requireAuth, requirePermission("invoicing", "submit"), async (req, res, next) => {
  try { res.json(await invoiceLifecycle.submit(req.params.id!, actorId(req))); }
  catch (e) { next(e); }
});

invoicingRouter.post("/:id/cancel", requireAuth, requirePermission("invoicing", "cancel"), async (req, res, next) => {
  try { res.json(await invoiceLifecycle.cancel(req.params.id!, actorId(req))); }
  catch (e) { next(e); }
});

// Detail = header + lines + customer + company snapshot: one fetch drives the
// review step, the resume-draft edit, and the print-CSS invoice.
invoicingRouter.get("/:id", requireAuth, requirePermission("invoicing", "read"), async (req, res, next) => {
  try {
    const { rows: [inv] } = await pool.query(
      `SELECT i.id, i.kind, i.doc_no, i.doc_date::text, i.status, i.customer_id,
              i.source_warehouse_id,
              i.place_of_supply, i.is_inter_state, i.due_date::text,
              i.company_gstin, i.customer_gstin,
              i.subtotal, i.discount_total, i.taxable_total,
              i.cgst_total, i.sgst_total, i.igst_total,
              i.rounding_adjustment, i.grand_total,
              i.submitted_at, i.created_at,
              o.amount_paid, o.outstanding, o.payment_status,
              jsonb_build_object(
                'name', c.name, 'gstin', c.gstin, 'state_code', c.state_code,
                'billing_address', c.billing_address
              ) AS customer,
              (SELECT jsonb_build_object(
                        'legal_name', s.legal_name, 'gstin', s.gstin,
                        'state_code', s.state_code, 'address', s.address,
                        'invoice_terms', s.invoice_terms)
                 FROM company_settings s WHERE s.id = 1) AS company
         FROM invoices i
         JOIN companies c ON c.id = i.customer_id
         LEFT JOIN v_invoice_outstanding o ON o.id = i.id
        WHERE i.id = $1`, [req.params.id]);
    if (!inv) throw new AppError("NOT_FOUND", "Invoice not found", 404);
    const { rows: lines } = await pool.query(
      `SELECT id, item_id, description, hsn_sac_code, qty::text, uom, rate,
              discount_pct, taxable_value, gst_rate, cgst_amount, sgst_amount,
              igst_amount, line_total, sort_order
         FROM invoice_lines WHERE invoice_id = $1 ORDER BY sort_order`, [req.params.id]);
    res.json({ ...inv, lines });
  } catch (e) { next(e); }
});
