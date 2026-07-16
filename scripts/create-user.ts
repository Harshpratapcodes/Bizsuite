/**
 * Create a user from the CLI (no admin UI yet — blueprint Phase 1 item).
 *
 *   npx tsx scripts/create-user.ts <email> <full name> <password> <role>
 *
 * Roles (seeded): admin | accounts | sales | inventory | readonly
 * Counter staff = 'sales' (can draft+submit invoices/payments, cannot cancel).
 */
import { createUser } from "../src/core/auth.js";
import { pool } from "../src/shared/db.js";

const [email, fullName, password, roleName] = process.argv.slice(2);

if (!email || !fullName || !password || !roleName) {
  console.error('Usage: npx tsx scripts/create-user.ts <email> "<full name>" <password> <role>');
  console.error("Roles: admin | accounts | sales | inventory | readonly");
  process.exit(1);
}

const { id } = await createUser({ email, fullName, password, roleName });
console.log(`Created ${roleName} user ${email} (${id})`);
await pool.end();
