import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CompanyDto } from "@bizsuite/contracts";
import { api, friendlyMessage } from "../api";
import { useAuth, canCreateCustomer } from "../auth";
import { fmtAddress } from "../address";
import { stateName } from "../gst-states";
import {
  GstIdentityFields, emptyGstIdentity, validateGstIdentity, gstIdentityPayload,
  type GstIdentity, type Treatment,
} from "../components/GstIdentityFields";

/**
 * Customer master (blueprint Phase 4 task 1 — the "[~] UI pending" half).
 *
 * The quick-add modal in the picker covers a walk-in mid-quote; this screen is
 * where a record gets CORRECTED. That matters more than it sounds: a wrong
 * state code silently bills every future invoice CGST/SGST instead of IGST,
 * and before this screen the only fix was an admin with a terminal.
 *
 * Search is name OR GSTIN. The list is capped server-side at 500 rows and says
 * so when it hits the cap, rather than quietly hiding later names (D11).
 * Real paging is TODOS.md #5, triggered at roughly 400 customers.
 */

const LIST_CAP = 500;

interface FormState {
  name: string;
  gst: GstIdentity;
  line1: string; line2: string; city: string; district: string; pincode: string;
  notes: string;
  isSupplier: boolean;
  isActive: boolean;
}

const emptyForm = (): FormState => ({
  name: "", gst: emptyGstIdentity(),
  line1: "", line2: "", city: "", district: "", pincode: "",
  notes: "", isSupplier: false, isActive: true,
});

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function formFrom(c: CompanyDto): FormState {
  const a = c.billing_address ?? {};
  return {
    name: c.name,
    gst: {
      gstTreatment: (c.gst_treatment as Treatment) ?? "unregistered",
      gstin: c.gstin ?? "",
      stateCode: c.state_code ?? "",
    },
    line1: str(a.line1), line2: str(a.line2), city: str(a.city),
    district: str(a.district), pincode: str(a.pincode),
    notes: c.notes ?? "", isSupplier: c.is_supplier, isActive: c.is_active,
  };
}

/** Address keys are only sent when filled, so we never write empty strings. */
function addressPayload(f: FormState): Record<string, string> {
  const a: Record<string, string> = {};
  for (const k of ["line1", "line2", "city", "district", "pincode"] as const) {
    if (f[k].trim()) a[k] = f[k].trim();
  }
  return a;
}

