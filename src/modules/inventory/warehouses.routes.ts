import { Router } from "express";
import { requireAuth } from "../../core/middleware.js";
import { requirePermission } from "../../core/rbac.js";
import { pool } from "../../shared/db.js";

/** Warehouse list for the invoice flow's source-warehouse default. Warehouses
 *  are created in SQL for now (no admin UI yet — same status as user creation). */
export const warehousesRouter = Router();

warehousesRouter.get("/", requireAuth, requirePermission("inventory", "read"), async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name FROM warehouses WHERE is_active ORDER BY created_at`);
    res.json(rows);
  } catch (e) { next(e); }
});
