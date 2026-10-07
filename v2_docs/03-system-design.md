# 03: System Design

Design IDs `D-xx`. DDL lives in `04-schema-deltas.md`; per-type extraction detail in `05-extraction-spec.md`.

## 1. Principles

- **D-01 The LLM proposes; the engine posts.** Language models produce typed proposals. Deterministic validators check them. The existing v1 service layer, inside `withTransaction`, is the only code that writes business records, and the v1 triggers (balance, immutability, period lock) remain the last line of defence. There is no code path from a model output to a `journal_entries` row that does not pass through a validator, a confirmation, and a service function.
- **D-02 One lifecycle for everything.** Quotation from a sentence, purchase bill from a photo, bank match from a statement: all are `Proposal → Confirmation → Posting`. Build the lifecycle once (V2-0), then add proposal types.
- **D-03 Provenance is a column, not a log.** Every posted record carries `proposal_id`; every proposal carries `document_id` (nullable) and `llm_call_ids`; every confirmation records edited fields. Rule 56(8) satisfied by design (`C-03`).
- **D-04 Deterministic where possible, model where necessary.** Arithmetic, tax split, GSTIN checks, duplicate detection, rate lookup, place of supply, number allocation, question selection: code. Reading a photo, naming an item, phrasing a question, parsing a free-text answer: model.
- **D-05 Stage isolation.** The ingestion pipeline is a sequence of idempotent stages with persisted state per document (the NSE pipeline pattern). Any stage can be re-run for one document without touching the others.
- **D-06 One container, one database, one queue.** Node/Express/TS on Render, PostgreSQL on Neon, pg-boss for jobs, S3-compatible object storage for files. No Redis, no second service, no Python sidecar in v1.
- **D-07 Everything measurable.** Every LLM call logs model, tokens, cost, latency, prompt version, and outcome. Every proposal logs whether it was confirmed unedited, edited, or rejected. These two tables drive the eval harness and the auto-post unlock rule (`P-12`).

## 2. Architecture

```
 phone (PWA)                                    admin laptop
   │ camera / Ask / Inbox / money view              │ config / corrections / evals
   ▼                                                ▼
 ┌──────────────────────────── Express API (one container) ────────────────────────────┐
 │  auth (sessions)   rbac (owner|admin)   contracts (zod, shared with SPA)             │
 │                                                                                      │
 │  ┌── agent ──────────────┐   ┌── ingestion ───────────────┐   ┌── proposals ──────┐  │
 │  │ Ask: NL → plan → tools│   │ upload → hash → store →    │   │ store, version,   │  │
 │  │ tool registry from    │──▶│ convert → gate → classify →│──▶│ validate, confirm │  │
 │  │ contracts; read tools │   │ extract → resolve → validate│  │ → post via service│  │
 │  │ free, write tools →   │   │ → propose                  │   │                   │  │
 │  │ proposals only        │   └────────────────────────────┘   └─────────┬─────────┘  │
 │  └───────────┬───────────┘                                              │            │
 │              │           ┌── clarifications ──┐   ┌── compliance ───┐    │            │
 │              │           │ templates, state,  │   │ GSTR-1 JSON, 2B │    │            │
 │              │           │ digest, follow-ups │   │ import + IMS    │    ▼            │
 │              │           └────────────────────┘   │ list, registers │  ┌──────────┐  │
 │              ▼                                    │ close package   │  │ v1 engine│  │
 │   ┌── llm gateway ──┐  ┌── banking ──┐            └─────────────────┘  │ crm sales│  │
 │   │ OpenRouter,     │  │ statement   │  ┌── service (CRM+) ──┐         │ invoicing│  │
 │   │ routing, schema,│  │ import,     │  │ units, AMC, tickets│         │ accounts │  │
 │   │ repair, cost log│  │ matching    │  └────────────────────┘         │ inventory│  │
 │   └─────────────────┘  └─────────────┘                                 │ khata    │  │
 │                                                                        └──────────┘  │
 │   jobs: pg-boss (digest, close, retries, cleanup)    pdf: headless Chromium           │
 └──────────────────────────────────────────────────────────────────────────────────────┘
          │                                  │                              │
      PostgreSQL 16 (Neon)          S3-compatible object storage       OpenRouter
```

## 3. Modules

The v1 modular-monolith rule holds: a module owns its tables and exposes service interfaces; cross-module work runs in one transaction; no cross-module table access.

