import { pool, withTransaction } from "../../shared/db.js";
import { AppError, fromPgError } from "../../shared/errors.js";

/**
 * Financial periods (ERPNext accounting_period). Closing a period locks it:
 * the journal_entries trigger (fn_posting_period_open) then rejects any posting
 * dated inside it, across every module. This service only opens/closes periods;
 * the lock itself lives in the database.
 */
export async function listPeriods() {
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.start_date::text, p.end_date::text, p.status,
            u.full_name AS closed_by_name, p.closed_at,
            (CURRENT_DATE BETWEEN p.start_date AND p.end_date) AS is_current
       FROM financial_periods p
       LEFT JOIN users u ON u.id = p.closed_by
      ORDER BY p.start_date`);
  return rows;
}

export async function closePeriod(id: string, userId: string): Promise<{ id: string }> {
  return withTransaction(userId, async (tx) => {
    const { rows: [p] } = await tx.query<{ status: string }>(
      `SELECT status FROM financial_periods WHERE id = $1 FOR UPDATE`, [id]);
    if (!p) throw new AppError("NOT_FOUND", "Period not found", 404);
    if (p.status === "closed") throw new AppError("INVALID_STATE", "Period is already closed", 409);
    await tx.query(
      `UPDATE financial_periods SET status='closed', closed_by=$2, closed_at=now() WHERE id=$1`, [id, userId]);
    return { id };
  }).catch((e) => { throw fromPgError(e); });
}

export async function reopenPeriod(id: string, userId: string): Promise<{ id: string }> {
  return withTransaction(userId, async (tx) => {
    const { rows: [p] } = await tx.query<{ status: string }>(
      `SELECT status FROM financial_periods WHERE id = $1 FOR UPDATE`, [id]);
    if (!p) throw new AppError("NOT_FOUND", "Period not found", 404);
    if (p.status === "open") throw new AppError("INVALID_STATE", "Period is already open", 409);
    await tx.query(
      `UPDATE financial_periods SET status='open', closed_by=NULL, closed_at=NULL WHERE id=$1`, [id]);
    return { id };
  }).catch((e) => { throw fromPgError(e); });
}
