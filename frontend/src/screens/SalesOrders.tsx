import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { SalesOrderListRow } from "@bizsuite/contracts";
import { api, friendlyMessage } from "../api";
import { useAuth, canCreateSalesOrder } from "../auth";
import { inr } from "./Khata";

/**
 * Sales order register. Clicking a row opens the detail — for drafts that IS
 * the resume path (review, edit, submit, invoice). Billing status is derived.
 */
export function SalesOrdersScreen() {
  const [status, setStatus] = useState<string>("submitted");
  const navigate = useNavigate();
  const { user } = useAuth();

  const orders = useQuery({
    queryKey: ["sales-orders", status],
    queryFn: () => api.get<SalesOrderListRow[]>(`/api/sales/sales-orders${status ? `?status=${status}` : ""}`),
  });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Sales orders</h1>
          <p className="sub">Confirmed customer orders. Raise the GST invoice from here once the order is ready to bill.</p>
        </div>
        {canCreateSalesOrder(user) && (
          <Link className="btn-link" to="/sales-orders/new">＋ New order</Link>
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
        {orders.isLoading && <p className="empty">Loading…</p>}
        {orders.isError && <div className="banner error" role="alert">{friendlyMessage(orders.error)}</div>}
        {orders.data && orders.data.length === 0 && <p className="empty">No sales orders here yet.</p>}
        {orders.data && orders.data.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>No.</th><th>Date</th><th>Customer</th>
                <th className="num">Total</th><th>Delivery</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {orders.data.map((r) => (
                <tr key={r.id} className="rowlink" onClick={() => navigate(`/sales-orders/${r.id}`)}>
                  <td>{r.doc_no ?? <span className="badge draft">draft</span>}</td>
                  <td>{r.doc_date}</td>
                  <td>{r.customer_name}</td>
                  <td className="num">{inr(r.grand_total)}</td>
                  <td>{r.delivery_date ?? "—"}</td>
                  <td>
                    <span className={`badge ${r.status}`}>{r.status}</span>
                    {r.status === "submitted" && r.billing_status !== "Not Billed" && (
                      <> <span className="badge paid">{r.billing_status.toLowerCase()}</span></>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {orders.data && orders.data.length > 0 && (
          <div className="table-foot">
            {orders.data.length} {orders.data.length === 1 ? "record" : "records"}
            {status ? ` · ${status}` : ""}
          </div>
        )}
      </div>
    </>
  );
}
