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

## Test status (last run, PostgreSQL 16.14)
- integration: **25/25** — moving average, GST totals, balanced journals,
  COGS at valuation, sub-ledger, outstanding view, oversell rollback,
  cancellation reversal, GL-zero + stock-cache integrity, audit attribution
- concurrency: **PASS** — 5 parallel submitters, exactly 1 success,
  losers fail with `INSUFFICIENT_STOCK`, ledgers consistent after
- auth / rbac / masters: **PASS** — login→session→protected-route, wrong
  password + logout revocation; role matrix + 403 guard; masters CRUD with
  duplicate/validation guards and readonly-vs-admin write checks

_All suites run locally today; getting them green in GitHub Actions CI is the
open Phase 0 item._

## Next (per the phased plan)
Phase 0 remainder: git repo + GitHub Actions CI, `.env` convention, `/docs/adr/`
scaffold (write ADR 004 sessions, 005 node-postgres). Phase 1: React app shell +
auth guard, admin user-management (create/deactivate), deploy (Caddy + Docker
Compose + HTTPS), nightly Postgres backup, security hardening (helmet, rate
limiting, CSRF). See `blueprint.md §5` and `system-design.md §11`.
