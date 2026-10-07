import { z } from "zod";

/**
 * @bizsuite/contracts — the single source of truth for request shapes shared
 * by the API (zod-parse on every body) and the SPA (same objects validate
 * forms before submit). Client and server can never disagree about shapes
 * (system-design §3.1; eng review D7).
 *
 * Money is ALWAYS a decimal string ("1234.50") — parsed to integer paise only
 * inside the server's money utility. Never floats.
 */

// ---------------------------------------------------------------------------
// Shared field shapes
// ---------------------------------------------------------------------------
export const money = z.string().regex(/^\d+(\.\d{1,2})?$/, "expected a decimal like 1500.00");
export const qty = z.string().regex(/^\d+(\.\d{1,3})?$/, "expected a quantity like 12 or 12.500");
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
export const gstRate = z.union([
  z.literal(0), z.literal(0.25), z.literal(3), z.literal(5),
  z.literal(12), z.literal(18), z.literal(28),
]);

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
export const Login = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof Login>;

export interface AuthUserDto {
  id: string;
  email: string;
  fullName: string;
  roleId: string;
  roleName: string;
}

// ---------------------------------------------------------------------------
// CRM — companies (the customer/supplier master, and the party dimension for
// the receivables/payables sub-ledger)
// ---------------------------------------------------------------------------
export const gstin = z.string().regex(/^[0-9]{2}[A-Z0-9]{13}$/, "invalid GSTIN format");
export const gstTreatment = z.enum(["registered", "unregistered", "overseas", "sez"]);
export const stateCode = z.string().length(2);

/** Treatments that are inside India, and therefore need a place of supply. */
const DOMESTIC: readonly string[] = ["registered", "unregistered"];

/**
 * Structured postal address.
 *
 * `state` is deliberately ABSENT. The authoritative buyer state is
 * companies.state_code — it decides CGST/SGST vs IGST and prints on its own
 * line beside the address on every tax invoice. A free-text state here would
 * let one document show two different states (eng review 2026-09-10, D15).
 * Read it back with fmtAddress(), which still tolerates legacy keys.
 */
export const Address = z.object({
  line1: z.string().max(200).optional(),
  line2: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  district: z.string().max(100).optional(),
  pincode: z.string().regex(/^[1-9][0-9]{5}$/, "expected a 6-digit PIN code").optional(),
});
export type AddressDto = z.infer<typeof Address>;

/**
 * Two cross-field rules, both GST correctness rather than tidiness:
 *   registered            → must carry a GSTIN (mirrors the DB CHECK)
 *   registered|unregistered → must carry a state code
 *
 * The state-code rule has no DB CHECK behind it on purpose: e2e/seed.ts and
 * test/concurrency.ts insert companies via raw SQL without one, and overseas
 * /SEZ parties legitimately have none. It is enforced here, at the only place
 * a human creates a company (eng review 2026-09-10, D4).
 */
export const CreateCompany = z.object({
  name: z.string().min(1).max(200),
  gstin: gstin.optional(),
  gstTreatment: gstTreatment.optional(),
  stateCode: stateCode.optional(),
  industry: z.string().max(100).optional(),
  website: z.string().max(200).optional(),
  billingAddress: Address.optional(),
  shippingAddress: Address.optional(),
  notes: z.string().max(2000).optional(),
  isCustomer: z.boolean().optional(),
  isSupplier: z.boolean().optional(),
}).superRefine((c, ctx) => {
  const treatment = c.gstTreatment ?? "unregistered";   // matches the column default
  if (treatment === "registered" && !c.gstin) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ["gstin"],
      message: "registered companies require a GSTIN",
    });
  }
  if (DOMESTIC.includes(treatment) && !c.stateCode) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ["stateCode"],
      message: "a state code is required — it decides CGST/SGST vs IGST",
    });
  }
});
export type CreateCompanyInput = z.infer<typeof CreateCompany>;

