import { pool, withTransaction } from "../../shared/db.js";
import { AppError, fromPgError } from "../../shared/errors.js";
import { toPaise, toDecimalString } from "../../shared/money.js";

/**
 * Chart of Accounts + the two core ledger reports (Trial Balance, General
 * Ledger), ported from the ERPNext Account model: a tree of accounts with a
 * root_type (Asset/Liability/Income/Expense/Equity), report_type derived from
 * it (Balance Sheet vs Profit and Loss), group vs postable ledger nodes, and
 * a normal balance side. Balances are DERIVED from posted journal lines
 * (schema principle 3) — never stored on the account.
 */

type RootType = "asset" | "liability" | "equity" | "income" | "expense";

/** root_type → report_type (ERPNext derivation). */
export function reportType(t: RootType): "Balance Sheet" | "Profit and Loss" {
  return t === "income" || t === "expense" ? "Profit and Loss" : "Balance Sheet";
}
/** Natural balance side (ERPNext balance_must_be). */
export function normalSide(t: RootType): "debit" | "credit" {
  return t === "asset" || t === "expense" ? "debit" : "credit";
}

export interface AccountNode {
  id: string;
  code: string;
  name: string;
  rootType: RootType;
  reportType: string;
  normalSide: string;
  isGroup: boolean;
  isActive: boolean;
  systemKey: string | null;
  parentId: string | null;
  balance: string;            // signed, debit-positive rupees (posted only)
}

/** Whole chart, flat, each node carrying its rolled-up posted balance. */
export async function listAccounts(): Promise<AccountNode[]> {
  const { rows: accounts } = await pool.query<{
    id: string; code: string; name: string; type: RootType;
    is_group: boolean; is_active: boolean; system_key: string | null; parent_id: string | null;
  }>(
    `SELECT id, code, name, type, is_group, is_active, system_key, parent_id
       FROM accounts ORDER BY code`);

  const { rows: bal } = await pool.query<{ account_id: string; signed: string }>(
    `SELECT jl.account_id, SUM(jl.debit - jl.credit)::text AS signed
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.status = 'posted'
      GROUP BY jl.account_id`);
  const ownPaise = new Map<string, number>();
  for (const b of bal) ownPaise.set(b.account_id, toPaise(b.signed));

  // Roll group balances up from their descendant ledgers (tree is small).
  const kids = new Map<string, string[]>();
  for (const a of accounts) {
    if (a.parent_id) (kids.get(a.parent_id) ?? kids.set(a.parent_id, []).get(a.parent_id)!).push(a.id);
  }
  const rollup = (id: string): number => {
    const children = kids.get(id);
    if (!children || children.length === 0) return ownPaise.get(id) ?? 0;
    return children.reduce((s, c) => s + rollup(c), 0);
  };

  return accounts.map((a) => ({
    id: a.id,
    code: a.code,
    name: a.name,
    rootType: a.type,
    reportType: reportType(a.type),
    normalSide: normalSide(a.type),
    isGroup: a.is_group,
    isActive: a.is_active,
    systemKey: a.system_key,
    parentId: a.parent_id,
    balance: toDecimalString(a.is_group ? rollup(a.id) : ownPaise.get(a.id) ?? 0),
  }));
}

export interface CreateAccountInput {
  parentId: string;           // must be a group; child inherits its root_type
  code: string;
  name: string;
  isGroup?: boolean;
}

