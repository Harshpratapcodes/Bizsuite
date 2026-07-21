# BizSuite — System Design Document

**Companion documents:** `blueprint.md` (scope, phases & tracker), `schema.sql` (validated database schema), `docs/implementation-notes.md` (scaffold implementation notes)
**Status:** design v1.1 — schema validated against PostgreSQL 16.14 with passing invariant tests; Phase 0 scaffold + Phase 1 auth/RBAC/masters implemented (see §11)
**Scale target:** 1–10 concurrent users, single business, ~10–50k documents/year

---

## 1. Design Goals & Constraints

| Property | Requirement | Consequence in design |
|----------|-------------|----------------------|
| Correctness | Financial and stock data must never be wrong or unverifiable | Append-only ledgers, DB-enforced invariants, derived balances |
| Integration | One action ripples correctly across modules | Single DB, cross-module work inside one transaction |
| Simplicity | One developer must operate the whole system | Modular monolith, one deployable, boring stack |
| Auditability | Every number traces to a document and a user | Trigger-based audit log, immutable submitted documents |
| Compliance | GST-correct invoices; e-invoicing-ready | GST-native schema, IRN fields, GSTR views |
| Availability | Business hours; minutes of downtime acceptable | Single node + fast restore beats complex HA at this scale |

Deliberately **not** goals: horizontal scaling, multi-tenancy, multi-region, sub-100ms p99. At 10 users, a single Postgres on a 2-vCPU VPS is idle 99% of the time.

---

## 2. High-Level Architecture

```
                                   ┌──────────────────────────────┐
                                   │          Users (≤10)         │
                                   │   Browser — React SPA        │
                                   └──────────────┬───────────────┘
                                                  │ HTTPS
                                   ┌──────────────▼───────────────┐
                                   │     Caddy (reverse proxy)    │
                                   │  TLS termination · gzip ·    │
                                   │  static SPA assets           │
                                   └──────────────┬───────────────┘
                                                  │ HTTP (loopback)
┌─────────────────────────────────────────────────▼─────────────────────────────────────┐
│                        Node.js 20 + Express + TypeScript (single process)             │
│                                                                                        │
│  ┌──────────────────────────────  MIDDLEWARE PIPELINE  ─────────────────────────────┐ │
│  │ helmet → rate-limit → session auth → RBAC(module, action) → zod validate → route │ │
│  └───────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                        │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌─────────────┐ ┌────────────┐          │
│  │   crm/     │ │   sales/   │ │ invoicing/ │ │ accounting/ │ │ inventory/ │          │
│  │ contacts   │ │ quotations │ │ invoices   │ │ CoA         │ │ items      │          │
│  │ deals      │ │ conversion │ │ credit nts │ │ journal eng │ │ stock lgr  │          │
│  │ activities │ │            │ │ payments   │ │ reports     │ │ valuation  │          │
│  └─────┬──────┘ └─────┬──────┘ └─────┬──────┘ └──────┬──────┘ └─────┬──────┘          │
│        │   public service interfaces + in-process domain event bus  │                 │
│  ┌─────┴─────────────┴──────────────┴───────────────┴──────────────┴──────┐          │
│  │  core/: auth · RBAC · document engine · numbering · audit · settings   │          │
│  │  shared/: db (node-postgres) · money · pdf (Chromium) · zod · logger   │          │
│  └─────────────────────────────────────┬───────────────────────────────────┘          │
│                                        │                                              │
│  ┌──────────────┐                      │                                              │
│  │ pg-boss jobs │ nightly integrity ·  │                                              │
│  │ (in-process) │ backups · reminders  │                                              │
│  └──────┬───────┘                      │                                              │
└─────────┼──────────────────────────────┼──────────────────────────────────────────────┘
          │                              │
┌─────────▼──────────────────────────────▼─────────┐      ┌───────────────────────────┐
│              PostgreSQL 16 (single DB)            │      │  Object storage (R2/S3)   │
│  append-only ledgers · deferred constraint        │─────►│  nightly pg_dump ·        │
│  triggers · audit log · pg-boss queue tables      │      │  generated PDFs (archive) │
└───────────────────────────────────────────────────┘      └───────────────────────────┘
```

**Everything is one deployable unit** (one container image + one Postgres). The internal module boundaries are enforced by code review and lint rules (no cross-module table imports), not by network boundaries.

---

## 3. Component Design

### 3.1 Frontend (React SPA)