/**
 * Patch shape. A patch only sees the fields it carries, so it can only catch
 * the explicit-null cases; clearing a GSTIN or state code some other way falls
 * through to the DB CHECK, which fromPgError turns into a typed 422.
 */
export const UpdateCompany = z.object({
  name: z.string().min(1).max(200).optional(),
  gstin: gstin.nullable().optional(),
  gstTreatment: gstTreatment.optional(),
  stateCode: stateCode.nullable().optional(),
  industry: z.string().max(100).nullable().optional(),
  website: z.string().max(200).nullable().optional(),
  billingAddress: Address.optional(),
  shippingAddress: Address.optional(),
  notes: z.string().max(2000).nullable().optional(),
  isCustomer: z.boolean().optional(),
  isSupplier: z.boolean().optional(),
  isActive: z.boolean().optional(),
}).strict().superRefine((p, ctx) => {
  if (p.gstTreatment === "registered" && p.gstin === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ["gstin"],
      message: "registered companies require a GSTIN",
    });
  }
  if (p.gstTreatment && DOMESTIC.includes(p.gstTreatment) && p.stateCode === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ["stateCode"],
      message: "a state code is required — it decides CGST/SGST vs IGST",
    });
  }
});
export type UpdateCompanyInput = z.infer<typeof UpdateCompany>;

