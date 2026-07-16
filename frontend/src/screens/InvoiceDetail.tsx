import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { InvoiceDetail } from "@bizsuite/contracts";
import { api, ApiError, friendlyMessage } from "../api";
import { useAuth, isAdmin } from "../auth";
import { inr } from "./Khata";
import { stateName } from "../gst-states";
import { amountInWords } from "../inr-words";

/**
 * One screen, three jobs (all fed by the same server fetch, so every number
 * shown is the server's math, never the browser's):
 *   draft     → review + submit (the confirm rail before anything hits the books)
 *   submitted → record view + print-CSS GST invoice + admin-only cancel
 *   cancelled → read-only record
 */
export function InvoiceDetailScreen() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuth();
  const [confirming, setConfirming] = useState<"submit" | "cancel" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSubmitted, setJustSubmitted] = useState<string | null>(null);

  const inv = useQuery({
    queryKey: ["invoice", id],
    queryFn: () => api.get<InvoiceDetail>(`/api/invoicing/invoices/${id}`),
  });

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const { docNo } = await api.post<{ id: string; docNo: string }>(`/api/invoicing/invoices/${id}/submit`);
      setJustSubmitted(docNo);
    } catch (e) {
      // Double-submit / retry after a network blip: refetch shows the real state.
      if (e instanceof ApiError && e.code === "INVALID_STATE") {
        setError("This invoice was already submitted — showing its current state.");
      } else {
        setError(friendlyMessage(e));
      }
    } finally {
      setBusy(false);
      setConfirming(null);
      void qc.invalidateQueries({ queryKey: ["invoice", id] });
      void qc.invalidateQueries({ queryKey: ["invoices"] });
      void qc.invalidateQueries({ queryKey: ["khata"] });
    }
  }

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/invoicing/invoices/${id}/cancel`);
      setJustSubmitted(null);
    } catch (e) {
      setError(friendlyMessage(e));
    } finally {
      setBusy(false);
      setConfirming(null);
      void qc.invalidateQueries({ queryKey: ["invoice", id] });
      void qc.invalidateQueries({ queryKey: ["invoices"] });
      void qc.invalidateQueries({ queryKey: ["khata"] });
    }
  }

  if (inv.isLoading) return <p className="empty">Loading invoice…</p>;
  if (inv.isError || !inv.data) {
    return <div className="banner error" role="alert">{friendlyMessage(inv.error)}</div>;
  }
  const d = inv.data;
  const isDraft = d.status === "draft";
  const intra = !d.is_inter_state;
  const stockError = error !== null && /stock/i.test(error);

  return (
    <>
      <div className="page-head no-print">
        <div>
          <h1>{isDraft ? "Review draft invoice" : `Invoice ${d.doc_no}`}</h1>
          <p className="sub">
            <span className={`badge ${d.status}`}>{d.status}</span>
            {d.payment_status && <> <span className={`badge ${d.payment_status}`}>{d.payment_status.replace("_", " ")}</span></>}
            {" "}· {d.doc_date} · {d.customer.name}
          </p>
        </div>
        <Link className="secondary btn-link" to="/invoices">← All invoices</Link>
      </div>

      {justSubmitted && (
        <div className="banner ok no-print" role="status">
          ✅ Invoice <strong>{justSubmitted}</strong> submitted — stock deducted, khata updated.
          Print it below.
        </div>
      )}
      {isDraft && !error && (
        <div className="banner draft-note no-print" role="note">
          Draft — nothing is on the books yet. Check every line, then submit.
        </div>
      )}
      {error && (
        <div className="banner error no-print" role="alert">
          {error}
          {stockError && isDraft && <> <Link to={`/invoices/${d.id}/edit`}>Edit the quantities</Link> and try again.</>}
        </div>
      )}

      <div className="card no-print">
        <div className="row">
          <div>
            <label style={{ marginTop: 0 }}>Customer</label>
            <div><strong>{d.customer.name}</strong></div>
            <div className="sub" style={{ margin: 0 }}>
              {d.customer_gstin ? <>GSTIN {d.customer_gstin} · </> : "Unregistered · "}
              {stateName(d.customer.state_code)}
            </div>
          </div>
          <div>
            <label style={{ marginTop: 0 }}>Tax</label>
            <div>Place of supply: <strong>{d.place_of_supply} — {stateName(d.place_of_supply)}</strong></div>
            <div className="sub" style={{ margin: 0 }}>{intra ? "Within state → CGST + SGST" : "Inter-state → IGST"}</div>
          </div>
          <div>
            <label style={{ marginTop: 0 }}>Dates</label>
            <div>Invoice: <strong>{d.doc_date}</strong></div>
            <div className="sub" style={{ margin: 0 }}>Due: {d.due_date ?? "—"}</div>
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
          <div className="trow grand"><span>Grand total</span><span>{inr(d.grand_total)}</span></div>
          {d.outstanding != null && d.status === "submitted" && (
            <div className="trow"><span>Outstanding</span><span>{inr(d.outstanding)}</span></div>
          )}
          <div className="words">{amountInWords(d.grand_total)}</div>
        </div>
      </div>

      <div className="no-print">
        {isDraft && confirming !== "submit" && (
          <div style={{ display: "flex", gap: 10 }}>
            <button className="primary" disabled={busy} onClick={() => setConfirming("submit")}>
              Submit invoice
            </button>
            <button className="secondary" style={{ marginTop: 20 }} disabled={busy}
                    onClick={() => navigate(`/invoices/${d.id}/edit`)}>
              Edit draft
            </button>
          </div>
        )}
        {isDraft && confirming === "submit" && (
          <div className="confirm-box">
            <strong>Confirm:</strong> submitting issues the next invoice number, deducts stock,
            and posts {inr(d.grand_total)} to <strong>{d.customer.name}</strong>'s khata.
            Corrections after this need an admin reversal.
            <div style={{ marginTop: 12, display: "flex", gap: 10 }}>
              <button className="primary" style={{ marginTop: 0 }} disabled={busy} onClick={() => void submit()}>
                {busy ? "Submitting…" : "Yes, submit invoice"}
              </button>
              <button className="secondary" disabled={busy} onClick={() => setConfirming(null)}>Go back</button>
            </div>
          </div>
        )}

        {d.status === "submitted" && (
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button className="primary" onClick={() => window.print()}>🖨 Print invoice</button>
            {isAdmin(user) && confirming !== "cancel" && (
              <button className="secondary" style={{ marginTop: 20 }} disabled={busy}
                      onClick={() => setConfirming("cancel")}>
                Cancel invoice (reversal)
              </button>
            )}
          </div>
        )}
        {d.status === "submitted" && confirming === "cancel" && (
          <div className="confirm-box">
            <strong>Confirm cancellation:</strong> this posts reversal entries (the original stays
            on the books, both net to zero) and returns the stock. The invoice number is not reused.
            <div style={{ marginTop: 12, display: "flex", gap: 10 }}>
              <button className="primary" style={{ marginTop: 0 }} disabled={busy} onClick={() => void cancel()}>
                {busy ? "Cancelling…" : "Yes, cancel with reversal"}
              </button>
              <button className="secondary" disabled={busy} onClick={() => setConfirming(null)}>Go back</button>
            </div>
          </div>
        )}
        {d.status === "cancelled" && (
          <p className="sub">Cancelled — reversal entries posted; original and reversal net to zero.</p>
        )}
      </div>

      {d.status === "submitted" && <PrintSheet d={d} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Print-CSS GST invoice (design doc Approach A: "Print-CSS invoices, no PDF
// engine yet"). Hidden on screen; @media print shows ONLY this sheet.
// ---------------------------------------------------------------------------
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

function PrintSheet({ d }: { d: InvoiceDetail }) {
  const intra = !d.is_inter_state;
  return (
    <div className="print-sheet">
      <div className="ps-head">
        <div>
          <div className="ps-company">{d.company.legal_name}</div>
          <div>{fmtAddress(d.company.address)}</div>
          <div>GSTIN: {d.company.gstin ?? "—"} · State: {stateName(d.company.state_code)} ({d.company.state_code})</div>
        </div>
        <div className="ps-title">TAX INVOICE</div>
      </div>

      <table className="ps-meta">
        <tbody>
          <tr>
            <td><strong>Invoice No:</strong> {d.doc_no}</td>
            <td><strong>Date:</strong> {d.doc_date}</td>
            <td><strong>Due:</strong> {d.due_date ?? "—"}</td>
            <td><strong>Place of supply:</strong> {d.place_of_supply} — {stateName(d.place_of_supply)}</td>
          </tr>
        </tbody>
      </table>

      <div className="ps-billto">
        <strong>Bill to:</strong> {d.customer.name}<br />
        {fmtAddress(d.customer.billing_address) || "—"}<br />
        GSTIN: {d.customer_gstin ?? "Unregistered"} · State: {stateName(d.customer.state_code)}
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
            <tr className="ps-grand"><td>Grand total</td><td className="num">{inr(d.grand_total)}</td></tr>
          </tbody>
        </table>
      </div>
      <div className="ps-words"><strong>Amount in words:</strong> {amountInWords(d.grand_total)}</div>

      {d.company.invoice_terms && <div className="ps-terms">{d.company.invoice_terms}</div>}

      <div className="ps-sign">
        <div>For <strong>{d.company.legal_name}</strong></div>
        <div className="ps-sign-space">Authorised Signatory</div>
      </div>
    </div>
  );
}
