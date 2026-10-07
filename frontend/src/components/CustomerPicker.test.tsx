import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { CustomerPicker } from "./CustomerPicker";
import { fmtAddress } from "../address";

/**
 * The picker's job in this feature: never leave staff at a dead end. These
 * cover the branches an end-to-end test would reach slowly and a type checker
 * cannot reach at all.
 */

const mockUser = vi.hoisted(() => ({ current: { roleName: "sales" } as { roleName: string } | null }));
vi.mock("../auth", async () => {
  const actual = await vi.importActual<typeof import("../auth")>("../auth");
  return { ...actual, useAuth: () => ({ user: mockUser.current }) };
});

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

const company = (over: Record<string, unknown> = {}) => ({
  id: "c1", name: "Sharma Traders", gstin: null, gst_treatment: "unregistered",
  state_code: "09", industry: null, website: null, billing_address: {}, shipping_address: {},
  notes: null, is_customer: true, is_supplier: false, is_active: true,
  created_at: "", updated_at: "", ...over,
});

/** Minimal fetch stub: route by URL + method. */
function stubFetch(routes: { match: RegExp; method?: string; status?: number; body: unknown }[]) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const r = routes.find((x) => x.match.test(url) && (x.method ?? "GET") === method);
    if (!r) throw new Error(`unstubbed ${method} ${url}`);
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      json: async () => r.body,
    } as Response;
  });
}

beforeEach(() => { mockUser.current = { roleName: "sales" }; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("<CustomerPicker> add-customer affordance", () => {
  it("offers to add a customer when the search finds nothing", async () => {
    vi.stubGlobal("fetch", stubFetch([{ match: /role=customer/, body: [] }]));
    const user = userEvent.setup();
    render(wrap(<CustomerPicker value={null} onChange={() => {}} />));

    await user.click(screen.getByLabelText("Search customer"));
    await user.type(screen.getByLabelText("Search customer"), "Sharma");

    expect(await screen.findByText(/No customer found/)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Add .Sharma./ })).toBeInTheDocument();
  });

  it("hides the add button from a role without crm write, and says who to ask", async () => {
    mockUser.current = { roleName: "accounts" };
    vi.stubGlobal("fetch", stubFetch([{ match: /role=customer/, body: [] }]));
    const user = userEvent.setup();
    render(wrap(<CustomerPicker value={null} onChange={() => {}} />));

    await user.click(screen.getByLabelText("Search customer"));

    expect(await screen.findByText(/Ask an admin to add them/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add a new customer/ })).not.toBeInTheDocument();
  });

  it("selects a customer straight from the results", async () => {
    vi.stubGlobal("fetch", stubFetch([{ match: /role=customer/, body: [company()] }]));
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(wrap(<CustomerPicker value={null} onChange={onChange} />));

    await user.click(screen.getByLabelText("Search customer"));
    await user.click(await screen.findByText("Sharma Traders"));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: "c1", state_code: "09" }));
  });

  it("carries the buyer state through on select, so place of supply is right", async () => {
    vi.stubGlobal("fetch", stubFetch([
      { match: /role=customer/, body: [company({ state_code: "27" })] },
    ]));
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(wrap(<CustomerPicker value={null} onChange={onChange} />));

    await user.click(screen.getByLabelText("Search customer"));
    await user.click(await screen.findByText("Sharma Traders"));

    // Not the seller's state, not undefined — the buyer's own.
    expect(onChange.mock.calls[0]![0].state_code).toBe("27");
  });

  it("shows only one search input at a time while adding", async () => {
    vi.stubGlobal("fetch", stubFetch([{ match: /role=customer/, body: [] }]));
    const user = userEvent.setup();
    render(wrap(<CustomerPicker value={null} onChange={() => {}} />));

    await user.click(screen.getByLabelText("Search customer"));
    await user.click(await screen.findByRole("button", { name: /Add a new customer/ }));

    await waitFor(() => expect(screen.queryByLabelText("Search customer")).not.toBeInTheDocument());
    expect(screen.getByRole("group", { name: "Add customer" })).toBeInTheDocument();
  });

  it("returns to the picker when the add form is cancelled", async () => {
    vi.stubGlobal("fetch", stubFetch([{ match: /role=customer/, body: [] }]));
    const user = userEvent.setup();
    render(wrap(<CustomerPicker value={null} onChange={() => {}} />));

    await user.click(screen.getByLabelText("Search customer"));
    await user.click(await screen.findByRole("button", { name: /Add a new customer/ }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(await screen.findByLabelText("Search customer")).toBeInTheDocument();
  });

  it("shows the selected customer with a way to change it", () => {
    vi.stubGlobal("fetch", stubFetch([]));
    render(wrap(
      <CustomerPicker
        value={{ id: "c1", name: "Sharma Traders", gstin: null, state_code: "09" }}
        onChange={() => {}}
      />,
    ));
    expect(screen.getByText("Sharma Traders")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change" })).toBeInTheDocument();
  });
});

describe("fmtAddress", () => {
  it("prints the typed keys in a fixed order", () => {
    expect(fmtAddress({ city: "Kanpur", line1: "12 MG Road", pincode: "208001" }))
      .toBe("12 MG Road, Kanpur, 208001");
  });

  it("still renders legacy keys nothing else knows about", () => {
    expect(fmtAddress({ line1: "12 MG Road", landmark: "near the depot" }))
      .toBe("12 MG Road, near the depot");
  });

  it("never prints a state from the address blob", () => {
    // The authoritative state prints on its own line from state_code. A second,
    // free-text one here could contradict it on the same tax invoice.
    expect(fmtAddress({ line1: "12 MG Road", state: "Delhi", city: "Kanpur" }))
      .toBe("12 MG Road, Kanpur");
  });

  it("returns an empty string for an empty address", () => {
    expect(fmtAddress({})).toBe("");
  });

  it("ignores non-string values", () => {
    expect(fmtAddress({ line1: "12 MG Road", verified: true, floor: 3 })).toBe("12 MG Road");
  });
});
