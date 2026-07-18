import { pool, withTransaction } from "../../shared/db.js";
import { AppError, fromPgError } from "../../shared/errors.js";
import { nextDocNumber } from "../../core/numbering.js";
import { toPaise, toDecimalString } from "../../shared/money.js";
import { reverseJournal } from "./service.js";

/**
 * Manual journal entries — the ERPNext Journal Entry doctype: a balanced set of
 * account lines (debit/credit, optional party) posted straight to the ledger.
 * Unlike postJournal (system-key based, used internally by invoices/payments),
 * these hit arbitrary accounts chosen by an accountant. draft → lines → posted
 * happens atomically; the DB deferred trigger re-checks balance at commit.
 */

export interface ManualJournalLine {
  accountId: string;
  debit: string;          // "0.00" when this line is a credit
  credit: string;
  partyType?: "customer" | "supplier";
  partyId?: string;
  remarks?: string;
}
export interface CreateJournalInput {
  postingDate?: string;   // defaults to today; never in the future
  narration: string;
  lines: ManualJournalLine[];
}

export async function postManualJournal(input: CreateJournalInput, userId: string): Promise<{ id: string; entryNo: string }> {
  if (input.postingDate && input.postingDate > new Date().toISOString().slice(0, 10)) {
    throw new AppError("INVALID_DATE", "Posting date cannot be in the future", 422);
  }
  if (input.lines.length < 2) throw new AppError("VALIDATION", "A journal needs at least two lines", 422);

  let totalDr = 0, totalCr = 0;
  for (const l of input.lines) {
    const d = toPaise(l.debit), c = toPaise(l.credit);
    if (d > 0 === c > 0) {
      throw new AppError("VALIDATION", "Each line must be either a debit or a credit, not both/neither", 422);
    }
    if ((l.partyType == null) !== (l.partyId == null)) {
      throw new AppError("VALIDATION", "A party needs both a type and a name", 422);
    }
    totalDr += d; totalCr += c;
  }
  if (totalDr !== totalCr) {
    throw new AppError("UNBALANCED", `Debits (${toDecimalString(totalDr)}) must equal credits (${toDecimalString(totalCr)})`, 422);
  }
  if (totalDr === 0) throw new AppError("VALIDATION", "A journal cannot be for zero", 422);

  return withTransaction(userId, async (tx) => {
    // All lines must post to active, non-group accounts.
    const ids = [...new Set(input.lines.map((l) => l.accountId))];
    const { rows: accts } = await tx.query<{ id: string; is_group: boolean; is_active: boolean }>(
      `SELECT id, is_group, is_active FROM accounts WHERE id = ANY($1)`, [ids]);
    const byId = new Map(accts.map((a) => [a.id, a]));
    for (const id of ids) {
      const a = byId.get(id);
      if (!a) throw new AppError("NOT_FOUND", "Account not found", 404);
      if (a.is_group) throw new AppError("GROUP_ACCOUNT", "Cannot post to a group account", 422);
      if (!a.is_active) throw new AppError("INACTIVE_ACCOUNT", "Cannot post to an archived account", 422);
    }

    const { rows: [entry] } = await tx.query<{ id: string }>(
      `INSERT INTO journal_entries (posting_date, voucher_type, narration, status)
       VALUES (COALESCE($1, CURRENT_DATE), 'manual_journal', $2, 'draft') RETURNING id`,
      [input.postingDate ?? null, input.narration]);

    for (const l of input.lines) {
      await tx.query(
        `INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit, party_type, party_id, remarks)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [entry!.id, l.accountId, l.debit, l.credit, l.partyType ?? null, l.partyId ?? null, l.remarks ?? null]);
    }

    const entryNo = await nextDocNumber(tx, "JV-2026");
    await tx.query(
      `UPDATE journal_entries SET status='posted', entry_no=$2, posted_by=$3, posted_at=now() WHERE id=$1`,
      [entry!.id, entryNo, userId]);
    return { id: entry!.id, entryNo };
  }).catch((e) => { throw fromPgError(e); });
}

/** Reverse a posted manual journal (admin). Original stays posted; both net to
 *  zero. Only manual journals are reversible here — invoice/payment vouchers are
 *  reversed by cancelling their source document, which keeps everything in sync. */
export async function reverseManualJournal(id: string, userId: string): Promise<{ id: string }> {
  return withTransaction(userId, async (tx) => {
    const { rows: [je] } = await tx.query<{ status: string; voucher_type: string; entry_no: string | null }>(
      `SELECT status, voucher_type::text, entry_no FROM journal_entries WHERE id = $1 FOR UPDATE`, [id]);
    if (!je) throw new AppError("NOT_FOUND", "Journal entry not found", 404);
    if (je.voucher_type !== "manual_journal") {
      throw new AppError("NOT_MANUAL", "Only manual journals can be reversed here; cancel the source document instead", 409);
    }
    if (je.status !== "posted") throw new AppError("INVALID_STATE", `entry is ${je.status}, expected posted`, 409);

    const { rows: [existing] } = await tx.query<{ id: string }>(
      `SELECT id FROM journal_entries WHERE reverses_id = $1 LIMIT 1`, [id]);
    if (existing) throw new AppError("ALREADY_REVERSED", "This journal was already reversed", 409);

    return reverseJournal(tx, id, userId, `Reversal of ${je.entry_no}`);
  }).catch((e) => { throw fromPgError(e); });
}

// ---------------------------------------------------------------------------
// Reads: register of manual journals + one entry's detail (header + lines).
// ---------------------------------------------------------------------------
export async function listManualJournals(opts: { from?: string; to?: string; limit: number; offset: number }) {
  const where: string[] = ["je.voucher_type = 'manual_journal'", "je.status = 'posted'"];
  const params: unknown[] = [];
  if (opts.from) { params.push(opts.from); where.push(`je.posting_date >= $${params.length}`); }
  if (opts.to)   { params.push(opts.to);   where.push(`je.posting_date <= $${params.length}`); }
  params.push(opts.limit, opts.offset);
  const { rows } = await pool.query(
    `SELECT je.id, je.entry_no, je.posting_date::text, je.narration,
            (SELECT COALESCE(SUM(debit),0)::text FROM journal_lines WHERE journal_entry_id = je.id) AS total,
            (je.reverses_id IS NOT NULL) AS is_reversal,
            EXISTS(SELECT 1 FROM journal_entries r WHERE r.reverses_id = je.id) AS reversed,
            je.posted_at
       FROM journal_entries je
      WHERE ${where.join(" AND ")}
      ORDER BY je.posting_date DESC, je.entry_no DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return rows;
}

export async function journalDetail(id: string) {
  const { rows: [je] } = await pool.query(
    `SELECT je.id, je.entry_no, je.posting_date::text, je.narration, je.status,
            je.voucher_type::text, je.reverses_id,
            rev.entry_no AS reverses_entry_no,
            (SELECT r.entry_no FROM journal_entries r WHERE r.reverses_id = je.id LIMIT 1) AS reversed_by_entry_no,
            (SELECT r.id FROM journal_entries r WHERE r.reverses_id = je.id LIMIT 1) AS reversed_by_id,
            je.posted_at, je.created_at
       FROM journal_entries je
       LEFT JOIN journal_entries rev ON rev.id = je.reverses_id
      WHERE je.id = $1`, [id]);
  if (!je) throw new AppError("NOT_FOUND", "Journal entry not found", 404);
  const { rows: lines } = await pool.query(
    `SELECT jl.account_id, a.code AS account_code, a.name AS account_name,
            jl.debit::text, jl.credit::text, jl.party_type, c.name AS party_name, jl.remarks
       FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id
       LEFT JOIN companies c ON c.id = jl.party_id
      WHERE jl.journal_entry_id = $1
      ORDER BY jl.id`, [id]);
  return { ...je, lines };
}
