import type { Tx } from "../../shared/db.js";
import { nextDocNumber } from "../../core/numbering.js";
import { toDecimalString, type Paise } from "../../shared/money.js";

export interface JournalLine {
  accountKey: string;            // system_key in accounts ('debtors','sales',...)
  debit?: Paise;
  credit?: Paise;
  party?: { type: "customer" | "supplier"; id: string };
  remarks?: string;
}

export interface PostJournalInput {
  postingDate: string;           // 'YYYY-MM-DD'
  voucherType: string;           // voucher_type enum value
  voucherId: string;
  narration?: string;
  lines: JournalLine[];
  reversesId?: string;
}

/**
 * Post a journal entry. PUBLIC INTERFACE of the accounting module —
 * other modules NEVER touch journal tables directly.
 *
 * Flow required by the schema triggers: insert DRAFT, insert lines,
 * flip to POSTED (arms the deferred balance check, verified at COMMIT).
 */
export async function postJournal(tx: Tx, input: PostJournalInput, userId: string): Promise<{ id: string; entryNo: string }> {
  // Application-level balance assertion — fail fast with a clear message
  // before the DB-level deferred trigger would catch it at commit.
  const dr = input.lines.reduce((s, l) => s + (l.debit ?? 0), 0);
  const cr = input.lines.reduce((s, l) => s + (l.credit ?? 0), 0);
  if (dr !== cr) {
    throw new Error(`Unbalanced journal: debit ${dr} != credit ${cr} (paise)`);
  }

  const { rows: [entry] } = await tx.query<{ id: string }>(
    `INSERT INTO journal_entries (posting_date, voucher_type, voucher_id, narration, status, reverses_id)
     VALUES ($1, $2::voucher_type, $3, $4, 'draft', $5) RETURNING id`,
    [input.postingDate, input.voucherType, input.voucherId, input.narration ?? null, input.reversesId ?? null],
  );

  for (const line of input.lines) {
    await tx.query(
      `INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit, party_type, party_id, remarks)
       SELECT $1, a.id, $3::numeric, $4::numeric, $5, $6, $7
         FROM accounts a WHERE a.system_key = $2`,
      [
        entry!.id, line.accountKey,
        toDecimalString(line.debit ?? 0), toDecimalString(line.credit ?? 0),
        line.party?.type ?? null, line.party?.id ?? null, line.remarks ?? null,
      ],
    );
  }

  const entryNo = await nextDocNumber(tx, "JV-2026");
  await tx.query(
    `UPDATE journal_entries
        SET status = 'posted', entry_no = $2, posted_by = $3, posted_at = now()
      WHERE id = $1`,
    [entry!.id, entryNo, userId],
  );
  return { id: entry!.id, entryNo };
}

/** Cancel by reversal: mirror every line, mark the original cancelled. */
export async function reverseJournal(tx: Tx, journalEntryId: string, userId: string, narration: string): Promise<{ id: string }> {
  const { rows: lines } = await tx.query<{ account_id: string; debit: string; credit: string; party_type: string | null; party_id: string | null }>(
    `SELECT account_id, debit, credit, party_type, party_id
       FROM journal_lines WHERE journal_entry_id = $1`,
    [journalEntryId],
  );
  const { rows: [orig] } = await tx.query<{ posting_date: string; voucher_type: string; voucher_id: string }>(
    `SELECT posting_date::text, voucher_type::text, voucher_id FROM journal_entries WHERE id = $1`,
    [journalEntryId],
  );

  const { rows: [rev] } = await tx.query<{ id: string }>(
    `INSERT INTO journal_entries (posting_date, voucher_type, voucher_id, narration, status, reverses_id)
     VALUES (CURRENT_DATE, $1::voucher_type, $2, $3, 'draft', $4) RETURNING id`,
    [orig!.voucher_type, orig!.voucher_id, narration, journalEntryId],
  );
  for (const l of lines) {
    await tx.query(
      `INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit, party_type, party_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [rev!.id, l.account_id, l.credit, l.debit, l.party_type, l.party_id], // swapped
    );
  }
  const entryNo = await nextDocNumber(tx, "JV-2026");
  await tx.query(
    `UPDATE journal_entries SET status='posted', entry_no=$2, posted_by=$3, posted_at=now() WHERE id=$1`,
    [rev!.id, entryNo, userId],
  );
  // NOTE: the original entry deliberately REMAINS 'posted'. Reversal means
  // both entries stay in the books and net to zero — history is preserved
  // and every report still reconciles. (Marking the original 'cancelled'
  // AND posting a reversal would remove the amount twice.)
  return { id: rev!.id };
}
