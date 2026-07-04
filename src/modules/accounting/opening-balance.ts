import { withTransaction } from "../../shared/db.js";
import { AppError, fromPgError } from "../../shared/errors.js";
import { postJournal } from "./service.js";
import { toPaise } from "../../shared/money.js";

/**
 * Opening balances — bill-book-era dues entered at go-live (eng review D3).
 *
 *   Dr Debtors[customer]  /  Cr 3300 Opening Balances     (one journal per debtor)
 *
 * Party-level lumps by design: fast to bootstrap, feeds v_party_balances (the
 * khata). No invoice rows are created, so these dues can't take allocations —
 * payments against them are recorded on-account. Bill-level upgrade: TODOS.md #2.
 *
 * Idempotency: exactly one LIVE (non-reversed) opening entry per customer.
 * Corrections follow ledger law — reverse the old entry, enter the new one.
 * We tag entries with voucher_type 'manual_journal' + voucher_id = customer id.
 */

const OPENING_NARRATION = "Opening balance";

export interface OpeningBalanceInput {
  customerId: string;
  amount: string;      // "40000.00" — what they owe us as of go-live
  asOfDate?: string;   // posting date, defaults to today
}

export async function enterOpeningBalance(input: OpeningBalanceInput, userId: string): Promise<{ journalEntryId: string; entryNo: string }> {
  return withTransaction(userId, async (tx) => {
    const amount = toPaise(input.amount);
    if (amount <= 0) throw new AppError("INVALID_AMOUNT", "Opening balance must be positive", 422);

    const { rows: [customer] } = await tx.query<{ name: string }>(
      `SELECT name FROM companies WHERE id = $1 AND is_customer`, [input.customerId]);
    if (!customer) throw new AppError("NOT_FOUND", "Customer not found", 404);

    // One live opening entry per customer: posted, tagged to this customer,
    // not itself a reversal, and not reversed by a later entry.
    const { rows: [existing] } = await tx.query<{ entry_no: string }>(
      `SELECT je.entry_no
         FROM journal_entries je
        WHERE je.voucher_type = 'manual_journal' AND je.voucher_id = $1
          AND je.narration = $2 AND je.status = 'posted'
          AND je.reverses_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_id = je.id)`,
      [input.customerId, OPENING_NARRATION]);
    if (existing) {
      throw new AppError("OPENING_EXISTS",
        `Customer '${customer.name}' already has a live opening balance (${existing.entry_no}). ` +
        `Reverse it first if this is a correction.`, 409);
    }

    const je = await postJournal(tx, {
      postingDate: input.asOfDate ?? new Date().toISOString().slice(0, 10),
      voucherType: "manual_journal",
      voucherId: input.customerId,
      narration: OPENING_NARRATION,
      lines: [
        { accountKey: "debtors", debit: amount,
          party: { type: "customer", id: input.customerId }, remarks: OPENING_NARRATION },
        { accountKey: "opening_balance", credit: amount },
      ],
    }, userId);
    return { journalEntryId: je.id, entryNo: je.entryNo };
  }).catch((e) => { throw fromPgError(e); });
}
