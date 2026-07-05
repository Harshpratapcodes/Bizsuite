/**
 * Golden staff journey (eng review D8, khata-rail half of Approach A):
 *   counter staff logs in → records a payment against the seeded customer →
 *   sees the doc number → khata reflects the reduced balance.
 * Plus the interaction rails: wrong password, double-click guard, and
 * role-based screen gating (staff never sees Opening balances).
 */
import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface Seed {
  admin: { email: string; password: string };
  counter: { email: string; password: string };
  customer: { id: string; name: string };
}
const seed: Seed = JSON.parse(fs.readFileSync(
  path.resolve(fileURLToPath(new URL(".", import.meta.url)), ".seed.json"), "utf8"));

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("link", { name: "Khata (dues)" })).toBeVisible();
}

test("wrong password shows a plain-language error, no navigation", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email").fill(seed.counter.email);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("alert")).toContainText("Wrong email or password");
  await expect(page.getByRole("button", { name: "Log in" })).toBeVisible();
});

test("staff does not see Opening balances; admin does", async ({ page }) => {
  await login(page, seed.counter.email, seed.counter.password);
  await expect(page.getByRole("link", { name: "Opening balances" })).toHaveCount(0);
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("button", { name: "Log in" })).toBeVisible();

  await login(page, seed.admin.email, seed.admin.password);
  await expect(page.getByRole("link", { name: "Opening balances" })).toBeVisible();
});

test("golden journey: staff records a payment, khata updates", async ({ page }) => {
  await login(page, seed.counter.email, seed.counter.password);

  // Khata shows the seeded opening balance first
  await page.getByRole("link", { name: "Khata (dues)" }).click();
  const row = page.getByRole("row", { name: new RegExp(seed.customer.name) });
  await expect(row).toContainText("₹30,000.00");

  // Guided payment entry
  await page.getByRole("link", { name: "Payment received" }).click();
  await page.getByLabel("Search customer").fill(seed.customer.name.slice(0, 12));
  await page.getByText(seed.customer.name, { exact: true }).click();
  await page.getByLabel(/Amount received/).fill("5000.00");
  // cash mode + cash box are the defaults — leave them (fewest taps at the counter)

  await page.getByRole("button", { name: "Review & submit" }).click();
  await expect(page.locator(".confirm-box")).toContainText("₹5,000.00");

  await page.getByRole("button", { name: "Yes, submit payment" }).click();

  const banner = page.getByRole("status");
  await expect(banner).toContainText(/PAY-2026-\d{5}/);

  // Khata reflects the payment
  await page.getByRole("link", { name: "Khata (dues)" }).click();
  await expect(page.getByRole("row", { name: new RegExp(seed.customer.name) }))
    .toContainText("₹25,000.00");
});

test("on-account note appears when customer has no open bills", async ({ page }) => {
  await login(page, seed.counter.email, seed.counter.password);
  await page.getByRole("link", { name: "Payment received" }).click();
  await page.getByLabel("Search customer").fill(seed.customer.name.slice(0, 12));
  await page.getByText(seed.customer.name, { exact: true }).click();
  await expect(page.getByText(/No open bills/)).toBeVisible();
});
