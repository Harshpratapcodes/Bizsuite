/**
 * Reset a user's password from the CLI (no admin UI / self-serve reset yet —
 * blueprint Phase 1 item, same status as scripts/create-user.ts).
 *
 *   npx tsx scripts/reset-password.ts <email> <new password>
 *
 * Also revokes every live session for the user, so anyone holding the old
 * login is logged out.
 */
import { hashPassword } from "../src/core/auth.js";
import { pool } from "../src/shared/db.js";

const [email, password] = process.argv.slice(2);

if (!email || !password) {
  console.error("Usage: npx tsx scripts/reset-password.ts <email> <new password>");
  process.exit(1);
}

const { rows: [user] } = await pool.query<{ id: string }>(
  `SELECT id FROM users WHERE email = $1`, [email]);
if (!user) {
  console.error(`No user with email ${email}`);
  process.exit(1);
}

await pool.query(`UPDATE users SET password_hash = $2 WHERE id = $1`,
  [user.id, await hashPassword(password)]);
const { rowCount } = await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [user.id]);
console.log(`Password reset for ${email}; ${rowCount ?? 0} session(s) revoked.`);
await pool.end();
