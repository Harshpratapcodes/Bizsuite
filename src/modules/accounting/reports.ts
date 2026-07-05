import { pool } from "../../shared/db.js";
import type { KhataRow, KhataReport, DigestData, Digest } from "@bizsuite/contracts";

/**
 * Read-side reports for the khata (receivables) and the Friday digest.
 * Everything derives from views — no report ever recomputes ledger math.
 *
 * IMPORTANT (eng review, outside-voice note): the khata reads v_party_balances,
 * NOT v_invoice_outstanding — opening balances are party-level journal lumps
 * with no invoice rows, and only the party view sees them.
 */

export type { KhataRow, KhataReport, DigestData, Digest };

export async function khataReport(): Promise<KhataReport> {
  const { rows } = await pool.query<{ party_id: string; party_name: string; balance: string }>(
    `SELECT party_id, party_name, balance::text
       FROM v_party_balances
      WHERE party_type = 'customer' AND balance <> 0
      ORDER BY balance DESC`);
  const total = rows.reduce((s, r) => (Number(r.balance) > 0 ? s + Number(r.balance) : s), 0);
  return {
    rows: rows.map((r) => ({ partyId: r.party_id, partyName: r.party_name, balance: r.balance })),
    totalReceivable: total.toFixed(2),
    asOf: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Friday digest — the WhatsApp text dad actually reads. Content per design doc:
// total receivables, top-5 debtors, this week's sales (+ payments received,
// because "kitna aaya" is the natural sibling of "kitna baaki hai").
// ---------------------------------------------------------------------------
/** ₹ formatting with Indian digit grouping (1,23,456.78). */
function inr(decimal: string | number): string {
  const n = typeof decimal === "number" ? decimal : Number(decimal);
  return "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Monday..Sunday window containing `ref` (digest goes out Friday, covers the week so far). */
function weekWindow(ref: Date): { start: string; end: string } {
  const d = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate()));
  const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();  // Mon=1..Sun=7
  const monday = new Date(d); monday.setUTCDate(d.getUTCDate() - (dow - 1));
  const sunday = new Date(monday); sunday.setUTCDate(monday.getUTCDate() + 6);
  return { start: monday.toISOString().slice(0, 10), end: sunday.toISOString().slice(0, 10) };
}

export async function fridayDigest(ref = new Date()): Promise<Digest> {
  const { start, end } = weekWindow(ref);

  const khata = await khataReport();
  const topDebtors = khata.rows.filter((r) => Number(r.balance) > 0).slice(0, 5);

  const { rows: [sales] } = await pool.query<{ total: string; count: string }>(
    `SELECT COALESCE(sum(grand_total),0)::text AS total, count(*)::text AS count
       FROM invoices
      WHERE status = 'submitted' AND kind = 'invoice' AND doc_date BETWEEN $1 AND $2`,
    [start, end]);

  const { rows: [pays] } = await pool.query<{ total: string; count: string }>(
    `SELECT COALESCE(sum(amount),0)::text AS total, count(*)::text AS count
       FROM payment_entries
      WHERE status = 'submitted' AND doc_date BETWEEN $1 AND $2`,
    [start, end]);

  const data: DigestData = {
    weekStart: start, weekEnd: end,
    totalReceivable: khata.totalReceivable,
    topDebtors,
    weekSalesTotal: sales!.total, weekSalesCount: Number(sales!.count),
    weekPaymentsTotal: pays!.total, weekPaymentsCount: Number(pays!.count),
  };

  const lines: string[] = [];
  lines.push(`📒 Friday ka hisaab (${formatDMY(start)} – ${formatDMY(end)})`);
  lines.push("");
  lines.push(`💰 Total udhaar (baaki): ${inr(data.totalReceivable)}`);
  if (topDebtors.length > 0) {
    lines.push("");
    lines.push("Top baaki wale:");
    topDebtors.forEach((d, i) => lines.push(`  ${i + 1}. ${d.partyName} — ${inr(d.balance)}`));
  } else {
    lines.push("Koi udhaar baaki nahi 🎉");
  }
  lines.push("");
  lines.push(`🧾 Is hafte ki sale: ${inr(data.weekSalesTotal)} (${data.weekSalesCount} bill)`);
  lines.push(`✅ Is hafte aaya: ${inr(data.weekPaymentsTotal)} (${data.weekPaymentsCount} payment)`);

  return { text: lines.join("\n"), data };
}

function formatDMY(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y!.slice(2)}`;
}
