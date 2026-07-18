import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { TrialBalanceDto } from "@bizsuite/contracts";
import { api, friendlyMessage } from "../api";
import { inr } from "./Khata";

/**
 * Trial Balance — closing balance per ledger account, netted onto its natural
 * side. The debit and credit columns MUST total to the same figure; if they
 * don't, the ledger is broken (they always do, by the posting invariants).
 */
const today = (): string => new Date().toISOString().slice(0, 10);

export function TrialBalanceScreen() {
  const [asOf, setAsOf] = useState(today());
  const tb = useQuery({
    queryKey: ["trial-balance", asOf],
    queryFn: () => api.get<TrialBalanceDto>(`/api/accounting/reports/trial-balance${asOf ? `?asOf=${asOf}` : ""}`),
  });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Trial balance</h1>
          <p className="sub">Every account's closing balance. Debit and credit totals must match.</p>
        </div>
      </div>

      <div className="card">
        <label htmlFor="asof" style={{ marginTop: 0 }}>As of date</label>
        <input id="asof" type="date" value={asOf} max={today()} onChange={(e) => setAsOf(e.target.value)} style={{ maxWidth: 220 }} />
      </div>

      <div className="card">
        {tb.isLoading && <p className="empty">Loading…</p>}
        {tb.isError && <div className="banner error" role="alert">{friendlyMessage(tb.error)}</div>}
        {tb.data && tb.data.rows.length === 0 && <p className="empty">No postings yet.</p>}
        {tb.data && tb.data.rows.length > 0 && (
          <>
            <table>
              <thead>
                <tr><th>Code</th><th>Account</th><th className="num">Debit</th><th className="num">Credit</th></tr>
              </thead>
              <tbody>
                {tb.data.rows.map((r) => (
                  <tr key={r.code}>
                    <td>{r.code}</td>
                    <td>{r.name}</td>
                    <td className="num">{Number(r.debit) > 0 ? inr(r.debit) : "—"}</td>
                    <td className="num">{Number(r.credit) > 0 ? inr(r.credit) : "—"}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="grand">
                  <td></td><td><strong>Total</strong></td>
                  <td className="num"><strong>{inr(tb.data.totalDebit)}</strong></td>
                  <td className="num"><strong>{inr(tb.data.totalCredit)}</strong></td>
                </tr>
              </tfoot>
            </table>
            <div className="table-foot">
              {tb.data.balanced
                ? <span className="badge paid">✓ balanced — debits equal credits</span>
                : <span className="badge cancelled">✗ OUT OF BALANCE — ledger integrity issue</span>}
            </div>
          </>
        )}
      </div>
    </>
  );
}
