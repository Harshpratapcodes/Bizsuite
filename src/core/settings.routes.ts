import { Router } from "express";
import { requireAuth } from "./middleware.js";
import { pool } from "../shared/db.js";
import { AppError } from "../shared/errors.js";

/** Company settings (read-only): drives the SPA's intra/inter-state tax hint
 *  and the printed invoice header. Every authenticated role may read it. */
export const settingsRouter = Router();

settingsRouter.get("/company", requireAuth, async (_req, res, next) => {
  try {
    const { rows: [s] } = await pool.query(
      `SELECT legal_name, gstin, state_code, address, invoice_terms
         FROM company_settings WHERE id = 1`);
    if (!s) throw new AppError("NOT_CONFIGURED", "Company settings missing", 500);
    res.json(s);
  } catch (e) { next(e); }
});
