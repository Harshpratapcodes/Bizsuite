import pg from "pg";

// NUMERIC comes back as string (pg default) — exactly what we want for money.
export const pool = new pg.Pool({
  host: process.env.PGHOST,
  database: process.env.PGDATABASE ?? "bizsuite",
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  max: 10,
});

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
