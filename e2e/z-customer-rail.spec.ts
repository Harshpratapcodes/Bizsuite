/**
 * Customer master + inline quick-add (eng-review test plan, critical paths).
 *
 * Named `z-` on purpose. The suite runs `workers: 1, fullyParallel: false`
 * against an append-only database and specs execute alphabetically, so the
 * khata and invoice specs rely on the balances they seed. This one creates
 * companies, so it runs LAST and cannot perturb them.
 *
 * Covers the journeys unit tests cannot reach:
 *   1. a walk-in is quoted in one pass, without leaving the form
 *   2. an out-of-state new customer produces IGST, not CGST + SGST
 *   3. a state code cannot be skipped
 *   4. a name already held by a supplier offers to promote, not a dead end
 *   5. a wrong state code can be corrected, and the correction reaches quoting
 *
 * Note on (1): the customer gates the entire quotation form — no item rows,
 * terms or notes render until one is picked — so on a NEW quote there are no
 * keystrokes to lose. What the quick-add saves is the interruption itself.
 * Unsaved work IS at risk when EDITING an existing draft, where the form is
 * already populated and leaving the page discards the changes.
 */
import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface Seed {
  admin: { email: string; password: string };
  counter: { email: string; password: string };
  items: { ups: { id: string; name: string }; stab: { id: string; name: string } };
}
const seed: Seed = JSON.parse(fs.readFileSync(
  path.resolve(fileURLToPath(new URL(".", import.meta.url)), ".seed.json"), "utf8"));

/** Unique per run — the DB is append-only and names are globally unique. */
const stamp = Date.now();

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("link", { name: "Khata", exact: true })).toBeVisible();
}

async function newQuotation(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Quotations", exact: true }).click();
  await page.getByRole("link", { name: "New quote", exact: true }).click();
  await expect(page.getByRole("heading", { name: "New quotation" })).toBeVisible();
}

test("a walk-in customer is quoted without ever leaving the form", async ({ page }) => {
  const name = `Z Walk-In Traders ${stamp}`;
  await login(page, seed.counter.email, seed.counter.password);
  await newQuotation(page);

  // The customer gates the whole form: no item rows, no terms, no notes until
  // one is picked. So the cost of a missing customer is not lost keystrokes on
  // a NEW quote — it is that the job stops dead here. Before this feature the
  // only way on was to leave for a customer master screen that did not exist.
  await expect(page.getByLabel("Search customer")).toBeVisible();
  await expect(page.getByLabel("Terms")).toHaveCount(0);

  await page.getByLabel("Search customer").fill(name);
  await expect(page.getByText(/No customer found/)).toBeVisible();
  await page.getByRole("button", { name: new RegExp(`Add .${name}.`) }).click();

  await expect(page.getByRole("group", { name: "Add customer" })).toBeVisible();
  await page.locator("#qac-state").selectOption("09");        // 09 = same state as the seller
  await page.getByRole("button", { name: "Save customer" }).click();

  // Selected in place, and the rest of the form opens up immediately — the
  // walk-in is quoted in one continuous pass.
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  await expect(page.getByText("CGST + SGST")).toBeVisible();   // same state as the seller

  await page.getByLabel("Search item").fill(seed.items.ups.name.slice(0, 18));
  await page.getByText(seed.items.ups.name, { exact: false }).first().click();
  await page.getByLabel("Quantity").fill("2");
  await page.getByLabel(/^Terms/).fill("50% advance, balance on delivery");

  await page.getByRole("button", { name: "Save draft & review" }).click();

  // The quotation exists, against the customer created moments earlier.
  await expect(page.getByRole("heading", { name: /Review draft quotation|Quotation/ })).toBeVisible();
  await expect(page.getByText(name, { exact: false }).first()).toBeVisible();
});

