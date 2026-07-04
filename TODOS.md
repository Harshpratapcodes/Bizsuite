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