A single-page app with an "app shell + module routes" layout, mirroring the backend modules: `/crm/*`, `/sales/*`, `/invoicing/*`, `/accounting/*`, `/inventory/*`, plus `/settings`. Server state lives in TanStack Query (cache keys per resource, invalidated on mutations); client state is minimal (UI preferences). Forms are zod-validated with the **same schema objects** the API uses (shared `packages/contracts`), so client and server can never disagree about shapes. Money is handled as strings end-to-end (`"1234.50"`), parsed only inside the money utility — never `parseFloat`.

### 3.2 API layer

REST, JSON, predictable conventions:

```
GET    /api/invoicing/invoices?status=submitted&customer=...&page=...
POST   /api/invoicing/invoices                 (create draft)
PATCH  /api/invoicing/invoices/:id             (edit draft only)
POST   /api/invoicing/invoices/:id/submit      (lifecycle transitions are POSTs,
POST   /api/invoicing/invoices/:id/cancel       not PATCHes — they are commands)
GET    /api/invoicing/invoices/:id/pdf
POST   /api/sales/quotations/:id/convert-to-invoice
GET    /api/accounting/reports/trial-balance?as_of=...
```

Errors are structured: `{ error: { code: "INSUFFICIENT_STOCK", message, details } }`, with Postgres error codes (`P0003` etc., raised by our triggers) mapped to typed application errors.

### 3.3 The document engine (core/)

One generic implementation of the lifecycle used by every transactional document:

```
            ┌────────┐  submit(tx)   ┌───────────┐   cancel(tx)   ┌───────────┐
  create →  │ DRAFT  │ ────────────► │ SUBMITTED │ ─────────────► │ CANCELLED │
            └────────┘               └───────────┘                └───────────┘
             editable                immutable (DB-enforced)      immutable
                                     number issued here           reversals posted here
```

`submit()` and `cancel()` are template methods: the engine handles numbering, status transition, timestamps, and audit; each document type plugs in its `onSubmit(tx)` / `onCancel(tx)` hooks (post journals, write stock entries, post reversals). The database is the second line of defense: even if application code is buggy, the triggers in `schema.sql` reject unbalanced journals, mutations of posted records, and negative stock.

### 3.4 Module communication: two channels, two purposes

**Channel 1 — synchronous service calls inside a transaction (for invariants).** When invoice submission needs accounting and inventory, it calls their exported services with the shared transaction handle:

```ts
// invoicing/invoice-service.ts (simplified)
await db.transaction(async (tx) => {
  await tx.execute(sql`SET LOCAL app.user_id = ${userId}`);
  await inventoryService.lockStock(tx, stockLines);          // FOR UPDATE, ordered
  const docNo = await numbering.next(tx, 'INV-2026');
  const je    = await accountingService.postJournal(tx, salesEntryLines);
  await inventoryService.issueStock(tx, stockLines);         // SLE rows
  await accountingService.postJournal(tx, cogsEntryLines);
  await tx.update(invoices).set({ status: 'submitted', docNo, journalEntryId: je.id })...
});  // deferred triggers verify balance at COMMIT
```

**Channel 2 — in-process domain events after commit (for conveniences).** `invoice.submitted`, `deal.stage_changed`, `stock.below_reorder_level` → listeners create activity-timeline rows, send notifications, advance deal stages. Events fire **after** the transaction commits (outbox-light: events queued in memory per-tx, flushed on commit) so listeners never see uncommitted state. A failed listener logs an error; it can never corrupt books.

### 3.5 Background jobs (pg-boss)

Postgres-backed queue — no Redis, jobs survive restarts, and job state is included in DB backups. Scheduled jobs: nightly `fn_verify_gl()` + `fn_verify_stock_cache()` (alert on failure), nightly `pg_dump` → object storage, daily reorder-level digest, weekly receivables-aging email, session cleanup. One-off jobs: PDF generation for bulk exports, future IRP (e-invoicing) submission with retry.

### 3.6 PDF generation

Invoice/quotation HTML templates (same React-rendered HTML aesthetic, server-side) rendered by a pooled headless Chromium instance. Generated PDFs for **submitted** documents are archived to object storage keyed by `doc_no` — the rendered artifact the customer received is preserved even if templates change later.

---

## 4. Data Design (summary — full DDL in schema.sql)

The schema has four layers:

