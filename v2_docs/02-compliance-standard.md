# 02: Compliance Standard

What a GST-registered trading business in India must record, issue and file, written as requirements the system enforces. IDs `C-xx`. Tests and code cite these IDs.

Researched September 2026. `VERIFY` marks a point we are confident of but should confirm with the CA before the first real filing. Everything with a number in it lives in the configuration table in §8, never hard-coded.

Scope assumptions for KAE: regular (non-composition) GST registration in Uttar Pradesh (state code 09); aggregate turnover under ₹5 crore; trading-style books; no exports, no SEZ, no imports in v1.

## 1. Records the business must maintain

Legal basis: CGST Act Section 35, CGST Rules 56 to 58.

- **C-01** Maintain a true and correct account of inward supplies, outward supplies, stock, input tax credit availed, and output tax payable and paid, at the principal place of business. In system terms: a purchase register, a sales register, a stock ledger, an ITC ledger, and an output tax ledger, all derived from posted entries.
- **C-02** Maintain registers of every tax invoice, delivery challan, credit note, debit note, and receipt/payment/refund voucher issued or received. Every such document is a first-class record with its own number series.
- **C-03** Electronic records must keep a log of every entry edited or deleted. Postings are append-only; corrections are reversals; every mutation records actor and time. (This is v1's ledger design, now cited as a legal requirement.)
- **C-04** Keep names and complete addresses of suppliers and customers; keep the address of every location where goods are stored.
- **C-05** Stock account must show opening balance, receipts, issues, and closing balance, plus goods lost, stolen, destroyed, written off, or given as gifts or free samples. The stock ledger needs an explicit movement type for each of those.
- **C-06** Retain books and records for at least 72 months from the due date of the annual return for that year (longer if any proceeding is pending). Documents in object storage are never deleted in v1; retention policy is a config value.

## 2. Documents the business issues

Legal basis: Section 31, Rules 46 to 55.

- **C-07 Tax invoice (goods)**: issued at or before removal/delivery. Mandatory particulars (Rule 46): the words "Tax Invoice"; supplier name, address, GSTIN; a consecutive serial number, unique for the financial year, at most 16 characters, letters, digits, hyphen and slash only; date; recipient name, address, GSTIN when registered; place of supply with state name and code for interstate supplies; delivery address when it differs; HSN per line (`C-15`); description, quantity and unit, taxable value, rate, and tax amount split as CGST + SGST or IGST; whether tax is payable on reverse charge; signature or digital signature. For an unregistered buyer with invoice value of ₹50,000 or more, the buyer's name, address and place-of-supply state are mandatory.
- **C-08 Number series**: one consecutive series per document type per financial year, gap-free, never reused. The system allocates numbers only at posting (drafts carry none), from a per-type per-FY sequence. Existing sequences (`INV-2026`, `QTN-2026`, `SO-2026`, `JV-2026`) follow this rule; new types (`PB-`, `EXP-`, `DC-`, `CN-`, `DN-`, `RCP-`, `PMT-`, `ST-`) join it.
- **C-09 Delivery challan** (Rule 55): for movement of goods without a sale at that moment (goods for installation before invoicing, job work, approval, returns, transfers). Particulars: date and number, consignor and consignee name/address/GSTIN, HSN and description, quantity, taxable value and tax where the movement is a supply, place of supply if interstate, signature. Marked "Original for consignee / Duplicate for transporter / Triplicate for consignor". Serial numbers of units are recorded on it (feeds the installed base).
- **C-10 Credit note and debit note** (Section 34): a credit note reduces the value or tax of an earlier invoice (return, shortfall, post-sale discount); a debit note increases it. Both reference the original invoice(s), carry the same particulars as an invoice, and post to the ledger as their own documents (never by editing the invoice). A credit note reducing output tax must be reported no later than 30 November following the end of the financial year of the original supply, or the annual return date if earlier. `VERIFY` the exact cut-off wording with the CA.
- **C-11 Receipt voucher, payment voucher, refund voucher**: a receipt voucher on receiving an advance; a refund voucher if the advance is returned without supply; a payment voucher when paying a supplier under reverse charge. Advances received are tracked per party and adjusted against later invoices (`C-01` advances register).
- **C-12 Bill of supply**: only for exempt supplies or composition dealers. Not expected for KAE; the document type exists in the schema so an exempt line does not break invoicing.

## 3. Tax computation

- **C-13 Rates are effective-dated.** Since 22 September 2025 (GST 2.0) the working rates are 0%, 5%, 18% and 40%, with special rates of 0.25%, 1.5% and 3% for precious stones and metals. Bills dated before that date may lawfully carry 12% or 28%. The system stores a rate schedule keyed by (HSN/SAC prefix, effective_from, effective_to, rate) and resolves the rate by document date. `items.gst_rate` is a default proposal, never the authority.
- **C-14 Thresholds are configuration**, effective-dated like rates: e-invoice AATO limit, e-way bill consignment value, HSN digit rule, B2C address rule value, cash payment and receipt limits, QRMP eligibility. See §8.
- **C-15 HSN/SAC on invoices**: with turnover up to ₹5 crore, 4-digit HSN is mandatory on every B2B invoice and optional on B2C. Above ₹5 crore, 6 digits. The system stores the full code on the item and prints the configured number of digits. GSTR-1 Table 12 requires the HSN summary split into B2B and B2C tabs, so every invoice line must carry the code even when the print omits it.
- **C-16 Place of supply for goods** is the buyer's location (delivery address). It comes from the buyer record only, never defaulted to the seller's state (v1 ADR 010). Same state as the supplier: CGST + SGST, each half the rate. Different state: IGST at the full rate. The tax split on every proposal is validated against this rule.
- **C-17 Place of supply for services** (installation, repair, AMC) to a registered recipient is the recipient's location; to an unregistered recipient, the address on record. Installation at a site in another state for a UP buyer is still a supply to the buyer's location under the general rule. `VERIFY` with the CA whether any on-site service is treated as immovable-property-related.
- **C-18 Rounding**: taxes are computed per line in integer paise; the invoice total may be rounded to the nearest rupee with an explicit round-off line (Section 170 permits rounding of tax to the nearest rupee). Per-line tax amounts are never silently rounded. `VERIFY` the CA's preferred presentation (round-off line vs exact paise) and make it a config.
- **C-19 Composite supply**: goods plus installation sold together as one bundle are taxed at the rate of the principal supply (the goods). Installation billed separately is a service under SAC 9987 (maintenance, repair and installation services), 18% `VERIFY`. AMC and paid service calls are SAC 9987 services. The treatment for "goods including installation" is a business config (`composite` or `separate`), set once with the CA.
- **C-20 Reverse charge (RCM)**: the business must self-pay GST on certain inward supplies, notably goods transport agency (GTA) services when the transporter has not opted to pay tax itself, at 5% without ITC on the GTA input or 12% with ITC as elected by the GTA `VERIFY`. Transport bills (bilties) are flagged for RCM review; an RCM liability posting and a payment voucher are generated on confirmation. RCM paid is itself eligible ITC in the same period, subject to `C-21`.
- **C-21 ITC conditions** (Section 16): credit is claimable only when the business holds a valid tax invoice or debit note; the goods or services were received; the supplier has reported the invoice and it appears in the business's GSTR-2B (hard-blocked since 1 April 2026, `C-27`); the supplier has paid the tax; and the business files its return. If the supplier is not paid within 180 days, the credit must be reversed with interest and can be reclaimed on payment: the payables ageing must expose the 180-day mark per bill. ITC for a financial year must be claimed by 30 November of the following year or the annual return date, whichever is earlier. `VERIFY` current dates.
- **C-22 Blocked ITC** (Section 17(5)): no credit on motor vehicles for personal use, food and beverages, club and health services, personal consumption, goods lost, stolen, destroyed, written off or gifted, works contracts for own buildings, and similar. The expense category list carries an `itc_blocked` flag; extraction may never propose claimable ITC on a blocked category.
- **C-23 Tax on advances**: advances received for goods are not taxed until the invoice (goods were relieved of tax on advances); advances for services are taxable on receipt `VERIFY`. Receipt vouchers record the advance either way.

## 4. Filing calendar (return-side facts the system must track)

The system does not file. It produces the inputs, tracks the dates, and flags what will lapse.

- **C-24 Filing profile**: `monthly` or `qrmp` is a business config. Default assumption for KAE: QRMP (turnover up to ₹5 crore). Confirm from the portal.
- **C-25 QRMP dates**: GSTR-1 quarterly by the 13th of the month after the quarter; GSTR-3B quarterly by the 24th for Uttar Pradesh (group 2 states) and the 22nd for group 1; tax for months one and two of each quarter paid by the 25th of the following month via PMT-06; the Invoice Furnishing Facility (IFF) optionally uploads B2B invoices for months one and two by the 13th of the next month so customers get their ITC early. The system computes each period's tax liability (output minus eligible ITC) so the PMT-06 amount is known.
- **C-26 Monthly dates** (if not QRMP): GSTR-1 by the 11th, GSTR-3B by the 20th of the following month.
- **C-27 IMS and GSTR-2B**: since 1 April 2026 the Invoice Management System is mandatory for every registered taxpayer. Every invoice, debit note and credit note a supplier files lands in the business's IMS dashboard to be accepted, rejected, or kept pending. No action by the time GSTR-2B is drafted (the 14th of the following month) means deemed acceptance. ITC is available only for entries reflected in GSTR-2B. The system therefore: imports the 2B JSON, matches every entry to a confirmed purchase bill, and outputs an action list per entry with a reason (`accept`: matched; `reject`: not ours, duplicate, wrong GSTIN, value mismatch beyond tolerance; `pending`: goods not yet received, bill not yet uploaded). Unmatched 2B entries with no bill are the highest money-at-risk item in the digest.
- **C-28 Annual return**: GSTR-9 by 31 December following the financial year, where the business is above the exemption threshold notified for that year; GSTR-9C reconciliation only above ₹5 crore. The system's close packages for the 12 months are the input.
- **C-29 Late fees and blocks**: late GSTR-3B attracts a daily fee and 18% interest on unpaid tax; two consecutive unfiled periods block e-way bill generation; six months' non-filing can suspend the GSTIN. The digest surfaces the next due date and whether the CA has confirmed filing (a manual tick by the admin in v1).

## 5. e-invoicing and e-way bill

- **C-30 e-way bill**: required before movement when the consignment value (invoice value including GST, excluding exempt goods) exceeds ₹50,000, for interstate and, in Uttar Pradesh, intrastate movement; also for non-sale movements (transfers, job work, returns, approval). Since 1 January 2025 it can only be generated against a document dated within the last 180 days. v1 flags "e-way bill required" on the invoice or challan and records the bill number the owner generates on the portal; API generation is a later phase. Splitting a consignment across invoices to stay under the limit does not avoid it and the system does not offer it.
- **C-31 e-invoicing (IRN)**: mandatory for B2B, export and SEZ supplies once aggregate annual turnover exceeds ₹5 crore in any financial year since 2017-18; once triggered it is permanent. Businesses at ₹10 crore or more must report to the IRP within 30 days of the invoice date. KAE is below the threshold; the invoice table carries `irn`, `ack_no`, `ack_date`, `signed_qr` columns from day one so the integration is additive.
- **C-32 QR and signature**: a Rule 46 invoice needs a signature or digital signature unless issued as an e-invoice under Rule 48(4). The PDF carries the configured signatory name and an image signature; digital signing is out of scope for v1.

## 6. Income-tax touchpoints the books must support

The system does not compute income tax. It records the facts the CA's income-tax work depends on.

- **C-33 Presumptive scheme (44AD)**: an eligible business with turnover up to ₹2 crore (₹3 crore where cash receipts are within 5% of total receipts) may declare 6% of digital receipts and 8% of cash receipts as income, file ITR-4, and is not required to keep books under Section 44AA for that income. GST record requirements (`C-01` to `C-06`) still apply in full. The system reports turnover and the cash share each year so the CA can decide.
- **C-34 Payment mode is a legal field**: every receipt and payment records `mode` (cash, UPI, NEFT/RTGS/IMPS, cheque, card, other). The 5% cash test in `C-33` and the tax-audit threshold (`C-35`) depend on it.
- **C-35 Tax audit (44AB)**: required above ₹1 crore turnover, lifted to ₹10 crore where cash receipts and cash payments are each within 5% of totals. Also triggered by declaring below the 44AD deemed rate while total income exceeds the exemption limit. The system reports both cash shares.
- **C-36 Cash limits**: a cash payment above ₹10,000 to one person in a day is disallowed as a business expense (Section 40A(3)); receiving ₹2,00,000 or more in cash from one person in a day (or for one transaction) is prohibited (Section 269ST). The system warns on proposals that cross either limit and records the warning with the posting. `VERIFY` the renumbered sections under the Income-tax Act, 2025 (in force from 1 April 2026); substance unchanged.
- **C-37 Fixed assets**: purchases capitalised as assets (a vehicle, a machine) go to an asset account, not an expense, and carry the date for depreciation. Extraction proposes `asset` when the item is durable and above a config value; the owner confirms.

## 7. Data handling

- **C-38** Business documents contain counterparties' GSTINs, addresses, bank details. They are stored encrypted at rest in object storage, served through signed URLs, and never sent to an LLM provider that trains on inputs (configure OpenRouter's data policy accordingly; log which provider handled each call in `llm_calls`).
- **C-39** If v2 ever serves more than one business, the Digital Personal Data Protection Act and its rules apply as a data fiduciary. Out of scope for the single-tenant v1; noted so the schema keeps `business_id` on every table from the start (default 1).

