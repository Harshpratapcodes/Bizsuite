import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * Frontend unit tests. The backend suites talk HTTP to a real Postgres; this
 * runner exists for the branchy UI logic those cannot reach — which fields a
 * GST treatment shows, whether a role sees the add-customer button, what the
 * picker does with a name that is already taken.
 *
 * Wired into CI as its own step (.github/workflows/ci.yml). A suite the
 * pipeline never runs is not coverage.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