1. **Core platform:** `users`, `roles`, `role_permissions`, `sessions`, `company_settings`, `document_sequences`, `audit_log` (append-only, trigger-fed; actor read from `SET LOCAL app.user_id`).
2. **Masters:** `companies` (customer+supplier in one party table), `contacts`, `items`, `warehouses`, `accounts` (tree with group/leaf semantics, system accounts wired by `system_key`).
3. **Documents:** `quotations`, `invoices` (+ `credit_note` kind), `payment_entries` + `payment_allocations`, `purchase_receipts`, `stock_adjustments`, `journal_entries` — all carrying the shared lifecycle columns and immutability triggers.
4. **Ledgers (append-only):** `journal_lines` (frozen once entry leaves draft) and `stock_ledger_entries` (UPDATE/DELETE forbidden by trigger), plus `item_warehouse` as a trigger-maintained, nightly-verified cache and lock anchor.

Key DB-enforced invariants (all validated by live tests):

| Invariant | Mechanism |
|---|---|
| Every posted journal entry balances, ≥2 lines | `DEFERRABLE INITIALLY DEFERRED` constraint trigger at COMMIT |
| Posted/cancelled records immutable | BEFORE UPDATE/DELETE triggers with column-whitelist diffing (`to_jsonb(OLD) - guard = to_jsonb(NEW) - guard`) |
| No posting to group accounts | BEFORE trigger on `journal_lines` |
| CGST+SGST xor IGST per document | CHECK constraint (`tax_split_consistent`) |
| No negative stock (configurable) | BEFORE INSERT trigger on stock ledger, reads `company_settings` |
| Stock arithmetic correct & cache in sync | Same trigger verifies `prev + change = qty_after`, then updates cache |
| Gapless, race-free document numbers | `UPDATE … RETURNING` on `document_sequences` (row lock serializes) |
| Submitted invoice is always booked | CHECK `submitted_is_booked` (journal_entry_id NOT NULL) |

Balances are **views**: `v_account_balances`, `v_party_balances`, `v_invoice_outstanding`, `v_receivables_aging`, `v_stock_on_hand`, `v_gst_sales_register`. At this data volume (≤ a few hundred thousand ledger rows over years), live aggregation with the defined indexes is single-digit milliseconds; no materialization needed.

---

## 5. Critical Flows (sequence detail)

### 5.1 Invoice submission — the most important transaction in the system

```
Client                API (invoicing)        inventory svc      accounting svc       PostgreSQL
  │ POST /invoices/:id/submit │                    │                  │                  │
  │──────────────────────────►│                    │                  │                  │
  │                           │ RBAC: can_submit('invoicing')?        │                  │
  │                           │ load draft + lines; recompute & assert totals            │
  │                           │ BEGIN ─────────────────────────────────────────────────► │
  │                           │ SET LOCAL app.user_id = <actor>                          │
  │                           │───lockStock(lines)►│ SELECT item_warehouse FOR UPDATE    │
  │                           │                    │ (ORDER BY item_id — deadlock-safe)  │
  │                           │ next_doc_number('INV-2026')  ──────── row-locked UPDATE ►│
  │                           │───────────────────────────────────────►postJournal(sales)│
  │                           │                    │                  │ draft → lines →  │
  │                           │                    │                  │ status='posted'  │
  │                           │───issueStock(lines)► SLE inserts (trigger: arithmetic,   │
  │                           │                    │  negative-stock guard, cache sync)  │
  │                           │───────────────────────────────────────►postJournal(COGS) │
  │                           │ UPDATE invoices SET status='submitted', doc_no, je_id    │
  │                           │ COMMIT ── deferred triggers: both journals balanced ───► │
  │                           │ emit('invoice.submitted') → timeline, notify, deal stage │
  │ ◄── 200 {doc_no, pdf_url} │                    │                  │                  │
```

Failure at any step rolls back **everything** — there is no state in which an invoice exists without its journal entry and stock movements. The two simultaneous-last-unit sales serialize on the `item_warehouse` row lock; the loser receives `INSUFFICIENT_STOCK` (`P0003`) cleanly.

### 5.2 Invoice cancellation (reversal, never deletion)

One transaction: post a reversing journal entry (`reverses_id` → original), insert opposite-sign stock ledger entries (stock returns at the issued valuation), set invoice `status='cancelled'` via the trigger-whitelisted transition. History remains complete; GSTR reports see the cancellation.

### 5.3 Payment receipt

Draft payment with allocations against open invoices (deferred trigger caps allocations ≤ amount) → submit posts `Dr Bank/Cash, Cr Debtors[party]` → `v_invoice_outstanding` flips invoices to paid/partially_paid automatically because it is derived.

### 5.4 Quotation → invoice conversion

