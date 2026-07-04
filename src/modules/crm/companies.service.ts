import { pool, withTransaction } from "../../shared/db.js";
import { AppError } from "../../shared/errors.js";

/**
 * Companies master = customers and/or suppliers (the CRM account record, also
 * the party dimension for the receivables/payables sub-ledger). Schema enforces
 * unique lower(name), a GSTIN format check, and registered_needs_gstin.
 */

export interface CompanyInput {
  name: string;
  gstin?: string | null;
  gstTreatment?: "registered" | "unregistered" | "overseas" | "sez";
  stateCode?: string | null;
  industry?: string | null;
  website?: string | null;
  billingAddress?: Record<string, unknown>;
  shippingAddress?: Record<string, unknown>;
  notes?: string | null;
  isCustomer?: boolean;
  isSupplier?: boolean;
}

export interface Company extends Record<string, unknown> {
  id: string;
  name: string;
}

const SELECT = `
  SELECT id, name, gstin, gst_treatment, state_code, industry, website,
         billing_address, shipping_address, notes, is_customer, is_supplier,
         is_active, created_at, updated_at
    FROM companies`;

export async function createCompany(input: CompanyInput, userId: string): Promise<Company> {
  return withTransaction(userId, async (tx) => {
    const dup = await tx.query(`SELECT 1 FROM companies WHERE lower(name) = lower($1)`, [input.name]);
    if (dup.rowCount) throw new AppError("DUPLICATE_NAME", `A company named '${input.name}' already exists`, 409);

    const { rows: [row] } = await tx.query<Company>(
      `INSERT INTO companies
         (name, gstin, gst_treatment, state_code, industry, website,
          billing_address, shipping_address, notes, is_customer, is_supplier, created_by)
       VALUES ($1,$2,COALESCE($3::gst_treatment,'unregistered'),$4,$5,$6,
               COALESCE($7::jsonb,'{}'::jsonb),COALESCE($8::jsonb,'{}'::jsonb),$9,
               COALESCE($10,true),COALESCE($11,false),$12)
       RETURNING id, name`,
      [input.name, input.gstin ?? null, input.gstTreatment ?? null, input.stateCode ?? null,
       input.industry ?? null, input.website ?? null,
       input.billingAddress ?? null, input.shippingAddress ?? null, input.notes ?? null,
       input.isCustomer ?? null, input.isSupplier ?? null, userId],
    );
    return row!;
  });
}

export async function listCompanies(opts: { role?: "customer" | "supplier"; activeOnly?: boolean; search?: string } = {}): Promise<Company[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.role === "customer") where.push("is_customer");
  if (opts.role === "supplier") where.push("is_supplier");
  if (opts.activeOnly) where.push("is_active");
  if (opts.search) { params.push(`%${opts.search}%`); where.push(`name ILIKE $${params.length}`); }
  const sql = `${SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY name LIMIT 500`;
  return (await pool.query<Company>(sql, params)).rows;
}

export async function getCompany(id: string): Promise<Company> {
  const { rows: [row] } = await pool.query<Company>(`${SELECT} WHERE id = $1`, [id]);
  if (!row) throw new AppError("NOT_FOUND", "Company not found", 404);
  return row;
}

// column name + optional cast for parameters that don't implicitly coerce
const UPDATABLE: Record<string, { col: string; cast?: string }> = {
  name: { col: "name" },
  gstin: { col: "gstin" },
  gstTreatment: { col: "gst_treatment", cast: "gst_treatment" },
  stateCode: { col: "state_code" },
  industry: { col: "industry" },
  website: { col: "website" },
  billingAddress: { col: "billing_address", cast: "jsonb" },
  shippingAddress: { col: "shipping_address", cast: "jsonb" },
  notes: { col: "notes" },
  isCustomer: { col: "is_customer" },
  isSupplier: { col: "is_supplier" },
  isActive: { col: "is_active" },
};

export async function updateCompany(id: string, patch: Record<string, unknown>, userId: string): Promise<Company> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  for (const [key, { col, cast }] of Object.entries(UPDATABLE)) {
    if (key in patch) {
      params.push(patch[key]);
      sets.push(`${col} = $${params.length}${cast ? `::${cast}` : ""}`);
    }
  }
  if (!sets.length) return getCompany(id);
  return withTransaction(userId, async (tx) => {
    const { rows: [row] } = await tx.query<Company>(
      `UPDATE companies SET ${sets.join(", ")} WHERE id = $1 RETURNING id, name`, params);
    if (!row) throw new AppError("NOT_FOUND", "Company not found", 404);
    return row;
  });
}
