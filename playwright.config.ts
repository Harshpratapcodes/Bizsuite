import { defineConfig } from "@playwright/test";

/**
 * E2E against the REAL stack: Express serving the built SPA (frontend/dist)
 * + the real database from .env. Run `npm run build:web` first (CI does).
 * globalSetup seeds fresh users/customer per run (append-only DB, no cleanup).
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,       // specs share seeded state; keep deterministic
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: "http://localhost:3998",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npx tsx src/server.ts",
    port: 3998,
    env: { PORT: "3998" },
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
