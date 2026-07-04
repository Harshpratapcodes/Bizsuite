import type { Tx } from "../../shared/db.js";
import { withTransaction } from "../../shared/db.js";
import { AppError, fromPgError } from "../../shared/errors.js";
import { makeLifecycle } from "../../core/document-engine.js";
import { postJournal, reverseJournal, type JournalLine } from "../accounting/service.js";
import { toDecimalString, toPaise } from "../../shared/money.js";

/**
 * Payment entries (money IN from customers) + allocations against open invoices.
 *
 *   draft ──submit──► Dr Cash/Bank  /  Cr Debtors[customer]   ──cancel──► reversal
 *
 * Allocations link a payment to specific invoices; v_invoice_outstanding only
 * counts allocations whose payment is SUBMITTED, so cancelling a payment
 * automatically un-pays its invoices — no allocation cleanup needed (append-only).
 * An unallocated ("on-account") payment is legal: it reduces the party balance
 * in v_party_balances without touching any invoice — this is how cash against
 * bill-book-era opening dues is recorded (design doc, khata flows).
 *
 * DB second line of defense: fn_alloc_within_payment (deferred) caps
 * sum(allocations) <= payment.amount at COMMIT.
 */

export interface CreatePaymentInput {
  customerId: string;
  amount: string;                    // "5000.00" — decimal string, never a float
  mode: "cash" | "bank_transfer" | "upi" | "cheque" | "card";
  depositAccountKey: "cash" | "bank"; // resolved to the seeded account by system_key
  referenceNo?: string;              // UTR / cheque no
  docDate?: string;                  // 'YYYY-MM-DD', defaults to today
  notes?: string;
  allocations?: { invoiceId: string; amount: string }[];
}

export async function createDraftPayment(input: CreatePaymentInput, userId: string): Promise<{ id: string }> {
  return withTransaction(userId, async (tx) => {
    const amountPaise = toPaise(input.amount);
    if (amountPaise <= 0) throw new AppError("INVALID_AMOUNT", "Payment amount must be positive", 422);

    const { rows: [customer] } = await tx.query(
      `SELECT 1 FROM companies WHERE id = $1 AND is_customer`, [input.customerId]);
    if (!customer) throw new AppError("NOT_FOUND", "Customer not found", 404);

    const { rows: [deposit] } = await tx.query<{ id: string }>(
      `SELECT id FROM accounts WHERE system_key = $1 AND system_key IN ('cash','bank')`,
      [input.depositAccountKey]);
    if (!deposit) throw new AppError("INVALID_ACCOUNT", "Deposit account must be Cash or Bank", 422);

    // Fail fast on obviously bad allocations; the deferred trigger re-checks at COMMIT.
    const allocations = input.allocations ?? [];
    const allocTotal = allocations.reduce((s, a) => s + toPaise(a.amount), 0);
    if (allocTotal > amountPaise) {
      throw new AppError("OVER_ALLOCATED",
        `Allocations (${toDecimalString(allocTotal)}) exceed payment amount (${input.amount})`, 422);
    }

    const { rows: [pay] } = await tx.query<{ id: string }>(
      `INSERT INTO payment_entries
         (customer_id, amount, mode, reference_no, deposit_account_id, doc_date, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6::date, CURRENT_DATE),$7,$8)
       RETURNING id`,
      [input.customerId, input.amount, input.mode, input.referenceNo ?? null,
       deposit.id, input.docDate ?? null, input.notes ?? null, userId]);

    for (const a of allocations) {
      if (toPaise(a.amount) <= 0) {
        throw new AppError("INVALID_AMOUNT", "Allocation amounts must be positive", 422);
      }
      // The invoice must be a submitted invoice of THIS customer, with enough
      // outstanding. Soft check (race-safe enough at this scale); the payment
      // cap trigger is the hard guard.
      const { rows: [inv] } = await tx.query<{ outstanding: string }>(
        `SELECT o.outstanding::text
           FROM v_invoice_outstanding o
          WHERE o.id = $1 AND o.customer_id = $2`,
        [a.invoiceId, input.customerId]);
      if (!inv) {
        throw new AppError("INVALID_ALLOCATION",
          `Invoice ${a.invoiceId} is not an open invoice of this customer`, 422);
      }
      if (toPaise(a.amount) > toPaise(inv.outstanding)) {
        throw new AppError("INVALID_ALLOCATION",
          `Allocation ${a.amount} exceeds outstanding ${inv.outstanding} on invoice ${a.invoiceId}`, 422);
      }
      await tx.query(
        `INSERT INTO payment_allocations (payment_entry_id, invoice_id, allocated_amount)
         VALUES ($1,$2,$3)`,
        [pay!.id, a.invoiceId, a.amount]);
    }
    return { id: pay!.id };
  }).catch((e) => { throw fromPgError(e); });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
interface LoadedPayment {
  id: string; status: string;
  customer_id: string; amount: string; doc_date: string;
  deposit_key: string;               // 'cash' | 'bank' (system_key of deposit account)
  journal_entry_id: string | null;
}

async function loadPayment(tx: Tx, id: string): Promise<LoadedPayment> {
  const { rows: [pay] } = await tx.query<LoadedPayment>(
    `SELECT p.id, p.status, p.customer_id, p.amount::text, p.doc_date::text,
            a.system_key AS deposit_key, p.journal_entry_id
       FROM payment_entries p JOIN accounts a ON a.id = p.deposit_account_id
      WHERE p.id = $1`, [id]);
  if (!pay) throw new AppError("NOT_FOUND", `Payment ${id} not found`, 404);
  return pay;
}

export const paymentLifecycle = makeLifecycle<LoadedPayment>({
  table: "payment_entries",
  series: () => "PAY-2026",
  load: loadPayment,

  /** Dr Cash/Bank, Cr Debtors[customer]. v_invoice_outstanding starts counting
   *  this payment's allocations the moment status flips to submitted. */
  async onSubmit(tx, pay, docNo, userId) {
    const amount = toPaise(pay.amount);
    const lines: JournalLine[] = [
      { accountKey: pay.deposit_key, debit: amount, remarks: docNo },
      { accountKey: "debtors", credit: amount,
        party: { type: "customer", id: pay.customer_id }, remarks: docNo },
    ];
    const je = await postJournal(tx, {
      postingDate: pay.doc_date, voucherType: "payment_in", voucherId: pay.id,
      narration: `Payment received ${docNo}`, lines,
    }, userId);
    return { journal_entry_id: je.id };
  },

  /** Reversal, never deletion. Allocations stay in the table but stop counting
   *  (the outstanding view filters on pe.status = 'submitted'). */
  async onCancel(tx, pay, userId) {
    const { rows: journals } = await tx.query<{ id: string }>(
      `SELECT id FROM journal_entries
        WHERE voucher_type = 'payment_in' AND voucher_id = $1 AND status = 'posted'
          AND reverses_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_id = journal_entries.id)`,
      [pay.id]);
    for (const j of journals) {
      await reverseJournal(tx, j.id, userId, `Reversal on cancellation of payment ${pay.id}`);
    }
  },
});
