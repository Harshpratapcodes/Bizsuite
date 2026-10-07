/**
 * One address formatter for every printed document.
 *
 * Was copy-pasted verbatim into InvoiceDetail, QuotationDetail and
 * SalesOrderDetail — 13 identical lines in three files, so a fix to the print
 * layout landed in one and silently missed two (eng review 2026-09-10, T9).
 *
 * Addresses are jsonb, so old rows carry whatever keys someone chose at the
 * time. The typed shape (@bizsuite/contracts Address) is rendered first, in a
 * fixed order; anything else still renders afterwards so legacy rows are never
 * dropped.
 *
 * `state` is skipped on purpose. Every document prints the authoritative state
 * — derived from companies.state_code — on its own line directly beneath the
 * address. A free-text state stored inside the address blob would print beside
 * it and could disagree, putting two different states on one tax invoice.
 */

/** Typed Address keys first, then legacy aliases, in print order. */
const PREFERRED = ["line1", "line2", "street", "area", "city", "district", "pincode", "pin"];

/** Never printed from the address blob — see the note above. */
const SKIP = new Set(["state", "state_code", "statecode"]);

export function fmtAddress(a: Record<string, unknown>): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const k of PREFERRED) {
    const v = a[k];
    if (typeof v === "string" && v) { parts.push(v); seen.add(k); }
  }
  for (const [k, v] of Object.entries(a)) {
    if (seen.has(k) || SKIP.has(k.toLowerCase())) continue;
    if (typeof v === "string" && v) parts.push(v);
  }
  return parts.join(", ");
}