## 8. Configuration table (effective-dated, editable by admin)

| Key | Value at time of writing | Basis |
|---|---|---|
| `gst.rates` | schedule: 0, 5, 18, 40 (+0.25, 1.5, 3) from 2025-09-22; 0, 5, 12, 18, 28 before | C-13 |
| `gst.filing_profile` | `qrmp` (confirm) | C-24 |
| `gst.state_code` | 09 (Uttar Pradesh) | C-16 |
| `gst.hsn_digits_b2b` | 4 | C-15 |
| `gst.b2c_address_threshold_paise` | 5,000,000 | C-07 |
| `gst.eway.threshold_paise` | 5,000,000 | C-30 |
| `gst.eway.document_age_days` | 180 | C-30 |
| `gst.einvoice.aato_threshold_paise` | 50,000,000,000 (₹5 crore); not applicable | C-31 |
| `gst.itc.unpaid_reversal_days` | 180 | C-21 |
| `gst.itc.annual_claim_deadline` | 30 Nov following FY | C-21 |
| `gst.ims.draft_2b_day` | 14 | C-27 |
| `gst.installation_treatment` | `composite` or `separate` (set with CA) | C-19 |
| `gst.rounding` | `round_total_to_rupee` with round-off line (confirm) | C-18 |
| `it.cash_payment_limit_paise` | 1,000,000 | C-36 |
| `it.cash_receipt_limit_paise` | 20,000,000 | C-36 |
| `it.asset_capitalisation_threshold_paise` | admin-set | C-37 |
| `records.retention_months` | 72 | C-06 |
| `digest.time_local` | admin-set | P-06 |
| `digest.max_items` | 3 | P-06 |

