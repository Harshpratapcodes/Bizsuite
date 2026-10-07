import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import {
  GstIdentityFields, emptyGstIdentity, validateGstIdentity, gstIdentityPayload,
  isDomestic, type GstIdentity,
} from "./GstIdentityFields";

/**
 * These are the rules that decide whether a tax number gets captured and
 * whether a bill is CGST+SGST or IGST. They are shared between the quick-add
 * modal and the customer master, so they are tested once, here.
 */

function Harness({ initial }: { initial?: Partial<GstIdentity> }) {
  const [v, setV] = useState<GstIdentity>({ ...emptyGstIdentity(), ...initial });
  return <GstIdentityFields value={v} onChange={setV} errors={validateGstIdentity(v)} />;
}

describe("validateGstIdentity", () => {
  it("requires a GSTIN when the treatment is registered", () => {
    const e = validateGstIdentity({ gstTreatment: "registered", gstin: "", stateCode: "27" });
    expect(e.gstin).toMatch(/must have a GSTIN/);
  });

  it("accepts a registered company that has a GSTIN", () => {
    const e = validateGstIdentity({ gstTreatment: "registered", gstin: "27AAAPA1234A1Z5", stateCode: "27" });
    expect(e.gstin).toBeUndefined();
    expect(e.stateCode).toBeUndefined();
  });

  it("rejects a malformed GSTIN even when one is not required", () => {
    const e = validateGstIdentity({ gstTreatment: "unregistered", gstin: "nonsense", stateCode: "27" });
    expect(e.gstin).toMatch(/does not look like a GSTIN/);
  });

  it("requires a state code for both domestic treatments", () => {
    for (const t of ["registered", "unregistered"] as const) {
      const e = validateGstIdentity({ gstTreatment: t, gstin: "27AAAPA1234A1Z5", stateCode: "" });
      expect(e.stateCode, `${t} should need a state`).toMatch(/CGST \+ SGST or IGST/);
    }
  });

  it("does NOT require a state code for overseas or SEZ", () => {
    for (const t of ["overseas", "sez"] as const) {
      const e = validateGstIdentity({ gstTreatment: t, gstin: "", stateCode: "" });
      expect(e.stateCode, `${t} should not need a state`).toBeUndefined();
    }
  });
});

describe("gstIdentityPayload", () => {
  it("upper-cases and trims a GSTIN", () => {
    const p = gstIdentityPayload({ gstTreatment: "registered", gstin: "  27aaapa1234a1z5 ", stateCode: "27" });
    expect(p.gstin).toBe("27AAAPA1234A1Z5");
  });

  it("omits empty optional fields rather than sending blanks", () => {
    const p = gstIdentityPayload({ gstTreatment: "unregistered", gstin: "", stateCode: "27" });
    expect(p).not.toHaveProperty("gstin");
    expect(p.stateCode).toBe("27");
  });

  it("never sends a state code for a non-domestic treatment", () => {
    const p = gstIdentityPayload({ gstTreatment: "overseas", gstin: "", stateCode: "27" });
    expect(p).not.toHaveProperty("stateCode");
  });
});

describe("isDomestic", () => {
  it("splits Indian from non-Indian treatments", () => {
    expect(isDomestic("registered")).toBe(true);
    expect(isDomestic("unregistered")).toBe(true);
    expect(isDomestic("overseas")).toBe(false);
    expect(isDomestic("sez")).toBe(false);
  });
});

describe("<GstIdentityFields> rendering", () => {
  it("shows the GSTIN field as required for a registered company", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.selectOptions(screen.getByLabelText(/GST treatment/), "registered");
    expect(screen.getByLabelText(/GSTIN/)).toBeInTheDocument();
    expect(screen.getByText("(required)")).toBeInTheDocument();
  });

  it("hides the GSTIN and state fields entirely for an overseas buyer", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.selectOptions(screen.getByLabelText(/GST treatment/), "overseas");
    expect(screen.queryByLabelText(/GSTIN/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^State/)).not.toBeInTheDocument();
  });

  it("shows the state field for a domestic buyer", async () => {
    render(<Harness initial={{ gstTreatment: "unregistered" }} />);
    expect(screen.getByLabelText(/^State/)).toBeInTheDocument();
  });

  it("clears a stale state code when the buyer moves overseas", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <GstIdentityFields
        value={{ gstTreatment: "registered", gstin: "27AAAPA1234A1Z5", stateCode: "27" }}
        onChange={onChange}
        errors={{}}
      />,
    );
    await user.selectOptions(screen.getByLabelText(/GST treatment/), "overseas");
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ gstTreatment: "overseas", stateCode: "", gstin: "" }),
    );
  });

  it("surfaces field errors next to their field", () => {
    render(
      <GstIdentityFields
        value={{ gstTreatment: "registered", gstin: "", stateCode: "" }}
        onChange={() => {}}
        errors={validateGstIdentity({ gstTreatment: "registered", gstin: "", stateCode: "" })}
      />,
    );
    expect(screen.getByText(/must have a GSTIN/)).toBeInTheDocument();
    expect(screen.getByText(/CGST \+ SGST or IGST/)).toBeInTheDocument();
  });
});
