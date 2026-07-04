import type { Tx } from "../shared/db.js";

/** Gapless, race-free document number. Must be called inside the
 *  submitting transaction — the row lock serializes concurrent submitters. */
export async function nextDocNumber(tx: Tx, series: string): Promise<string> {
  const { rows } = await tx.query<{ next_doc_number: string }>(
    "SELECT next_doc_number($1)",
    [series],
  );
  return rows[0]!.next_doc_number;
}