export function CustomersScreen() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [term, setTerm] = useState("");
  const [debounced, setDebounced] = useState("");
  const [editing, setEditing] = useState<CompanyDto | "new" | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(term), 250);
    return () => clearTimeout(t);
  }, [term]);

  const list = useQuery({
    queryKey: ["companies", debounced],
    queryFn: () => api.get<CompanyDto[]>(
      `/api/crm/companies?role=customer${debounced ? `&q=${encodeURIComponent(debounced)}` : ""}`),
  });

  const canEdit = canCreateCustomer(user);
  const rows = list.data ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Customers</h1>
          <p className="sub">
            The customer master. Every quotation, invoice and payment points at a record here,
            and the state on the record decides the GST split on the bill.
          </p>
        </div>
        {canEdit && !editing && (
          <button type="button" className="btn-link" onClick={() => setEditing("new")}>＋ New customer</button>
        )}
      </div>

      {editing && (
        <CustomerForm
          key={editing === "new" ? "new" : editing.id}
          existing={editing === "new" ? null : editing}
          onDone={() => {
            setEditing(null);
            void qc.invalidateQueries({ queryKey: ["companies"] });
            void qc.invalidateQueries({ queryKey: ["customers"] });
          }}
          onCancel={() => setEditing(null)}
        />
      )}

      {!editing && (
        <>
          <div className="card">
            <label htmlFor="cust-search" style={{ marginTop: 0 }}>
              Search <span className="hint">(name or GSTIN)</span>
            </label>
            <input
              id="cust-search"
              value={term}
              placeholder="Sharma Traders, or 27AAAPA…"
              onChange={(e) => setTerm(e.target.value)}
              style={{ maxWidth: 420 }}
            />
          </div>

          <div className="card">
            {list.isLoading && <p className="empty">Loading…</p>}
            {list.isError && <div className="banner error" role="alert">{friendlyMessage(list.error)}</div>}
            {list.data && rows.length === 0 && (
              <p className="empty">
                {debounced ? `No customer matches “${debounced}”.` : "No customers yet."}
              </p>
            )}
            {rows.length > 0 && (
              <>
                <table>
                  <thead>
                    <tr><th>Name</th><th>GSTIN</th><th>State</th><th>Address</th><th>Status</th><th /></tr>
                  </thead>
                  <tbody>
                    {rows.map((c) => (
                      <tr key={c.id}>
                        <td>
                          <strong>{c.name}</strong>
                          {c.is_supplier && <span className="cell-hint"> · also a supplier</span>}
                        </td>
                        <td>{c.gstin ?? <span className="cell-hint">Unregistered</span>}</td>
                        <td>{c.state_code ? stateName(c.state_code) : <span className="cell-hint">—</span>}</td>
                        <td>{fmtAddress(c.billing_address) || <span className="cell-hint">—</span>}</td>
                        <td>{c.is_active ? "Active" : <span className="cell-hint">Deactivated</span>}</td>
                        <td>
                          {canEdit && (
                            <button type="button" className="btn-link" onClick={() => setEditing(c)}>Edit</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {rows.length >= LIST_CAP && (
                  <p className="sub" style={{ marginTop: 12 }}>
                    Showing the first {LIST_CAP} customers. Use search to narrow the list —
                    names later in the alphabet are not shown here.
                  </p>
                )}
              </>
            )}
          </div>
        </>
      )}
    </>
  );
}

/**
 * Full master record. Shares only <GstIdentityFields> with the quick-add modal
 * — the rules that produce wrong tax live in one place, the plain fields are
 * written out flatly on each surface so neither carries a mode flag (D9).
 */
function CustomerForm({ existing, onDone, onCancel }: {
  existing: CompanyDto | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [f, setF] = useState<FormState>(existing ? formFrom(existing) : emptyForm());
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<FormState>) => setF((s) => ({ ...s, ...patch }));

  async function save() {
    if (busy) return;
    const fieldErrors: Record<string, string> = { ...validateGstIdentity(f.gst) };
    if (!f.name.trim()) fieldErrors.name = "Enter the customer name.";
    if (f.pincode.trim() && !/^[1-9][0-9]{5}$/.test(f.pincode.trim())) {
      fieldErrors.pincode = "A PIN code is 6 digits.";
    }
    setErrors(fieldErrors);
    if (Object.keys(fieldErrors).length) return;

    setBusy(true);
    setError(null);
    const gstPart = gstIdentityPayload(f.gst);
    const common = {
      name: f.name.trim(),
      billingAddress: addressPayload(f),
      isCustomer: true,
      isSupplier: f.isSupplier,
    };
    try {
      if (existing) {
        // On a patch, absent means "leave alone" — so nullable fields are sent
        // explicitly. Clearing a GSTIN has to be a deliberate null, never a
        // silently omitted key.
        await api.patch(`/api/crm/companies/${existing.id}`, {
          ...common,
          gstTreatment: gstPart.gstTreatment,
          gstin: gstPart.gstin ?? null,
          stateCode: gstPart.stateCode ?? null,
          notes: f.notes.trim() || null,
          isActive: f.isActive,
        });
      } else {
        await api.post("/api/crm/companies", {
          ...common,
          ...gstPart,
          ...(f.notes.trim() ? { notes: f.notes.trim() } : {}),
        });
      }
      onDone();
    } catch (e) {
      setError(friendlyMessage(e));
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>{existing ? `Edit ${existing.name}` : "New customer"}</h2>
      {error && <div className="banner error" role="alert">{error}</div>}

      <div>
        <label htmlFor="cf-name">Name</label>
        <input id="cf-name" value={f.name} onChange={(e) => set({ name: e.target.value })} />
        {errors.name && <div className="field-error">{errors.name}</div>}
      </div>

      <GstIdentityFields value={f.gst} onChange={(gst) => set({ gst })} errors={errors} idPrefix="cf" />

      <h3>Billing address</h3>
      <p className="sub" style={{ marginTop: 0 }}>
        Printed on quotations and invoices. The state comes from the field above, not from here.
      </p>
      <div>
        <label htmlFor="cf-line1">Address line 1</label>
        <input id="cf-line1" value={f.line1} onChange={(e) => set({ line1: e.target.value })} />
      </div>
      <div>
        <label htmlFor="cf-line2">Address line 2</label>
        <input id="cf-line2" value={f.line2} onChange={(e) => set({ line2: e.target.value })} />
      </div>
      <div className="row">
        <div>
          <label htmlFor="cf-city">City</label>
          <input id="cf-city" value={f.city} onChange={(e) => set({ city: e.target.value })} />
        </div>
        <div>
          <label htmlFor="cf-district">District</label>
          <input id="cf-district" value={f.district} onChange={(e) => set({ district: e.target.value })} />
        </div>
        <div>
          <label htmlFor="cf-pincode">PIN code</label>
          <input id="cf-pincode" value={f.pincode} inputMode="numeric"
                 onChange={(e) => set({ pincode: e.target.value })} />
          {errors.pincode && <div className="field-error">{errors.pincode}</div>}
        </div>
      </div>

      <div>
        <label htmlFor="cf-notes">Notes</label>
        <input id="cf-notes" value={f.notes} onChange={(e) => set({ notes: e.target.value })} />
      </div>

      <div style={{ marginTop: 12 }}>
        <label htmlFor="cf-supplier" style={{ display: "inline" }}>
          <input id="cf-supplier" type="checkbox" checked={f.isSupplier}
                 onChange={(e) => set({ isSupplier: e.target.checked })} />
          {" "}We also buy from them (supplier)
        </label>
      </div>

      {existing && (
        <div style={{ marginTop: 8 }}>
          <label htmlFor="cf-active" style={{ display: "inline" }}>
            <input id="cf-active" type="checkbox" checked={f.isActive}
                   onChange={(e) => set({ isActive: e.target.checked })} />
            {" "}Active{" "}
            <span className="hint">(deactivated customers stay on old documents but cannot be picked)</span>
          </label>
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <button type="button" className="primary" style={{ marginTop: 0 }} disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : existing ? "Save changes" : "Create customer"}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
