# BizSuite — Backend Scaffold (Phase 0 + Phase 1 core)

Reference implementation of the modular-monolith design. Companion docs:
`blueprint.md` (scope/phases/tracker), `system-design.md` (architecture; §11 maps
design→built), `schema.sql`.

## What's implemented
- **shared/** — `money.ts` (integer-paise arithmetic, zero floats), `db.ts`
  (node-postgres pool + `withTransaction` that sets `app.user_id` for audit
  triggers), `errors.ts` (Postgres trigger errors → typed app errors)
- **core/** — `numbering.ts` (gapless doc numbers), `document-engine.ts`
  (generic DRAFT→SUBMITTED→CANCELLED lifecycle with onSubmit/onCancel hooks),
  `auth.ts` (argon2id passwords + SHA-256-hashed opaque session tokens, 30-day
  TTL), `middleware.ts` (`requireAuth`, session cookie), `rbac.ts`
  (`requirePermission` guard over the seeded 5-role `role_permissions` matrix)
- **modules/accounting** — `postJournal` (draft→lines→posted, app-level balance
  assert + DB deferred trigger), `reverseJournal` (original stays posted;
  original + reversal net to zero)
- **modules/inventory** — `lockStock` (ordered FOR UPDATE = the concurrency
  control point), `issueStock`, `receiveStock` (moving-average revaluation);
  `items` master (CRUD service + routes: SKU, HSN/SAC, GST rate, reorder level)
- **modules/crm** — `companies` master (CRUD service + routes: customer/supplier,
  GST treatment, GSTIN validation, billing/shipping addresses)
- **modules/invoicing** — GST math (per-line half-up rounding, CGST/SGST vs
  IGST by place of supply, rupee rounding adjustment), `createDraftInvoice`,
  `updateDraftInvoice` (draft-only full replace — the edit-and-retry rail),
  invoice detail endpoint (header + lines + parties, print-ready), and the
  **reference lifecycle**: submit = lock → number → sales journal →
  stock issues → COGS journal in one transaction; cancel = full reversal
- **modules/sales** — the ERPNext/Odoo standard chain
  **quotation → sales order → invoice** (all non-posting until the invoice):
  - `quotations`: `createDraftQuotation`/`updateDraftQuotation`, a no-op
    submit/cancel `quotationLifecycle` (issues `QTN-2026`, freezes lines, touches
    no ledger or stock); grand total is the exact sum (estimate)
  - `sales_orders`: `createDraftSalesOrder`/`updateDraftSalesOrder`,
    `salesOrderLifecycle` (issues `SO-2026`; cancel blocked once invoiced),
    `createSalesOrderFromQuotation` (quote → draft SO, no re-entry) and
    `createInvoiceFromSalesOrder` (SO → draft invoice via `createDraftInvoice`,
    linked by `invoices.sales_order_id`). Rounds to the rupee; **billing status
    is derived** from the submitted invoices raised against the order
  - reuses the invoicing GST math (`computeGst`)
- **frontend/** — operator SPA (staff-usable bar, Bizesuite design system):
  Odoo-style **home launcher** + per-app workspace shell (topbar app switcher,
  per-app hues); khata, payments, opening balances, invoice register, and the
  **guided invoice flow** — new sale → server-computed review → submit →
  print-CSS tax invoice; drafts resume from the register; INSUFFICIENT_STOCK
  surfaces in plain language with edit-and-retry. Plus the **quotation** and
  **sales order** apps — register → guided builder → server-computed review →
  submit → print-CSS document → convert down the chain (quote → order → invoice)
- **server.ts** — Express app: auth routes, masters routes, and the invoice
  lifecycle, all zod-validated and behind `requireAuth` + `requirePermission`

## Run
```bash
createdb bizsuite && psql -d bizsuite -f schema.sql
npm install
PGDATABASE=bizsuite npm run test:integration    # 25 assertions, full quote-to-cash
PGDATABASE=bizsuite npm run test:auth           # login/session/logout over real HTTP
PGDATABASE=bizsuite npm run test:rbac           # role_permissions + route guard
PGDATABASE=bizsuite npm run test:masters        # items & companies CRUD + RBAC
PGDATABASE=bizsuite npm run test:quotations     # quotation lifecycle + convert + RBAC
PGDATABASE=bizsuite npm run test:sales-orders    # sales order lifecycle + billing + RBAC
PGDATABASE=bizsuite npx tsx test/concurrency.ts # 5 parallel sales, 1 unit, 1 winner
PGDATABASE=bizsuite npm run dev                 # API on :3000
```

## Test status (last full run: 2026-07-16, Neon cloud Postgres 18.4)
- integration: **25/25** — moving average, GST totals, balanced journals,
  COGS at valuation, sub-ledger, outstanding view, oversell rollback,
  cancellation reversal, GL-zero + stock-cache integrity, audit attribution
- **khata rail: 35/35** — opening balances (idempotent, 422/403/409 guards),
  on-account + allocated payments (staff-role submit end-to-end per D4),
  partial-payment status, cancel-as-reversal nets to zero, invoice list,
  Friday digest incl. empty-week
- concurrency: **PASS** — 5 parallel submitters, exactly 1 success,
  losers fail with `INSUFFICIENT_STOCK`, ledgers consistent after
- auth 14/14 / rbac 18/18 (regression-updated for the D4 grant) / masters 17/17
- **quotations: 27/27** — non-posting GST math (intra CGST+SGST, no rupee
  rounding), draft edit, QTN numbering on submit, immutable-after-submit,
  quote → draft **sales order** conversion (linked, one-time), admin-only cancel
- **sales-orders: 30/30** — non-posting GST (rounded), draft edit, SO numbering,
  immutable-after-submit, SO → draft invoice link, **derived billing status**
  (Not/Fully Billed from submitted invoices), one-time billing, cancel blocked
  once invoiced, admin-only cancel
- **Playwright E2E 8/8** (`npm run test:e2e`, real SPA + real DB): khata rail
  (golden payment journey, role gating) + invoice rail (guided invoice → server
  totals → submit → khata; insufficient-stock edit-and-retry; admin-only
  cancel; draft resume from the register)

CI: `.github/workflows/ci.yml` runs typecheck + all eight suites against a
Postgres 16 service on every push/PR.

## Environment
Copy `.env.example` → `.env`. Either set `DATABASE_URL` (cloud/Neon, keep
`sslmode=require` in the URL) or the `PG*` vars (local). `.env` is gitignored;
CI sets real env vars and ignores it.

## Next (per the approved design doc + eng review)
T6–T8 and the guided invoice UI are done. Remaining: **CA handshake + monthly
CSV export (T11 — blocks the first real system B2B invoice)**, deploy +
hardening (T12), restore drill week one of real data (T10), admin UI for
users/warehouses. See `blueprint.md §10` and the design doc's GSTACK review
report.
