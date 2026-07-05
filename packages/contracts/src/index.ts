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
  dueDate: isoDate.optional(),
  lines: z.array(z.object({
    itemId: z.string().uuid(),
    description: z.string().min(1),
    hsn: z.string().regex(/^[0-9]{4,8}$/),
    qty,
    rate: money,
    discountPct: z.number().min(0).max(100).optional(),
    gstRate: z.number(),
  })).min(1),
});
export type CreateInvoiceInput = z.infer<typeof CreateInvoice>;

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

export interface ApiErrorBody {
  error: { code: string; message?: string; details?: unknown };
}
