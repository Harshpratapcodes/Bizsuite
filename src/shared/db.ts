import pg from "pg";
import { loadDotEnv } from "./env.js";

loadDotEnv(); // .env (gitignored) fills anything the real environment didn't set

// NUMERIC comes back as string (pg default) — exactly what we want for money.
// DATABASE_URL (e.g. Neon, sslmode=require in the URL) wins over PG* vars.
export const pool = new pg.Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL, max: 10 }
    : {
        host: process.env.PGHOST,
        database: process.env.PGDATABASE ?? "bizsuite",
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        max: 10,
      },
);

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
