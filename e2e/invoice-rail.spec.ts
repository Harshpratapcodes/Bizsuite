/**
 * Guided invoice rail (second half of Approach A, eng-review test plan
 * `/invoices/new`): staff walks customer → items → review → submit and the
 * khata reflects it; INSUFFICIENT_STOCK surfaces in plain language with an
 * edit-and-retry path; cancel stays admin-only.
 *
 * Runs before khata-rail.spec.ts (alphabetical) against its own seeded
 * customer, so the khata spec's balance assertions are untouched.
 *
 * Expected money (server-computed, intra-state 09→09, GST 18% = 9% + 9%):
 *   UPS  2 × ₹12,000 → taxable 24,000 · CGST 2,160 · SGST 2,160 · total 28,320
 *   STAB 1 × ₹9,000  → taxable  9,000 · CGST   810 · SGST   810 · total 10,620
 */
import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface Seed {
  admin: { email: string; password: string };
  counter: { email: string; password: string };
  customer: { id: string; name: string };
  invoiceCustomer: { id: string; name: string };
  warehouse: { id: string; name: string };
  items: { ups: { id: string; name: string }; stab: { id: string; name: string } };
}
const seed: Seed = JSON.parse(fs.readFileSync(
  path.resolve(fileURLToPath(new URL(".", import.meta.url)), ".seed.json"), "utf8"));

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  // Login lands on the home launcher (Bizesuite design): app tiles.
  await expect(page.getByRole("link", { name: "Khata", exact: true })).toBeVisible();
}

/** Jump between apps the design way: ⊞ click → all-apps home → tile. */
async function switchApp(page: Page, appName: string): Promise<void> {
  await page.getByRole("button", { name: "All apps" }).click();
  await page.getByRole("link", { name: appName, exact: true }).click();
}

/** customer → item(s) on the guided entry screen, up to "Save draft & review". */
async function startInvoice(page: Page, itemName: string, qty: string): Promise<void> {
  await page.getByRole("link", { name: "Invoicing", exact: true }).click();
  await page.getByRole("link", { name: "New sale", exact: true }).click();
  await page.getByLabel("Search customer").fill(seed.invoiceCustomer.name.slice(0, 14));
  await page.getByText(seed.invoiceCustomer.name, { exact: true }).click();

  // place of supply defaulted from the customer's state → intra-state hint
  await expect(page.getByText("CGST + SGST")).toBeVisible();

  // test DBs accumulate warehouses from other suites — always pick the seeded
  // one. selectOption auto-waits for the select to render, unlike isVisible().
  await page.locator("#wh").selectOption({ label: seed.warehouse.name });

  await page.getByLabel("Search item").fill(itemName.slice(0, 18));
  await page.getByText(itemName, { exact: false }).first().click();
  await page.getByLabel("Quantity").fill(qty);
}

test("golden journey: staff invoices 2 UPS, server totals shown, khata updates", async ({ page }) => {
  await login(page, seed.counter.email, seed.counter.password);
  await startInvoice(page, seed.items.ups.name, "2");

  // live pre-tax feedback while entering
  await expect(page.getByText("Items total (before GST)")).toContainText("₹24,000.00");

  await page.getByRole("button", { name: "Save draft & review" }).click();

  // review = the SERVER's math from the persisted draft
  await expect(page.getByRole("heading", { name: "Review draft invoice" })).toBeVisible();
  const totals = page.locator(".totals");
  await expect(totals).toContainText("₹24,000.00");   // taxable
  await expect(totals).toContainText("₹2,160.00");    // CGST (and SGST)
  await expect(totals).toContainText("₹28,320.00");   // grand
  await expect(totals).toContainText("Twenty Eight Thousand Three Hundred Twenty");

  await page.getByRole("button", { name: "Submit invoice" }).click();
  await page.getByRole("button", { name: "Yes, submit invoice" }).click();

  await expect(page.getByRole("status")).toContainText(/INV-2026-\d{5}/);

  // submitted view: printable, but staff sees no cancel
  await expect(page.getByRole("button", { name: /Print invoice/ })).toBeVisible();
  await expect(page.locator(".print-sheet")).toHaveCount(1);
  await expect(page.getByRole("button", { name: /Cancel invoice/ })).toHaveCount(0);

  // khata reflects the sale
  await switchApp(page, "Khata");
  await expect(page.getByRole("row", { name: new RegExp(seed.invoiceCustomer.name) }))
    .toContainText("₹28,320.00");
});

test("insufficient stock: plain-language error, edit draft, retry succeeds", async ({ page }) => {
  await login(page, seed.counter.email, seed.counter.password);
  await startInvoice(page, seed.items.stab.name, "3");   // only 1 on hand

  // pre-warned at entry, but staff can push on (stock may be arriving)
  await expect(page.getByText("Only 1 in stock")).toBeVisible();
  await page.getByRole("button", { name: "Save draft & review" }).click();

  await page.getByRole("button", { name: "Submit invoice" }).click();
  await page.getByRole("button", { name: "Yes, submit invoice" }).click();

  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Not enough stock");
  await expect(alert).not.toContainText("INSUFFICIENT_STOCK");   // no raw codes (staff-usable bar)

  // edit-and-retry rail: fix the quantity on the same server-side draft
  await page.getByRole("link", { name: "Edit the quantities" }).click();
  await expect(page.getByRole("heading", { name: "Edit draft invoice" })).toBeVisible();
  await page.getByLabel("Quantity").fill("1");
  await page.getByRole("button", { name: "Save draft & review" }).click();

  await expect(page.locator(".totals")).toContainText("₹10,620.00");
  await page.getByRole("button", { name: "Submit invoice" }).click();
  await page.getByRole("button", { name: "Yes, submit invoice" }).click();
  await expect(page.getByRole("status")).toContainText(/INV-2026-\d{5}/);

  // khata now carries both invoices: 28,320 + 10,620
  await switchApp(page, "Khata");
  await expect(page.getByRole("row", { name: new RegExp(seed.invoiceCustomer.name) }))
    .toContainText("₹38,940.00");
});

test("cancel is admin-only: staff has no cancel button, admin does", async ({ page }) => {
  await login(page, seed.admin.email, seed.admin.password);
  await page.getByRole("link", { name: "Invoicing", exact: true }).click();
  await page.getByRole("row", { name: new RegExp(seed.invoiceCustomer.name) }).first().click();
  await expect(page.getByRole("button", { name: /Cancel invoice/ })).toBeVisible();
  // visibility only — cancelling would disturb the khata totals above
});

test("draft survives and resumes from the invoice list", async ({ page }) => {
  await login(page, seed.counter.email, seed.counter.password);
  await startInvoice(page, seed.items.ups.name, "1");
  await page.getByRole("button", { name: "Save draft & review" }).click();
  await expect(page.getByRole("heading", { name: "Review draft invoice" })).toBeVisible();

  // walk away mid-entry…
  await switchApp(page, "Khata");

  // …and resume from the list: Drafts filter → row → review screen
  await switchApp(page, "Invoicing");
  await page.getByLabel("Show").selectOption("draft");
  await page.getByRole("row", { name: new RegExp(seed.invoiceCustomer.name) }).first().click();
  await expect(page.getByRole("heading", { name: "Review draft invoice" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Submit invoice" })).toBeVisible();
  // left as a draft deliberately: proves drafts are parked safely off the books
});