| Module | Status | Owns |
|---|---|---|
| `core` | kept, simplified | users (roles `owner`, `admin`), sessions, audit plumbing, config (`C-14`), business profile |
| `crm` | extended | companies (customers/suppliers), contacts, addresses; new: `installed_units`, `amc_contracts`, `service_tickets` |
| `sales` | kept | quotations, sales orders |
| `invoicing` | extended | invoices, payments; new: `delivery_challans`, `credit_notes`, `debit_notes`, `receipt_vouchers`; new columns for IRN and e-way bill |
| `accounting` | extended | accounts, journals, periods, reports; new: `gst_rate_schedule`, `hsn_codes`, tax ledgers (output, ITC, RCM) as views over posted lines |
| `inventory` | kept | items, warehouses, stock moves; new movement types (`C-05`) |
| `purchases` | new | `purchase_bills`, `purchase_bill_lines`, `expenses`, payables, ITC eligibility, RCM |
| `banking` | new | `bank_accounts`, `bank_statement_imports`, `bank_lines`, `bank_matches` |
| `documents` | new | `documents` (files), `document_pages`, storage adapter, hashing, dedup |
| `extraction` | new | `extraction_runs`, stage state, quality gate, classifiers, extractors |
| `proposals` | new | `proposals`, `proposal_versions`, `proposal_issues`, `confirmations`; the lifecycle |
| `agent` | new | `conversations`, `messages`, `tool_calls`, tool registry, planner |
| `clarifications` | new | `clarifications`, `clarification_answers`, `digests` |
| `compliance` | new | `gstr1_exports`, `gstr2b_imports`, `gstr2b_entries`, `reconciliations`, close packages |
| `llm` | new | `llm_calls`, `prompts` (versioned), gateway, routing, budget |
| `notifications` | new | web push subscriptions, deliveries |

Dropped from the v1 roadmap: the CRM leads/pipeline kanban (replaced by the service module), the unified Odoo-style Sales app, the admin user-management UI beyond two roles, per-module RBAC screens.

## 4. The proposal lifecycle (D-10 to D-18)

- **D-10 Proposal**: `{ id, type, business_id, document_id?, conversation_id?, status, current_version, created_by, created_via }`. Types in v1: `quotation`, `sales_order`, `invoice`, `delivery_challan`, `credit_note`, `debit_note`, `receipt`, `purchase_bill`, `expense`, `bank_match_batch`, `service_ticket`, `party_upsert`, `item_upsert`. Each type's payload is the exact `Create…` contract from `@bizsuite/contracts` (the same zod object the v1 UI and routes validate with), plus per-field confidence and provenance.
- **D-11 Versions are immutable.** Every edit (by the model on retry, by a clarification answer, by the owner on the confirm screen) creates a new `proposal_versions` row. The confirmation names the version it approved.
- **D-12 Status machine**: `draft → needs_input → ready → confirmed → posted`, with `rejected` and `superseded` as terminal side exits and `failed` for a posting error (which never leaves partial state because posting is one transaction). `needs_input` means at least one blocking issue or open clarification; `ready` means zero blocking issues.
- **D-13 Validation runs on every version** and produces `proposal_issues`: `{ code, severity: block|warn|info, field_path, message, suggested_clarification_template }`. Severity `block` prevents `ready`. The validator catalogue is §7.
- **D-14 Confirmation** is a POST by an authenticated owner/admin naming the version. It records the diff between the last model-produced version and the confirmed version (the "edited fields" signal for `P-12`), then calls the type's posting function.
- **D-15 Posting function** = the v1 service (`createDraftQuotation` + `quotationLifecycle.submit`, `postPurchaseBill`, `postBankMatches`, …) called with the confirmed payload inside `withTransaction`, with `app.user_id` set for audit and `proposal_id` written on the resulting record(s). Number allocation happens here, never earlier.
- **D-16 Undo** for 24 hours calls the type's reversal function (existing for journals and invoices; new for bills, expenses, matches) and marks the proposal `reversed`. Outbound documents that were already sent show a warning that the counterparty holds a copy.
- **D-17 Auto-post** (`P-12`): a per-type flag in config; when on, a `ready` version with no `warn` issues is confirmed by the system actor after a configurable delay and appears in the digest as "posted automatically, tap to review". Outbound types cannot be set.
- **D-18 Idempotency**: proposals from documents are keyed on `(document_id, type)`; re-running extraction supersedes the previous version rather than creating a second proposal. Confirmation is idempotent on `(proposal_id, version)`.

