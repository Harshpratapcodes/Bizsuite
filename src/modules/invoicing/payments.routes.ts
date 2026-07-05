import { Router } from "express";
import { z } from "zod";
import { CreatePayment } from "@bizsuite/contracts";
import { requireAuth, actorId } from "../../core/middleware.js";
import { requirePermission } from "../../core/rbac.js";
import { createDraftPayment, paymentLifecycle } from "./payments.service.js";
import { pool } from "../../shared/db.js";
import { AppError } from "../../shared/errors.js";

const ListQuery = z.object({
  status: z.enum(["draft", "submitted", "cancelled"]).optional(),
  customer: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const paymentsRouter = Router();

paymentsRouter.post("/", requireAuth, requirePermission("invoicing", "write"), async (req, res, next) => {
  try {
    const input = CreatePayment.parse(req.body);
    res.status(201).json(await createDraftPayment(input, actorId(req)));
  } catch (e) { next(e); }
});

paymentsRouter.get("/", requireAuth, requirePermission("invoicing", "read"), async (req, res, next) => {
  try {
    const q = ListQuery.parse(req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.status)   { params.push(q.status);   where.push(`p.status = $${params.length}`); }
    if (q.customer) { params.push(q.customer); where.push(`p.customer_id = $${params.length}`); }
    params.push(q.limit, q.offset);
    const { rows } = await pool.query(
      `SELECT p.id, p.doc_no, p.doc_date, p.status, p.customer_id, c.name AS customer_name,
              p.amount, p.mode, p.reference_no, p.created_by, p.created_at
         FROM payment_entries p JOIN companies c ON c.id = p.customer_id
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY p.doc_date DESC, p.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params);
    res.json(rows);
  } catch (e) { next(e); }
});

paymentsRouter.post("/:id/submit", requireAuth, requirePermission("invoicing", "submit"), async (req, res, next) => {
  try { res.json(await paymentLifecycle.submit(req.params.id!, actorId(req))); }
  catch (e) { next(e); }
});

paymentsRouter.post("/:id/cancel", requireAuth, requirePermission("invoicing", "cancel"), async (req, res, next) => {
  try { res.json(await paymentLifecycle.cancel(req.params.id!, actorId(req))); }
  catch (e) { next(e); }
});

paymentsRouter.get("/:id", requireAuth, requirePermission("invoicing", "read"), async (req, res, next) => {
  try {
    const { rows: [pay] } = await pool.query(
      `SELECT p.*, c.name AS customer_name,
              COALESCE(json_agg(json_build_object(
                'invoiceId', pa.invoice_id, 'amount', pa.allocated_amount,
                'invoiceNo', i.doc_no
              ) ORDER BY i.doc_date) FILTER (WHERE pa.id IS NOT NULL), '[]') AS allocations
         FROM payment_entries p
         JOIN companies c ON c.id = p.customer_id
         LEFT JOIN payment_allocations pa ON pa.payment_entry_id = p.id
         LEFT JOIN invoices i ON i.id = pa.invoice_id
        WHERE p.id = $1
        GROUP BY p.id, c.name`, [req.params.id]);
    if (!pay) throw new AppError("NOT_FOUND", "Payment not found", 404);
    res.json(pay);
  } catch (e) { next(e); }
});
