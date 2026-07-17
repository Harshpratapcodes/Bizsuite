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

/** Convert a submitted quotation into a draft invoice; warehouse is needed
 *  because invoices issue stock and quotations don't carry one. */
export const ConvertQuotation = z.object({
  warehouseId: z.string().uuid(),
  dueDate: isoDate.optional(),
});
export type ConvertQuotationInput = z.infer<typeof ConvertQuotation>;

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
// Accounting
// ---------------------------------------------------------------------------
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
  converted_invoice_id: string | null;
  converted_invoice_no: string | null;
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
  converted_invoice_id: string | null;
  created_by: string | null;
  created_at: string;
}

export interface ApiErrorBody {
  error: { code: string; message?: string; details?: unknown };
}
