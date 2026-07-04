import fs from "node:fs";
import path from "node:path";

/**
 * Minimal .env loader — zero dependencies, loaded once by db.ts before the
 * pool is constructed. Existing process.env values always win (so CI, which
 * sets real env vars and has no .env file, is unaffected).
 */
export function loadDotEnv(dir = process.cwd()): void {
  const file = path.join(dir, ".env");
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip optional surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
