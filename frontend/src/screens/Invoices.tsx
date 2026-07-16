import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { InvoiceListRow } from "@bizsuite/contracts";
import { api, friendlyMessage } from "../api";
import { useAuth, canCreateInvoice } from "../auth";
import { inr } from "./Khata";

/**
 * Invoice register + entry point to the guided flow. Clicking a row opens the
 * detail screen — for drafts that IS the resume path (review, edit, submit).
 */
export function InvoicesScreen() {
  const [status, setStatus] = useState<string>("submitted");
  const navigate = useNavigate();
  const { user } = useAuth();

  const invoices = useQuery({
    queryKey: ["invoices", status],
    queryFn: () => api.get<InvoiceListRow[]>(`/api/invoicing/invoices${status ? `?status=${status}` : ""}`),
  });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Invoices</h1>
          <p className="sub">System invoices (B2B GST sales). Walk-in counter sales stay on the bill book until staff handover.</p>
        </div>
        {canCreateInvoice(user) && (
          <Link className="btn-link" to="/invoices/new">＋ New sale</Link>
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
        {invoices.isLoading && <p className="empty">Loading…</p>}
        {invoices.isError && <div className="banner error" role="alert">{friendlyMessage(invoices.error)}</div>}
        {invoices.data && invoices.data.length === 0 && (
          <p className="empty">No invoices here yet.</p>
        )}
        {invoices.data && invoices.data.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>No.</th><th>Date</th><th>Customer</th>
                <th className="num">Total</th><th className="num">Outstanding</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {invoices.data.map((r) => (
                <tr key={r.id} className="rowlink" onClick={() => navigate(`/invoices/${r.id}`)}>
                  <td>{r.doc_no ?? <span className="badge draft">draft</span>}</td>
                  <td>{r.doc_date}</td>
                  <td>{r.customer_name}</td>
                  <td className="num">{inr(r.grand_total)}</td>
                  <td className="num">{r.outstanding != null ? inr(r.outstanding) : "—"}</td>
                  <td>
                    <span className={`badge ${r.payment_status ?? r.status}`}>
                      {(r.payment_status ?? r.status).replace("_", " ")}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