## 5. The agent layer

### 5.1 Ask (command agent)
- **D-20 Tool registry generated from contracts.** Every service function exposed to the agent is registered as `{ name, description, input: zodSchema, kind: read|propose }`. Read tools (`searchCustomers`, `getItem`, `listOpenInvoices`, `getStock`, `getQuotation`) execute immediately and return data. Propose tools (`proposeQuotation`, `proposeInvoice`, `proposeReceipt`, `proposeServiceTicket`, …) create a proposal and return its id. There is no `post*` tool. The JSON schema the model sees is derived from the same zod object the route validates with, so the model cannot construct a payload the API would reject.
- **D-21 Loop**: user message → planner call (model, with tool definitions and a compact business context: state code, filing profile, today's date, open proposals) → up to N tool calls (config, default 8) → a final message that references the proposal id(s). The SPA renders proposals inline with a Confirm button; the model never claims something was posted.
- **D-22 Entity resolution before proposing**: the planner must call read tools to resolve party and items by id; a `propose*` tool call with unresolved names is rejected by the registry with an error the model sees, and the registry offers `proposePartyUpsert` / `proposeItemUpsert` for genuinely new entities (which become sub-proposals of the main one, confirmed together).
- **D-23 Conversation state** persists per business with a rolling window; the model receives the last K turns plus the summary of older ones. Voice input is a later feature; the input box is text in v1.
- **D-24 Guardrails in code**: max tool calls, max tokens, a denylist of tools per role, a rule that a proposal's totals are always recomputed server-side from lines (the model's totals are ignored), and a rule that dates default to today and cannot be in a closed period.

### 5.2 Ingestion (document agent)
The pipeline in §6 produces proposals without a conversation. The owner's only interaction is the confirm screen and clarifications. A document can also be attached to an Ask message ("this is the bill for the Sharma job") which links the resulting proposal to the conversation and lets the model use the message as a hint.

## 6. Extraction pipeline (D-30 to D-38)

Stages, each persisted in `extraction_runs.stage_state`, each idempotent and re-runnable for one document:

- **D-30 ingest**: multipart or resumable upload from the PWA; compute SHA-256; if a document with the same hash exists, link and stop (dedup); store under `business/{id}/documents/{yyyy}/{mm}/{hash}.{ext}`; create `documents` row with mime, size, source (`upload|ask|email-later`).
- **D-31 convert**: PDFs → per-page PNG at 150 dpi plus the text layer via `pdfjs-dist` and `@napi-rs/canvas`; images → normalised (EXIF rotation, max 2,000 px long side, JPEG q85). Store pages under the document; record page count. Multi-page statements keep page order.
- **D-32 quality gate**: for PDFs with a text layer, score real-word ratio and numeric density per page; pages scoring `CLEAN` can be extracted from text (cheaper); `DEGRADED` or image-only pages go to the vision model. Photos always go to vision. The gate is the cost lever.
- **D-33 classify**: one cheap model call per document (first page image or text) returning `{ doc_type, confidence, language, page_roles }`. Types: `purchase_bill`, `expense_receipt`, `bank_statement`, `transport_bilty`, `our_invoice` (a copy of something we issued), `our_quotation` (imported history), `delivery_challan_in`, `credit_note_in`, `unknown`. Below a confidence threshold, a clarification asks the owner to pick the type.
- **D-34 extract**: one structured-output call per document (or per page for statements, then merged) with the type's prompt and JSON schema derived from the type's zod extraction schema (`05-extraction-spec.md`). Output goes through `json-repair`, then zod. On zod failure, one retry with the errors appended. Per-field confidence is requested in the schema; page number per field is required for anything monetary.
- **D-35 resolve**: parties by GSTIN exact match, then normalised-name fuzzy match above a threshold, else `party_upsert` sub-proposal; items by SKU, then by normalised description against the item master and the owner's confirmed history (a small vector index over item names is optional; start with trigram similarity in Postgres); HSN from the item, else from the bill, else from an HSN lookup table; rate from the schedule by document date.
- **D-36 validate**: the catalogue in §7; produces issues and proposed clarifications.
- **D-37 propose**: create or supersede the proposal version; notify the Inbox; if `ready`, push "1 bill ready to confirm".
- **D-38 audit**: per-document report (stages, timings, model calls, issues) viewable by admin; the extraction eval reads the same tables.