Copy header + lines into a draft invoice, link both ways (`quotation.converted_invoice_id`, allowed post-submission via trigger whitelist; `invoice.quotation_id`). No financial effect until the invoice itself is submitted.

### 5.5 Purchase receipt (stock in + moving average)

Lock `item_warehouse` rows → for each line compute
`new_rate = (qty_on_hand·rate + in_qty·in_rate) / (qty_on_hand + in_qty)` →
insert SLE receipt rows → post `Dr Stock in Hand / Cr Stock Received Not Billed (or Creditors)` → submit document. The Stock-in-Hand GL balance and the stock ledger value move in lockstep — and the nightly job proves it.

---

## 6. Security Model

**Authentication (implemented):** email + argon2id password (OWASP baseline: 19 MiB, t=2, p=1); a 256-bit random session token is returned in an `httpOnly; SameSite=Lax` cookie (`Secure` in production) — only its SHA-256 hash is stored as `sessions.id`, so a DB leak never yields live tokens. 30-day expiry; the `sessions` table allows instant revocation on logout. No JWTs — first-party app, revocability matters more than statelessness (ADR 004, Accepted).

**Authorization (implemented):** every route declares `(module, action)`; the `requirePermission` guard checks the role's `role_permissions` row after `requireAuth`. Action granularity is the document lifecycle itself: `read / write(draft) / submit / cancel`, mapped to the `can_read/can_write/can_submit/can_cancel` columns via a fixed whitelist (the action never reaches SQL as free text). The schema seeds five roles — `admin`, `accounts`, `sales`, `inventory`, `readonly` — with a per-module permission matrix; cancellation of financial documents is `admin`-only. Defense in depth: even a code-path that bypasses middleware cannot violate immutability or balance — the database refuses.

**Input & transport:** zod on every body/param/query; parameterized queries only (node-postgres — no string interpolation of user input); helmet headers, rate limiting (strict on `/auth/*`), and CSRF tokens for state-changing requests are wired during Phase 1/6 hardening; TLS via Caddy with HSTS.

**Auditability:** `SET LOCAL app.user_id` per transaction feeds trigger-written `audit_log` (itself append-only). Combined with immutable documents and append-only ledgers: every figure on every report is reconstructible — who created it, who posted it, what it changed.

---

## 7. Reliability, Operations & Observability

**Deployment topology:** one VPS (2 vCPU / 4 GB), Docker Compose: `caddy` + `app` + `postgres` (+ `postgres-backup` sidecar). Staging = same compose file on a second box (or Railway environment) with anonymized fixtures.

**Deploy procedure:** build image → `pg_dump` safety snapshot → run SQL migrations (forward-only) → swap container. Total downtime: seconds; acceptable per requirements.

**Backups & recovery:** nightly `pg_dump -Fc` to object storage (30-day retention) + the pre-migration snapshots; archived invoice PDFs in object storage. **Monthly restore drill** into staging is a calendar event, not an aspiration. RPO ≤ 24h (acceptable for v1; WAL archiving with `wal-g` is the documented upgrade path to RPO ≈ minutes), RTO ≤ 1h (provision VM, compose up, restore dump).

**Monitoring:** `/healthz` (DB round-trip) polled by an external uptime monitor; pino JSON logs shipped to the host journal with logrotate; pg-boss job failures and integrity-check failures send email/Telegram alerts. The two integrity functions are the system's heartbeat: **a green nightly check is the operational definition of "the books are right."**

**Capacity sanity check:** 10 users × generous 50 documents/day ≈ 18k docs/year ≈ ~150k journal/stock rows/year. Postgres handles this in RAM. The design's headroom (indexes, derived views) is ~100× current load before any optimization conversation is warranted.

---

## 8. Testing Strategy

| Layer | Tooling | What it proves |
|---|---|---|
| Money/tax/valuation unit tests | Vitest | GST splits, per-line rounding, moving-average math, rupee rounding — exhaustive cases |
| DB invariant tests | Vitest + test DB running `schema.sql` | The trigger suite (the tests run in this design session are the seed of this suite: unbalanced-rejection, immutability, negative stock, arithmetic guard, append-only, cancellation whitelist) |
| API integration | Supertest | Every lifecycle transition incl. failure paths; RBAC denials |
| Concurrency | Vitest, parallel txns | N parallel sales of the last unit → exactly 1 success |
| E2E | Playwright | Deal → quotation → invoice → payment happy path; PDF renders |

---

## 9. Evolution Paths (designed-for, not built)

