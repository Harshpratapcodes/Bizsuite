import { useMemo, useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CreateQuotation,
  type CompanySettingsDto, type ItemOption, type KhataReport, type QuotationDetail,
} from "@bizsuite/contracts";
import { api, friendlyMessage } from "../api";
import { inr } from "./Khata";
import { CustomerPicker, type CustomerOption } from "../components/CustomerPicker";
import { ItemPicker } from "../components/ItemPicker";
import { GST_STATES, stateName } from "../gst-states";

/**
 * Guided quotation entry — the sales flow, mirroring the invoice builder but
 * non-posting: no warehouse, no stock, no due date. GST is NOT computed here;
 * "Save draft" posts to the server and the review screen (QuotationDetail)
 * shows the server-computed totals. Drafts survive server-side and resume from
 * the quotations register.
 */

interface LineDraft {
  key: number;
  item: ItemOption | null;
  description: string;
  qty: string;
  rate: string;
  discountPct: string;
}

let lineKey = 1;
const newLine = (): LineDraft => ({ key: lineKey++, item: null, description: "", qty: "1", rate: "", discountPct: "" });
const today = (): string => new Date().toISOString().slice(0, 10);

export function QuotationNewScreen() {
  const { id: editingId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [customer, setCustomer] = useState<CustomerOption | null>(null);
  const [placeOfSupply, setPlaceOfSupply] = useState("");
  const [docDate, setDocDate] = useState(today());
  const [validUntil, setValidUntil] = useState("");
  const [terms, setTerms] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([newLine()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedDraft, setLoadedDraft] = useState(false);

  const company = useQuery({
    queryKey: ["company-settings"],
    queryFn: () => api.get<CompanySettingsDto>("/api/settings/company"),
  });
  const khata = useQuery({
    queryKey: ["khata"],
    queryFn: () => api.get<KhataReport>("/api/accounting/reports/khata"),
  });
  const editingDraft = useQuery({
    queryKey: ["quotation", editingId],
    enabled: !!editingId,
    queryFn: () => api.get<QuotationDetail>(`/api/sales/quotations/${editingId}`),
  });

  // Edit mode: prefill the form from the server-side draft, exactly once.
  useEffect(() => {
    const d = editingDraft.data;
    if (!d || loadedDraft) return;
    if (d.status !== "draft") { navigate(`/quotations/${d.id}`, { replace: true }); return; }
    setLoadedDraft(true);
    setCustomer({ id: d.customer_id, name: d.customer.name, gstin: d.customer.gstin, state_code: d.customer.state_code });
    setPlaceOfSupply(d.place_of_supply);
    setDocDate(d.doc_date);
    setValidUntil(d.valid_until ?? "");
    setTerms(d.terms ?? "");
    setNotes(d.notes ?? "");
    setLines(d.lines.filter((l) => l.item_id).map((l) => ({
      key: lineKey++,
      item: {
        id: l.item_id!, sku: "", name: l.description, description: null,
        uom: l.uom, hsn_sac_code: l.hsn_sac_code, gst_rate: l.gst_rate,
        is_stock_item: true, standard_selling_rate: null, on_hand: "", is_active: true,
      },
      description: l.description,
      qty: String(Number(l.qty)),
      rate: l.rate,
      discountPct: Number(l.discount_pct) > 0 ? String(Number(l.discount_pct)) : "",
    })));
  }, [editingDraft.data, loadedDraft, navigate]);

  function pickCustomer(c: CustomerOption | null) {
    setCustomer(c);
    if (c) setPlaceOfSupply(c.state_code ?? company.data?.state_code ?? "");
  }
  function pickItem(key: number, item: ItemOption) {
    setLines((ls) => ls.map((l) => l.key === key
      ? { ...l, item, description: item.name, rate: item.standard_selling_rate ?? l.rate }
      : l));
  }
  function patchLine(key: number, patch: Partial<LineDraft>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }
  function removeLine(key: number) {
    setLines((ls) => (ls.length > 1 ? ls.filter((l) => l.key !== key) : ls.map((l) => l.key === key ? newLine() : l)));
  }

  const lineAmount = (l: LineDraft): number => {
    const q = Number(l.qty || 0), r = Number(l.rate || 0), d = Number(l.discountPct || 0);
    return q * r * (1 - d / 100);
  };
  const itemsTotal = lines.reduce((s, l) => s + (l.item ? lineAmount(l) : 0), 0);

  const payload = useMemo(() => ({
    customerId: customer?.id ?? "",
    placeOfSupply,
    ...(docDate ? { docDate } : {}),
    ...(validUntil ? { validUntil } : {}),
    ...(terms.trim() ? { terms: terms.trim() } : {}),
    ...(notes.trim() ? { notes: notes.trim() } : {}),
    lines: lines.filter((l) => l.item).map((l) => ({
      itemId: l.item!.id,
      description: l.description.trim() || l.item!.name,
      hsn: l.item!.hsn_sac_code,
      qty: l.qty,
      uom: l.item!.uom,
      rate: l.rate,
      ...(l.discountPct && Number(l.discountPct) > 0 ? { discountPct: Number(l.discountPct) } : {}),
      gstRate: Number(l.item!.gst_rate),
    })),
  }), [customer, placeOfSupply, docDate, validUntil, terms, notes, lines]);

  const parsed = CreateQuotation.safeParse(payload);
  const allLinesValid = lines.every((l) => !l.item || Number(l.qty) > 0);
  const anyItem = lines.some((l) => l.item);
  const futureDated = docDate > today();
  const ready = parsed.success && allLinesValid && anyItem && !futureDated && !busy;

  const interState = company.data && placeOfSupply
    ? company.data.state_code !== placeOfSupply : null;
  const dues = customer && khata.data?.rows.find((r) => r.partyId === customer.id);

  async function saveDraft() {
    if (!parsed.success) return;
    setBusy(true);
    setError(null);
    try {
      const res = editingId
        ? await api.patch<{ id: string }>(`/api/sales/quotations/${editingId}`, parsed.data)
        : await api.post<{ id: string }>("/api/sales/quotations", parsed.data);
      void qc.invalidateQueries({ queryKey: ["quotations"] });
      void qc.invalidateQueries({ queryKey: ["quotation", res.id] });
      navigate(`/quotations/${res.id}`);
    } catch (e) {
      setError(friendlyMessage(e));
      setBusy(false);
    }
  }

  if (editingId && editingDraft.isLoading) return <p className="empty">Loading draft…</p>;
  if (editingId && editingDraft.isError) {
    return <div className="banner error" role="alert">{friendlyMessage(editingDraft.error)}</div>;
  }

  return (
    <>
      <h1>{editingId ? "Edit draft quotation" : "New quotation"}</h1>
      <p className="sub">
        Step through: customer → items → dates. A quotation is an estimate —
        nothing hits the books. Submit to lock it, then convert to an invoice when the order lands.
      </p>

      <div className="card">
        <label>Customer</label>
        <CustomerPicker value={customer} onChange={pickCustomer} />
        {customer && (
          <p className="sub" style={{ margin: "8px 0 0" }}>
            {customer.gstin ? <>GSTIN <strong>{customer.gstin}</strong> · </> : "No GSTIN (unregistered) · "}
            {dues ? <>current dues {inr(dues.balance)}</> : "no dues on the books"}
          </p>
        )}

        {customer && (
          <div className="row" style={{ marginTop: 4 }}>
            <div>
              <label htmlFor="pos">Place of supply <span className="hint">(buyer's state — decides the GST split)</span></label>
              <select id="pos" value={placeOfSupply} onChange={(e) => setPlaceOfSupply(e.target.value)}>
                <option value="" disabled>Select state…</option>
                {Object.entries(GST_STATES).sort(([a], [b]) => a.localeCompare(b)).map(([code, name]) => (
                  <option key={code} value={code}>{code} — {name}</option>
                ))}
              </select>
              {interState !== null && (
                <div className="sub" style={{ marginTop: 6 }}>
                  {interState
                    ? <>Outside {stateName(company.data!.state_code)} → <strong>IGST</strong></>
                    : <>Within {stateName(company.data!.state_code)} → <strong>CGST + SGST</strong></>}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {customer && (
        <div className="card">
          <label style={{ marginTop: 0 }}>Items</label>
          {lines.map((l, idx) => (
            <div className="line-row" key={l.key} data-line={idx + 1}>
              {!l.item ? (
                <ItemPicker onPick={(item) => pickItem(l.key, item)} />
              ) : (
                <>
                  <div className="grow">
                    <input aria-label="Description" value={l.description}
                           onChange={(e) => patchLine(l.key, { description: e.target.value })} />
                    <div className="sub" style={{ margin: "4px 0 0", fontSize: 12 }}>
                      HSN {l.item.hsn_sac_code} · GST {Number(l.item.gst_rate)}%
                    </div>
                  </div>
                  <div className="cell-qty">
                    <input aria-label="Quantity" inputMode="decimal" value={l.qty}
                           aria-invalid={l.qty !== "" && !(Number(l.qty) > 0)}
                           onChange={(e) => patchLine(l.key, { qty: e.target.value.trim() })} />
                    <span className="cell-hint">{l.item.uom}</span>
                  </div>
                  <div className="cell-rate">
                    <input aria-label="Rate" inputMode="decimal" placeholder="0.00" value={l.rate}
                           aria-invalid={l.rate !== "" && !/^\d+(\.\d{1,2})?$/.test(l.rate)}
                           onChange={(e) => patchLine(l.key, { rate: e.target.value.trim() })} />
                    <span className="cell-hint">₹/unit</span>
                  </div>
                  <div className="cell-disc">
                    <input aria-label="Discount %" inputMode="decimal" placeholder="0" value={l.discountPct}
                           onChange={(e) => patchLine(l.key, { discountPct: e.target.value.trim() })} />
                    <span className="cell-hint">disc %</span>
                  </div>
                  <div className="line-amount">{inr(lineAmount(l))}</div>
                </>
              )}
              <button type="button" className="secondary" aria-label={`Remove line ${idx + 1}`}
                      onClick={() => removeLine(l.key)}>✕</button>
            </div>
          ))}
          <button type="button" className="secondary" style={{ marginTop: 12 }}
                  onClick={() => setLines((ls) => [...ls, newLine()])}>
            ＋ Add another item
          </button>
          {anyItem && (
            <p className="sub" style={{ marginTop: 12 }}>
              Items total (before GST): <strong>{inr(itemsTotal)}</strong> — GST and the final
              total are calculated at the review step.
            </p>
          )}
        </div>
      )}

      {customer && (
        <div className="card">
          <div className="row">
            <div>
              <label htmlFor="docdate">Quotation date</label>
              <input id="docdate" type="date" value={docDate} max={today()}
                     onChange={(e) => setDocDate(e.target.value)} />
              {futureDated && <div className="field-error">The quotation date cannot be in the future.</div>}
            </div>
            <div>
              <label htmlFor="validuntil">Valid until <span className="hint">(optional)</span></label>
              <input id="validuntil" type="date" value={validUntil} min={docDate}
                     onChange={(e) => setValidUntil(e.target.value)} />
            </div>
          </div>
          <label htmlFor="terms" style={{ marginTop: 12 }}>Terms <span className="hint">(optional — shown on the printout)</span></label>
          <input id="terms" value={terms} onChange={(e) => setTerms(e.target.value)}
                 placeholder="e.g. 50% advance, delivery in 7 days" />
          <label htmlFor="notes" style={{ marginTop: 12 }}>Internal notes <span className="hint">(optional)</span></label>
          <input id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      )}

      {error && <div className="banner error" role="alert">{error}</div>}

      <button className="primary" disabled={!ready} onClick={() => void saveDraft()}>
        {busy ? "Saving…" : "Save draft & review"}
      </button>
    </>
  );
}
