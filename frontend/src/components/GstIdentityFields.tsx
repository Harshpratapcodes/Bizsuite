import { GST_STATES } from "../gst-states";

/**
 * The GST identity block: treatment → GSTIN → state code.
 *
 * Shared by the picker's quick-add modal and the customers master screen, and
 * ONLY this block is shared (eng review D9). These three fields carry every
 * rule that produces wrong tax when it goes wrong:
 *
 *   registered              → GSTIN required (also a DB CHECK)
 *   registered|unregistered → state code required; it IS the place of supply
 *   overseas|sez            → no state code, no GSTIN
 *
 * The surrounding plain fields (name, address, notes) are written out flatly
 * on each surface instead, so neither form has a mode flag threaded through it.
 */

export type Treatment = "registered" | "unregistered" | "overseas" | "sez";

export interface GstIdentity {
  gstTreatment: Treatment;
  gstin: string;
  stateCode: string;
}

export const emptyGstIdentity = (): GstIdentity =>
  ({ gstTreatment: "unregistered", gstin: "", stateCode: "" });

/** True when the treatment is inside India and therefore needs a state. */
export const isDomestic = (t: Treatment): boolean => t === "registered" || t === "unregistered";

const GSTIN_RE = /^[0-9]{2}[A-Z0-9]{13}$/;

/**
 * Field-level errors, keyed by field. Mirrors the CreateCompany superRefine in
 * @bizsuite/contracts — the server re-checks the same rules, but a 422 carries
 * no message the UI can render, so the form must catch these itself.
 */
export function validateGstIdentity(v: GstIdentity): Partial<Record<keyof GstIdentity, string>> {
  const errors: Partial<Record<keyof GstIdentity, string>> = {};
  if (v.gstTreatment === "registered" && !v.gstin.trim()) {
    errors.gstin = "A registered customer must have a GSTIN.";
  } else if (v.gstin.trim() && !GSTIN_RE.test(v.gstin.trim().toUpperCase())) {
    errors.gstin = "That does not look like a GSTIN (15 characters, e.g. 27AAAPA1234A1Z5).";
  }
  if (isDomestic(v.gstTreatment) && !v.stateCode) {
    errors.stateCode = "Pick the state — it decides whether the bill is CGST + SGST or IGST.";
  }
  return errors;
}

/** The parts of a CreateCompany/UpdateCompany body this block owns. */
export function gstIdentityPayload(v: GstIdentity): {
  gstTreatment: Treatment; gstin?: string; stateCode?: string;
} {
  return {
    gstTreatment: v.gstTreatment,
    ...(v.gstin.trim() ? { gstin: v.gstin.trim().toUpperCase() } : {}),
    ...(isDomestic(v.gstTreatment) && v.stateCode ? { stateCode: v.stateCode } : {}),
  };
}

export function GstIdentityFields({ value, onChange, errors, idPrefix = "gst" }: {
  value: GstIdentity;
  onChange: (v: GstIdentity) => void;
  errors: Partial<Record<keyof GstIdentity, string>>;
  idPrefix?: string;
}) {
  const domestic = isDomestic(value.gstTreatment);
  const set = (patch: Partial<GstIdentity>) => onChange({ ...value, ...patch });

  return (
    <>
      <div>
        <label htmlFor={`${idPrefix}-treatment`}>GST treatment</label>
        <select
          id={`${idPrefix}-treatment`}
          value={value.gstTreatment}
          onChange={(e) => {
            const gstTreatment = e.target.value as Treatment;
            // Leaving India clears the fields that only make sense inside it,
            // so a stale state code can't ride along on an export invoice.
            set(isDomestic(gstTreatment) ? { gstTreatment } : { gstTreatment, stateCode: "", gstin: "" });
          }}
        >
          <option value="unregistered">Unregistered (no GSTIN)</option>
          <option value="registered">Registered (has a GSTIN)</option>
          <option value="overseas">Overseas (export)</option>
          <option value="sez">SEZ</option>
        </select>
      </div>

      {value.gstTreatment !== "overseas" && value.gstTreatment !== "sez" && (
        <div>
          <label htmlFor={`${idPrefix}-gstin`}>
            GSTIN{" "}
            <span className="hint">
              {value.gstTreatment === "registered" ? "(required)" : "(optional)"}
            </span>
          </label>
          <input
            id={`${idPrefix}-gstin`}
            value={value.gstin}
            placeholder="27AAAPA1234A1Z5"
            autoCapitalize="characters"
            onChange={(e) => set({ gstin: e.target.value.toUpperCase() })}
          />
          {errors.gstin && <div className="field-error">{errors.gstin}</div>}
        </div>
      )}

      {domestic && (
        <div>
          <label htmlFor={`${idPrefix}-state`}>
            State <span className="hint">(decides the GST split on every bill)</span>
          </label>
          <select
            id={`${idPrefix}-state`}
            value={value.stateCode}
            onChange={(e) => set({ stateCode: e.target.value })}
          >
            <option value="">Select state…</option>
            {Object.entries(GST_STATES).sort(([a], [b]) => a.localeCompare(b)).map(([code, name]) => (
              <option key={code} value={code}>{code} — {name}</option>
            ))}
          </select>
          {errors.stateCode && <div className="field-error">{errors.stateCode}</div>}
        </div>
      )}
    </>
  );
}
