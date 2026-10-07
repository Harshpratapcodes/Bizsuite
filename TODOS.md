# TODOS

Captured by /plan-eng-review on 2026-07-04. Each entry carries enough context to pick up cold in 3 months.

## 1. Service/AMC module design spike

- **What:** Half-day schema + workflow design for AMC contracts, machines/assets per customer, service visits, renewal reminders.
- **Why:** Biggest scope hole found across two reviews — absent from blueprint AND v2 backlog for a sales+SERVICE business; one of only two legs the build-over-buy case stands on (the other is succession learning).
- **Pros:** Protects recurring service revenue; sharpens Approach B's estimate; COTS billing tools are weak here so it's genuine differentiation.
- **Cons:** Net-new schema work; needs dad's input on what AMC records exist (paper? memory?).
- **Context:** Design doc OQ3/OQ5. The business sells and services UPS/stabilizers; renewals lapsing silently is pure lost money today.
- **Depends on / blocked by:** Nothing to design; builds in Approach B after the pilot verdict.

## 2. Per-invoice opening balances for big B2B debtors

- **What:** Upgrade selected debtors from lump-sum opening journals to bill-level records (tax-zero "opening" invoices: no stock effect, no GST re-post) enabling bill-by-bill allocation and true aging.
- **Why:** D3 chose party-level lumps for speed; bill-level disputes ("that payment was for the stabilizer, not the UPS") are unresolvable by construction on lumps.
- **Pros:** Payment allocations and `v_receivables_aging` work uniformly for old and new dues where it matters.
- **Cons:** New invoice variant needs engine care (bypass GST/stock without weakening triggers); per-bill entry effort.
- **Context:** **Trigger = dad asks bill-level questions about old dues during the pilot.** Watch for it explicitly. Khata endpoint reads `v_party_balances` (not `v_invoice_outstanding`) until/unless this lands.
- **Depends on / blocked by:** Khata rail built; pilot observations.

## 3. Vitest migration for the tsx test scripts

- **What:** Move `test/*.ts` hand-rolled `check()` scripts to Vitest (parallel runs, watch mode, structured CI reporting).
- **Why:** system-design §8 names Vitest as the strategy; scripts work today but won't scale past ~10 suites and CI output readability matters once CI exists.
- **Pros:** Closes the stated-strategy-vs-reality drift; better failure output in CI.
- **Cons:** Toolchain churn for zero new coverage — which is why it was deliberately kept out of Approach A.
- **Context:** Kept tsx scripts in A for consistency (eng review D8 discussion). Right moment: early B, or when suite count doubles.
- **Depends on / blocked by:** CI pipeline existing (blueprint Phase 0 completion).

## 4. `accounts` role: grant CRM write, or not?

- **What:** Decide whether the `accounts` role gains `crm` write; if yes, add it to the seeded matrix and ship an UPDATE migration for the live database.
- **Why:** `accounts` can raise quotations and invoices but cannot create the customer they are for. The customer quick-add button is deliberately hidden from them (eng review 2026-09-10, D5), so they still hit the dead end the feature exists to remove — just without a misleading button.
- **Pros:** One line in the seed plus a migration; makes the permission model match how documents actually get raised.
- **Cons:** Widens write access to the party master that feeds the receivables/payables sub-ledger.
- **Context:** `schema.sql:1193` gives accounts `ARRAY['accounting','invoicing','sales']` — no `crm`. `frontend/src/auth.tsx:72` lets them quote, and `companies.routes.ts:55` requires `crm:write`. **The blocker is a business question, not a technical one: does an accounts person ever serve a new walk-in customer directly?** If yes, grant it. If they only process paperwork someone else originated, leave it as-is.
- **Depends on / blocked by:** Nothing technical. Needs an answer from whoever knows who works the counter.

## 5. Real pagination for the customers (and items) master

- **What:** Replace the hardcoded `LIMIT 500` in `listCompanies` with limit/offset or cursor paging, plus paging controls on the customers screen.
- **Why:** The customers master ships with a "showing the first 500 — use search to narrow" notice (eng review 2026-09-10, D11) rather than paging. Honest, but records past 500 remain reachable only by search.
- **Pros:** Correct at any size; the same pattern serves the items master, which carries the identical cap.
- **Cons:** Speculative until the customer count actually approaches 500; adds API surface that must stay supported.
- **Context:** `companies.service.ts:64` and `items.service.ts:64` both hardcode `ORDER BY name LIMIT 500`. **Trigger to act: the customer count passes ~400, or the CSV import lands a book bigger than that.** Check the row count immediately after the go-live import runs.
- **Depends on / blocked by:** The CSV import script may reveal the real size on day one.
