import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { GeneralLedgerDto } from "@bizsuite/contracts";
import { api, friendlyMessage } from "../api";
import { inr } from "./Khata";

/**
 * General Ledger — every posted line for one account, oldest first, with a
 * running balance (debit-positive) carried from the opening. Reached by
 * clicking a ledger account in the chart of accounts.
 */
function dc(balance: string): string {
  const n = Number(balance);
  if (Math.round(n * 100) === 0) return "0.00";
  return `${inr(Math.abs(n))} ${n > 0 ? "Dr" : "Cr"}`;
}

export function GeneralLedgerScreen() {
  const { id } = useParams();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const params = new URLSearchParams({ account: id! });
  if (from) params.set("from", from);
  if (to) params.set("to", to);

  const gl = useQuery({
    queryKey: ["general-ledger", id, from, to],
    queryFn: () => api.get<GeneralLedgerDto>(`/api/accounting/reports/general-ledger?${params.toString()}`),
  });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>General ledger</h1>
          <p className="sub">
            {gl.data ? <>{gl.data.account.code} — <strong>{gl.data.account.name}</strong> ({gl.data.account.rootType}, normal {gl.data.account.normalSide})</> : "Account postings"}
          </p>
        </div>
        <Link className="secondary btn-link" to="/accounting">← Chart of accounts</Link>
      </div>

      <div className="card">
        <div className="row">
          <div>
            <label htmlFor="from" style={{ marginTop: 0 }}>From <span className="hint">(optional)</span></label>
            <input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label htmlFor="to" style={{ marginTop: 0 }}>To <span className="hint">(optional)</span></label>
            <input id="to" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
      </div>

      <div className="card">
        {gl.isLoading && <p className="empty">Loading…</p>}
        {gl.isError && <div className="banner error" role="alert">{friendlyMessage(gl.error)}</div>}
        {gl.data && (
          <table>
            <thead>
              <tr>
                <th>Date</th><th>Entry</th><th>Voucher</th><th>Party</th>
                <th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td colSpan={6} className="sub">Opening balance</td>
                <td className="num"><strong>{dc(gl.data.opening)}</strong></td>
              </tr>
              {gl.data.rows.map((r, i) => (
                <tr key={i}>
                  <td>{r.postingDate}</td>
                  <td>{r.entryNo ?? "—"}</td>
                  <td>{r.voucherType.replace(/_/g, " ")}</td>
                  <td>{r.party ?? "—"}</td>
                  <td className="num">{Number(r.debit) > 0 ? inr(r.debit) : "—"}</td>
                  <td className="num">{Number(r.credit) > 0 ? inr(r.credit) : "—"}</td>
                  <td className="num">{dc(r.balance)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="grand">
                <td colSpan={6}><strong>Closing balance</strong></td>
                <td className="num"><strong>{dc(gl.data.closing)}</strong></td>
              </tr>
            </tfoot>
          </table>
        )}
        {gl.data && gl.data.rows.length === 0 && (
          <p className="empty" style={{ marginTop: 12 }}>No postings in this period.</p>
        )}
      </div>
    </>
  );
}