## 7. Validator catalogue (D-40)

Deterministic, ordered, each returning issues. Implemented as pure functions over a proposal payload plus a read-only context (parties, items, rate schedule, config, period state).

| Code | Check | Severity |
|---|---|---|
| ARITH_LINE | qty × rate − discount = taxable, per line, to the paisa | block |
| ARITH_TAX | tax = taxable × rate, split per `C-16`, tolerance ±1 paisa per line | block |
| ARITH_TOTAL | sum of lines + round-off = grand total on the document | block |
| GSTIN_FORMAT | 15 chars, state prefix, PAN in positions 3 to 12, checksum | block |
| GSTIN_STATE | state code on the party equals GSTIN prefix | block |
| POS_SPLIT | CGST+SGST iff supplier state = place of supply, else IGST | block |
| RATE_SCHEDULE | line rate exists in the schedule for the HSN on the document date | warn (block for outbound) |
| HSN_DIGITS | outbound B2B lines carry ≥ configured digits | block (outbound) |
| DUP_DOC | same content hash, or same (supplier, bill number, FY) | block |
| PERIOD_OPEN | document date in an open period | block |
| DATE_SANITY | not in the future; not older than config (e-way 180-day rule warns) | warn |
| PARTY_RESOLVED | party id present, or an upsert sub-proposal attached | block |
| ITEM_RESOLVED | every line has an item id or an upsert sub-proposal | block |
| ITC_BLOCKED | no claimable ITC on a blocked category (`C-22`) | block |
| RCM_FLAG | transport/GTA supplier or bilty → RCM review issue (`C-20`) | warn |
| CASH_LIMIT | cash payment > ₹10,000 or receipt ≥ ₹2,00,000 (`C-36`) | warn |
| EWAY_REQUIRED | outbound consignment value > threshold (`C-30`) | info (creates a task) |
| B2C_ADDRESS | unregistered buyer ≥ ₹50,000 without address/state | block |
| STOCK_AVAILABLE | outbound goods lines ≤ on-hand (reuses INSUFFICIENT_STOCK) | block |
| SERIALS | challan/invoice serial count = quantity for serialised items | block |
| LOW_CONFIDENCE | any monetary field below the confidence floor | needs_input (clarification) |

Every `block` and `needs_input` issue maps to a clarification template (`06-clarification-spec.md`). Validators never call a model.

## 8. Clarification engine (summary; detail in 06)

- **D-50** A clarification is `{ proposal_id, field_path?, template_code, question_text, answer_type: party|item|date|amount|choice|yes_no|text, options?, blocking, money_at_risk_paise, status }`.
- **D-51** Generated only from validator issues and resolution failures (ADR 023). The model phrases the question from the template with the document's specifics, and parses free-text answers into the typed answer; it does not choose what to ask.
- **D-52** Answering writes a new proposal version, re-runs validation, and either surfaces the next question for the same proposal immediately or marks it `ready`.
- **D-53** Digest job: once a day at `digest.time_local`, select open items ranked by `money_at_risk_paise` (unmatched 2B entries, unconfirmed bills nearing 180 days, overdue invoices, blocking questions), cap at `digest.max_items`, send one web push plus the Inbox card. Never repeats a question already answered or dismissed.

## 9. LLM gateway (D-60 to D-66)

- **D-60** Single module wrapping OpenRouter: `call({ task, input, schema?, images? })`. Tasks: `classify`, `extract:<type>`, `plan`, `phrase_question`, `parse_answer`, `summarise`. Each task maps to a model in config (routing), with a fallback model and a cost ceiling per call.
- **D-61** Structured output: JSON schema from zod (`zod-to-json-schema`), provider structured-output mode where supported, `json-repair` then zod parse, one retry with errors.
- **D-62** Prompt versioning: prompts live in the repo under `src/llm/prompts/<task>/<version>.md`; the version string is logged per call; changing a prompt or a model requires the eval gate to pass in CI (`07-eval-harness.md`).
- **D-63** `llm_calls` row per call: task, model, provider, prompt version, input tokens, output tokens, cost, latency, outcome (`ok|repaired|schema_fail|timeout|refused`), linked proposal/document. Monthly budget from config; at 80% the digest warns the admin; at 100% new extraction jobs queue but do not run until the admin raises the cap.
- **D-64** Data policy: route only to providers whose OpenRouter data policy is no-training/no-retention; log the provider actually used.
- **D-65** Concurrency: extraction jobs run through pg-boss with a small worker concurrency (config, default 2) so a batch of 30 photos does not spike cost or hit rate limits.
- **D-66** Offline degradation: if the gateway is down, uploads still ingest and store; extraction jobs retry with backoff; Ask returns a plain "the assistant is unavailable, your file is saved" message.

