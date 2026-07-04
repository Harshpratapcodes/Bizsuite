import crypto from "node:crypto";
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import { pool, withTransaction } from "../shared/db.js";
import { AppError } from "../shared/errors.js";

/**
 * Authentication: argon2id password hashing + server-side sessions.
 *
 * Session model (per schema.sql, table `sessions`):
 *   - a random 256-bit token is generated at login and returned to the client
 *     in an httpOnly cookie;
 *   - only its SHA-256 hash is stored as sessions.id, so a database leak does
 *     not hand out usable session tokens;
 *   - validation re-hashes the cookie value and looks it up, checking expiry
 *     and that the user is still active.
 */

const SESSION_TTL_DAYS = 30;

// argon2id parameters — OWASP-recommended baseline (19 MiB, t=2, p=1).
const ARGON_OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  roleId: string;
  roleName: string;
}

export function hashPassword(plain: string): Promise<string> {
  return argonHash(plain, ARGON_OPTS);
}

export function verifyPassword(storedHash: string, plain: string): Promise<boolean> {
  return argonVerify(storedHash, plain).catch(() => false);
}

/** Raw token for the cookie; never stored. */
function newSessionToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** What we persist: a hash of the token, so the DB never holds the live secret. */
function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export interface CreateUserInput {
  email: string;
  fullName: string;
  password: string;
  roleName: string;
}

/** Create a user with a hashed password, resolving the role by name. */
export async function createUser(input: CreateUserInput): Promise<{ id: string }> {
  const passwordHash = await hashPassword(input.password);
  return withTransaction(null, async (tx) => {
    const { rows: [role] } = await tx.query<{ id: string }>(
      `SELECT id FROM roles WHERE name = $1`, [input.roleName],
    );
    if (!role) throw new AppError("UNKNOWN_ROLE", `Role '${input.roleName}' not found`, 422);

    const { rows: [user] } = await tx.query<{ id: string }>(
      `INSERT INTO users (email, full_name, password_hash, role_id)
       VALUES (lower($1), $2, $3, $4)
       RETURNING id`,
      [input.email, input.fullName, passwordHash, role.id],
    );
    return { id: user!.id };
  });
}

export interface LoginMeta {
  ip?: string | null;
  userAgent?: string | null;
}

/** Verify credentials and open a session. Returns the raw token + user, or
 *  null on any failure (unknown email, bad password, inactive user) — the
 *  caller must not distinguish these to the client. */
export async function login(
  email: string, password: string, meta: LoginMeta = {},
): Promise<{ token: string; user: AuthUser } | null> {
  const { rows: [row] } = await pool.query<{
    id: string; email: string; full_name: string; password_hash: string;
    role_id: string; role_name: string; is_active: boolean;
  }>(
    `SELECT u.id, u.email, u.full_name, u.password_hash,
            u.role_id, r.name AS role_name, u.is_active
       FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.email = lower($1)`,
    [email],
  );
  if (!row || !row.is_active) return null;
  if (!(await verifyPassword(row.password_hash, password))) return null;

  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);
  await pool.query(
    `INSERT INTO sessions (id, user_id, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [hashToken(token), row.id, expiresAt, meta.ip ?? null, meta.userAgent ?? null],
  );
  await pool.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [row.id]);

  return {
    token,
    user: { id: row.id, email: row.email, fullName: row.full_name,
            roleId: row.role_id, roleName: row.role_name },
  };
}

/** Resolve a cookie token to the live user, or null if invalid/expired. */
export async function validateSession(token: string): Promise<AuthUser | null> {
  const { rows: [row] } = await pool.query<{
    id: string; email: string; full_name: string; role_id: string; role_name: string;
  }>(
    `SELECT u.id, u.email, u.full_name, u.role_id, r.name AS role_name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN roles r ON r.id = u.role_id
      WHERE s.id = $1 AND s.expires_at > now() AND u.is_active`,
    [hashToken(token)],
  );
  if (!row) return null;
  return { id: row.id, email: row.email, fullName: row.full_name,
           roleId: row.role_id, roleName: row.role_name };
}

/** Revoke a session (idempotent). */
export async function logout(token: string): Promise<void> {
  await pool.query(`DELETE FROM sessions WHERE id = $1`, [hashToken(token)]);
}
