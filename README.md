# BizSuite

A modular business management suite for a single Indian business — sales,
invoicing, inventory, accounting and CRM in one integrated system, GST-native,
built to the correctness standard of ERPNext and Odoo.

**Scale target:** 1–10 users, single tenant, ~10–50k documents/year.
**Stack:** React SPA · Node.js/Express · TypeScript · PostgreSQL 16.

---

## What it is

One system where a business action ripples correctly through every module. A
submitted invoice, in a single database transaction, locks stock, issues a
gapless document number, posts a balanced sales journal, writes the stock
issues, and posts COGS at valuation. Cancelling it reverses all of that —
nothing is ever deleted.

The document chain follows the ERPNext/Odoo standard:

```
quotation ──► sales order ──► invoice ──► payment
  QTN-2026      SO-2026        INV-2026     (khata / ledger)
              (non-posting)   (posts: GL + stock + COGS)
```

Modules today: `core` (auth, RBAC, numbering, document engine), `crm`
(companies), `sales` (quotations, sales orders), `invoicing` (GST invoices,
payments, khata), `accounting` (chart of accounts, journals, trial balance,
general ledger, financial periods), `inventory` (items, stock ledger,
moving-average valuation).

## Why I'm building it

The books of a small business are the one dataset that cannot be
"approximately right" — and the tools that get it right (ERPNext, Odoo) carry
an operational and customisation cost that a 10-person business running one
developer cannot absorb, while the tools that are easy to run (spreadsheets,
point solutions) don't keep stock, ledger and GST in agreement with each other.

BizSuite is the narrow version: the ERP correctness model, ported honestly, for
exactly one business. Six properties drive every design decision
(`system-design.md §1`):

| Property | Requirement | What it forces |
|---|---|---|
| **Correctness** | Financial and stock data must never be wrong or unverifiable | Append-only ledgers, DB-enforced invariants, derived balances |
| **Integration** | One action ripples correctly across modules | Single database, cross-module work in one transaction |
| **Simplicity** | One developer must operate the whole system | Modular monolith, one deployable, boring stack |
| **Auditability** | Every number traces to a document and a user | Trigger-based audit log, immutable submitted documents |
| **Compliance** | GST-correct invoices, e-invoicing-ready | GST-native schema, IRN fields, GSTR views |
| **Availability** | Business hours; minutes of downtime acceptable | Single node + fast restore beats HA at this scale |

Explicitly **not** goals: horizontal scaling, multi-tenancy, multi-region,
sub-100ms p99. At 10 users, one Postgres instance is idle 99% of the time.

## Architecture in brief

**A strict modular monolith.** One container (Express API + built SPA) against
one PostgreSQL database. Module boundaries are real — each module owns its
tables and is reached only through its service interface, never by cross-module
table access — but they are enforced by review and lint rules, not network
hops, because transactional integrity across modules *is* the product.

```
Browser (React SPA)
      │ HTTPS
Express: helmet → rate-limit → session auth → RBAC(module, action) → zod → route
      │
  crm · sales · invoicing · accounting · inventory     ← service interfaces
      │
  core/  auth · RBAC · document engine · numbering · audit
  shared/ db (node-postgres) · money · errors
      │
PostgreSQL 16 — append-only ledgers · deferred constraint triggers · audit log
```

The load-bearing decisions:

- **The database is the last line of defence.** Deferred constraint triggers
  verify journal balance; a closed financial period blocks any posting dated
  inside it, from any module. Application bugs are inevitable; corrupted books
  are unrecoverable.
- **Append-only, reversal-only.** Corrections create a reversing entry; both
  entries stay posted and net to zero. No UPDATE, no DELETE on a ledger.
- **A generic document engine.** Every document runs the same
  DRAFT → SUBMITTED → CANCELLED lifecycle with `onSubmit`/`onCancel` hooks.
  Drafts are free and editable; numbers are issued at submission, so statutory
  sequences stay gapless.
- **Integer paise everywhere.** No float ever touches money; `NUMERIC` arrives
  from Postgres as a string and is parsed only inside the money utility.
- **Ordered `SELECT … FOR UPDATE`** is the single stock concurrency control
  point — five parallel sales of one unit yield exactly one winner.
- **Raw node-postgres, no ORM** — the invariants live in triggers,
  deferred constraints and `SET LOCAL app.user_id`; hand-written SQL keeps that
  contract explicit.
- **Sessions over JWT, one node over Kubernetes** — at this scale, every
  component you don't run is reliability you don't have to earn.

Full reasoning: `system-design.md`; decisions per-file in [docs/adr/](docs/adr/).

## Repo map

| Path | What's there |
|---|---|
| [src/](src/) | API: `core/`, `shared/`, `modules/{crm,sales,invoicing,accounting,inventory}`, `server.ts` |
| [frontend/](frontend/) | Operator SPA — Odoo-style home launcher + per-app workspaces |
| [packages/contracts/](packages/contracts/) | zod schemas shared by client and server |
| [schema.sql](schema.sql) | Full DDL: constraints, triggers, seed roles & accounts |
| [test/](test/) | Integration suites (real Postgres) + concurrency test |
| [e2e/](e2e/) | Playwright end-to-end journeys against the real SPA + DB |
| [docs/](docs/) | Implementation notes, ADRs, per-phase design/test/release docs |

## Quick start

```bash
createdb bizsuite && psql -d bizsuite -f schema.sql
npm install
PGDATABASE=bizsuite npm run test:integration   # full quote-to-cash
PGDATABASE=bizsuite npm run dev                # API on :3000
npm run dev:web                                # SPA
```

Copy `.env.example` → `.env`: either `DATABASE_URL` (cloud/Neon, keep
`sslmode=require`) or the `PG*` vars (local). Every suite, the deploy shape and
current test status are in
[docs/implementation-notes.md](docs/implementation-notes.md).

## Documentation

| Doc | What it answers |
|---|---|
| [blueprint.md](blueprint.md) | Scope, phases, tracker, risk register — source of truth for *what's next* |
| [system-design.md](system-design.md) | Architecture, critical flows, security, §11 design→built status |
| [docs/implementation-notes.md](docs/implementation-notes.md) | What's built, how to run each suite, test status, deploy |
| [docs/adr/](docs/adr/) | One file per architectural decision |
| [claude.md](claude.md) | Rules Claude Code must follow in this repo |
