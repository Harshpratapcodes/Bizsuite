/**
 * E2E seed — run by playwright's globalSetup via `npx tsx e2e/seed.ts`.
 * Creates a fresh admin + counter (sales role) user and a customer with a
 * known opening balance, then writes credentials/ids to e2e/.seed.json for
 * the specs. Unique names per run; nothing is ever deleted (append-only DB).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../src/shared/db.js";
import { createUser } from "../src/core/auth.js";
import { enterOpeningBalance } from "../src/modules/accounting/opening-balance.js";

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

  const seed = { admin, counter, customer: { id: customer!.id, name: customerName } };
  const out = path.resolve(fileURLToPath(new URL(".", import.meta.url)), ".seed.json");
  fs.writeFileSync(out, JSON.stringify(seed, null, 2));
  console.log(`seeded: ${customerName}`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