/** Full company row as the API returns it. */
export interface CompanyDto {
  id: string;
  name: string;
  gstin: string | null;
  gst_treatment: string;
  state_code: string | null;
  industry: string | null;
  website: string | null;
  billing_address: Record<string, unknown>;
  shipping_address: Record<string, unknown>;
  notes: string | null;
  is_customer: boolean;
  is_supplier: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * What the customer picker hands to a document builder. gstin and state_code
 * are REQUIRED (nullable) rather than optional: a caller must state what it
 * knows about the buyer's state, because a silently-absent one used to fall
 * back to the seller's state and produce the wrong GST split.
 */
export interface CustomerOption {
  id: string;
  name: string;
  gstin: string | null;
  state_code: string | null;
  gst_treatment?: string;
}

// ---------------------------------------------------------------------------
// Invoicing
// ---------------------------------------------------------------------------
export const CreateInvoice = z.object({
  customerId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  placeOfSupply: z.string().length(2),
  docDate: isoDate.optional(),     // back-entry from bill photos; server rejects future dates
  dueDate: isoDate.optional(),
  lines: z.array(z.object({
    itemId: z.string().uuid(),
    description: z.string().min(1),
    hsn: z.string().regex(/^[0-9]{4,8}$/),
    qty,
    uom: z.string().min(1).optional(),
    rate: money,
    discountPct: z.number().min(0).max(100).optional(),
    gstRate: z.number(),
  })).min(1),
});
export type CreateInvoiceInput = z.infer<typeof CreateInvoice>;

// ---------------------------------------------------------------------------
// Sales — quotations (non-posting: no journal, no stock, no warehouse)
// ---------------------------------------------------------------------------
export const CreateQuotation = z.object({
  customerId: z.string().uuid(),
  placeOfSupply: z.string().length(2),
  docDate: isoDate.optional(),      // server rejects future dates, same as invoices
  validUntil: isoDate.optional(),
  terms: z.string().max(2000).optional(),
  notes: z.string().max(2000).optional(),
  lines: z.array(z.object({
    itemId: z.string().uuid(),
    description: z.string().min(1),
    hsn: z.string().regex(/^[0-9]{4,8}$/),
    qty,
    uom: z.string().min(1).optional(),
    rate: money,
    discountPct: z.number().min(0).max(100).optional(),
    gstRate: z.number(),
  })).min(1),
});
export type CreateQuotationInput = z.infer<typeof CreateQuotation>;

/** Convert a submitted quotation into a draft Sales Order (ERPNext/Odoo chain:
 *  quotation → sales order → invoice). Optional order details the staff adds. */
export const ConvertQuotation = z.object({
  deliveryDate: isoDate.optional(),
  poNo: z.string().max(64).optional(),
  poDate: isoDate.optional(),
});
export type ConvertQuotationInput = z.infer<typeof ConvertQuotation>;

// ---------------------------------------------------------------------------
// Sales orders (non-posting confirmed order; rounds to the rupee)
// ---------------------------------------------------------------------------
export const CreateSalesOrder = z.object({
  customerId: z.string().uuid(),
  placeOfSupply: z.string().length(2),
  docDate: isoDate.optional(),        // order date; server rejects future dates
  deliveryDate: isoDate.optional(),
  poNo: z.string().max(64).optional(),
  poDate: isoDate.optional(),
  terms: z.string().max(2000).optional(),
  notes: z.string().max(2000).optional(),
  lines: z.array(z.object({
    itemId: z.string().uuid(),
    description: z.string().min(1),
    hsn: z.string().regex(/^[0-9]{4,8}$/),
    qty,
    uom: z.string().min(1).optional(),
    rate: money,
    discountPct: z.number().min(0).max(100).optional(),
    gstRate: z.number(),
  })).min(1),
});
export type CreateSalesOrderInput = z.infer<typeof CreateSalesOrder>;

/** Raise a draft invoice from a submitted sales order; warehouse is needed
 *  because the invoice issues stock and the order doesn't carry one. */
export const MakeInvoiceFromSalesOrder = z.object({
  warehouseId: z.string().uuid(),
  dueDate: isoDate.optional(),
});
export type MakeInvoiceFromSalesOrderInput = z.infer<typeof MakeInvoiceFromSalesOrder>;

export const CreatePayment = z.object({
  customerId: z.string().uuid(),
  amount: money,
  mode: z.enum(["cash", "bank_transfer", "upi", "cheque", "card"]),
  depositAccountKey: z.enum(["cash", "bank"]),
  referenceNo: z.string().max(64).optional(),
  docDate: isoDate.optional(),
  notes: z.string().optional(),
  allocations: z.array(z.object({
    invoiceId: z.string().uuid(),
    amount: money,
  })).optional(),
});
export type CreatePaymentInput = z.infer<typeof CreatePayment>;

// ---------------------------------------------------------------------------
// Accounting — chart of accounts + ledger reports
// ---------------------------------------------------------------------------
export const CreateAccount = z.object({
  parentId: z.string().uuid(),          // child inherits the parent's root type
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(120),
  isGroup: z.boolean().optional(),
});
export type CreateAccountInput = z.infer<typeof CreateAccount>;

export interface AccountNodeDto {
  id: string;
  code: string;
  name: string;
  rootType: "asset" | "liability" | "equity" | "income" | "expense";
  reportType: string;                   // Balance Sheet | Profit and Loss
  normalSide: string;                   // debit | credit
  isGroup: boolean;
  isActive: boolean;
  systemKey: string | null;
  parentId: string | null;
  balance: string;                      // signed, debit-positive
}

export interface TrialBalanceRowDto { code: string; name: string; rootType: string; debit: string; credit: string; }
export interface TrialBalanceDto {
  asOf: string | null;
  rows: TrialBalanceRowDto[];
  totalDebit: string;
  totalCredit: string;
  balanced: boolean;
}

export interface GeneralLedgerRowDto {
  postingDate: string;
  entryNo: string | null;
  voucherType: string;
  narration: string | null;
  party: string | null;
  debit: string;
  credit: string;
  balance: string;
}
export interface GeneralLedgerDto {
  account: { id: string; code: string; name: string; rootType: string; normalSide: string };
  from: string | null;
  to: string | null;
  opening: string;
  rows: GeneralLedgerRowDto[];
  closing: string;
}

// Manual journal entries (ERPNext Journal Entry)
export const CreateJournalEntry = z.object({
  postingDate: isoDate.optional(),
  narration: z.string().min(1).max(500),
  lines: z.array(z.object({
    accountId: z.string().uuid(),
    debit: money,                       // "0" on a credit line
    credit: money,                      // "0" on a debit line
    partyType: z.enum(["customer", "supplier"]).optional(),
    partyId: z.string().uuid().optional(),
    remarks: z.string().max(200).optional(),
  })).min(2),
});
export type CreateJournalEntryInput = z.infer<typeof CreateJournalEntry>;

export interface JournalEntryListRow {
  id: string;
  entry_no: string | null;
  posting_date: string;
  narration: string | null;
  total: string;
  is_reversal: boolean;
  reversed: boolean;
  posted_at: string | null;
}
export interface JournalLineDto {
  account_id: string;
  account_code: string;
  account_name: string;
  debit: string;
  credit: string;
  party_type: string | null;
  party_name: string | null;
  remarks: string | null;
}
export interface JournalEntryDetail {
  id: string;
  entry_no: string | null;
  posting_date: string;
  narration: string | null;
  status: string;
  voucher_type: string;
  reverses_id: string | null;
  reverses_entry_no: string | null;
  reversed_by_entry_no: string | null;
  reversed_by_id: string | null;
  posted_at: string | null;
  created_at: string;
  lines: JournalLineDto[];
}

export interface FinancialPeriodDto {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  status: string;                 // open | closed
  closed_by_name: string | null;
  closed_at: string | null;
  is_current: boolean;
}

export const OpeningBalance = z.object({
  customerId: z.string().uuid(),
  amount: money,
  asOfDate: isoDate.optional(),
});
export type OpeningBalanceInput = z.infer<typeof OpeningBalance>;

// ---------------------------------------------------------------------------
// Read-side DTOs (reports)
// ---------------------------------------------------------------------------
export interface KhataRow {
  partyId: string;
  partyName: string;
  balance: string;          // decimal string, +ve = they owe us
}

export interface KhataReport {
  rows: KhataRow[];
  totalReceivable: string;
  asOf: string;             // ISO timestamp
}

export interface DigestData {
  weekStart: string;
  weekEnd: string;
  totalReceivable: string;
  topDebtors: KhataRow[];
  weekSalesTotal: string;
  weekSalesCount: number;
  weekPaymentsTotal: string;
  weekPaymentsCount: number;
}

export interface Digest {
  text: string;             // WhatsApp-ready
  data: DigestData;
}

/** Item master row as returned by GET /api/inventory/items (pg numerics are strings). */
export interface ItemOption {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  uom: string;
  hsn_sac_code: string;
  gst_rate: string;                       // "18.00"
  is_stock_item: boolean;
  standard_selling_rate: string | null;   // "12000.00"
  on_hand: string;                        // summed qty across warehouses, "0" when none
  is_active: boolean;
}

export interface WarehouseDto {
  id: string;
  name: string;
}

export interface CompanySettingsDto {
  legal_name: string;
  gstin: string | null;
  state_code: string;
  address: Record<string, unknown>;
  invoice_terms: string | null;
}

export interface InvoiceLineDto {
  id: string;
  item_id: string | null;
  description: string;
  hsn_sac_code: string;
  qty: string;
  uom: string;
  rate: string;
  discount_pct: string;
  taxable_value: string;
  gst_rate: string;
  cgst_amount: string;
  sgst_amount: string;
  igst_amount: string;
  line_total: string;
  sort_order: number;
}

/** GET /api/invoicing/invoices/:id — header + lines + parties, print-ready. */
export interface InvoiceDetail {
  id: string;
  kind: string;
  doc_no: string | null;
  doc_date: string;                       // YYYY-MM-DD
  status: string;
  customer_id: string;
  source_warehouse_id: string | null;
  place_of_supply: string;
  is_inter_state: boolean;
  due_date: string | null;
  company_gstin: string | null;
  customer_gstin: string | null;
  subtotal: string;
  discount_total: string;
  taxable_total: string;
  cgst_total: string;
  sgst_total: string;
  igst_total: string;
  rounding_adjustment: string;
  grand_total: string;
  amount_paid: string | null;
  outstanding: string | null;
  payment_status: string | null;
  submitted_at: string | null;
  created_at: string;
  customer: {
    name: string;
    gstin: string | null;
    state_code: string | null;
    billing_address: Record<string, unknown>;
  };
  company: CompanySettingsDto;
  lines: InvoiceLineDto[];
}

export interface InvoiceListRow {
  id: string;
  kind: string;
  doc_no: string | null;
  doc_date: string;
  status: string;
  customer_id: string;
  customer_name: string;
  grand_total: string;
  amount_paid: string | null;
  outstanding: string | null;
  payment_status: string | null;
  created_by: string | null;
  created_at: string;
}

export interface QuotationLineDto {
  id: string;
  item_id: string | null;
  description: string;
  hsn_sac_code: string;
  qty: string;
  uom: string;
  rate: string;
  discount_pct: string;
  taxable_value: string;
  gst_rate: string;
  cgst_amount: string;
  sgst_amount: string;
  igst_amount: string;
  line_total: string;
  sort_order: number;
}

/** GET /api/sales/quotations/:id — header + lines + parties, print-ready. */
export interface QuotationDetail {
  id: string;
  doc_no: string | null;
  doc_date: string;                       // YYYY-MM-DD
  status: string;
  customer_id: string;
  place_of_supply: string;
  is_inter_state: boolean;
  valid_until: string | null;
  terms: string | null;
  notes: string | null;
  subtotal: string;
  discount_total: string;
  taxable_total: string;
  cgst_total: string;
  sgst_total: string;
  igst_total: string;
  grand_total: string;
  sales_order_id: string | null;          // set once converted to a sales order
  sales_order_no: string | null;
  submitted_at: string | null;
  created_at: string;
  customer: {
    name: string;
    gstin: string | null;
    state_code: string | null;
    billing_address: Record<string, unknown>;
  };
  company: CompanySettingsDto;
  lines: QuotationLineDto[];
}

export interface QuotationListRow {
  id: string;
  doc_no: string | null;
  doc_date: string;
  status: string;
  customer_id: string;
  customer_name: string;
  valid_until: string | null;
  grand_total: string;
  sales_order_id: string | null;
  created_by: string | null;
  created_at: string;
}

// Sales order read-side DTOs
export interface SalesOrderLineDto {
  id: string;
  item_id: string | null;
  description: string;
  hsn_sac_code: string;
  qty: string;
  uom: string;
  rate: string;
  discount_pct: string;
  taxable_value: string;
  gst_rate: string;
  cgst_amount: string;
  sgst_amount: string;
  igst_amount: string;
  line_total: string;
  sort_order: number;
}

/** GET /api/sales/sales-orders/:id — header + lines + parties + billing status. */
export interface SalesOrderDetail {
  id: string;
  doc_no: string | null;
  doc_date: string;
  status: string;                         // draft | submitted | cancelled
  billing_status: string;                 // Not Billed | Partly Billed | Fully Billed (derived)
  customer_id: string;
  quotation_id: string | null;
  quotation_no: string | null;
  place_of_supply: string;
  is_inter_state: boolean;
  delivery_date: string | null;
  po_no: string | null;
  po_date: string | null;
  terms: string | null;
  notes: string | null;
  subtotal: string;
  discount_total: string;
  taxable_total: string;
  cgst_total: string;
  sgst_total: string;
  igst_total: string;
  rounding_adjustment: string;
  grand_total: string;
  submitted_at: string | null;
  created_at: string;
  customer: {
    name: string;
    gstin: string | null;
    state_code: string | null;
    billing_address: Record<string, unknown>;
  };
  company: CompanySettingsDto;
  lines: SalesOrderLineDto[];
  invoices: { id: string; doc_no: string | null; status: string; grand_total: string }[];
}

export interface SalesOrderListRow {
  id: string;
  doc_no: string | null;
  doc_date: string;
  status: string;
  billing_status: string;
  customer_id: string;
  customer_name: string;
  delivery_date: string | null;
  grand_total: string;
  created_by: string | null;
  created_at: string;
}

export interface ApiErrorBody {
  error: { code: string; message?: string; details?: unknown };
}