## 9. Sources consulted (September 2026)

Statute text and rule summaries: gstzen.in (Rule 56), taxguru.in (Rule 56, HSN notification 78/2020), taxtmi.com (Sections 35 and 36), teachoo.com (Rule 56), cbic-gst.gov.in (Rule 46 particulars via secondary summaries). Rates: busy.in, cleartax.in, kkscapital.com (GST 2.0, 56th Council, effective 22 Sep 2025). Filing calendar and QRMP: taxaj.com, pkcindia.com, trulyinvoice.com, taxfilr.com. IMS and GSTR-2B: irisgst.com (guidance note), tutorial.gst.gov.in (revised IMS advisory), smartgst.in, taxgarden.in, taxslabs.com (mandatory from 1 April 2026). e-invoicing: xflowpay.com, credlix.com, gimbooks.com, aiaccountant.com. e-way bill: busy.in, cleartax.in, indiapost.org, mybillbook.in. Income tax: qwikfilings.com, treelife.in, legalsuvidha.com, regitom.com, taxsocial.pro, caclubindia.com. Product landscape: refrens.com (free plan of 15 documents/year), patronaccounting.com and incorpx.io (Zoho Books free plan), dclouds.in and flickai.in (Indian AI accounting tools). Primary notifications to pin in the repo: Notification 10/2023-CT (e-invoice ₹5 crore), Notification 78/2020-CT (HSN digits), the 56th GST Council rate notifications of 17 Sep 2025, the GSTN IMS advisories.
