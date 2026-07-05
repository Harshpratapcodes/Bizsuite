import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CreatePayment, type InvoiceListRow } from "@bizsuite/contracts";
import { api, friendlyMessage } from "../api";
import { inr } from "./Khata";
import { CustomerPicker, type CustomerOption } from "../components/CustomerPicker";

/**
 * Guided payment entry — the staff flow:
 *   1. pick customer  2. amount + mode  3. optional invoice-wise split
 *   4. confirm  5. Save & Submit (draft POST + submit POST)
 * Validation runs client-side with the SAME zod objects the server enforces.
 */
export function PaymentNewScreen() {
  const qc = useQueryClient();
  const [customer, setCustomer] = useState<CustomerOption | null>(null);
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<"cash" | "bank_transfer" | "upi" | "cheque" | "card">("cash");
  const [deposit, setDeposit] = useState<"cash" | "bank">("cash");
  const [referenceNo, setReferenceNo] = useState("");
  const [alloc, setAlloc] = useState<Record<string, string>>({});   // invoiceId -> amount
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);            // doc no on success

  const openInvoices = useQuery({
    queryKey: ["open-invoices", customer?.id],
    enabled: !!customer,
    queryFn: () => api.get<InvoiceListRow[]>(`/api/invoicing/invoices?status=submitted&customer=${customer!.id}`),
    select: (rows) => rows.filter((r) => Number(r.outstanding ?? 0) > 0),
  });

  const allocEntries = Object.entries(alloc).filter(([, v]) => v && Number(v) > 0);
  const allocTotal = allocEntries.reduce((s, [, v]) => s + Number(v), 0);
  const amountNum = Number(amount || 0);
  const overSplit = allocTotal > amountNum && amountNum > 0;

  const payload = useMemo(() => ({
    customerId: customer?.id ?? "",
    amount,
    mode,
    depositAccountKey: deposit,
    ...(referenceNo ? { referenceNo } : {}),
    ...(allocEntries.length > 0
      ? { allocations: allocEntries.map(([invoiceId, amt]) => ({ invoiceId, amount: Number(amt).toFixed(2) })) }
      : {}),
  }), [customer, amount, mode, deposit, referenceNo, alloc]);

  const parsed = CreatePayment.safeParse(payload);
  const ready = parsed.success && !overSplit && amountNum > 0;

  async function saveAndSubmit() {
    if (!parsed.success) return;
    setBusy(true);
    setError(null);
    try {
      const { id } = await api.post<{ id: string }>("/api/invoicing/payments", parsed.data);
      const { docNo } = await api.post<{ docNo: string }>(`/api/invoicing/payments/${id}/submit`);
      setDone(docNo);
      setConfirming(false);
      setCustomer(null); setAmount(""); setReferenceNo(""); setAlloc({});
      void qc.invalidateQueries({ queryKey: ["khata"] });
      void qc.invalidateQueries({ queryKey: ["open-invoices"] });
    } catch (e) {
      setError(friendlyMessage(e));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Payment received</h1>
      <p className="sub">Record money received from a customer — cash at the counter, UPI, bank transfer, or cheque.</p>

      {done && (
        <div className="banner ok" role="status">
          ✅ Payment recorded and posted: <strong>{done}</strong>. The khata is updated.
        </div>
      )}

      <div className="card">
        <label>Customer</label>
        <CustomerPicker value={customer} onChange={(c) => { setCustomer(c); setAlloc({}); setDone(null); }} />

        <div className="row">
          <div>
            <label htmlFor="amount">Amount received <span className="hint">(₹)</span></label>
            <input id="amount" inputMode="decimal" placeholder="e.g. 15000.00" value={amount}
                   aria-invalid={amount !== "" && !/^\d+(\.\d{1,2})?$/.test(amount)}
                   onChange={(e) => { setAmount(e.target.value.trim()); setDone(null); }} />
            {amount !== "" && !/^\d+(\.\d{1,2})?$/.test(amount) && (
              <div className="field-error">Enter a plain amount like 15000 or 15000.50</div>
            )}
          </div>
          <div>
            <label htmlFor="mode">How was it paid?</label>
            <select id="mode" value={mode} onChange={(e) => {
              const m = e.target.value as typeof mode;
              setMode(m);
              setDeposit(m === "cash" ? "cash" : "bank"); // sane default; still editable
            }}>
              <option value="cash">Cash</option>
              <option value="upi">UPI</option>
              <option value="bank_transfer">Bank transfer</option>
              <option value="cheque">Cheque</option>
              <option value="card">Card</option>
            </select>
          </div>
          <div>
            <label htmlFor="deposit">Money goes into</label>
            <select id="deposit" value={deposit} onChange={(e) => setDeposit(e.target.value as "cash" | "bank")}>
              <option value="cash">Cash box</option>
              <option value="bank">Bank account</option>
            </select>
          </div>
        </div>

        {(mode === "upi" || mode === "bank_transfer" || mode === "cheque") && (
          <>
            <label htmlFor="ref">Reference no. <span className="hint">(UTR / cheque no — optional)</span></label>
            <input id="ref" value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} />
          </>
        )}
      </div>

      {customer && (
        <div className="card">
          <label style={{ marginTop: 0 }}>
            Against which bills? <span className="hint">(optional — leave empty for on-account / old dues)</span>
          </label>
          {openInvoices.isLoading && <p className="empty">Loading open bills…</p>}
          {openInvoices.data && openInvoices.data.length === 0 && (
            <p className="empty">No open bills for {customer.name}. The payment will reduce their overall balance (on-account).</p>
          )}
          {openInvoices.data?.map((invoice) => (
            <div className="alloc-row" key={invoice.id}>
              <span className="inv">
                <strong>{invoice.doc_no}</strong> · {invoice.doc_date} · outstanding {inr(invoice.outstanding ?? "0")}
              </span>
              <input inputMode="decimal" placeholder="0.00" value={alloc[invoice.id] ?? ""}
                     aria-invalid={!!alloc[invoice.id] && Number(alloc[invoice.id]) > Number(invoice.outstanding ?? 0)}
                     onChange={(e) => setAlloc((a) => ({ ...a, [invoice.id]: e.target.value.trim() }))} />
            </div>
          ))}
          {allocEntries.length > 0 && (
            <p className="sub" style={{ marginTop: 10 }}>
              Split total: <strong>{inr(allocTotal)}</strong> of {amount ? inr(amountNum) : "—"}
            </p>
          )}
          {overSplit && (
            <div className="banner error" role="alert">The bill-wise split is more than the payment amount.</div>
          )}
        </div>
      )}

      {error && <div className="banner error" role="alert">{error}</div>}

      {!confirming ? (
        <button className="primary" disabled={!ready || busy} onClick={() => setConfirming(true)}>
          Review &amp; submit
        </button>
      ) : (
        <div className="confirm-box">
          <strong>Confirm:</strong> {inr(amountNum)} received from <strong>{customer?.name}</strong> by {mode.replace("_", " ")}
          {allocEntries.length > 0 ? `, split across ${allocEntries.length} bill(s)` : ", on account"}.
          Once submitted, corrections need an admin reversal.
          <div style={{ marginTop: 12, display: "flex", gap: 10 }}>
            <button className="primary" style={{ marginTop: 0 }} disabled={busy} onClick={() => void saveAndSubmit()}>
              {busy ? "Submitting…" : "Yes, submit payment"}
            </button>
            <button className="secondary" disabled={busy} onClick={() => setConfirming(false)}>Go back</button>
          </div>
        </div>
      )}
    </>
  );
}
