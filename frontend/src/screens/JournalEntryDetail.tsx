import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { JournalEntryDetail } from "@bizsuite/contracts";
import { api, friendlyMessage } from "../api";
import { useAuth, isAdmin } from "../auth";
import { inr } from "./Khata";

/**
 * Journal entry detail — the posted voucher, read-only (append-only ledger).
 * Admins can reverse a manual entry; the original stays posted and both net to
 * zero. Reversal links are shown both ways.
 */
export function JournalEntryDetailScreen() {
  const { id } = useParams();
  const qc = useQueryClient();
  const { user } = useAuth();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const je = useQuery({
    queryKey: ["journal", id],
    queryFn: () => api.get<JournalEntryDetail>(`/api/accounting/journals/${id}`),
  });

  async function reverse() {
    setBusy(true); setError(null);
    try {
      await api.post(`/api/accounting/journals/${id}/reverse`);
      void qc.invalidateQueries({ queryKey: ["journal", id] });
      void qc.invalidateQueries({ queryKey: ["journals"] });
      void qc.invalidateQueries({ queryKey: ["trial-balance"] });
      void qc.invalidateQueries({ queryKey: ["accounts"] });
    } catch (e) { setError(friendlyMessage(e)); }
    finally { setBusy(false); setConfirming(false); }
  }

  if (je.isLoading) return <p className="empty">Loading…</p>;
  if (je.isError || !je.data) return <div className="banner error" role="alert">{friendlyMessage(je.error)}</div>;
  const d = je.data;
  const totalDebit = d.lines.reduce((s, l) => s + Number(l.debit), 0);
  const totalCredit = d.lines.reduce((s, l) => s + Number(l.credit), 0);
  const isManual = d.voucher_type === "manual_journal";
  const canReverse = isAdmin(user) && isManual && !d.reversed_by_id && !d.reverses_id;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Journal {d.entry_no}</h1>
          <p className="sub">
            <span className="badge submitted">{d.status}</span>
            {d.reverses_id && <> <span className="badge">reversal</span></>}
            {d.reversed_by_id && <> <span className="badge cancelled">reversed</span></>}
            {" "}· {d.posting_date}
          </p>
        </div>
        <Link className="secondary btn-link" to="/accounting/journals">← All journals</Link>
      </div>

      {d.reverses_id && (
        <div className="banner" role="note">
          This is a reversal of <Link to={`/accounting/journals/${d.reverses_id}`}>{d.reverses_entry_no}</Link>.
        </div>
      )}
      {d.reversed_by_id && (
        <div className="banner" role="note">
          Reversed by <Link to={`/accounting/journals/${d.reversed_by_id}`}>{d.reversed_by_entry_no}</Link> — both entries stay posted and net to zero.
        </div>
      )}
      {error && <div className="banner error" role="alert">{error}</div>}

      <div className="card">
        <label style={{ marginTop: 0 }}>Narration</label>
        <div>{d.narration ?? "—"}</div>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr><th>Account</th><th>Party</th><th>Remarks</th><th className="num">Debit</th><th className="num">Credit</th></tr>
          </thead>
          <tbody>
            {d.lines.map((l, i) => (
              <tr key={i}>
                <td>{l.account_code} — {l.account_name}</td>
                <td>{l.party_name ?? "—"}</td>
                <td>{l.remarks ?? "—"}</td>
                <td className="num">{Number(l.debit) > 0 ? inr(l.debit) : "—"}</td>
                <td className="num">{Number(l.credit) > 0 ? inr(l.credit) : "—"}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="grand">
              <td colSpan={3}><strong>Total</strong></td>
              <td className="num"><strong>{inr(totalDebit)}</strong></td>
              <td className="num"><strong>{inr(totalCredit)}</strong></td>
            </tr>
          </tfoot>
        </table>
      </div>

      {canReverse && (
        <div>
          {!confirming ? (
            <button className="secondary" onClick={() => setConfirming(true)}>Reverse this journal</button>
          ) : (
            <div className="confirm-box">
              <strong>Reverse {d.entry_no}?</strong> This posts a mirror-image entry. The original stays on
              the books; both net to zero. It cannot be undone.
              <div style={{ marginTop: 12, display: "flex", gap: 10 }}>
                <button className="primary" style={{ marginTop: 0 }} disabled={busy} onClick={() => void reverse()}>
                  {busy ? "Reversing…" : "Yes, post the reversal"}
                </button>
                <button className="secondary" disabled={busy} onClick={() => setConfirming(false)}>Go back</button>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
