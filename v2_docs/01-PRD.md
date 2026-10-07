# 01: Product Requirements

Requirement IDs: `P-xx`. Compliance requirements live in `02-compliance-standard.md` as `C-xx`.

## 1. Problem

Small Indian businesses cannot afford an accounts operator for the first several years. The owner hands every invoice, bill and statement to a low-cost CA for a small fee, gets no visibility into his own numbers, loses input tax credit silently, and shares everything about the business with someone he cannot supervise. Since 1 April 2026 the GST portal requires the recipient to act on every supplier invoice (IMS) or lose the credit; nobody at the business is doing this. Separately, the owner's invoicing tool (Refrens free tier) is now capped at 15 documents a year, so the one workflow he actually runs himself is breaking.

## 2. Product

Bizsuite v2 is the accounts department. The owner does two things: feeds it documents, and asks it for things in plain language. The system does everything an accounts clerk plus a bookkeeper would do, stops before anything that legally needs a CA (return filing, audit sign-off), and asks for what it cannot infer. Every posting needs the owner's confirmation. Every number is traceable to a source document, a proposal, and a confirmation event.

The business it serves in v1: Kumar Abhiyantriki Enterprises, Lucknow. Trading-style books (buys finished goods and parts, sells, delivers, installs, services). Units carry serial numbers; some are under AMC. One owner, one admin (the developer), one CA who receives files.

## 3. Users

| User | Device / channel | What they do | v1 access |
|---|---|---|---|
| Owner | Phone, PWA, English UI | uploads documents, asks for documents, confirms proposals, answers clarifications, reads the money view | full, role `owner` |
| Admin (developer) | Laptop | configuration, corrections and reversals, evals, close package, opening balances | full, role `admin` |
| CA | Email / files | receives the monthly close package; files returns | none (files only) |
| Customers, suppliers | Email / WhatsApp (manual forward) | receive PDFs | none |

Roles collapse to `owner` and `admin` in v2. The v1 five-role matrix stays in the schema (harmless, and the `readonly` role becomes the future CA login) but the UI does not expose user management beyond these two.

## 4. Jobs to be done

Ranked by value to the owner. Each has a trigger, an output, and acceptance criteria that `08-build-plan.md` maps to phases.

### J1: Quotation from a request (P-01)
- Trigger: owner types or speaks "quotation for Sharma Electricals, 2 units 5 kVA stabilizer at 18,500 each, 18% GST, installation included, valid 15 days".
- Output: a `Quotation` proposal (party resolved or created, items resolved or created, lines, tax computed server-side, terms), shown for confirmation; on confirm: a numbered quotation, a PDF matching the existing print template, the customer upserted in CRM, a follow-up date.
- Acceptance: a quotation for a known customer with known items is produced in under 90 seconds of owner time; totals match the owner's past Refrens quotations for the same inputs (reproduction test in `07-eval-harness.md`); an unknown item or party triggers exactly one clarification, not a failure.

### J2: Outbound rail: order, invoice, challan, notes, receipts (P-02)
- Trigger: "convert QTN-2026-014 to invoice", "raise a delivery challan for the Sharma order, 2 units, serials A123 and A124", "record 20,000 received from Sharma by UPI", "credit note for 1 unit returned".
- Output: proposals for sales order, tax invoice, delivery challan, credit/debit note, payment receipt; on confirm: posted through the existing services (ledger, stock, khata), PDF generated, e-way bill requirement flagged when the consignment value crosses the threshold (`C-30`).
- Acceptance: the quote → order → invoice → payment chain works end-to-end through Ask without opening a form; every posted document is immutable and reversible only through the documented reversal path; serial numbers captured on the challan land in the installed base (J8).

