import { execSync } from "node:child_process";

/** Seed fresh users + customer before the suite. Runs `tsx` in a child so the
 *  seed can import server code with its own loader, independent of Playwright's. */
export default function globalSetup(): void {
  execSync("npx tsx e2e/seed.ts", { stdio: "inherit" });
}
