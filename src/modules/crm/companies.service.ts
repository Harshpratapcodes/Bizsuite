import type { CreateCompanyInput, CompanyDto } from "@bizsuite/contracts";
import { pool, withTransaction } from "../../shared/db.js";
import { AppError, fromPgError } from "../../shared/errors.js";

/**
 * Companies master = customers and/or suppliers (the CRM account record, also
 * the party dimension for the receivables/payables sub-ledger). Schema enforces
 * unique lower(name), a GSTIN format check, and registered_needs_gstin.
 *
 * Both write paths RETURN THE FULL ROW, not just id+name. The customer picker
 * selects a freshly created company straight into a document builder, and a
 * row missing state_code there used to fall back to the SELLER's state and
 * produce CGST/SGST where IGST was correct (eng review 2026-09-10, T2).
 *
 * Every query is wrapped in fromPgError so unique-violation and CHECK failures
 * surface as typed 409/422 rather than a bare 500 (T3).
 */

const COLUMNS = `id, name, gstin, gst_treatment, state_code, industry, website,
                 billing_address, shipping_address, notes, is_customer, is_supplier,
                 is_active, created_at, updated_at`;

const SELECT = `SELECT ${COLUMNS} FROM companies`;

export type CompanyInput = CreateCompanyInput;
export type Company = CompanyDto;

export async function createCompany(input: CompanyInput, userId: string): Promise<Company> {
  try {
    return await withTransaction(userId, async (tx) => {
      const dup = await tx.query(`SELECT 1 FROM companies WHERE lower(name) = lower($1)`, [input.name]);
      if (dup.rowCount) throw new AppError("DUPLICATE_NAME", `A company named '${input.name}' already exists`, 409);

      const { rows: [row] } = await tx.query<Company>(
        `INSERT INTO companies
           (name, gstin, gst_treatment, state_code, industry, website,
            billing_address, shipping_address, notes, is_customer, is_supplier, created_by)
         VALUES ($1,$2,COALESCE($3::gst_treatment,'unregistered'),$4,$5,$6,
                 COALESCE($7::jsonb,'{}'::jsonb),COALESCE($8::jsonb,'{}'::jsonb),$9,
                 COALESCE($10,true),COALESCE($11,false),$12)
         RETURNING ${COLUMNS}`,
        [input.name, input.gstin ?? null, input.gstTreatment ?? null, input.stateCode ?? null,
         input.industry ?? null, input.website ?? null,
         input.billingAddress ?? null, input.shippingAddress ?? null, input.notes ?? null,
         input.isCustomer ?? null, input.isSupplier ?? null, userId],
      );
      return row!;
    });
  } catch (e) {
    // Two counters creating the same name concurrently race past the SELECT 1
    // above and land on uq_companies_name — same 409, not a 500.
    throw fromPgError(e);
  }
}

export async function listCompanies(
  opts: { role?: "customer" | "supplier"; activeOnly?: boolean; search?: string } = {},
): Promise<Company[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.role === "customer") where.push("is_customer");
  if (opts.role === "supplier") where.push("is_supplier");
  if (opts.activeOnly) where.push("is_active");
  if (opts.search) {
    params.push(`%${opts.search}%`);
    where.push(`(name ILIKE $${params.length} OR gstin ILIKE $${params.length})`);
  }
  const sql = `${SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY name LIMIT 500`;
  try {
    return (await pool.query<Company>(sql, params)).rows;
  } catch (e) { throw fromPgError(e); }
}

/**
 * Exact, case-insensitive lookup by name, ignoring the customer/supplier and
 * active filters. This is what the picker's quick-add uses to recover from a
 * DUPLICATE_NAME: the search endpoint is a substring match and can return
 * several rows, so taking rows[0] there could flip the WRONG company's flags
 * (eng review 2026-09-10, D15). Uniqueness on lower(name) makes this exact.
 */
export async function findCompanyByExactName(name: string): Promise<Company | null> {
  try {
    const { rows: [row] } = await pool.query<Company>(
      `${SELECT} WHERE lower(name) = lower($1)`, [name]);
    return row ?? null;
  } catch (e) { throw fromPgError(e); }
}

export async function getCompany(id: string): Promise<Company> {
  try {
    const { rows: [row] } = await pool.query<Company>(`${SELECT} WHERE id = $1`, [id]);
    if (!row) throw new AppError("NOT_FOUND", "Company not found", 404);
    return row;
  } catch (e) { throw fromPgError(e); }
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
  try {
    return await withTransaction(userId, async (tx) => {
      // Renaming onto an existing name is the same conflict as creating one,
      // so it gets the same typed 409 instead of a raw unique violation.
      if (typeof patch.name === "string") {
        const dup = await tx.query(
          `SELECT 1 FROM companies WHERE lower(name) = lower($1) AND id <> $2`, [patch.name, id]);
        if (dup.rowCount) throw new AppError("DUPLICATE_NAME", `A company named '${patch.name}' already exists`, 409);
      }
      const { rows: [row] } = await tx.query<Company>(
        `UPDATE companies SET ${sets.join(", ")} WHERE id = $1 RETURNING ${COLUMNS}`, params);
      if (!row) throw new AppError("NOT_FOUND", "Company not found", 404);
      return row;
    });
  } catch (e) { throw fromPgError(e); }
}