export async function createAccount(input: CreateAccountInput, userId: string): Promise<{ id: string }> {
  return withTransaction(userId, async (tx) => {
    const { rows: [parent] } = await tx.query<{ type: RootType; is_group: boolean }>(
      `SELECT type, is_group FROM accounts WHERE id = $1`, [input.parentId]);
    if (!parent) throw new AppError("NOT_FOUND", "Parent account not found", 404);
    if (!parent.is_group) throw new AppError("INVALID_PARENT", "Parent must be a group account", 422);

    const { rows: [acc] } = await tx.query<{ id: string }>(
      `INSERT INTO accounts (code, name, type, parent_id, is_group)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [input.code.trim(), input.name.trim(), parent.type, input.parentId, input.isGroup ?? false]);
    return { id: acc!.id };
  }).catch((e) => { throw fromPgError(e); });
}

/** Archive = disable (ERPNext never deletes an account with history). System
 *  accounts and groups with active children cannot be archived. */
export async function archiveAccount(id: string, userId: string): Promise<{ id: string }> {
  return withTransaction(userId, async (tx) => {
    const { rows: [acc] } = await tx.query<{ system_key: string | null; is_group: boolean }>(
      `SELECT system_key, is_group FROM accounts WHERE id = $1 FOR UPDATE`, [id]);
    if (!acc) throw new AppError("NOT_FOUND", "Account not found", 404);
    if (acc.system_key) throw new AppError("SYSTEM_ACCOUNT", "System accounts cannot be archived", 409);
    if (acc.is_group) {
      const { rows: [child] } = await tx.query<{ id: string }>(
        `SELECT id FROM accounts WHERE parent_id = $1 AND is_active LIMIT 1`, [id]);
      if (child) throw new AppError("HAS_CHILDREN", "Archive or move the child accounts first", 409);
    }
    await tx.query(`UPDATE accounts SET is_active = false WHERE id = $1`, [id]);
    return { id };
  }).catch((e) => { throw fromPgError(e); });
}

// ---------------------------------------------------------------------------
// Trial Balance — closing balance per ledger account, netted onto its natural
// side. The grand debit and grand credit totals must be equal (the invariant).
// ---------------------------------------------------------------------------
export interface TrialBalanceRow { code: string; name: string; rootType: RootType; debit: string; credit: string; }
export interface TrialBalance {
  asOf: string | null;
  rows: TrialBalanceRow[];
  totalDebit: string;
  totalCredit: string;
  balanced: boolean;
}

export async function trialBalance(asOf?: string): Promise<TrialBalance> {
  const { rows } = await pool.query<{ code: string; name: string; type: RootType; net: string }>(
    `SELECT a.code, a.name, a.type,
            COALESCE(SUM(jl.debit - jl.credit), 0)::text AS net
       FROM accounts a
       JOIN journal_lines jl     ON jl.account_id = a.id
       JOIN journal_entries je   ON je.id = jl.journal_entry_id
                                AND je.status = 'posted'
                                AND ($1::date IS NULL OR je.posting_date <= $1::date)
      WHERE a.is_group = false
      GROUP BY a.code, a.name, a.type
      HAVING COALESCE(SUM(jl.debit - jl.credit), 0) <> 0
      ORDER BY a.code`,
    [asOf ?? null]);

  let totalDr = 0, totalCr = 0;
  const out: TrialBalanceRow[] = rows.map((r) => {
    const net = toPaise(r.net);
    const debit = net > 0 ? net : 0;
    const credit = net < 0 ? -net : 0;
    totalDr += debit; totalCr += credit;
    return { code: r.code, name: r.name, rootType: r.type, debit: toDecimalString(debit), credit: toDecimalString(credit) };
  });
  return {
    asOf: asOf ?? null,
    rows: out,
    totalDebit: toDecimalString(totalDr),
    totalCredit: toDecimalString(totalCr),
    balanced: totalDr === totalCr,
  };
}

// ---------------------------------------------------------------------------
// General Ledger — every posted line for one account, with a running balance
// (debit-positive) and an opening carried from before the window.
// ---------------------------------------------------------------------------
export interface GeneralLedgerRow {
  postingDate: string;
  entryNo: string | null;
  voucherType: string;
  narration: string | null;
  party: string | null;
  debit: string;
  credit: string;
  balance: string;            // running, debit-positive
}
export interface GeneralLedger {
  account: { id: string; code: string; name: string; rootType: RootType; normalSide: string };
  from: string | null;
  to: string | null;
  opening: string;
  rows: GeneralLedgerRow[];
  closing: string;
}

export async function generalLedger(accountId: string, from?: string, to?: string): Promise<GeneralLedger> {
  const { rows: [acc] } = await pool.query<{ id: string; code: string; name: string; type: RootType }>(
    `SELECT id, code, name, type FROM accounts WHERE id = $1`, [accountId]);
  if (!acc) throw new AppError("NOT_FOUND", "Account not found", 404);

  const { rows: [op] } = await pool.query<{ opening: string }>(
    `SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::text AS opening
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'posted'
      WHERE jl.account_id = $1 AND ($2::date IS NULL OR je.posting_date < $2::date)`,
    [accountId, from ?? null]);
  let running = toPaise(op!.opening);
  const opening = running;

  const { rows } = await pool.query<{
    posting_date: string; entry_no: string | null; voucher_type: string;
    narration: string | null; party: string | null; debit: string; credit: string;
  }>(
    `SELECT je.posting_date::text, je.entry_no, je.voucher_type, je.narration,
            c.name AS party, jl.debit::text, jl.credit::text
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'posted'
       LEFT JOIN companies c ON c.id = jl.party_id
      WHERE jl.account_id = $1
        AND ($2::date IS NULL OR je.posting_date >= $2::date)
        AND ($3::date IS NULL OR je.posting_date <= $3::date)
      ORDER BY je.posting_date, je.entry_no, jl.id`,
    [accountId, from ?? null, to ?? null]);

  const out: GeneralLedgerRow[] = rows.map((r) => {
    running += toPaise(r.debit) - toPaise(r.credit);
    return {
      postingDate: r.posting_date, entryNo: r.entry_no, voucherType: r.voucher_type,
      narration: r.narration, party: r.party, debit: r.debit, credit: r.credit,
      balance: toDecimalString(running),
    };
  });

  return {
    account: { id: acc.id, code: acc.code, name: acc.name, rootType: acc.type, normalSide: normalSide(acc.type) },
    from: from ?? null,
    to: to ?? null,
    opening: toDecimalString(opening),
    rows: out,
    closing: toDecimalString(running),
  };
}
