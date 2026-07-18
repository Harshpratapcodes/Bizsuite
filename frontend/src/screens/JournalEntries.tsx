import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { JournalEntryListRow } from "@bizsuite/contracts";
import { api, friendlyMessage } from "../api";
import { useAuth, canManageAccounts } from "../auth";
import { inr } from "./Khata";

/**
 * Manual journal register — accountant-entered vouchers only (invoice/payment
 * postings live in the general ledger). Reversal entries and reversed originals
 * are flagged.
 */
export function JournalEntriesScreen() {
  const navigate = useNavigate();
  const { user } = useAuth();

  const journals = useQuery({
    queryKey: ["journals"],
    queryFn: () => api.get<JournalEntryListRow[]>("/api/accounting/journals"),
  });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Journal entries</h1>
          <p className="sub">Manual ledger postings — rent, bank charges, adjustments. Corrections are made by reversal, never edited.</p>
        </div>
        {canManageAccounts(user) && <Link className="btn-link" to="/accounting/journals/new">＋ New journal</Link>}
      </div>

      <div className="card">
        {journals.isLoading && <p className="empty">Loading…</p>}
        {journals.isError && <div className="banner error" role="alert">{friendlyMessage(journals.error)}</div>}
        {journals.data && journals.data.length === 0 && <p className="empty">No manual journals yet.</p>}
        {journals.data && journals.data.length > 0 && (
          <table>
            <thead>
              <tr><th>Entry</th><th>Date</th><th>Narration</th><th className="num">Amount</th><th></th></tr>
            </thead>
            <tbody>
              {journals.data.map((r) => (
                <tr key={r.id} className="rowlink" onClick={() => navigate(`/accounting/journals/${r.id}`)}>
                  <td>{r.entry_no}</td>
                  <td>{r.posting_date}</td>
                  <td>{r.narration}</td>
                  <td className="num">{inr(r.total)}</td>
                  <td>
                    {r.is_reversal && <span className="badge">reversal</span>}
                    {r.reversed && <span className="badge cancelled">reversed</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {journals.data && journals.data.length > 0 && (
          <div className="table-foot">{journals.data.length} {journals.data.length === 1 ? "entry" : "entries"}</div>
        )}
      </div>
    </>
  );
}
