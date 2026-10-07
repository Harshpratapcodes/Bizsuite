import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CompanyDto, CustomerOption } from "@bizsuite/contracts";
import { api } from "../api";
import { useAuth, canCreateCustomer } from "../auth";
import { QuickAddCustomer } from "./QuickAddCustomer";

/** Re-exported so the five document builders keep importing it from here. */
export type { CustomerOption };

/**
 * Search-as-you-type customer picker. Staff still pick from the master rather
 * than typing a free-text name — a document's customer is a foreign key into
 * the party ledger, and the buyer's state decides the GST split.
 *
 * What changed (eng review 2026-09-10): "not found" used to be a dead end that
 * told staff to visit a customer master screen which did not exist, and
 * walking off to build one lost the whole draft. Now the miss offers to create
 * the customer inline. Roles without crm write never see the button, because a
 * control that 403s on click is worse than no control (D5).
 *
 * Debounced 250ms against GET /api/crm/companies?role=customer&active=true&q=…
 */
export function CustomerPicker({ value, onChange }: {
  value: CustomerOption | null;
  onChange: (c: CustomerOption | null) => void;
}) {
  const { user } = useAuth();
  const [term, setTerm] = useState("");
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
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
    enabled: open && !adding,
    queryFn: () => api.get<CompanyDto[]>(
      `/api/crm/companies?role=customer&active=true${debounced ? `&q=${encodeURIComponent(debounced)}` : ""}`),
  });

  const canAdd = canCreateCustomer(user);

  // The add form replaces the picker rather than floating over it, so there is
  // never a second "Search customer" input in the DOM for tests (or for people
  // tabbing through) to trip over.
  if (adding) {
    return (
      <QuickAddCustomer
        initialName={term}
        onCreated={(c) => { setAdding(false); setOpen(false); setTerm(""); onChange(c); }}
        onCancel={() => setAdding(false)}
      />
    );
  }

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

  const empty = results.data && results.data.length === 0;

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
          {empty && (
            <div style={{ padding: 12, color: "var(--muted)" }}>
              No customer found{debounced ? ` for “${debounced}”` : ""}.
              {!canAdd && " Ask an admin to add them to the customer master."}
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
          {canAdd && (
            <div style={{ borderTop: "1px solid var(--line)", padding: 8 }}>
              <button type="button" className="btn-link" onMouseDown={() => setAdding(true)}>
                + Add {term.trim() ? `“${term.trim()}”` : "a new customer"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
