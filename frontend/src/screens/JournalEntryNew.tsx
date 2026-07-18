import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CreateJournalEntry, type AccountNodeDto } from "@bizsuite/contracts";
import { api, friendlyMessage } from "../api";
import { inr } from "./Khata";

/**
 * Manual journal builder — pick accounts, enter a debit or credit per line,
 * watch the running Dr/Cr totals. Posting is blocked until the entry balances
 * (the server re-checks, and the DB deferred trigger is the final guard).
 */
interface LineDraft { key: number; accountId: string; side: "debit" | "credit"; amount: string; remarks: string; }
let lineKey = 1;
const newLine = (): LineDraft => ({ key: lineKey++, accountId: "", side: "debit", amount: "", remarks: "" });
const today = (): string => new Date().toISOString().slice(0, 10);
const amt = (s: string): number => (/^\d+(\.\d{1,2})?$/.test(s) ? Number(s) : 0);

export function JournalEntryNewScreen() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [postingDate, setPostingDate] = useState(today());
  const [narration, setNarration] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([newLine(), newLine()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api.get<AccountNodeDto[]>("/api/accounting/accounts"),
  });
  const postable = useMemo(
    () => (accounts.data ?? []).filter((a) => !a.isGroup && a.isActive).sort((a, b) => a.code.localeCompare(b.code)),
    [accounts.data]);

  function patch(key: number, p: Partial<LineDraft>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)));
  }
  function removeLine(key: number) {
    setLines((ls) => (ls.length > 2 ? ls.filter((l) => l.key !== key) : ls));
  }

  const totalDebit = lines.reduce((s, l) => s + (l.side === "debit" ? amt(l.amount) : 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.side === "credit" ? amt(l.amount) : 0), 0);
  const difference = Math.round((totalDebit - totalCredit) * 100) / 100;
  const balanced = difference === 0 && totalDebit > 0;
  const futureDated = postingDate > today();
  const allLinesValid = lines.every((l) => l.accountId && amt(l.amount) > 0);

  const payload = useMemo(() => ({
    ...(postingDate ? { postingDate } : {}),
    narration: narration.trim(),
    lines: lines.map((l) => ({
      accountId: l.accountId,
      debit: l.side === "debit" ? (l.amount || "0") : "0",
      credit: l.side === "credit" ? (l.amount || "0") : "0",
      ...(l.remarks.trim() ? { remarks: l.remarks.trim() } : {}),
    })),
  }), [postingDate, narration, lines]);

  const parsed = CreateJournalEntry.safeParse(payload);
  const ready = parsed.success && balanced && allLinesValid && narration.trim() !== "" && !futureDated && !busy;

  async function post() {
    if (!parsed.success) return;
    setBusy(true); setError(null);
    try {
      const res = await api.post<{ id: string }>("/api/accounting/journals", parsed.data);
      void qc.invalidateQueries({ queryKey: ["journals"] });
      void qc.invalidateQueries({ queryKey: ["accounts"] });
      void qc.invalidateQueries({ queryKey: ["trial-balance"] });
      navigate(`/accounting/journals/${res.id}`);
    } catch (e) { setError(friendlyMessage(e)); setBusy(false); }
  }

  return (
    <>
      <h1>New journal entry</h1>
      <p className="sub">Manual ledger posting. Enter a debit or a credit on each line; the totals must match before you can post. Posting is immediate — corrections are by reversal.</p>

      <div className="card">
        <div className="row">
          <div>
            <label htmlFor="date">Posting date</label>
            <input id="date" type="date" value={postingDate} max={today()} onChange={(e) => setPostingDate(e.target.value)} />
            {futureDated && <div className="field-error">The posting date cannot be in the future.</div>}
          </div>
          <div className="grow">
            <label htmlFor="narration">Narration</label>
            <input id="narration" value={narration} onChange={(e) => setNarration(e.target.value)} placeholder="e.g. Shop rent for July paid in cash" />
          </div>
        </div>
      </div>

      <div className="card">
        <label style={{ marginTop: 0 }}>Lines</label>
        <table>
          <thead>
            <tr><th>Account</th><th>Dr/Cr</th><th className="num">Amount</th><th>Remarks</th><th></th></tr>
          </thead>
          <tbody>
            {lines.map((l, idx) => (
              <tr key={l.key}>
                <td>
                  <select aria-label={`Account line ${idx + 1}`} value={l.accountId} onChange={(e) => patch(l.key, { accountId: e.target.value })}>
                    <option value="" disabled>Select account…</option>
                    {postable.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
                  </select>
                </td>
                <td>
                  <select aria-label={`Side line ${idx + 1}`} value={l.side} onChange={(e) => patch(l.key, { side: e.target.value as "debit" | "credit" })}>
                    <option value="debit">Debit</option>
                    <option value="credit">Credit</option>
                  </select>
                </td>
                <td className="num">
                  <input aria-label={`Amount line ${idx + 1}`} inputMode="decimal" placeholder="0.00" value={l.amount}
                         aria-invalid={l.amount !== "" && !(amt(l.amount) > 0)}
                         onChange={(e) => patch(l.key, { amount: e.target.value.trim() })} />
                </td>
                <td><input aria-label={`Remarks line ${idx + 1}`} value={l.remarks} onChange={(e) => patch(l.key, { remarks: e.target.value })} /></td>
                <td>
                  {lines.length > 2 && (
                    <button type="button" className="secondary" style={{ marginTop: 0, padding: "2px 10px" }}
                            aria-label={`Remove line ${idx + 1}`} onClick={() => removeLine(l.key)}>✕</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="grand">
              <td colSpan={2}><strong>Totals</strong></td>
              <td className="num">
                <div><strong>Dr {inr(totalDebit)}</strong></div>
                <div><strong>Cr {inr(totalCredit)}</strong></div>
              </td>
              <td colSpan={2}>
                {balanced
                  ? <span className="badge paid">✓ balanced</span>
                  : <span className="badge cancelled">difference {inr(Math.abs(difference))}</span>}
              </td>
            </tr>
          </tfoot>
        </table>
        <button type="button" className="secondary" style={{ marginTop: 12 }} onClick={() => setLines((ls) => [...ls, newLine()])}>
          ＋ Add line
        </button>
      </div>

      {error && <div className="banner error" role="alert">{error}</div>}

      <button className="primary" disabled={!ready} onClick={() => void post()}>
        {busy ? "Posting…" : "Post journal"}
      </button>
    </>
  );
}