## 10. Compliance engine (D-70 to D-76)

- **D-70 Registers** are SQL views over posted records: sales register (invoices + notes by period), purchase register (bills + notes with ITC columns), expense register, output tax ledger, ITC ledger, RCM ledger. Exportable as CSV.
- **D-71 GSTR-1 JSON builder**: from the sales register for a period, emit the portal offline-tool JSON structure: B2B (by GSTIN), B2C large (interstate ≥ ₹2.5 lakh, `VERIFY`), B2C others (state-wise summary), credit/debit notes (registered and unregistered), HSN summary (Table 12, B2B and B2C tabs), document series summary (Table 13). Validate against a fixture that is known to import cleanly. Filing profile decides period granularity; IFF export is the B2B subset for months one and two.
- **D-72 GSTR-2B import**: parse the portal's 2B JSON (owner downloads, uploads through the PWA); store entries with supplier GSTIN, document number, date, taxable value, tax, and the 2B's own ITC availability flag.
- **D-73 Reconciliation**: match 2B entries to confirmed purchase bills on (supplier GSTIN, normalised document number, date ±config days, total ±config paise); outcomes `matched`, `value_mismatch`, `missing_in_books`, `missing_in_2b`, `duplicate`. Produce the IMS action list with a suggested action and reason per entry, and "ITC at risk" (books bills not in 2B) and "not ours" (2B entries with no bill) totals. Never auto-acts on the portal.
- **D-74 Liability computation** per period: output tax − eligible ITC (from matched bills only) + RCM = cash payable; shown before the PMT-06 date.
- **D-75 Close package**: a zip per period with the registers (CSV), GSTR-1 JSON, IFF JSON (if QRMP), 2B reconciliation (CSV + PDF summary), cash and bank books, a cover note listing open clarifications and unposted proposals. Stored as a document; downloadable; emailed later.
- **D-76 Tally XML** (P-07b, later): masters and vouchers in Tally's import XML so any CA can pull the month into their own Tally.

## 11. Banking and matching (D-80 to D-84)

- **D-80** `bank_accounts` per business; statement imports keyed on (account, period, hash). Extraction yields lines `{ date, narration, ref, debit_paise, credit_paise, balance_paise }`; a running-balance check across lines is a block-level validator (any break means an extraction error).
- **D-81** Matching runs in code first: exact amount + party token in narration within ±config days → invoice or bill; UPI reference or cheque number stored on a receipt → exact; recurring narrations learned from confirmed matches. Model assistance only for narration-to-party disambiguation, as a `propose` step.
- **D-82** A `bank_match_batch` proposal groups a statement's matches; the confirm screen shows matched, suggested, and unmatched lines; unmatched become clarifications. Confirming posts receipts/payments through the existing khata/payment services and marks lines reconciled.
- **D-83** Cash book: cash receipts and payments are postings with `mode = cash`; the cash account balance is derived. A physical count entry is a journal, not an edit.
- **D-84** The money view (P-09) reads posted balances only.

## 12. CRM and service (D-90 to D-93)

- **D-90** `installed_units`: `{ id, item_id, serial_no, customer_id, site_address_id, sold_on_invoice_id, challan_id, installed_at, warranty_until, status }`. Created from challan/invoice serials; serial uniqueness per item.
- **D-91** `amc_contracts`: `{ customer_id, units[], start, end, price_paise, visits_planned, visits_done, invoice_id }`; renewal reminders 30 days before `end` in the digest.
- **D-92** `service_tickets`: `{ unit_id, reported_at, issue, resolution, parts_used (stock issue lines), labour_paise, coverage: warranty|amc|billable, invoice_id? }`. A billable ticket produces an invoice proposal (SAC line, `C-19`). Parts used move stock.
- **D-93** Customer timeline view: quotations, orders, invoices, payments, units, tickets, AMCs, in one list; the "what does this customer have" answer for Ask's read tools.

## 13. Data model deltas (summary; DDL in 04)

