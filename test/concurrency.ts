/** THE inventory race: N parallel submissions competing for stock that can
 *  satisfy only one. Exactly one must win; losers must roll back cleanly. */
import { pool, withTransaction } from "../src/shared/db.js";
import { lockStock, receiveStock } from "../src/modules/inventory/service.js";
import { createDraftInvoice, invoiceLifecycle } from "../src/modules/invoicing/service.js";
import { toPaise } from "../src/shared/money.js";

const q = async <T extends Record<string, unknown>>(sql: string, p: unknown[] = []) =>
  (await pool.query<T>(sql, p)).rows;

async function main() {
  const [u] = await q<{ id: string }>(
    `INSERT INTO users (email, full_name, password_hash, role_id)
     VALUES ('race@test.com','Racer','x',(SELECT id FROM roles WHERE name='admin'))
     ON CONFLICT (email) DO UPDATE SET full_name=EXCLUDED.full_name RETURNING id`);
  const userId = u!.id;
  const [c] = await q<{ id: string }>(`INSERT INTO companies (name) VALUES ('Race Co ' || gen_random_uuid()) RETURNING id`);
  const [w] = await q<{ id: string }>(`INSERT INTO warehouses (name) VALUES ('Race-WH-' || gen_random_uuid()) RETURNING id`);
  const [i] = await q<{ id: string }>(
    `INSERT INTO items (sku, name, hsn_sac_code, gst_rate)
     VALUES ('RACE-' || substr(gen_random_uuid()::text,1,8), 'Last Widget', '8471', 18) RETURNING id`);

  // exactly ONE unit in stock
  await withTransaction(userId, async (tx) => {
    const lines = [{ itemId: i!.id, warehouseId: w!.id, qty: "1.000", ratePaise: toPaise("500.00") }];
    await receiveStock(tx, await lockStock(tx, lines), lines, { type: "purchase_receipt", id: crypto.randomUUID() }, userId);
  });

  // five drafts, each wanting that one unit
  const N = 5;
  const drafts = await Promise.all(Array.from({ length: N }, () =>
    createDraftInvoice({
      customerId: c!.id, warehouseId: w!.id, placeOfSupply: "09",
      lines: [{ itemId: i!.id, description: "Last Widget", hsn: "8471", qty: "1.000", rate: "999.00", gstRate: 18 }],
    }, userId)));

  // fire all submissions truly in parallel
  const results = await Promise.allSettled(drafts.map((d) => invoiceLifecycle.submit(d.id, userId)));
  const wins = results.filter((r) => r.status === "fulfilled");
  const losses = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];

  console.log(`parallel submitters: ${N}`);
  console.log(`winners: ${wins.length}  losers: ${losses.length}`);
  console.log(`loser error codes: ${[...new Set(losses.map((l) => (l.reason as { code?: string }).code))].join(", ")}`);

  const [stock] = await q<{ qty_on_hand: string }>(
    `SELECT qty_on_hand::text FROM item_warehouse WHERE item_id=$1 AND warehouse_id=$2`, [i!.id, w!.id]);
  const [gl] = await q<{ ok: boolean }>(`SELECT ok FROM fn_verify_gl() WHERE check_name='gl_sums_to_zero'`);
  const mism = await q(`SELECT * FROM fn_verify_stock_cache()`);

  const pass = wins.length === 1
    && losses.every((l) => (l.reason as { code?: string }).code === "INSUFFICIENT_STOCK")
    && stock!.qty_on_hand === "0.000" && gl!.ok && mism.length === 0;

  console.log(`final stock: ${stock!.qty_on_hand} | GL balanced: ${gl!.ok} | cache mismatches: ${mism.length}`);
  console.log(pass ? "\nCONCURRENCY TEST: PASS — exactly one sale succeeded" : "\nCONCURRENCY TEST: FAIL");
  await pool.end();
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
