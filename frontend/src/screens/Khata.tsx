import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Digest, KhataReport } from "@bizsuite/contracts";
import { api, friendlyMessage } from "../api";

/** ₹ with Indian digit grouping. */
export function inr(decimal: string | number): string {
  const n = typeof decimal === "number" ? decimal : Number(decimal);
  return "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function KhataScreen() {
  const [copied, setCopied] = useState(false);
  const [digestError, setDigestError] = useState<string | null>(null);

  const khata = useQuery({
    queryKey: ["khata"],
    queryFn: () => api.get<KhataReport>("/api/accounting/reports/khata"),
  });

  async function copyDigest() {
    setDigestError(null);
    setCopied(false);
    try {
      const digest = await api.get<Digest>("/api/accounting/reports/digest");
      await navigator.clipboard.writeText(digest.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 4000);
    } catch (e) {
      setDigestError(friendlyMessage(e));
    }
  }

  return (
    <>
      <h1>Khata — who owes us</h1>
      <p className="sub">Live from the ledger. Positive = customer owes us.</p>

      <div className="card">
        <button className="secondary" onClick={() => void copyDigest()}>
          📋 Copy Friday digest for WhatsApp
        </button>
        {copied && <div className="banner ok" role="status">Digest copied — paste it into WhatsApp.</div>}
        {digestError && <div className="banner error" role="alert">{digestError}</div>}
      </div>

      <div className="card">
        {khata.isLoading && <p className="empty">Loading…</p>}
        {khata.isError && <div className="banner error" role="alert">{friendlyMessage(khata.error)}</div>}
        {khata.data && khata.data.rows.length === 0 && (
          <p className="empty">No dues on the books yet. Enter opening balances to start the khata.</p>
        )}
        {khata.data && khata.data.rows.length > 0 && (
          <table>
            <thead>
              <tr><th>Customer</th><th className="num">Balance</th></tr>
            </thead>
            <tbody>
              {khata.data.rows.map((r) => (
                <tr key={r.partyId}>
                  <td>{r.partyName}</td>
                  <td className="num">{inr(r.balance)}</td>
                </tr>
              ))}
              <tr className="total-row">
                <td>Total receivable</td>
                <td className="num">{inr(khata.data.totalReceivable)}</td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