### J3: Purchase bill capture (P-03)
- Trigger: owner uploads a photo or PDF of a supplier's tax invoice.
- Output: a `PurchaseBill` proposal: supplier (matched by GSTIN, then name), bill number and date, lines with HSN, quantities, taxable value, tax split, totals; ITC eligibility per line; stock receipt lines; a payable. Validators check arithmetic, GSTIN format and state consistency, place of supply against tax split, duplicate bill, period open (`02-compliance-standard.md` §3). Issues become clarifications.
- Acceptance: on the golden set, amounts, GSTIN, bill number and date extract at ≥ 98% field accuracy; a duplicate upload is detected by content hash and by (supplier, bill number, FY); confirm posts ledger + stock + payable in one transaction; the owner never types a line item for a printed bill.

### J4: Expense capture (P-04)
- Trigger: photo of a fuel receipt, transport bilty, hardware shop bill, courier slip.
- Output: an `Expense` proposal: payee, date, amount, category (from a fixed expense account list), GST split if a GSTIN is present, payment mode.
- Acceptance: category suggestion accuracy ≥ 90% on the golden set; ineligible ITC (Section 17(5) categories, `C-22`) is never proposed as claimable.

### J5: Bank statement capture and matching (P-05)
- Trigger: owner uploads the monthly statement PDF.
- Output: bank lines in the bank book; `BankMatch` proposals linking lines to invoices, bills, expenses, or new receipts/payments; unmatched lines become clarifications ("₹18,500 received from SHARMA ELEC on 14 Sep: is this against INV-2026-041?").
- Acceptance: lines extract with zero amount errors on the golden statements; ≥ 80% of lines auto-matched with a proposal on a typical month; batch confirm works; the bank balance in the books equals the statement closing balance after the month is confirmed.

### J6: Clarifications and the daily digest (P-06)
- Trigger: any validator issue, any unmatched entity, any pending confirmation.
- Output: structured questions in the Inbox; one digest a day at a configured time, capped at three items ranked by money at risk; answering an item immediately triggers the next question on the same proposal until it is clean; web push for the digest and for blocking questions.
- Acceptance: no question is ever asked twice for the same fact; answers are typed (party, item, date, amount, choice, yes/no, free text parsed to a type); a proposal with zero open questions is one tap from posted.

### J7: Monthly close and the CA package (P-07)
- Trigger: the 1st of each month (job), or "close August".
- Output: sales register, purchase register, GSTR-1 JSON in the portal's import format, GSTR-2B import and the IMS action list (accept / reject / pending, with the reason and the ITC amount per line), ITC at risk summary, cash and bank books, a zip for the CA. Tally XML export later (P-07b).
- Acceptance: GSTR-1 JSON imports into the portal's offline tool without errors; every supplier invoice in 2B is either matched to a confirmed bill or listed with a reason; the package is generated by the 5th of the month without owner effort beyond confirmations.

### J8: CRM, installed base, AMC, service (P-08)
- Trigger: a challan with serials; "log a service call for Sharma's unit A123, fan replaced, ₹800"; AMC expiry.
- Output: customers with contacts and history; installed units (serial, item, customer, site, install date, warranty end); AMC contracts with period and visits; service tickets billed (SAC line) or covered; reminders for AMC renewal and warranty expiry in the digest.
- Acceptance: any unit's history (sale, install, tickets) is one search away; AMC renewal reminders fire 30 days before expiry; a billed service call produces a tax invoice through J2.

### J9: The money view (P-09)
- Trigger: opening the app; "how much does Sharma owe", "what do I owe suppliers", "cash this month".
- Output: receivables by customer with ageing (existing khata), payables by supplier, bank and cash balances, upcoming: GST payment due, AMC renewals, overdue invoices.
- Acceptance: numbers derive from posted entries only (never from proposals); the view loads in under 2 seconds on a phone.

## 5. Autonomy and trust policy (P-10 to P-15)

