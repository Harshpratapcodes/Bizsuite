import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { QuickAddCustomer } from "./QuickAddCustomer";

/**
 * The recovery paths. A name clash used to be a wall: the picker said the
 * customer did not exist and the server refused to create them, with no button
 * that resolved it.
 */

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

interface Route { match: RegExp; method?: string; status?: number; body: unknown }
function stubFetch(routes: Route[]) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const r = routes.find((x) => x.match.test(url) && (x.method ?? "GET") === method);
    if (!r) throw new Error(`unstubbed ${method} ${url}`);
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body } as Response;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const dup = { error: { code: "DUPLICATE_NAME", message: "already exists" } };

afterEach(() => vi.unstubAllGlobals());

describe("<QuickAddCustomer>", () => {
  it("blocks submit until a state code is chosen", async () => {
    const fetchMock = stubFetch([]);
    const user = userEvent.setup();
    render(wrap(<QuickAddCustomer initialName="Sharma Traders" onCreated={() => {}} onCancel={() => {}} />));

    await user.click(screen.getByRole("button", { name: "Save customer" }));

    expect(await screen.findByText(/CGST \+ SGST or IGST/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks submit when a registered customer has no GSTIN", async () => {
    const fetchMock = stubFetch([]);
    const user = userEvent.setup();
    render(wrap(<QuickAddCustomer initialName="Sharma Traders" onCreated={() => {}} onCancel={() => {}} />));

    await user.selectOptions(screen.getByLabelText(/GST treatment/), "registered");
    await user.selectOptions(screen.getByLabelText(/^State/), "09");
    await user.click(screen.getByRole("button", { name: "Save customer" }));

    expect(await screen.findByText(/must have a GSTIN/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks submit with no name", async () => {
    const fetchMock = stubFetch([]);
    const user = userEvent.setup();
    render(wrap(<QuickAddCustomer initialName="" onCreated={() => {}} onCancel={() => {}} />));

    await user.selectOptions(screen.getByLabelText(/^State/), "09");
    await user.click(screen.getByRole("button", { name: "Save customer" }));

    expect(await screen.findByText(/Enter the customer/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates the customer and hands back the full record", async () => {
    stubFetch([{ match: /crm\/companies$/, method: "POST", status: 201, body: company({ state_code: "27" }) }]);
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(wrap(<QuickAddCustomer initialName="Sharma Traders" onCreated={onCreated} onCancel={() => {}} />));

    await user.selectOptions(screen.getByLabelText(/^State/), "27");
    await user.click(screen.getByRole("button", { name: "Save customer" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    // The state must survive the round-trip: this is what stops place of
    // supply falling back to the seller's own state.
    expect(onCreated.mock.calls[0]![0]).toMatchObject({ id: "c1", name: "Sharma Traders", state_code: "27" });
  });

  it("offers to promote a company that is on file as a supplier", async () => {
    stubFetch([
      { match: /crm\/companies$/, method: "POST", status: 409, body: dup },
      { match: /name=/, body: [company({ is_customer: false, is_supplier: true })] },
    ]);
    const user = userEvent.setup();
    render(wrap(<QuickAddCustomer initialName="Sharma Traders" onCreated={() => {}} onCancel={() => {}} />));

    await user.selectOptions(screen.getByLabelText(/^State/), "09");
    await user.click(screen.getByRole("button", { name: "Save customer" }));

    expect(await screen.findByText(/already on file as a supplier/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Also make them a customer/ })).toBeInTheDocument();
  });

  it("promotes the supplier and selects it", async () => {
    stubFetch([
      { match: /crm\/companies$/, method: "POST", status: 409, body: dup },
      { match: /name=/, body: [company({ is_customer: false, is_supplier: true })] },
      { match: /crm\/companies\/c1/, method: "PATCH", body: company({ is_customer: true, is_supplier: true }) },
    ]);
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(wrap(<QuickAddCustomer initialName="Sharma Traders" onCreated={onCreated} onCancel={() => {}} />));

    await user.selectOptions(screen.getByLabelText(/^State/), "09");
    await user.click(screen.getByRole("button", { name: "Save customer" }));
    await user.click(await screen.findByRole("button", { name: /Also make them a customer/ }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "c1" })));
  });

  it("offers to reactivate a deactivated company", async () => {
    stubFetch([
      { match: /crm\/companies$/, method: "POST", status: 409, body: dup },
      { match: /name=/, body: [company({ is_active: false })] },
    ]);
    const user = userEvent.setup();
    render(wrap(<QuickAddCustomer initialName="Sharma Traders" onCreated={() => {}} onCancel={() => {}} />));

    await user.selectOptions(screen.getByLabelText(/^State/), "09");
    await user.click(screen.getByRole("button", { name: "Save customer" }));

    expect(await screen.findByText(/deactivated/)).toBeInTheDocument();
  });

  it("does not offer to promote a company that is already an active customer", async () => {
    stubFetch([
      { match: /crm\/companies$/, method: "POST", status: 409, body: dup },
      { match: /name=/, body: [company()] },
    ]);
    const user = userEvent.setup();
    render(wrap(<QuickAddCustomer initialName="Sharma Traders" onCreated={() => {}} onCancel={() => {}} />));

    await user.selectOptions(screen.getByLabelText(/^State/), "09");
    await user.click(screen.getByRole("button", { name: "Save customer" }));

    expect(await screen.findByText(/Search for them in the box above/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Also make them a customer/ })).not.toBeInTheDocument();
  });

  it("returns to the form with the typed name intact when promotion is declined", async () => {
    stubFetch([
      { match: /crm\/companies$/, method: "POST", status: 409, body: dup },
      { match: /name=/, body: [company({ is_customer: false, is_supplier: true })] },
    ]);
    const user = userEvent.setup();
    render(wrap(<QuickAddCustomer initialName="Sharma Traders" onCreated={() => {}} onCancel={() => {}} />));

    await user.selectOptions(screen.getByLabelText(/^State/), "09");
    await user.click(screen.getByRole("button", { name: "Save customer" }));
    await user.click(await screen.findByRole("button", { name: "Go back" }));

    expect(screen.getByLabelText("Name")).toHaveValue("Sharma Traders");
  });

  it("keeps the typed values when the server errors", async () => {
    stubFetch([
      { match: /crm\/companies$/, method: "POST", status: 500, body: { error: { code: "INTERNAL", message: "boom" } } },
    ]);
    const user = userEvent.setup();
    render(wrap(<QuickAddCustomer initialName="Sharma Traders" onCreated={() => {}} onCancel={() => {}} />));

    await user.selectOptions(screen.getByLabelText(/^State/), "09");
    await user.click(screen.getByRole("button", { name: "Save customer" }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Sharma Traders");
    expect(screen.getByRole("button", { name: "Save customer" })).toBeEnabled();
  });

  it("creates exactly one company when submit is double-clicked", async () => {
    const fetchMock = stubFetch([
      { match: /crm\/companies$/, method: "POST", status: 201, body: company() },
    ]);
    const user = userEvent.setup();
    render(wrap(<QuickAddCustomer initialName="Sharma Traders" onCreated={() => {}} onCancel={() => {}} />));

    await user.selectOptions(screen.getByLabelText(/^State/), "09");
    const save = screen.getByRole("button", { name: "Save customer" });
    await user.dblClick(save);

    const posts = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(posts).toHaveLength(1);
  });

  it("sends an upper-cased GSTIN and the chosen state", async () => {
    const fetchMock = stubFetch([
      { match: /crm\/companies$/, method: "POST", status: 201, body: company() },
    ]);
    const user = userEvent.setup();
    render(wrap(<QuickAddCustomer initialName="Sharma Traders" onCreated={() => {}} onCancel={() => {}} />));

    await user.selectOptions(screen.getByLabelText(/GST treatment/), "registered");
    await user.type(screen.getByLabelText(/GSTIN/), "27aaapa1234a1z5");
    await user.selectOptions(screen.getByLabelText(/^State/), "27");
    await user.click(screen.getByRole("button", { name: "Save customer" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    const body = JSON.parse((post![1] as RequestInit).body as string);
    expect(body).toMatchObject({
      name: "Sharma Traders", isCustomer: true,
      gstTreatment: "registered", gstin: "27AAAPA1234A1Z5", stateCode: "27",
    });
  });
});
