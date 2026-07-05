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
  and the **reference lifecycle**: submit = lock → number → sales journal →
  stock issues → COGS journal in one transaction; cancel = full reversal
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
PGDATABASE=bizsuite npx tsx test/concurrency.ts # 5 parallel sales, 1 unit, 1 winner
PGDATABASE=bizsuite npm run dev                 # API on :3000
```

## Test status (last full run: 2026-07-04, Neon cloud Postgres 18.4)
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

CI: `.github/workflows/ci.yml` runs typecheck + all six suites against a
Postgres 16 service on every push/PR.

## Environment
Copy `.env.example` → `.env`. Either set `DATABASE_URL` (cloud/Neon, keep
`sslmode=require` in the URL) or the `PG*` vars (local). `.env` is gitignored;
CI sets real env vars and ignores it.

## Next (per the approved design doc + eng review)
Khata rail UI: contracts workspace (T6) → React SPA khata/payment/opening
screens (T7) → Playwright E2E (T8). Then guided invoice UI (weeks 3-6), CA
handshake before first system B2B invoice (T11), deploy + hardening (T12),
restore drill week one of real data (T10). See `blueprint.md §10` and the
design doc's GSTACK review report.
