import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { OpeningBalance } from "@bizsuite/contracts";
import { api, friendlyMessage } from "../api";
import { inr } from "./Khata";
import { CustomerPicker, type CustomerOption } from "../components/CustomerPicker";

/**
 * Opening balances — the week-one bootstrap (design doc D3). One live entry
 * per customer; the server rejects duplicates (OPENING_EXISTS) and corrections
 * go through an admin reversal, never an edit.
 */
export function OpeningBalanceScreen() {
  const qc = useQueryClient();
  const [customer, setCustomer] = useState<CustomerOption | null>(null);
  const [amount, setAmount] = useState("");
  const [asOfDate, setAsOfDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const payload = {
    customerId: customer?.id ?? "",
    amount,
    ...(asOfDate ? { asOfDate } : {}),
  };
  const parsed = OpeningBalance.safeParse(payload);
  const ready = parsed.success && Number(amount) > 0;

  async function submit() {
    if (!parsed.success) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await api.post<{ entryNo: string }>("/api/accounting/opening-balances", parsed.data);
      setDone(res.entryNo);
      setCustomer(null);
      setAmount("");
      void qc.invalidateQueries({ queryKey: ["khata"] });
    } catch (e) {
      setError(friendlyMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Opening balances</h1>
      <p className="sub">
        Old dues from the bill-book days — entered once per customer at go-live.
        Dr Debtors / Cr Opening Balances. Corrections need a reversal, not an edit.
      </p>

      {done && (
        <div className="banner ok" role="status">
          ✅ Opening balance posted (<strong>{done}</strong>). Khata updated.
        </div>
      )}

      <div className="card">
        <label>Customer</label>
        <CustomerPicker value={customer} onChange={(c) => { setCustomer(c); setDone(null); }} />

        <label htmlFor="ob-amount">They owe us <span className="hint">(₹, as of go-live)</span></label>
        <input id="ob-amount" inputMode="decimal" placeholder="e.g. 40000.00" value={amount}
               aria-invalid={amount !== "" && !/^\d+(\.\d{1,2})?$/.test(amount)}
               onChange={(e) => { setAmount(e.target.value.trim()); setDone(null); }} />
        {amount !== "" && !/^\d+(\.\d{1,2})?$/.test(amount) && (
          <div className="field-error">Enter a plain amount like 40000 or 40000.50</div>
        )}

        <label htmlFor="ob-date">As-of date <span className="hint">(optional, defaults to today)</span></label>
        <input id="ob-date" type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} />

        {error && <div className="banner error" role="alert">{error}</div>}

        <button className="primary" disabled={!ready || busy} onClick={() => void submit()}>
          {busy ? "Posting…" : customer && amount ? `Post ${inr(Number(amount))} for ${customer.name}` : "Post opening balance"}
        </button>
      </div>
    </>
  );
}
