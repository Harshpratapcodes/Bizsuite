import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { FinancialPeriodDto } from "@bizsuite/contracts";
import { api, friendlyMessage } from "../api";
import { useAuth, isAdmin } from "../auth";

/**
 * Financial periods — open/close the books month by month. Closing a period
 * locks it: the ledger then rejects any posting dated inside it (across every
 * module). Reopening is admin-only, for corrections.
 */
export function FinancialPeriodsScreen() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const admin = isAdmin(user);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const periods = useQuery({
    queryKey: ["periods"],
    queryFn: () => api.get<FinancialPeriodDto[]>("/api/accounting/periods"),
  });

  async function act(id: string, action: "close" | "reopen") {
    setBusyId(id); setError(null);
    try {
      await api.post(`/api/accounting/periods/${id}/${action}`);
      void qc.invalidateQueries({ queryKey: ["periods"] });
    } catch (e) { setError(friendlyMessage(e)); }
    finally { setBusyId(null); }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Financial periods</h1>
          <p className="sub">Close a month once it's filed — the ledger then blocks any entry dated inside it. Reopen only to make corrections.</p>
        </div>
      </div>

      {error && <div className="banner error" role="alert">{error}</div>}

      <div className="card">
        {periods.isLoading && <p className="empty">Loading…</p>}
        {periods.isError && <div className="banner error" role="alert">{friendlyMessage(periods.error)}</div>}
        {periods.data && (
          <table>
            <thead>
              <tr><th>Period</th><th>From</th><th>To</th><th>Status</th>{admin && <th></th>}</tr>
            </thead>
            <tbody>
              {periods.data.map((p) => (
                <tr key={p.id}>
                  <td>
                    <strong>{p.name}</strong>
                    {p.is_current && <span className="badge submitted" style={{ marginLeft: 8 }}>current</span>}
                  </td>
                  <td>{p.start_date}</td>
                  <td>{p.end_date}</td>
                  <td>
                    {p.status === "closed"
                      ? <span className="badge cancelled">closed{p.closed_by_name ? ` · ${p.closed_by_name}` : ""}</span>
                      : <span className="badge paid">open</span>}
                  </td>
                  {admin && (
                    <td className="num">
                      {p.status === "open" ? (
                        <button className="secondary" style={{ marginTop: 0, padding: "2px 12px" }}
                                disabled={busyId === p.id} onClick={() => void act(p.id, "close")}>
                          {busyId === p.id ? "…" : "Close"}
                        </button>
                      ) : (
                        <button className="secondary" style={{ marginTop: 0, padding: "2px 12px" }}
                                disabled={busyId === p.id} onClick={() => void act(p.id, "reopen")}>
                          {busyId === p.id ? "…" : "Reopen"}
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