New tables: `business`, `config_values`, `documents`, `document_pages`, `extraction_runs`, `proposals`, `proposal_versions`, `proposal_issues`, `confirmations`, `clarifications`, `clarification_answers`, `digests`, `conversations`, `messages`, `tool_calls`, `llm_calls`, `prompts`, `gst_rate_schedule`, `hsn_codes`, `purchase_bills`, `purchase_bill_lines`, `expenses`, `expense_categories`, `credit_notes`, `debit_notes`, `delivery_challans`, `delivery_challan_lines`, `receipt_vouchers`, `bank_accounts`, `bank_statement_imports`, `bank_lines`, `bank_matches`, `gstr1_exports`, `gstr2b_imports`, `gstr2b_entries`, `reconciliations`, `installed_units`, `amc_contracts`, `service_tickets`, `push_subscriptions`.

Changed tables: `invoices` (+`proposal_id`, `irn`, `ack_no`, `ack_date`, `signed_qr`, `eway_required`, `eway_bill_no`, `delivery_challan_id`, `round_off_paise`); `payments` (+`mode`, `reference`, `bank_line_id`, `proposal_id`); `items` (+`sac_code`, `is_service`, `is_serialised`, `default_rate_note`); `companies` (+`is_transporter`, `rcm_default`); `stock_moves` (+movement types per `C-05`); every business table (+`business_id` default 1); every posted document (+`proposal_id`).

Invariants added at DB level: proposals never deleted; `proposal_versions` insert-only; `confirmations.version_id` must be the proposal's current version at confirm time (checked in the service, enforced by a trigger); `llm_calls` insert-only; `bank_lines` insert-only; number sequences allocate only inside the posting transaction.

## 14. PDF rendering (D-100)

Server-side PDF renders the same print-CSS templates the SPA uses (quotation, invoice, challan, note, receipt, close-package summary) through headless Chromium (`playwright-core` + the Chromium build already used for E2E, installed in the Docker image). One template, two outputs, pixel-identical. Rendered PDFs are stored as documents with `source = generated` and linked to the record. If image size becomes a problem on Render, ADR 024 records `@react-pdf/renderer` as the fallback with a second template set.

## 15. Jobs, scheduling, notifications (D-110 to D-113)

- **D-110** pg-boss on the same Postgres: queues `extraction`, `pdf`, `digest`, `close`, `notify`, `cleanup`. Retries with exponential backoff; dead-letter after N attempts surfaces in the admin view.
- **D-111** Schedules: digest daily at the configured local time; close package on the 1st; 2B reminder on the 15th ("2B is out, upload it") until an import for the period exists; AMC/warranty scan daily; e-way document-age scan daily.
- **D-112** Web push via the PWA service worker (VAPID); email as fallback for the admin. One push per digest, one per blocking question; never more than config per day.
- **D-113** Every job is idempotent on its key (document id, period, date) so a redeploy mid-run cannot double-post or double-notify.

## 16. Storage (D-120)

S3-compatible bucket (Cloudflare R2 or equivalent), one per environment, server-side encryption on. Objects are written once and never overwritten; access through short-lived signed URLs minted by the API. Local filesystem adapter for development and CI. Backups: Neon point-in-time restore for the database; bucket versioning for files; the restore drill (V2-8) restores both and re-verifies every `documents.sha256`.

## 17. Frontend (D-130 to D-134)

- **D-130** The existing React SPA becomes a PWA: manifest, service worker (offline shell, upload queue, push), install prompt. Same design system (Bizesuite tokens, IBM Plex, Bricolage).
- **D-131** Screens: **Inbox** (proposals awaiting confirm, open questions, digest), **Ask** (conversation with inline proposal cards), **Capture** (camera/file, multi-shot, upload queue with progress), **Money** (receivables, payables, cash/bank, upcoming dues), **Documents** (all files with status), **Sales / Purchases / Banking / Accounting / Compliance / Service** (registers and detail screens; the v1 guided builders survive as the "edit before confirm" screens, reached from a proposal, never as the primary entry point), **Settings** (config table, digest time, auto-post flags with the unlock counters).
- **D-132** The confirm screen is the product. It shows the source image beside the proposed record, field confidences as subtle markers, issues inline, one primary button. Editing a field creates a version; confirming names it.
- **D-133** Mobile first: every screen usable one-handed on a 360 px width; uploads resumable; large lists virtualised.
- **D-134** i18n-ready strings from day one (English only shipped).

## 18. Security (D-140 to D-145)