test("an out-of-state new customer is billed IGST, not CGST + SGST", async ({ page }) => {
  const name = `Z Mumbai Power ${stamp}`;
  await login(page, seed.counter.email, seed.counter.password);
  await newQuotation(page);

  await page.getByLabel("Search customer").fill(name);
  await page.getByRole("button", { name: new RegExp(`Add .${name}.`) }).click();

  await page.locator("#qac-treatment").selectOption("registered");
  await page.locator("#qac-gstin").fill("27AAAPA1234A1Z5");
  await page.locator("#qac-state").selectOption("27");        // 27 = Maharashtra, seller is 09
  await page.getByRole("button", { name: "Save customer" }).click();

  await expect(page.getByText(name, { exact: true })).toBeVisible();

  // The whole point of T1+T2: the new customer's OWN state drives this, rather
  // than falling back to the seller's and quietly showing CGST + SGST.
  await expect(page.getByText("IGST")).toBeVisible();
  await expect(page.getByText("CGST + SGST")).toHaveCount(0);
  await expect(page.locator("#pos")).toHaveValue("27");
});

test("a state code is required before the customer can be saved", async ({ page }) => {
  await login(page, seed.counter.email, seed.counter.password);
  await newQuotation(page);

  await page.getByLabel("Search customer").fill(`Z No State ${stamp}`);
  await page.getByRole("button", { name: /Add /}).click();
  await page.getByRole("button", { name: "Save customer" }).click();

  await expect(page.getByText(/CGST \+ SGST or IGST/)).toBeVisible();
  await expect(page.getByRole("group", { name: "Add customer" })).toBeVisible();
});

test("a name held by a supplier offers to promote instead of dead-ending", async ({ page }) => {
  const name = `Z Dual Party ${stamp}`;

  // Create it as a supplier-only company through the master screen.
  await login(page, seed.admin.email, seed.admin.password);
  await page.getByRole("link", { name: "Quotations", exact: true }).click();
  await page.getByRole("link", { name: "Customers", exact: true }).click();
  await page.getByRole("button", { name: /New customer/ }).click();
  await page.getByLabel("Name").fill(name);
  await page.locator("#cf-state").selectOption("09");
  await page.getByLabel(/also buy from them/).check();
  await page.getByRole("button", { name: "Create customer" }).click();
  await expect(page.getByText(name, { exact: true })).toBeVisible();

  // Now deactivate it so the picker cannot see it — the same shape as a
  // supplier-only record, and the state the recovery path has to handle.
  // Search first: the list is sorted by name and full of other suites' rows,
  // so .first() without a filter edits whoever sorts alphabetically first.
  await page.getByLabel(/^Search/).fill(name);
  const row = page.getByRole("row").filter({ hasText: name });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Edit" }).click();
  await page.locator("#cf-active").uncheck();
  await page.getByRole("button", { name: "Save changes" }).click();

  await newQuotation(page);
  await page.getByLabel("Search customer").fill(name);
  await expect(page.getByText(/No customer found/)).toBeVisible();
  await page.getByRole("button", { name: new RegExp(`Add .${name}.`) }).click();

  await page.locator("#qac-state").selectOption("09");
  await page.getByRole("button", { name: "Save customer" }).click();

  // Not a wall: the clash is explained and one button resolves it.
  await expect(page.getByText(/on file/)).toBeVisible();
  await page.getByRole("button", { name: /Also make them a customer/ }).click();

  await expect(page.getByText(name, { exact: true })).toBeVisible();
  await expect(page.getByText("CGST + SGST")).toBeVisible();
});

test("the customer master corrects a wrong state code", async ({ page }) => {
  const name = `Z Fix My State ${stamp}`;
  await login(page, seed.admin.email, seed.admin.password);

  await page.getByRole("link", { name: "Quotations", exact: true }).click();
  await page.getByRole("link", { name: "Customers", exact: true }).click();
  await page.getByRole("button", { name: /New customer/ }).click();
  await page.getByLabel("Name").fill(name);
  await page.locator("#cf-state").selectOption("09");         // wrong on purpose
  await page.getByRole("button", { name: "Create customer" }).click();

  await page.getByLabel(/^Search/).fill(name);
  const row = page.getByRole("row").filter({ hasText: name });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Edit" }).click();
  await page.locator("#cf-state").selectOption("27");         // corrected
  await page.getByRole("button", { name: "Save changes" }).click();

  // The correction reaches the document builder, which is the point of the
  // screen: before it existed a wrong state code needed an admin with psql.
  await newQuotation(page);
  await page.getByLabel("Search customer").fill(name);
  await page.getByText(name, { exact: true }).click();
  await expect(page.locator("#pos")).toHaveValue("27");
  await expect(page.getByText("IGST")).toBeVisible();
});
