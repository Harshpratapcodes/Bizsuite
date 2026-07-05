import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { InvoiceListRow } from "@bizsuite/contracts";
import { api, friendlyMessage } from "../api";
import { inr } from "./Khata";

/**
 * Read-only invoice register. Creation stays on the bill book during the
 * interim phase (design doc premise 3); the guided invoice flow ships in the
 * second half of Approach A, after the CA handshake (D9/D10).
 */
export function InvoicesScreen() {
  const [status, setStatus] = useState<string>("submitted");

  const invoices = useQuery({
    queryKey: ["invoices", status],
    queryFn: () => api.get<InvoiceListRow[]>(`/api/invoicing/invoices${status ? `?status=${status}` : ""}`),
  });

  return (
    <>
      <h1>Invoices</h1>
      <p className="sub">System invoices. New sales stay on the bill book until the invoice flow ships (per plan).</p>

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
                <tr key={r.id}>
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