- **D-140** Sessions as in v1 (argon2id, hashed opaque tokens). Two roles. The `readonly` role is reserved for a future CA login and has no UI in v1.
- **D-141** All uploads scanned for type by magic bytes, size-capped, stored outside the web root, served via signed URLs only.
- **D-142** The agent's tool registry is the only interface between models and services; tool inputs are zod-validated; the model cannot name a tool outside the registry; prompt content from documents is treated as data (a bill that says "ignore previous instructions" is still just a bill: the extraction schema has no free-form instruction channel).
- **D-143** Helmet, rate limits on `/auth/*` and on upload and Ask endpoints, CSRF on state-changing routes (the v1 hardening list, now blocking go-live).
- **D-144** Secrets in Render environment; OpenRouter key scoped and rotated; no key in the SPA.
- **D-145** Dev bypass (v1 ADR 012) kept, fail-closed in production.

## 19. Observability and cost (D-150)

Structured JSON logs with request id, proposal id, document id; error tracking (Sentry or equivalent); the `llm_calls` and `confirmations` tables as the two dashboards that matter: cost per document type per month, and edit rate per proposal type (the auto-post unlock signal). A `/healthz` that checks DB, queue, and storage.

## 20. Testing and evals (D-160 to D-164)

- **D-160** The v1 suites stay green. New integration suites per module in the same `tsx` style: proposals lifecycle, purchases posting (ledger + stock + payable in one transaction, reversal nets to zero), banking matches, compliance builders (GSTR-1 fixture round-trip, 2B reconciliation cases), service module.
- **D-161** Validator unit tests: every row of the §7 table has a passing and a failing case.
- **D-162** Extraction evals (`07-eval-harness.md`): golden documents with expected JSON; per-field scorers; thresholds from `P` metrics; run in CI on any change under `src/llm/`, `src/extraction/`, or the model routing config; recorded models are used so CI does not call live providers except on a scheduled nightly job.
- **D-163** Quotation reproduction: the owner's real Refrens quotations as goldens; given their inputs as an Ask sentence, the proposed totals must match exactly.
- **D-164** E2E (Playwright): capture → confirm → posted; Ask → quotation → PDF; statement → matches → money view; run against a fresh DB in CI as today.

## 21. Deployment and migration from v1 (D-170 to D-173)

- **D-170** Tag `v1` at the last commit of the customer rail. v2 development continues on `main` behind the same CI; the Render service keeps deploying `main`. Nothing in v1's schema is dropped; v2 migrations are additive (new tables, new nullable columns) and folded into `schema.sql` after each phase as v1 did.
- **D-171** Roles: existing `admin` user stays admin; create the owner user; the other seeded roles remain but unused.
- **D-172** Opening balances and masters (V2-8): customers via the existing CSV importer; items via a new one through the same contract path; opening stock and party balances via the existing opening-balance journal path (account 3300 rail); bank opening balance as a journal.
- **D-173** Parallel run: one full month where the CA files from the close package while still receiving the paper, and the two are reconciled before the paper stops.

## 22. Key interfaces (TypeScript, illustrative)

```ts
// proposals
type ProposalType = 'quotation' | 'sales_order' | 'invoice' | 'delivery_challan' | 'credit_note'
  | 'debit_note' | 'receipt' | 'purchase_bill' | 'expense' | 'bank_match_batch'
  | 'service_ticket' | 'party_upsert' | 'item_upsert';

interface ProposalVersion<T> {
  proposalId: string; version: number;
  payload: T;                                    // the Create… contract for the type
  fieldMeta: Record<string, { confidence?: number; page?: number; source: 'model'|'rule'|'user' }>;
  producedBy: 'model' | 'validator' | 'user' | 'answer';
  llmCallIds: string[];
}

interface ValidationIssue {
  code: string; severity: 'block' | 'warn' | 'info' | 'needs_input';
  fieldPath?: string; message: string; clarificationTemplate?: string; moneyAtRiskPaise?: number;
}

// agent tools
interface ToolDef<I> { name: string; description: string; input: z.ZodType<I>; kind: 'read' | 'propose';
  run(input: I, ctx: ToolContext): Promise<unknown> }

// llm gateway
interface LlmRequest<T> { task: LlmTask; prompt: string; promptVersion: string;
  schema?: z.ZodType<T>; images?: StoredImageRef[]; maxCostPaise: number; links: { proposalId?: string; documentId?: string } }
```
