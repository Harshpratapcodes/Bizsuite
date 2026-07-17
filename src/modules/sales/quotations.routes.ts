import { Router } from "express";
import { z } from "zod";
import { CreateQuotation, ConvertQuotation } from "@bizsuite/contracts";
import { requireAuth, actorId } from "../../core/middleware.js";
import { requirePermission } from "../../core/rbac.js";
import {
  createDraftQuotation, updateDraftQuotation, quotationLifecycle, convertQuotationToInvoice,
} from "./quotations.service.js";
import { pool } from "../../shared/db.js";
import { AppError } from "../../shared/errors.js";

/**
 * Quotation routes — the sales module. Same router-per-module shape as
 * invoicing (eng review D6); request shapes live in @bizsuite/contracts (D7).
 * Guarded by the seeded `sales` permission matrix (admin/accounts/sales).
 */

const ListQuery = z.object({
  status: z.enum(["draft", "submitted", "cancelled"]).optional(),
  customer: z.string().uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const quotationsRouter = Router();

quotationsRouter.post("/", requireAuth, requirePermission("sales", "write"), async (req, res, next) => {
  try {
    const input = CreateQuotation.parse(req.body);
    res.status(201).json(await createDraftQuotation(input, actorId(req)));
  } catch (e) { next(e); }
});

quotationsRouter.get("/", requireAuth, requirePermission("sales", "read"), async (req, res, next) => {
  try {
    const q = ListQuery.parse(req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.status)   { params.push(q.status);   where.push(`q.status = $${params.length}`); }
    if (q.customer) { params.push(q.customer); where.push(`q.customer_id = $${params.length}`); }
    if (q.from)     { params.push(q.from);     where.push(`q.doc_date >= $${params.length}`); }
    if (q.to)       { params.push(q.to);       where.push(`q.doc_date <= $${params.length}`); }
    params.push(q.limit, q.offset);
    const { rows } = await pool.query(
      `SELECT q.id, q.doc_no, q.doc_date, q.status, q.customer_id,
              c.name AS customer_name, q.valid_until, q.grand_total,
              q.converted_invoice_id, q.created_by, q.created_at
         FROM quotations q
         JOIN companies c ON c.id = q.customer_id
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY q.doc_date DESC, q.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params);
    res.json(rows);
  } catch (e) { next(e); }
});

// Full replace of a draft (resume a mid-entry draft). Service enforces draft-only.
quotationsRouter.patch("/:id", requireAuth, requirePermission("sales", "write"), async (req, res, next) => {
  try {
    const input = CreateQuotation.parse(req.body);
    res.json(await updateDraftQuotation(req.params.id!, input, actorId(req)));
  } catch (e) { next(e); }
});

quotationsRouter.post("/:id/submit", requireAuth, requirePermission("sales", "submit"), async (req, res, next) => {
  try { res.json(await quotationLifecycle.submit(req.params.id!, actorId(req))); }
  catch (e) { next(e); }
});

quotationsRouter.post("/:id/cancel", requireAuth, requirePermission("sales", "cancel"), async (req, res, next) => {
  try { res.json(await quotationLifecycle.cancel(req.params.id!, actorId(req))); }
  catch (e) { next(e); }
});

// Convert produces a DRAFT invoice, so it is gated on the invoice-write
// permission (the tangible effect lives in the invoicing module).
quotationsRouter.post("/:id/convert", requireAuth, requirePermission("invoicing", "write"), async (req, res, next) => {
  try {
    const input = ConvertQuotation.parse(req.body);
    res.status(201).json(await convertQuotationToInvoice(req.params.id!, input, actorId(req)));
  } catch (e) { next(e); }
});

// Detail = header + lines + customer + company snapshot + converted invoice no:
// one fetch drives the review step, the resume-draft edit, and the print sheet.
quotationsRouter.get("/:id", requireAuth, requirePermission("sales", "read"), async (req, res, next) => {
  try {
    const { rows: [q] } = await pool.query(
      `SELECT q.id, q.doc_no, q.doc_date::text, q.status, q.customer_id,
              q.place_of_supply, q.is_inter_state, q.valid_until::text,
              q.terms, q.notes,
              q.subtotal, q.discount_total, q.taxable_total,
              q.cgst_total, q.sgst_total, q.igst_total, q.grand_total,
              q.converted_invoice_id, ci.doc_no AS converted_invoice_no,
              q.submitted_at, q.created_at,
              jsonb_build_object(
                'name', c.name, 'gstin', c.gstin, 'state_code', c.state_code,
                'billing_address', c.billing_address
              ) AS customer,
              (SELECT jsonb_build_object(
                        'legal_name', s.legal_name, 'gstin', s.gstin,
                        'state_code', s.state_code, 'address', s.address,
                        'invoice_terms', s.invoice_terms)
                 FROM company_settings s WHERE s.id = 1) AS company
         FROM quotations q
         JOIN companies c ON c.id = q.customer_id
         LEFT JOIN invoices ci ON ci.id = q.converted_invoice_id
        WHERE q.id = $1`, [req.params.id]);
    if (!q) throw new AppError("NOT_FOUND", "Quotation not found", 404);
    const { rows: lines } = await pool.query(
      `SELECT id, item_id, description, hsn_sac_code, qty::text, uom, rate,
              discount_pct, taxable_value, gst_rate, cgst_amount, sgst_amount,
              igst_amount, line_total, sort_order
         FROM quotation_lines WHERE quotation_id = $1 ORDER BY sort_order`, [req.params.id]);
    res.json({ ...q, lines });
  } catch (e) { next(e); }
});
