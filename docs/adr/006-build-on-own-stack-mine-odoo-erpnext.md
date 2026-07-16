# ADR 006 — Build on our own stack; mine Odoo & ERPNext as references, don't rebase onto them

**Status:** Accepted
**Date:** 2026-07-16

## Context

The product vision is an Odoo-style suite: multiple apps (accounting, inventory,
CRM, invoicing, …) over one single source of truth. Odoo itself is partially
open source, which raised the question: fork/adopt Odoo instead of continuing
bizsuite?

Facts that drove the decision:

- **Odoo Community** is LGPL-3 (Python + PostgreSQL). But it is dual-edition:
  the full **Accounting app, Documents, Helpdesk, Planning, Field Service,
  Sign, Studio, Subscriptions** are **Enterprise (proprietary)**. Community has
  the double-entry engine + Invoicing; the accounting workspace (bank rec,
  financial reports, assets) is paywalled. India GST localization (`l10n_in`)
  is in Community.
- **ERPNext** is GPL-3 with no paid split (full accounting included, GST-first,
  huge Indian install base) but runs on Frappe/Python/MariaDB.
- Rebasing onto either discards a validated TS/Postgres scaffold (109 green
  assertions, concurrency-safe stock, append-only ledgers, integer paise) and
  forces a full stack switch plus a yearly upgrade treadmill.
- The blueprint targets **one Indian business, 1–10 users** — not the full
  24-app grid. The money path the business needs is already largely built.
- bizsuite already has Odoo's core architecture: strict modular monolith,
  single Postgres as source of truth, cross-module writes in one transaction,
  generic document lifecycle engine.

## Decision

Keep building bizsuite on the existing React/Node/TypeScript/PostgreSQL stack.
Use Odoo Community and ERPNext as **read-only reference implementations**:
when designing each new module, study their data models, document flows, and
edge-case handling first, then implement our own version under our invariants.

Shallow reference clones live **outside the repo** at
`../bizsuite-refs/odoo` (branch 19.0) and `../bizsuite-refs/erpnext`
(branch version-15). See `claude.md` §Reference codebases for the file map.

**Licensing rule:** never copy code verbatim from either codebase into
bizsuite (LGPL-3/GPL-3 would attach to derived code). Port concepts, schemas,
and workflows; write original implementations. Schema shapes and ideas are
fine; copied expression is not.

## Consequences

- (+) Momentum, test suite, and Postgres-level invariants are preserved; the
  khata-first UX stays the product's edge.
- (+) Each new module starts from battle-tested designs (20 years of Odoo edge
  cases, ERPNext's India-specific flows) instead of a blank page.
- (−) Every app beyond the money path must still be built by hand. If the
  business comes to need the long tail (POS, website, HR, helpdesk) on a
  deadline, revisit this decision — the fallback is deploying Odoo
  Community/ERPNext alongside and integrating, not rewriting bizsuite.
- Reference clones are ~1 GB on disk and are never committed, imported, or
  built against.
