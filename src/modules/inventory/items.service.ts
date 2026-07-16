import { pool, withTransaction } from "../../shared/db.js";
import { AppError } from "../../shared/errors.js";

/**
 * Items master (CRUD). Items are mutable masters (no submit lifecycle) — the
 * schema's audit trigger records every change, and updated_at is maintained by
 * a trigger. Money rates are passed as decimal strings to keep floats out.
 */

export interface ItemInput {
  sku: string;
  name: string;
  description?: string | null;
  uom?: string;
  hsnSacCode: string;
  gstRate: number;
  isStockItem?: boolean;
  reorderLevel?: string | null;
  standardSellingRate?: string | null;
  standardBuyingRate?: string | null;
}

export interface Item extends Record<string, unknown> {
  id: string;
  sku: string;
  name: string;
}

// on_hand: live stock summed across warehouses (single-warehouse in practice) —
// shown in the item picker so staff see availability BEFORE submit fails.
const SELECT = `
  SELECT i.id, i.sku, i.name, i.description, i.uom, i.hsn_sac_code, i.gst_rate,
         i.is_stock_item, i.reorder_level, i.standard_selling_rate, i.standard_buying_rate,
         i.is_active, i.created_at, i.updated_at,
         COALESCE(w.on_hand, 0)::text AS on_hand
    FROM items i
    LEFT JOIN (SELECT item_id, SUM(qty_on_hand) AS on_hand
                 FROM item_warehouse GROUP BY item_id) w ON w.item_id = i.id`;

export async function createItem(input: ItemInput, userId: string): Promise<Item> {
  return withTransaction(userId, async (tx) => {
    const dup = await tx.query(`SELECT 1 FROM items WHERE sku = $1`, [input.sku]);
    if (dup.rowCount) throw new AppError("DUPLICATE_SKU", `SKU '${input.sku}' already exists`, 409);

    const { rows: [row] } = await tx.query<Item>(
      `INSERT INTO items
         (sku, name, description, uom, hsn_sac_code, gst_rate, is_stock_item,
          reorder_level, standard_selling_rate, standard_buying_rate)
       VALUES ($1,$2,$3,COALESCE($4,'Nos'),$5,$6,COALESCE($7,true),$8,$9,$10)
       RETURNING id, sku, name`,
      [input.sku, input.name, input.description ?? null, input.uom ?? null,
       input.hsnSacCode, input.gstRate, input.isStockItem ?? null,
       input.reorderLevel ?? null, input.standardSellingRate ?? null, input.standardBuyingRate ?? null],
    );
    return row!;
  });
}

export async function listItems(opts: { activeOnly?: boolean; search?: string } = {}): Promise<Item[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.activeOnly) where.push("is_active");
  if (opts.search) { params.push(`%${opts.search}%`); where.push(`(name ILIKE $${params.length} OR sku ILIKE $${params.length})`); }
  const sql = `${SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY name LIMIT 500`;
  return (await pool.query<Item>(sql, params)).rows;
}

export async function getItem(id: string): Promise<Item> {
  const { rows: [row] } = await pool.query<Item>(`${SELECT} WHERE id = $1`, [id]);
  if (!row) throw new AppError("NOT_FOUND", "Item not found", 404);
  return row;
}

const UPDATABLE: Record<string, string> = {
  name: "name", description: "description", uom: "uom", hsnSacCode: "hsn_sac_code",
  gstRate: "gst_rate", isStockItem: "is_stock_item", reorderLevel: "reorder_level",
  standardSellingRate: "standard_selling_rate", standardBuyingRate: "standard_buying_rate",
  isActive: "is_active",
};

export async function updateItem(id: string, patch: Record<string, unknown>, userId: string): Promise<Item> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  for (const [key, col] of Object.entries(UPDATABLE)) {
    if (key in patch) { params.push(patch[key]); sets.push(`${col} = $${params.length}`); }
  }
  if (!sets.length) return getItem(id);
  return withTransaction(userId, async (tx) => {
    const { rows: [row] } = await tx.query<Item>(
      `UPDATE items SET ${sets.join(", ")} WHERE id = $1 RETURNING id, sku, name`, params);
    if (!row) throw new AppError("NOT_FOUND", "Item not found", 404);
    return row;
  });
}
