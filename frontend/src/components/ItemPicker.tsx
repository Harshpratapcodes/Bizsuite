import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ItemOption } from "@bizsuite/contracts";
import { api } from "../api";
import { inr } from "../screens/Khata";

/**
 * Search-as-you-type item picker (hard rail: staff sells from the item master,
 * never free text — HSN and GST rate ride along from the master). Shows live
 * stock so INSUFFICIENT_STOCK is caught before submit, not after.
 */
export function ItemPicker({ onPick }: { onPick: (item: ItemOption) => void }) {
  const [term, setTerm] = useState("");
  const [open, setOpen] = useState(false);
  const [debounced, setDebounced] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(term), 250);
    return () => clearTimeout(t);
  }, [term]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const results = useQuery({
    queryKey: ["items", debounced],
    enabled: open,
    queryFn: () => api.get<ItemOption[]>(
      `/api/inventory/items?active=true${debounced ? `&q=${encodeURIComponent(debounced)}` : ""}`),
  });

  function stockLabel(item: ItemOption): { text: string; cls: string } {
    if (!item.is_stock_item) return { text: "Service", cls: "svc" };
    const n = Number(item.on_hand);
    return n > 0
      ? { text: `In stock: ${n.toLocaleString("en-IN")}`, cls: "ok" }
      : { text: "Out of stock", cls: "out" };
  }

  return (
    <div ref={boxRef} style={{ position: "relative", maxWidth: 520 }}>
      <input
        placeholder="Type item name or SKU…"
        value={term}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setTerm(e.target.value); setOpen(true); }}
        aria-label="Search item"
      />
      {open && (
        <div style={{
          position: "absolute", zIndex: 10, top: "100%", left: 0, right: 0,
          background: "#fff", border: "1px solid var(--line)", borderRadius: 8,
          marginTop: 4, maxHeight: 280, overflowY: "auto", boxShadow: "0 4px 16px rgba(0,0,0,.08)",
        }}>
          {results.isLoading && <div style={{ padding: 12, color: "var(--muted)" }}>Searching…</div>}
          {results.data && results.data.length === 0 && (
            <div style={{ padding: 12, color: "var(--muted)" }}>
              No item found{debounced ? ` for “${debounced}”` : ""}. Add it in the item master first.
            </div>
          )}
          {results.data?.map((item) => {
            const stock = stockLabel(item);
            return (
              <div key={item.id}
                   style={{ padding: "10px 12px", cursor: "pointer", display: "flex", gap: 10, alignItems: "baseline" }}
                   onMouseDown={() => { onPick(item); setOpen(false); setTerm(""); }}
                   onMouseEnter={(e) => (e.currentTarget.style.background = "#f1f5ff")}
                   onMouseLeave={(e) => (e.currentTarget.style.background = "")}>
                <span style={{ flex: 1 }}>
                  <strong>{item.name}</strong>
                  <span style={{ color: "var(--muted)", fontSize: 13 }}> · {item.sku} · GST {Number(item.gst_rate)}%</span>
                </span>
                <span style={{ fontSize: 13, color: "var(--muted)" }}>
                  {item.standard_selling_rate ? inr(item.standard_selling_rate) : ""}
                </span>
                <span className={`stock-badge ${stock.cls}`}>{stock.text}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
