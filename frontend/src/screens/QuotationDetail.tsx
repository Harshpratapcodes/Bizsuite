import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { QuotationDetail, WarehouseDto } from "@bizsuite/contracts";
import { api, ApiError, friendlyMessage } from "../api";
import { useAuth, isAdmin, canCreateInvoice } from "../auth";
import { inr } from "./Khata";
import { stateName } from "../gst-states";
import { amountInWords } from "../inr-words";

/**
 * One screen, several jobs (all fed by the same server fetch, so every number
 * shown is the server's math):
 *   draft     → review + submit (locks the number; nothing posts)
 *   submitted → record view + print-CSS quotation + convert-to-invoice + admin cancel
 *   converted → banner linking to the draft invoice it produced
 *   cancelled → read-only record
 */
export function QuotationDetailScreen() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuth();
  const [confirming, setConfirming] = useState<"submit" | "cancel" | "convert" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSubmitted, setJustSubmitted] = useState<string | null>(null);
  const [warehouseId, setWarehouseId] = useState("");

  const q = useQuery({
    queryKey: ["quotation", id],
    queryFn: () => api.get<QuotationDetail>(`/api/sales/quotations/${id}`),
  });
  const warehouses = useQuery({
    queryKey: ["warehouses"],
    enabled: q.data?.status === "submitted" && canCreateInvoice(user),
    queryFn: () => api.get<WarehouseDto[]>("/api/inventory/warehouses"),
  });
  useEffect(() => {
    if (!warehouseId && warehouses.data?.length) setWarehouseId(warehouses.data[0]!.id);
  }, [warehouses.data, warehouseId]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const { docNo } = await api.post<{ id: string; docNo: string }>(`/api/sales/quotations/${id}/submit`);
      setJustSubmitted(docNo);
    } catch (e) {
      if (e instanceof ApiError && e.code === "INVALID_STATE") {
        setError("This quotation was already submitted — showing its current state.");
      } else {
        setError(friendlyMessage(e));
      }
    } finally {
      setBusy(false);
      setConfirming(null);
      void qc.invalidateQueries({ queryKey: ["quotation", id] });
      void qc.invalidateQueries({ queryKey: ["quotations"] });
    }
  }

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/sales/quotations/${id}/cancel`);
      setJustSubmitted(null);
    } catch (e) {
      setError(friendlyMessage(e));
    } finally {
      setBusy(false);
      setConfirming(null);
      void qc.invalidateQueries({ queryKey: ["quotation", id] });
      void qc.invalidateQueries({ queryKey: ["quotations"] });
    }
  }

  async function convert() {
    setBusy(true);
    setError(null);
    try {
      const { invoiceId } = await api.post<{ invoiceId: string }>(
        `/api/sales/quotations/${id}/convert`, { warehouseId });
      void qc.invalidateQueries({ queryKey: ["quotation", id] });
      void qc.invalidateQueries({ queryKey: ["quotations"] });
      void qc.invalidateQueries({ queryKey: ["invoices"] });
      navigate(`/invoices/${invoiceId}`);
    } catch (e) {
      setError(friendlyMessage(e));
      setBusy(false);
      setConfirming(null);
    }
  }

  if (q.isLoading) return <p className="empty">Loading quotation…</p>;
  if (q.isError || !q.data) {
    return <div className="banner error" role="alert">{friendlyMessage(q.error)}</div>;
  }
  const d = q.data;
  const isDraft = d.status === "draft";
  const intra = !d.is_inter_state;

  return (
    <>
      <div className="page-head no-print">
        <div>
          <h1>{isDraft ? "Review draft quotation" : `Quotation ${d.doc_no}`}</h1>
          <p className="sub">
            <span className={`badge ${d.status}`}>{d.status}</span>
            {d.converted_invoice_id && <> <span className="badge paid">converted</span></>}
            {" "}· {d.doc_date} · {d.customer.name}
          </p>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 10 }}>
          <Link className="secondary btn-link" to="/quotations">← All quotations</Link>
          {d.status !== "cancelled" && <StageTrack status={d.status} converted={!!d.converted_invoice_id} />}
        </div>
      </div>

      {justSubmitted && (
        <div className="banner ok no-print" role="status">
          ✅ Quotation <strong>{justSubmitted}</strong> submitted. Print it below, or convert it to an invoice when the order lands.
        </div>
      )}
      {d.converted_invoice_id && (
        <div className="banner ok no-print" role="status">
          Converted to invoice{d.converted_invoice_no ? <> <strong>{d.converted_invoice_no}</strong></> : ""}.
          {" "}<Link to={`/invoices/${d.converted_invoice_id}`}>Open the invoice →</Link>
        </div>
      )}
      {isDraft && !error && (
        <div className="banner draft-note no-print" role="note">
          Draft — not issued yet. Check every line, then submit to lock the quotation number.
        </div>
      )}
      {error && <div className="banner error no-print" role="alert">{error}</div>}

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
            <label style={{ marginTop: 0 }}>Dates</label>
            <div>Quotation: <strong>{d.doc_date}</strong></div>
            <div className="sub" style={{ margin: 0 }}>Valid until: {d.valid_until ?? "—"}</div>
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
          <div className="trow grand"><span>Estimated total</span><span>{inr(d.grand_total)}</span></div>
          <div className="words">{amountInWords(d.grand_total)}</div>
        </div>
      </div>

      {d.terms && <div className="card no-print"><label style={{ marginTop: 0 }}>Terms</label><div>{d.terms}</div></div>}

      <div className="no-print">
        {isDraft && confirming !== "submit" && (
          <div style={{ display: "flex", gap: 10 }}>
            <button className="primary" disabled={busy} onClick={() => setConfirming("submit")}>
              Submit quotation
            </button>
            <button className="secondary" style={{ marginTop: 20 }} disabled={busy}
                    onClick={() => navigate(`/quotations/${d.id}/edit`)}>
              Edit draft
            </button>
          </div>
        )}
        {isDraft && confirming === "submit" && (
          <div className="confirm-box">
            <strong>Confirm:</strong> submitting issues the next quotation number and locks the lines.
            Nothing hits the books — this is still just an estimate.
            <div style={{ marginTop: 12, display: "flex", gap: 10 }}>
              <button className="primary" style={{ marginTop: 0 }} disabled={busy} onClick={() => void submit()}>
                {busy ? "Submitting…" : "Yes, submit quotation"}
              </button>
              <button className="secondary" disabled={busy} onClick={() => setConfirming(null)}>Go back</button>
            </div>
          </div>
        )}

        {d.status === "submitted" && (
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button className="primary" onClick={() => window.print()}>🖨 Print quotation</button>
            {canCreateInvoice(user) && !d.converted_invoice_id && confirming !== "convert" && (
              <button className="secondary" style={{ marginTop: 20 }} disabled={busy}
                      onClick={() => setConfirming("convert")}>
                Convert to invoice
              </button>
            )}
            {isAdmin(user) && !d.converted_invoice_id && confirming !== "cancel" && (
              <button className="secondary" style={{ marginTop: 20 }} disabled={busy}
                      onClick={() => setConfirming("cancel")}>
                Cancel quotation
              </button>
            )}
          </div>
        )}
        {d.status === "submitted" && confirming === "convert" && (
          <div className="confirm-box">
            <strong>Convert to invoice:</strong> this creates a <em>draft</em> invoice with these lines —
            nothing is posted until you review and submit that invoice. Stock is issued from:
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
              <button className="primary" style={{ marginTop: 0 }} disabled={busy || !warehouseId} onClick={() => void convert()}>
                {busy ? "Converting…" : "Create draft invoice"}
              </button>
              <button className="secondary" disabled={busy} onClick={() => setConfirming(null)}>Go back</button>
            </div>
          </div>
        )}
        {d.status === "submitted" && confirming === "cancel" && (
          <div className="confirm-box">
            <strong>Cancel this quotation?</strong> It stays on record as cancelled; the number is not reused.
            <div style={{ marginTop: 12, display: "flex", gap: 10 }}>
              <button className="primary" style={{ marginTop: 0 }} disabled={busy} onClick={() => void cancel()}>
                {busy ? "Cancelling…" : "Yes, cancel quotation"}
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

/** Stage rail: Draft → Submitted → Converted. */
function StageTrack({ status, converted }: { status: string; converted: boolean }) {
  const idx = status === "draft" ? 0 : converted ? 2 : 1;
  return (
    <div className="stage-track">
      {["Draft", "Submitted", "Converted"].map((s, i) => (
        <span key={s} className={`stage ${i === idx ? "current" : i < idx ? "past" : ""}`}>{s}</span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Print-CSS quotation. Hidden on screen; @media print shows ONLY this sheet.
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

function PrintSheet({ d }: { d: QuotationDetail }) {
  const intra = !d.is_inter_state;
  return (
    <div className="print-sheet">
      <div className="ps-head">
        <div>
          <div className="ps-company">{d.company.legal_name}</div>
          <div>{fmtAddress(d.company.address)}</div>
          <div>GSTIN: {d.company.gstin ?? "—"} · State: {stateName(d.company.state_code)} ({d.company.state_code})</div>
        </div>
        <div className="ps-title">QUOTATION</div>
      </div>

      <table className="ps-meta">
        <tbody>
          <tr>
            <td><strong>Quotation No:</strong> {d.doc_no}</td>
            <td><strong>Date:</strong> {d.doc_date}</td>
            <td><strong>Valid until:</strong> {d.valid_until ?? "—"}</td>
            <td><strong>Place of supply:</strong> {d.place_of_supply} — {stateName(d.place_of_supply)}</td>
          </tr>
        </tbody>
      </table>

      <div className="ps-billto">
        <strong>Quote to:</strong> {d.customer.name}<br />
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
            <tr className="ps-grand"><td>Estimated total</td><td className="num">{inr(d.grand_total)}</td></tr>
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
