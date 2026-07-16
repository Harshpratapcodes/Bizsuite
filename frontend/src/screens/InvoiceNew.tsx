import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CreateInvoice,
  type CompanySettingsDto, type InvoiceDetail, type ItemOption,
  type KhataReport, type WarehouseDto,
} from "@bizsuite/contracts";
import { api, friendlyMessage } from "../api";
import { inr } from "./Khata";
import { CustomerPicker, type CustomerOption } from "../components/CustomerPicker";
import { ItemPicker } from "../components/ItemPicker";
import { GST_STATES, stateName } from "../gst-states";

/**
 * Guided invoice entry — the staff flow (eng-review test plan `/invoices/new`):
 *   1. pick customer  2. add items from the master (qty/rate/discount)
 *   3. dates  4. Save draft & review
 * GST is NOT computed here: "Save draft" posts to the server, and the review
 * screen (InvoiceDetail) shows the server-computed totals — client and server
 * can never disagree about tax. The draft survives a crash/logout server-side
 * and is resumable from the Invoices list.
 */

interface LineDraft {
  key: number;
  item: ItemOption | null;
  description: string;
  qty: string;
  rate: string;
  discountPct: string;   // "" = no discount
}

let lineKey = 1;
const newLine = (): LineDraft => ({ key: lineKey++, item: null, description: "", qty: "1", rate: "", discountPct: "" });

const today = (): string => new Date().toISOString().slice(0, 10);

export function InvoiceNewScreen() {
  const { id: editingId } = useParams();          // present on /invoices/:id/edit
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [customer, setCustomer] = useState<CustomerOption | null>(null);
  const [placeOfSupply, setPlaceOfSupply] = useState("");
  const [docDate, setDocDate] = useState(today());
  const [dueDate, setDueDate] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([newLine()]);
  const [warehouseId, setWarehouseId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedDraft, setLoadedDraft] = useState(false);

  const company = useQuery({
    queryKey: ["company-settings"],
    queryFn: () => api.get<CompanySettingsDto>("/api/settings/company"),
  });
  const warehouses = useQuery({
    queryKey: ["warehouses"],
    queryFn: () => api.get<WarehouseDto[]>("/api/inventory/warehouses"),
  });
  const khata = useQuery({
    queryKey: ["khata"],
    queryFn: () => api.get<KhataReport>("/api/accounting/reports/khata"),
  });
  const editingDraft = useQuery({
    queryKey: ["invoice", editingId],
    enabled: !!editingId,
    queryFn: () => api.get<InvoiceDetail>(`/api/invoicing/invoices/${editingId}`),
  });

  // Default the sole warehouse silently; show a select only when there are several.
  useEffect(() => {
    if (!warehouseId && warehouses.data?.length) setWarehouseId(warehouses.data[0]!.id);
  }, [warehouses.data, warehouseId]);

  // Edit mode: prefill the form from the server-side draft, exactly once.
  useEffect(() => {
    const d = editingDraft.data;
    if (!d || loadedDraft) return;
    if (d.status !== "draft") { navigate(`/invoices/${d.id}`, { replace: true }); return; }
    setLoadedDraft(true);
    setCustomer({ id: d.customer_id, name: d.customer.name, gstin: d.customer.gstin, state_code: d.customer.state_code });
    if (d.source_warehouse_id) setWarehouseId(d.source_warehouse_id);   // keep the draft's warehouse
    setPlaceOfSupply(d.place_of_supply);
    setDocDate(d.doc_date);
    setDueDate(d.due_date ?? "");
    setLines(d.lines.filter((l) => l.item_id).map((l) => ({
      key: lineKey++,
      item: {
        id: l.item_id!, sku: "", name: l.description, description: null,
        uom: l.uom, hsn_sac_code: l.hsn_sac_code, gst_rate: l.gst_rate,
        is_stock_item: true, standard_selling_rate: null,
        on_hand: "", is_active: true,     // on_hand unknown here; low-stock warning skipped
      },
      description: l.description,
      qty: String(Number(l.qty)),   // "2.000" → "2", "2.500" → "2.5"
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
    warehouseId,
    placeOfSupply,
    ...(docDate ? { docDate } : {}),
    ...(dueDate ? { dueDate } : {}),
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
  }), [customer, warehouseId, placeOfSupply, docDate, dueDate, lines]);

  const parsed = CreateInvoice.safeParse(payload);
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
        ? await api.patch<{ id: string }>(`/api/invoicing/invoices/${editingId}`, parsed.data)
        : await api.post<{ id: string }>("/api/invoicing/invoices", parsed.data);
      void qc.invalidateQueries({ queryKey: ["invoices"] });
      void qc.invalidateQueries({ queryKey: ["invoice", res.id] });
      navigate(`/invoices/${res.id}`);
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
      <h1>{editingId ? "Edit draft invoice" : "New sale (invoice)"}</h1>
      <p className="sub">
        Step through: customer → items → dates → review. Nothing goes on the books
        until you submit on the review screen.
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
            {(warehouses.data?.length ?? 0) > 1 && (
              <div>
                <label htmlFor="wh">From warehouse</label>
                <select id="wh" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                  {warehouses.data!.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              </div>
            )}
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
                      {l.item.on_hand !== "" && l.item.is_stock_item &&
                        <> · in stock: {Number(l.item.on_hand).toLocaleString("en-IN")}</>}
                    </div>
                  </div>
                  <div className="cell-qty">
                    <input aria-label="Quantity" inputMode="decimal" value={l.qty}
                           aria-invalid={l.qty !== "" && !(Number(l.qty) > 0)}
                           onChange={(e) => patchLine(l.key, { qty: e.target.value.trim() })} />
                    <span className="cell-hint">{l.item.uom}</span>
                    {l.item.on_hand !== "" && l.item.is_stock_item && Number(l.qty) > Number(l.item.on_hand) && (
                      <div className="field-error">Only {Number(l.item.on_hand)} in stock</div>
                    )}
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
              <label htmlFor="docdate">Invoice date</label>
              <input id="docdate" type="date" value={docDate} max={today()}
                     onChange={(e) => setDocDate(e.target.value)} />
              {futureDated && <div className="field-error">The invoice date cannot be in the future.</div>}
            </div>
            <div>
              <label htmlFor="duedate">Due date <span className="hint">(optional)</span></label>
              <input id="duedate" type="date" value={dueDate} min={docDate}
                     onChange={(e) => setDueDate(e.target.value)} />
            </div>
          </div>
        </div>
      )}

      {error && <div className="banner error" role="alert">{error}</div>}

      <button className="primary" disabled={!ready} onClick={() => void saveDraft()}>
        {busy ? "Saving…" : "Save draft & review"}
      </button>
    </>
  );
}
