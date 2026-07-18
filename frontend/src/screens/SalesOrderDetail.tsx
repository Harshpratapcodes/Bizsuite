import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SalesOrderDetail, WarehouseDto } from "@bizsuite/contracts";
import { api, ApiError, friendlyMessage } from "../api";
import { useAuth, isAdmin, canCreateInvoice } from "../auth";
import { inr } from "./Khata";
import { stateName } from "../gst-states";
import { amountInWords } from "../inr-words";

/**
 * Sales order detail — one screen fed by one server fetch:
 *   draft     → review + submit (confirms the order; nothing posts)
 *   submitted → record view + print + Create Invoice + admin cancel
 *   cancelled → read-only
 * Billing status and the linked invoices are derived server-side.
 */
export function SalesOrderDetailScreen() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuth();
  const [confirming, setConfirming] = useState<"submit" | "cancel" | "invoice" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSubmitted, setJustSubmitted] = useState<string | null>(null);
  const [warehouseId, setWarehouseId] = useState("");

  const so = useQuery({
    queryKey: ["sales-order", id],
    queryFn: () => api.get<SalesOrderDetail>(`/api/sales/sales-orders/${id}`),
  });
  const warehouses = useQuery({
    queryKey: ["warehouses"],
    enabled: so.data?.status === "submitted" && canCreateInvoice(user),
    queryFn: () => api.get<WarehouseDto[]>("/api/inventory/warehouses"),
  });
  useEffect(() => {
    if (!warehouseId && warehouses.data?.length) setWarehouseId(warehouses.data[0]!.id);
  }, [warehouses.data, warehouseId]);

  async function submit() {
    setBusy(true); setError(null);
    try {
      const { docNo } = await api.post<{ id: string; docNo: string }>(`/api/sales/sales-orders/${id}/submit`);
      setJustSubmitted(docNo);
    } catch (e) {
      if (e instanceof ApiError && e.code === "INVALID_STATE") setError("This order was already submitted — showing its current state.");
      else setError(friendlyMessage(e));
    } finally {
      setBusy(false); setConfirming(null);
      void qc.invalidateQueries({ queryKey: ["sales-order", id] });
      void qc.invalidateQueries({ queryKey: ["sales-orders"] });
    }
  }

  async function cancel() {
    setBusy(true); setError(null);
    try {
      await api.post(`/api/sales/sales-orders/${id}/cancel`);
      setJustSubmitted(null);
    } catch (e) { setError(friendlyMessage(e)); }
    finally {
      setBusy(false); setConfirming(null);
      void qc.invalidateQueries({ queryKey: ["sales-order", id] });
      void qc.invalidateQueries({ queryKey: ["sales-orders"] });
    }
  }

  async function makeInvoice() {
    setBusy(true); setError(null);
    try {
      const { invoiceId } = await api.post<{ invoiceId: string }>(
        `/api/sales/sales-orders/${id}/invoice`, { warehouseId });
      void qc.invalidateQueries({ queryKey: ["sales-order", id] });
      void qc.invalidateQueries({ queryKey: ["invoices"] });
      navigate(`/invoices/${invoiceId}`);
    } catch (e) {
      setError(friendlyMessage(e)); setBusy(false); setConfirming(null);
    }
  }

  if (so.isLoading) return <p className="empty">Loading sales order…</p>;
  if (so.isError || !so.data) {
    return <div className="banner error" role="alert">{friendlyMessage(so.error)}</div>;
  }
  const d = so.data;
  const isDraft = d.status === "draft";
  const intra = !d.is_inter_state;
  const openInvoices = d.invoices.filter((i) => i.status !== "cancelled");

  return (
    <>
      <div className="page-head no-print">
        <div>
          <h1>{isDraft ? "Review draft sales order" : `Sales order ${d.doc_no}`}</h1>
          <p className="sub">
            <span className={`badge ${d.status}`}>{d.status}</span>
            {d.status === "submitted" && d.billing_status !== "Not Billed" && (
              <> <span className="badge paid">{d.billing_status.toLowerCase()}</span></>
            )}
            {" "}· {d.doc_date} · {d.customer.name}
            {d.quotation_id && <> · from <Link to={`/quotations/${d.quotation_id}`}>{d.quotation_no}</Link></>}
          </p>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 10 }}>
          <Link className="secondary btn-link" to="/sales-orders">← All sales orders</Link>
          {d.status !== "cancelled" && <StageTrack status={d.status} billingStatus={d.billing_status} />}
        </div>
      </div>

      {justSubmitted && (
        <div className="banner ok no-print" role="status">
          ✅ Sales order <strong>{justSubmitted}</strong> confirmed. Print it below, or raise the GST invoice when it's ready to bill.
        </div>
      )}
      {isDraft && !error && (
        <div className="banner draft-note no-print" role="note">
          Draft — not confirmed yet. Check every line, then submit to lock the order number.
        </div>
      )}
      {error && <div className="banner error no-print" role="alert">{error}</div>}

      {openInvoices.length > 0 && (
        <div className="card no-print">
          <label style={{ marginTop: 0 }}>Invoices raised</label>
          <table>
            <thead><tr><th>No.</th><th className="num">Total</th><th>Status</th></tr></thead>
            <tbody>
              {d.invoices.map((i) => (
                <tr key={i.id} className="rowlink" onClick={() => navigate(`/invoices/${i.id}`)}>
                  <td>{i.doc_no ?? <span className="badge draft">draft</span>}</td>
                  <td className="num">{inr(i.grand_total)}</td>
                  <td><span className={`badge ${i.status}`}>{i.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card no-print">
        <div className="row">
          <div>
            <label style={{ marginTop: 0 }}>Customer</label>
            <div><strong>{d.customer.name}</strong></div>
            <div className="sub" style={{ margin: 0 }}>
              {d.customer.gstin ? <>GSTIN {d.customer.gstin} · </> : "Unregistered · "}
              {stateName(d.customer.state_code)}
            </div>
          </div>
          <div>
            <label style={{ marginTop: 0 }}>Tax</label>
            <div>Place of supply: <strong>{d.place_of_supply} — {stateName(d.place_of_supply)}</strong></div>
            <div className="sub" style={{ margin: 0 }}>{intra ? "Within state → CGST + SGST" : "Inter-state → IGST"}</div>
          </div>
          <div>
            <label style={{ marginTop: 0 }}>Order</label>
            <div>Date: <strong>{d.doc_date}</strong></div>
            <div className="sub" style={{ margin: 0 }}>
              Delivery: {d.delivery_date ?? "—"}{d.po_no ? ` · PO ${d.po_no}` : ""}
            </div>
          </div>
        </div>
      </div>

      <div className="card no-print">
        <table>
          <thead>
            <tr>
              <th>Item</th><th>HSN</th><th className="num">Qty</th><th className="num">Rate</th>
              <th className="num">Disc%</th><th className="num">Taxable</th><th className="num">GST%</th><th className="num">Total</th>
            </tr>
          </thead>
          <tbody>
            {d.lines.map((l) => (
              <tr key={l.id}>
                <td>{l.description}</td>
                <td>{l.hsn_sac_code}</td>
                <td className="num">{Number(l.qty).toLocaleString("en-IN")} {l.uom}</td>
                <td className="num">{inr(l.rate)}</td>
                <td className="num">{Number(l.discount_pct) > 0 ? `${Number(l.discount_pct)}%` : "—"}</td>
                <td className="num">{inr(l.taxable_value)}</td>
                <td className="num">{Number(l.gst_rate)}%</td>
                <td className="num">{inr(l.line_total)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="totals">
          <div className="trow"><span>Taxable value</span><span>{inr(d.taxable_total)}</span></div>
          {intra ? (
            <>
              <div className="trow"><span>CGST</span><span>{inr(d.cgst_total)}</span></div>
              <div className="trow"><span>SGST</span><span>{inr(d.sgst_total)}</span></div>
            </>
          ) : (
            <div className="trow"><span>IGST</span><span>{inr(d.igst_total)}</span></div>
          )}
          {Number(d.rounding_adjustment) !== 0 && (
            <div className="trow"><span>Rounding</span><span>{inr(d.rounding_adjustment)}</span></div>
          )}
          <div className="trow grand"><span>Order total</span><span>{inr(d.grand_total)}</span></div>
          <div className="words">{amountInWords(d.grand_total)}</div>
        </div>
      </div>

      {d.terms && <div className="card no-print"><label style={{ marginTop: 0 }}>Terms</label><div>{d.terms}</div></div>}

      <div className="no-print">
        {isDraft && confirming !== "submit" && (
          <div style={{ display: "flex", gap: 10 }}>
            <button className="primary" disabled={busy} onClick={() => setConfirming("submit")}>Submit order</button>
            <button className="secondary" style={{ marginTop: 20 }} disabled={busy}
                    onClick={() => navigate(`/sales-orders/${d.id}/edit`)}>Edit draft</button>
          </div>
        )}
        {isDraft && confirming === "submit" && (
          <div className="confirm-box">
            <strong>Confirm:</strong> submitting issues the next order number and locks the lines.
            Nothing hits the books yet.
            <div style={{ marginTop: 12, display: "flex", gap: 10 }}>
              <button className="primary" style={{ marginTop: 0 }} disabled={busy} onClick={() => void submit()}>
                {busy ? "Submitting…" : "Yes, submit order"}
              </button>
              <button className="secondary" disabled={busy} onClick={() => setConfirming(null)}>Go back</button>
            </div>
          </div>
        )}

        {d.status === "submitted" && (
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button className="primary" onClick={() => window.print()}>🖨 Print order</button>
            {canCreateInvoice(user) && openInvoices.length === 0 && confirming !== "invoice" && (
              <button className="secondary" style={{ marginTop: 20 }} disabled={busy}
                      onClick={() => setConfirming("invoice")}>Create invoice</button>
            )}
            {isAdmin(user) && openInvoices.length === 0 && confirming !== "cancel" && (
              <button className="secondary" style={{ marginTop: 20 }} disabled={busy}
                      onClick={() => setConfirming("cancel")}>Cancel order</button>
            )}
          </div>
        )}
        {d.status === "submitted" && confirming === "invoice" && (
          <div className="confirm-box">
            <strong>Raise invoice:</strong> creates a <em>draft</em> invoice with these lines —
            nothing is posted until you review and submit that invoice. Stock issues from:
            <div style={{ marginTop: 10 }}>
              {(warehouses.data?.length ?? 0) > 1 ? (
                <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} style={{ maxWidth: 280 }}>
                  {warehouses.data!.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              ) : (
                <strong>{warehouses.data?.[0]?.name ?? "…"}</strong>
              )}
            </div>
            <div style={{ marginTop: 12, display: "flex", gap: 10 }}>
              <button className="primary" style={{ marginTop: 0 }} disabled={busy || !warehouseId} onClick={() => void makeInvoice()}>
                {busy ? "Creating…" : "Create draft invoice"}
              </button>
              <button className="secondary" disabled={busy} onClick={() => setConfirming(null)}>Go back</button>
            </div>
          </div>
        )}
        {d.status === "submitted" && confirming === "cancel" && (
          <div className="confirm-box">
            <strong>Cancel this order?</strong> It stays on record as cancelled; the number is not reused.
            <div style={{ marginTop: 12, display: "flex", gap: 10 }}>
              <button className="primary" style={{ marginTop: 0 }} disabled={busy} onClick={() => void cancel()}>
                {busy ? "Cancelling…" : "Yes, cancel order"}
              </button>
              <button className="secondary" disabled={busy} onClick={() => setConfirming(null)}>Go back</button>
            </div>
          </div>
        )}
        {d.status === "cancelled" && <p className="sub">Cancelled — kept on record; the number is not reused.</p>}
      </div>

      {d.status === "submitted" && <PrintSheet d={d} />}
    </>
  );
}

/** Stage rail: Draft → Confirmed → Billed. */
function StageTrack({ status, billingStatus }: { status: string; billingStatus: string }) {
  const idx = status === "draft" ? 0 : billingStatus === "Fully Billed" ? 2 : 1;
  return (
    <div className="stage-track">
      {["Draft", "Confirmed", "Billed"].map((s, i) => (
        <span key={s} className={`stage ${i === idx ? "current" : i < idx ? "past" : ""}`}>{s}</span>
      ))}
    </div>
  );
}

function fmtAddress(a: Record<string, unknown>): string {
  const preferred = ["line1", "line2", "street", "area", "city", "district", "state", "pincode", "pin"];
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const k of preferred) {
    const v = a[k];
    if (typeof v === "string" && v) { parts.push(v); seen.add(k); }
  }
  for (const [k, v] of Object.entries(a)) {
    if (!seen.has(k) && typeof v === "string" && v) parts.push(v);
  }
  return parts.join(", ");
}

function PrintSheet({ d }: { d: SalesOrderDetail }) {
  const intra = !d.is_inter_state;
  return (
    <div className="print-sheet">
      <div className="ps-head">
        <div>
          <div className="ps-company">{d.company.legal_name}</div>
          <div>{fmtAddress(d.company.address)}</div>
          <div>GSTIN: {d.company.gstin ?? "—"} · State: {stateName(d.company.state_code)} ({d.company.state_code})</div>
        </div>
        <div className="ps-title">SALES ORDER</div>
      </div>

      <table className="ps-meta">
        <tbody>
          <tr>
            <td><strong>Order No:</strong> {d.doc_no}</td>
            <td><strong>Date:</strong> {d.doc_date}</td>
            <td><strong>Delivery:</strong> {d.delivery_date ?? "—"}</td>
            <td><strong>Place of supply:</strong> {d.place_of_supply} — {stateName(d.place_of_supply)}</td>
          </tr>
          {(d.po_no || d.po_date) && (
            <tr><td colSpan={4}><strong>Customer PO:</strong> {d.po_no ?? "—"}{d.po_date ? ` dated ${d.po_date}` : ""}</td></tr>
          )}
        </tbody>
      </table>

      <div className="ps-billto">
        <strong>Order from:</strong> {d.customer.name}<br />
        {fmtAddress(d.customer.billing_address) || "—"}<br />
        GSTIN: {d.customer.gstin ?? "Unregistered"} · State: {stateName(d.customer.state_code)}
      </div>

      <table className="ps-lines">
        <thead>
          <tr>
            <th>#</th><th>Description</th><th>HSN/SAC</th><th className="num">Qty</th>
            <th className="num">Rate</th><th className="num">Disc%</th>
            <th className="num">Taxable</th><th className="num">GST%</th>
            <th className="num">GST Amt</th><th className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          {d.lines.map((l, i) => (
            <tr key={l.id}>
              <td>{i + 1}</td>
              <td>{l.description}</td>
              <td>{l.hsn_sac_code}</td>
              <td className="num">{Number(l.qty).toLocaleString("en-IN")} {l.uom}</td>
              <td className="num">{Number(l.rate).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td>
              <td className="num">{Number(l.discount_pct) > 0 ? Number(l.discount_pct) : "—"}</td>
              <td className="num">{Number(l.taxable_value).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td>
              <td className="num">{Number(l.gst_rate)}%</td>
              <td className="num">{(Number(l.cgst_amount) + Number(l.sgst_amount) + Number(l.igst_amount))
                .toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td>
              <td className="num">{Number(l.line_total).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="ps-totals">
        <table>
          <tbody>
            <tr><td>Taxable value</td><td className="num">{inr(d.taxable_total)}</td></tr>
            {intra ? (
              <>
                <tr><td>CGST</td><td className="num">{inr(d.cgst_total)}</td></tr>
                <tr><td>SGST</td><td className="num">{inr(d.sgst_total)}</td></tr>
              </>
            ) : (
              <tr><td>IGST</td><td className="num">{inr(d.igst_total)}</td></tr>
            )}
            {Number(d.rounding_adjustment) !== 0 && (
              <tr><td>Rounding</td><td className="num">{inr(d.rounding_adjustment)}</td></tr>
            )}
            <tr className="ps-grand"><td>Order total</td><td className="num">{inr(d.grand_total)}</td></tr>
          </tbody>
        </table>
      </div>
      <div className="ps-words"><strong>Amount in words:</strong> {amountInWords(d.grand_total)}</div>

      {d.terms && <div className="ps-terms">{d.terms}</div>}

      <div className="ps-sign">
        <div>For <strong>{d.company.legal_name}</strong></div>
        <div className="ps-sign-space">Authorised Signatory</div>
      </div>
    </div>
  );
}
