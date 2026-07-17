import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { QuotationListRow } from "@bizsuite/contracts";
import { api, friendlyMessage } from "../api";
import { useAuth, canCreateQuote } from "../auth";
import { inr } from "./Khata";

/**
 * Quotation register + entry point to the guided flow. Clicking a row opens the
 * detail screen — for drafts that IS the resume path (review, edit, submit,
 * convert).
 */
export function QuotationsScreen() {
  const [status, setStatus] = useState<string>("submitted");
  const navigate = useNavigate();
  const { user } = useAuth();

  const quotes = useQuery({
    queryKey: ["quotations", status],
    queryFn: () => api.get<QuotationListRow[]>(`/api/sales/quotations${status ? `?status=${status}` : ""}`),
  });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Quotations</h1>
          <p className="sub">Estimates for customers. Submit to lock the number, then convert to an invoice when the order is confirmed.</p>
        </div>
        {canCreateQuote(user) && (
          <Link className="btn-link" to="/quotations/new">＋ New quotation</Link>
        )}
      </div>

      <div className="card">
        <label htmlFor="status" style={{ marginTop: 0 }}>Show</label>
        <select id="status" value={status} onChange={(e) => setStatus(e.target.value)} style={{ maxWidth: 220 }}>
          <option value="submitted">Submitted</option>
          <option value="draft">Drafts</option>
          <option value="cancelled">Cancelled</option>
          <option value="">All</option>
        </select>
      </div>

      <div className="card">
        {quotes.isLoading && <p className="empty">Loading…</p>}
        {quotes.isError && <div className="banner error" role="alert">{friendlyMessage(quotes.error)}</div>}
        {quotes.data && quotes.data.length === 0 && (
          <p className="empty">No quotations here yet.</p>
        )}
        {quotes.data && quotes.data.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>No.</th><th>Date</th><th>Customer</th>
                <th className="num">Total</th><th>Valid until</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {quotes.data.map((r) => (
                <tr key={r.id} className="rowlink" onClick={() => navigate(`/quotations/${r.id}`)}>
                  <td>{r.doc_no ?? <span className="badge draft">draft</span>}</td>
                  <td>{r.doc_date}</td>
                  <td>{r.customer_name}</td>
                  <td className="num">{inr(r.grand_total)}</td>
                  <td>{r.valid_until ?? "—"}</td>
                  <td>
                    {r.converted_invoice_id
                      ? <span className="badge paid">converted</span>
                      : <span className={`badge ${r.status}`}>{r.status}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {quotes.data && quotes.data.length > 0 && (
          <div className="table-foot">
            {quotes.data.length} {quotes.data.length === 1 ? "record" : "records"}
            {status ? ` · ${status}` : ""}
          </div>
        )}
      </div>
    </>
  );
}