- **P-10** The LLM never writes to the database. It produces proposals typed by zod schemas from `@bizsuite/contracts`. Only the existing service layer posts, inside `withTransaction`, with the v1 triggers enforcing balance, immutability and period locks.
- **P-11** Every posting in v1 requires a confirmation by the owner or admin. This applies to inbound (purchase bills, expenses, bank matches) and outbound (quotations, invoices, notes, challans, receipts) alike.
- **P-12** Auto-post is a per-document-type flag, off by default. It may be enabled for an inbound type only after 30 consecutive confirmations of that type with no field edited. Outbound types can never be auto-posted: they reach a counterparty or the government and cannot be un-issued.
- **P-13** Every posted record links to: the source document (if any), the proposal version that was confirmed, the confirmation event (who, when, which fields were edited before confirming), and the LLM calls that produced it. This is the audit trail Rule 56(8) requires for electronic records (`C-03`).
- **P-14** Corrections are reversals plus a new posting, never edits. The UI offers "undo" on a posting for 24 hours; it executes the reversal path, not a delete.
- **P-15** Money at risk drives priority: the digest orders items by rupee impact (ITC that will lapse, an invoice that is unmatched, a payable that is overdue), not by recency.

## 6. Non-goals for v1

Multi-tenancy; Hindi or voice input (design the UI strings for i18n, do not implement); WhatsApp Business API; e-invoicing (IRN) and e-way bill generation via API (fields modelled, events flagged); filing returns on the portal; TDS; payroll; manufacturing costing or BOMs; purchase orders (bills are captured after the fact); multiple warehouses; a CA login; a mobile-store app (PWA only).

## 7. Success metrics

| Metric | Target | How measured |
|---|---|---|
| Owner adoption | 4 consecutive weeks where every sale is invoiced through the system and every supplier bill is uploaded within 7 days | usage log |
| Time to quotation | ≤ 90 s owner time for known party and items | instrumented in Ask |
| Extraction accuracy | ≥ 98% on amounts, GSTIN, document number, date; ≥ 95% on line descriptions and HSN; on the golden set | `07-eval-harness.md`, CI |
| Ledger integrity | 0 unbalanced or edited postings, ever | DB invariants + integration suite |
| ITC protection | 100% of 2B entries classified before the 14th of the following month | close job |
| Close package | produced by the 5th of the month, with ≤ 3 open clarifications | close job |
| LLM cost | ≤ ₹1,500/month at the business's volume | `llm_calls` table |

## 8. Constraints

Single tenant. Existing engine: Node/Express/TypeScript, PostgreSQL 16 on Neon, React SPA, zod contracts, pg triggers, Playwright E2E, Vitest. Deployed on Render as one container. LLM access via OpenRouter. Built by one developer with a coding agent, part-time, no fixed date. English-only UI in v1. The owner's phone is the primary device; assume a mid-range Android and patchy mobile data (uploads must be resumable and small).

## 9. Risks

| Risk | Mitigation |
|---|---|
| Extraction error posts a wrong number | confirm-to-post (P-11); validators before proposal; golden-set gate in CI; 24-hour undo |
| Owner stops uploading | digest ranked by money at risk; uploads take one tap from the camera; the money view is only as good as what is fed, and the UI says so |
| GST rule drift (rates, thresholds, formats) | all thresholds and rates in effective-dated tables (`C-13`, `C-14`); compliance doc reviewed each quarter |
| Wrong classification of installation/AMC supplies | configurable treatment (`C-19`), confirm with the CA once before the first invoice that includes installation |
| LLM provider outage or cost spike | gateway with model routing and fallback; monthly budget cap; the system degrades to manual proposals, never to no service |
| Solo-dev stall | phases ship independently; V2-1 alone replaces Refrens |

## 10. Open questions (owner or CA to answer before V2-6)

1. Monthly or QRMP filer? (Portal shows it. Default assumption: QRMP.)
2. ITR-4 (44AD presumptive) or ITR-3 last year?
3. Is installation billed as part of the goods (composite supply) or as a separate service line? Which does the CA currently file?
4. Bank name(s) and statement format(s); approximate share of receipts in cash.
5. Does the business ever sell interstate or to unregistered buyers above ₹50,000?
