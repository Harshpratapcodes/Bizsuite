import type { AuthUserDto } from "@bizsuite/contracts";
import { canCreateInvoice, canCreateQuote, canCreateSalesOrder, canEnterOpening } from "./auth";

/**
 * App registry (Bizesuite design: home launcher tiles + workspace switcher).
 * Live apps map to real routes; `soon` tiles surface the blueprint's future
 * phases without pretending they exist.
 */
export interface AppDef {
  id: string;
  name: string;
  glyph: string;
  hue: string;   // app accent (design: per-app hue)
  tint: string;  // matching soft background
  path: string;
  desc: string;  // status line under the launcher tile
  soon?: boolean;
  visible?: (user: AuthUserDto | null) => boolean;
}

export const APPS: AppDef[] = [
  { id: "khata", name: "Khata", glyph: "☷", hue: "#4353A4", tint: "#E9EBF7",
    path: "/khata", desc: "Who owes us — live from the ledger" },
  { id: "quotations", name: "Quotations", glyph: "✎", hue: "#B0642A", tint: "#F7ECE1",
    path: "/quotations", desc: "Estimates → convert to order" },
  { id: "salesorders", name: "Sales orders", glyph: "▤", hue: "#2A7D7B", tint: "#E1F0EF",
    path: "/sales-orders", desc: "Confirmed orders → invoice" },
  { id: "invoicing", name: "Invoicing", glyph: "₹", hue: "#1E8E5A", tint: "#E2F2EA",
    path: "/invoices", desc: "GST invoices & drafts" },
  { id: "payments", name: "Payments", glyph: "⇅", hue: "#4A6B8A", tint: "#E7EEF3",
    path: "/payments/new", desc: "Record money received" },
  { id: "opening", name: "Opening balances", glyph: "Σ", hue: "#7E4A8E", tint: "#F2E9F4",
    path: "/opening-balances", desc: "Go-live setup (admin)", visible: canEnterOpening },
  { id: "accounting", name: "Accounting", glyph: "◫", hue: "#5C6B7A", tint: "#ECEFF2",
    path: "", desc: "Phase 2", soon: true },
  { id: "inventory", name: "Inventory", glyph: "▦", hue: "#C77D0A", tint: "#FAF0DD",
    path: "", desc: "Phase 3", soon: true },
  { id: "crm", name: "CRM", glyph: "◎", hue: "#4A6B8A", tint: "#E7EEF3",
    path: "", desc: "Phase 5", soon: true },
];

export function visibleApps(user: AuthUserDto | null): AppDef[] {
  return APPS.filter((a) => !a.visible || a.visible(user));
}

/** Which app owns the current route (drives the workspace topbar). */
export function appForPath(pathname: string): AppDef {
  const byId = (id: string): AppDef => APPS.find((a) => a.id === id)!;
  if (pathname.startsWith("/quotations")) return byId("quotations");
  if (pathname.startsWith("/sales-orders")) return byId("salesorders");
  if (pathname.startsWith("/invoices")) return byId("invoicing");
  if (pathname.startsWith("/payments")) return byId("payments");
  if (pathname.startsWith("/opening-balances")) return byId("opening");
  return byId("khata");
}

/** Section tabs inside a workspace (design: topbar tabs). */
export function tabsForApp(app: AppDef, user: AuthUserDto | null): { name: string; to: string; end?: boolean }[] {
  if (app.id === "quotations") {
    return canCreateQuote(user)
      ? [{ name: "Quotations", to: "/quotations", end: true }, { name: "New quote", to: "/quotations/new" }]
      : [{ name: "Quotations", to: "/quotations", end: true }];
  }
  if (app.id === "salesorders") {
    return canCreateSalesOrder(user)
      ? [{ name: "Sales orders", to: "/sales-orders", end: true }, { name: "New order", to: "/sales-orders/new" }]
      : [{ name: "Sales orders", to: "/sales-orders", end: true }];
  }
  if (app.id === "invoicing") {
    return canCreateInvoice(user)
      ? [{ name: "Invoices", to: "/invoices", end: true }, { name: "New sale", to: "/invoices/new" }]
      : [{ name: "Invoices", to: "/invoices", end: true }];
  }
  return [];
}
