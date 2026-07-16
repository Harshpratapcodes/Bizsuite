import pg from "pg";
import { loadDotEnv } from "./env.js";

loadDotEnv(); // .env (gitignored) fills anything the real environment didn't set

// NUMERIC comes back as string (pg default) — exactly what we want for money.
// DATABASE_URL (e.g. Neon, sslmode=require in the URL) wins over PG* vars.
// Cloud PG (Neon) handshakes can stall; pg's defaults wait FOREVER, turning one
// stalled connect into a permanently hung request (observed in E2E traces).
// Bounded waits fail fast instead — the client's retry then gets a fresh socket.
const limits = {
  max: 10,
  keepAlive: true,
  connectionTimeoutMillis: 10_000,
  query_timeout: 20_000,
} as const;

export const pool = new pg.Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL, ...limits }
    : {
        host: process.env.PGHOST,
        database: process.env.PGDATABASE ?? "bizsuite",
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        ...limits,
      },
);

// Cloud Postgres (Neon) drops idle connections; without a listener that's an
// unhandled 'error' event. The pool discards the dead client — log and move on.
pool.on("error", (err) => console.error("pg pool idle-client error:", err.message));

export type Tx = pg.PoolClient;

/**
 * Every business operation runs inside withTransaction:
 *  - sets app.user_id so audit triggers know the actor
 *  - deferred constraint triggers (journal balance, allocation caps) fire at COMMIT
 */
export async function withTransaction<T>(
  userId: string | null,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (userId) {
      await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    }
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