- **E-invoicing (IRP):** invoice schema already carries `irn/irn_ack_no/irn_ack_date/signed_qr` (post-submission writable via trigger whitelist); add a pg-boss job that builds the GST JSON, calls the IRP, retries, and persists the signed payload.
- **Purchase invoices / payables:** `companies.is_supplier`, `Creditors`, and `Stock Received Not Billed` accounts are already in place; the payables document mirrors the receivables design.
- **FIFO valuation:** stock ledger already stores `incoming_rate` per receipt; FIFO is an alternative valuation strategy over the same ledger.
- **Module extraction:** if a module ever needs independent scaling, its service interface is the seam — swap in-process calls for RPC, replace shared transactions with sagas. At the stated scale this is intentionally deferred forever.
- **Multi-company:** add `company_id` to documents/ledgers + composite indexes; the single-row `company_settings` becomes a table.

---

## 10. Design Decisions Record (condensed ADRs)

1. **Modular monolith over microservices** — transactional integrity across modules is the product's core value; a network boundary would turn an ACID guarantee into a distributed-systems project. (Pattern proven by Odoo and Frappe/ERPNext.)
2. **Database-enforced invariants over application-only checks** — application bugs are inevitable; corrupted books are unrecoverable. Triggers are the last line of defense and were validated live.
3. **Append-only ledgers, derived balances** — auditability and correctness over micro-optimizations that this scale will never need.
4. **Numbers issued at submission** — drafts are free; statutory sequences stay gapless and ordered.
5. **Sessions over JWT, pg-boss over Redis, one VPS over Kubernetes** — at 10 users, every component you don't run is reliability you don't have to earn. (Session-vs-JWT decision recorded as ADR 004, Accepted.)
6. **Raw node-postgres over an ORM** — the invariants live in the database (triggers, deferred constraints, `SET LOCAL app.user_id`) and the money contract depends on `NUMERIC` arriving as a string; hand-written parameterized SQL keeps that contract explicit rather than hiding it behind an ORM abstraction. (Supersedes the earlier Drizzle sketch.)

---

## 11. Implementation Status (design → built)

Tracks how much of this design exists in code. Authoritative phase tracker is `blueprint.md §5`; this table maps design sections to their build state.

| Design area | § | Status | Notes |
|---|---|---|---|
| PostgreSQL schema + invariant triggers | 4 | ✅ Built & validated | `schema.sql`, 25-assertion suite + concurrency test green on PG 16.14 |
| `shared/` money · db-transaction · typed errors | 3 | ✅ Built | integer-paise money, `withTransaction` sets `app.user_id`, PG error → `AppError` mapping |
| `core/` numbering · document engine | 3.3 | ✅ Built | gapless numbering; generic DRAFT→SUBMITTED→CANCELLED with onSubmit/onCancel hooks |
| accounting `postJournal` / `reverseJournal` | 3.4, 5.2 | ✅ Built | app-level balance assert + DB deferred trigger; reversals net to zero |
| inventory `lockStock` / `issueStock` / `receiveStock` | 5.1, 5.5 | ✅ Built | ordered `FOR UPDATE`; moving-average revaluation |
| invoicing GST math + submit/cancel lifecycle | 5.1 | ✅ Built | per-line half-up rounding, CGST/SGST vs IGST, rupee rounding; full quote-to-cash txn |
| Authentication (argon2id + sessions) | 6 | ✅ Built | `core/auth.ts`, `core/middleware.ts`; auth integration test |
| Authorization (RBAC guard + role matrix) | 6 | ✅ Built | `core/rbac.ts`; RBAC test; 5 seeded roles |
| Masters: items, companies (customer/supplier) | 4 | ✅ Built | CRUD + validation over HTTP; masters test |
| Express API + structured error envelope | 3.2 | ◐ Partial | invoice lifecycle, auth, masters routes live; other module routes pending per phase |
| React SPA + shared `contracts` package | 3.1 | 🔲 Not started | Phase 1 (app shell) onward |
| PDF generation (headless Chromium) | 3.6 | 🔲 Not started | Phase 4 |
| Domain event bus (post-commit) | 3.4 | 🔲 Not started | design intent; not yet wired |
| pg-boss background jobs | 3.5 | 🔲 Not started | Phase 6 (integrity checks, backups) |
| Deploy topology: Caddy + Docker Compose + HTTPS | 7 | 🔲 Not started | Phase 1 deploy task |
| Backups / restore drill / monitoring | 7 | 🔲 Not started | Phase 1 (backups) / Phase 6 (drill, alerting) |

Legend: ✅ built · ◐ partial · 🔲 not started.
