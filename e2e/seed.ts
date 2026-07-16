/**
 * E2E seed — run by playwright's globalSetup via `npx tsx e2e/seed.ts`.
 * Creates a fresh admin + counter (sales role) user and a customer with a
 * known opening balance, then writes credentials/ids to e2e/.seed.json for
 * the specs. Unique names per run; nothing is ever deleted (append-only DB).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, withTransaction } from "../src/shared/db.js";
import { createUser } from "../src/core/auth.js";
import { enterOpeningBalance } from "../src/modules/accounting/opening-balance.js";
import { lockStock, receiveStock } from "../src/modules/inventory/service.js";
import { toPaise } from "../src/shared/money.js";

async function main() {
  const stamp = Date.now();

  await pool.query(
    `INSERT INTO company_settings (id, legal_name, gstin, state_code)
     VALUES (1,'Harsh Trading Co','09ABCDE1234F1Z5','09')
     ON CONFLICT (id) DO UPDATE SET state_code='09', gstin=EXCLUDED.gstin`);

  const admin = { email: `e2e_admin_${stamp}@test.com`, password: "E2ePass!9" };
  const counter = { email: `e2e_counter_${stamp}@test.com`, password: "E2ePass!9" };
  const { id: adminId } = await createUser({
    email: admin.email, fullName: "E2E Admin", password: admin.password, roleName: "admin",
  });
  await createUser({
    email: counter.email, fullName: "E2E Counter", password: counter.password, roleName: "sales",
  });

  const customerName = `E2E Traders ${stamp}`;
  const { rows: [customer] } = await pool.query<{ id: string }>(
    `INSERT INTO companies (name, gst_treatment, state_code)
     VALUES ($1, 'unregistered', '09') RETURNING id`, [customerName]);

  await enterOpeningBalance({ customerId: customer!.id, amount: "30000.00" }, adminId);

  // --- Invoice-rail fixtures (separate customer so the khata spec's balance
  // assertions on the customer above stay untouched) -------------------------
  const invCustomerName = `E2E Power Systems ${stamp}`;
  const { rows: [invCustomer] } = await pool.query<{ id: string }>(
    `INSERT INTO companies (name, gstin, gst_treatment, state_code)
     VALUES ($1, '09AAACP1234B1Z6', 'registered', '09') RETURNING id`, [invCustomerName]); // 09 = intra-state

  const { rows: [wh] } = await pool.query<{ id: string }>(
    `INSERT INTO warehouses (name) VALUES ('E2E-WH-' || $1) RETURNING id`, [String(stamp)]);

  const upsName = `Luminous UPS 1kVA E2E ${stamp}`;
  const { rows: [ups] } = await pool.query<{ id: string }>(
    `INSERT INTO items (sku, name, hsn_sac_code, gst_rate, standard_selling_rate)
     VALUES ('E2E-UPS-' || $1, $2, '8504', 18, 12000.00) RETURNING id`, [String(stamp), upsName]);
  const stabName = `Servo Stabilizer 5kVA E2E ${stamp}`;
  const { rows: [stab] } = await pool.query<{ id: string }>(
    `INSERT INTO items (sku, name, hsn_sac_code, gst_rate, standard_selling_rate)
     VALUES ('E2E-STAB-' || $1, $2, '8504', 18, 9000.00) RETURNING id`, [String(stamp), stabName]);

  // UPS: 5 on hand (golden journey sells 2) · Stabilizer: 1 on hand
  // (insufficient-stock rail asks for 3, then edits down to 1).
  await withTransaction(adminId, async (tx) => {
    const lines = [
      { itemId: ups!.id, warehouseId: wh!.id, qty: "5.000", ratePaise: toPaise("8000.00") },
      { itemId: stab!.id, warehouseId: wh!.id, qty: "1.000", ratePaise: toPaise("6000.00") },
    ];
    const locked = await lockStock(tx, lines);
    await receiveStock(tx, locked, lines, { type: "purchase_receipt", id: crypto.randomUUID() }, adminId);
  });

  const seed = {
    admin, counter,
    customer: { id: customer!.id, name: customerName },
    invoiceCustomer: { id: invCustomer!.id, name: invCustomerName },
    warehouse: { id: wh!.id, name: `E2E-WH-${stamp}` },
    items: {
      ups: { id: ups!.id, name: upsName },
      stab: { id: stab!.id, name: stabName },
    },
  };
  const out = path.resolve(fileURLToPath(new URL(".", import.meta.url)), ".seed.json");
  fs.writeFileSync(out, JSON.stringify(seed, null, 2));
  console.log(`seeded: ${customerName}`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
