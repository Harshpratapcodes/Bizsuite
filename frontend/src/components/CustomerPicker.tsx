import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

export interface CustomerOption {
  id: string;
  name: string;
}

/**
 * Search-as-you-type customer picker (hard rail: staff picks from the master,
 * never types a free-text name). Debounced 250ms against
 * GET /api/crm/companies?role=customer&active=true&q=…
 */
export function CustomerPicker({ value, onChange }: {
  value: CustomerOption | null;
  onChange: (c: CustomerOption | null) => void;
}) {
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
    queryKey: ["customers", debounced],
    enabled: open,
    queryFn: () => api.get<CustomerOption[]>(
      `/api/crm/companies?role=customer&active=true${debounced ? `&q=${encodeURIComponent(debounced)}` : ""}`),
  });

  if (value) {
    return (
      <div>
        <strong>{value.name}</strong>{" "}
        <button type="button" className="secondary" style={{ marginLeft: 8 }}
                onClick={() => { onChange(null); setTerm(""); }}>
          Change
        </button>
      </div>
    );
  }

  return (
    <div ref={boxRef} style={{ position: "relative", maxWidth: 420 }}>
      <input
        placeholder="Type customer name…"
        value={term}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setTerm(e.target.value); setOpen(true); }}
        aria-label="Search customer"
      />
      {open && (
        <div style={{
          position: "absolute", zIndex: 10, top: "100%", left: 0, right: 0,
          background: "#fff", border: "1px solid var(--line)", borderRadius: 8,
          marginTop: 4, maxHeight: 260, overflowY: "auto", boxShadow: "0 4px 16px rgba(0,0,0,.08)",
        }}>
          {results.isLoading && <div style={{ padding: 12, color: "var(--muted)" }}>Searching…</div>}
          {results.data && results.data.length === 0 && (
            <div style={{ padding: 12, color: "var(--muted)" }}>
              No customer found{debounced ? ` for “${debounced}”` : ""}. Add them in the customer master first.
            </div>
          )}
          {results.data?.map((c) => (
            <div key={c.id}
                 style={{ padding: "10px 12px", cursor: "pointer" }}
                 onMouseDown={() => { onChange(c); setOpen(false); }}
                 onMouseEnter={(e) => (e.currentTarget.style.background = "#f1f5ff")}
                 onMouseLeave={(e) => (e.currentTarget.style.background = "")}>
              {c.name}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
