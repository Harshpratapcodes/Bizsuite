import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { CompanyDto, CustomerOption } from "@bizsuite/contracts";
import { api, ApiError, friendlyMessage } from "../api";
import {
  GstIdentityFields, emptyGstIdentity, validateGstIdentity, gstIdentityPayload,
  type GstIdentity,
} from "./GstIdentityFields";

/**
 * Add a customer without leaving the document you are building.
 *
 * The whole reason this exists: every document builder holds its draft in
 * component state until "Save draft" posts it, so walking off to a customer
 * master screen threw away every line already typed. Staff hit this with a
 * customer standing in front of them (eng review D3).
 *
 * Two paths out of a name clash, because companies are unique on lower(name)
 * across customers AND suppliers, while the picker only ever searched active
 * customers. So a party you buy from looked absent and then refused to be
 * created. The 409 now offers to promote that record instead (D6).
 *
 *   type name → [+ Add customer]
 *        │
 *        ├── POST 201 ──────────────────→ select the new customer
 *        │
 *        └── POST 409 ─→ GET ?name=exact ─→ "on file as a supplier"
 *                                           [Also make them a customer]
 *                                                  │
 *                                            PATCH isCustomer/isActive
 *                                                  └──→ select it
 */

const toOption = (c: CompanyDto): CustomerOption => ({
  id: c.id, name: c.name, gstin: c.gstin, state_code: c.state_code, gst_treatment: c.gst_treatment,
});

/** How an existing record differs from what the user was trying to create. */
function describeExisting(c: CompanyDto): string {
  if (!c.is_active) return "is on file but was deactivated";
  if (!c.is_customer && c.is_supplier) return "is already on file as a supplier";
  if (!c.is_customer) return "is already on file, but not as a customer";
  return "is already on file as a customer";
}

export function QuickAddCustomer({ initialName, onCreated, onCancel }: {
  initialName: string;
  onCreated: (c: CustomerOption) => void;
  onCancel: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(initialName);
  const [gst, setGst] = useState<GstIdentity>(emptyGstIdentity);
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<CompanyDto | null>(null);

  function done(c: CompanyDto) {
    void qc.invalidateQueries({ queryKey: ["customers"] });
    void qc.invalidateQueries({ queryKey: ["companies"] });
    onCreated(toOption(c));
  }

  async function submit() {
    if (busy) return;                        // double-click guard: one company, not two
    const fieldErrors: Record<string, string> = { ...validateGstIdentity(gst) };
    if (!name.trim()) fieldErrors.name = "Enter the customer's name.";
    setErrors(fieldErrors);
    if (Object.keys(fieldErrors).length) return;

    setBusy(true);
    setError(null);
    setExisting(null);
    try {
      const created = await api.post<CompanyDto>("/api/crm/companies", {
        name: name.trim(), isCustomer: true, ...gstIdentityPayload(gst),
      });
      done(created);
    } catch (e) {
      if (e instanceof ApiError && e.code === "DUPLICATE_NAME") {
        // Exact lookup, not the substring search — see companies.routes.ts.
        try {
          const hits = await api.get<CompanyDto[]>(
            `/api/crm/companies?name=${encodeURIComponent(name.trim())}`);
          if (hits[0]) { setExisting(hits[0]); setBusy(false); return; }
        } catch { /* fall through to the plain message below */ }
      }
      setError(friendlyMessage(e));
      setBusy(false);
    }
  }

  async function promote() {
    if (!existing || busy) return;
    setBusy(true);
    setError(null);
    try {
      const patch = { ...(existing.is_customer ? {} : { isCustomer: true }), ...(existing.is_active ? {} : { isActive: true }) };
      const updated = Object.keys(patch).length
        ? await api.patch<CompanyDto>(`/api/crm/companies/${existing.id}`, patch)
        : existing;
      done(updated);
    } catch (e) {
      setError(friendlyMessage(e));
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: 8 }} role="group" aria-label="Add customer">
      <h3 style={{ margin: "0 0 4px" }}>Add customer</h3>
      <p className="sub" style={{ marginTop: 0 }}>
        Saved to the customer master and selected here. Your lines are kept.
      </p>

      {error && <div className="banner error" role="alert">{error}</div>}

      {existing ? (
        <div className="confirm-box">
          <p style={{ marginTop: 0 }}>
            <strong>{existing.name}</strong> {describeExisting(existing)}.
            {existing.is_customer && existing.is_active
              ? " Search for them in the box above instead."
              : " Use the same record so their account stays in one place."}
          </p>
          {!(existing.is_customer && existing.is_active) && (
            <button type="button" className="primary" style={{ marginTop: 0 }} disabled={busy} onClick={() => void promote()}>
              {busy ? "Working…" : "Also make them a customer"}
            </button>
          )}
          <button type="button" className="secondary" disabled={busy} onClick={() => setExisting(null)}>
            Go back
          </button>
        </div>
      ) : (
        <>
          <div>
            <label htmlFor="qac-name">Name</label>
            <input
              id="qac-name"
              value={name}
              autoFocus
              placeholder="Customer or business name"
              onChange={(e) => setName(e.target.value)}
            />
            {errors.name && <div className="field-error">{errors.name}</div>}
          </div>

          <GstIdentityFields value={gst} onChange={setGst} errors={errors} idPrefix="qac" />

          <div style={{ marginTop: 12 }}>
            <button type="button" className="primary" style={{ marginTop: 0 }} disabled={busy} onClick={() => void submit()}>
              {busy ? "Saving…" : "Save customer"}
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}
