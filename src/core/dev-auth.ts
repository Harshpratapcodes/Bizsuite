import crypto from "node:crypto";
import { pool } from "../shared/db.js";
import { createUser, type AuthUser } from "./auth.js";

/**
 * Development-only login bypass (DEV_AUTH_BYPASS=true).
 *
 * When active, `requireAuth` attaches a real database user to every request
 * instead of validating a session cookie, so the SPA comes up already logged
 * in and no password is needed locally.
 *
 * It resolves a REAL `users` row (never a synthetic object) because the rest
 * of the system depends on that being true: RBAC reads `role_permissions` by
 * `roleId`, and the audit triggers write `app.user_id` as a foreign key into
 * `users`. A fake id would either bypass the permission matrix or blow up
 * every INSERT on the audit log.
 *
 * Fail-closed by construction:
 *   - `devBypassEnabled()` returns false whenever NODE_ENV === "production",
 *     even if the flag is set, so a leaked env var cannot open production;
 *   - `assertDevBypassSafe()` refuses to boot at all in that combination,
 *     turning a silent misconfiguration into a crash on startup.
 */

const DEV_EMAIL = () => process.env.DEV_AUTH_EMAIL ?? "dev@localhost";
const DEV_ROLE = () => process.env.DEV_AUTH_ROLE ?? "admin";

function flagSet(): boolean {
  return process.env.DEV_AUTH_BYPASS === "true";
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/** True only when the bypass is both requested and safe to honour. */
export function devBypassEnabled(): boolean {
  return flagSet() && !isProduction();
}

/**
 * Startup guard: crash rather than run a production build with the bypass set.
 * Called from server.ts before the listener binds.
 */
export function assertDevBypassSafe(): void {
  if (flagSet() && isProduction()) {
    throw new Error(
      "DEV_AUTH_BYPASS=true with NODE_ENV=production — refusing to start. " +
        "The login bypass is for local development only; unset DEV_AUTH_BYPASS.",
    );
  }
  if (devBypassEnabled()) {
    console.warn(
      `\n  ⚠  DEV_AUTH_BYPASS is ON — authentication is disabled.\n` +
        `     Every request runs as '${DEV_EMAIL()}' (role: ${DEV_ROLE()}).\n` +
        `     Local development only. Never set this in a deployed environment.\n`,
    );
  }
}

/** Cached so the lookup is one query per process, not one per request. */
let cached: AuthUser | null = null;

async function lookup(email: string): Promise<AuthUser | null> {
  const { rows: [row] } = await pool.query<{
    id: string; email: string; full_name: string; role_id: string; role_name: string;
  }>(
    `SELECT u.id, u.email, u.full_name, u.role_id, r.name AS role_name
       FROM users u
       JOIN roles r ON r.id = u.role_id
      WHERE u.email = $1 AND u.is_active`,
    [email],
  );
  if (!row) return null;
  return {
    id: row.id, email: row.email, fullName: row.full_name,
    roleId: row.role_id, roleName: row.role_name,
  };
}

/**
 * The user every request runs as while the bypass is on. Provisioned on first
 * use if absent, with a random password that is never printed or stored
 * anywhere — the account is unusable through the normal login form by design.
 */
export async function getDevUser(): Promise<AuthUser> {
  if (cached) return cached;

  const email = DEV_EMAIL();
  const existing = await lookup(email);
  if (existing) return (cached = existing);

  await createUser({
    email,
    fullName: "Dev Bypass",
    password: crypto.randomBytes(32).toString("base64url"),
    roleName: DEV_ROLE(),
  });
  console.warn(`  ⚠  DEV_AUTH_BYPASS: provisioned '${email}' (role: ${DEV_ROLE()}).`);

  const created = await lookup(email);
  if (!created) {
    throw new Error(`DEV_AUTH_BYPASS: could not provision dev user '${email}'`);
  }
  return (cached = created);
}
