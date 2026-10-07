/**
 * Bulk-load the existing customer book at go-live.
 *
 * The app creates customers one at a time, which is right for a walk-in and
 * wrong for the two hundred names already in a ledger or a Tally export. This
 * is the other half: a script an admin runs once.
 *
 * It goes through the SAME CreateCompany contract and the SAME createCompany
 * service the API uses, so an import cannot smuggle in a record the UI would
 * have rejected — no missing state codes, no malformed GSTINs.
 *
 *   npm run import:customers -- customers.csv --dry-run
 *   npm run import:customers -- customers.csv --user admin@example.com
 *
 * Columns (header row required, order free, extras ignored):
 *   name        required
 *   gstin       optional; required when gst_treatment is "registered"
 *   treatment   registered | unregistered | overseas | sez   (default unregistered)
 *   state_code  2-digit GST state code; required unless overseas/sez
 *   line1 line2 city district pincode   optional address parts
 *   notes       optional
 *   supplier    optional; "yes"/"true"/"1" marks them a supplier too
 *
 * Rows are independent: a bad row is reported and skipped, the rest still
 * load. Names already on file are skipped rather than treated as failures, so
 * re-running after fixing a few rows is safe.
 */
import fs from "node:fs";
import { CreateCompany } from "@bizsuite/contracts";
import { createCompany, findCompanyByExactName } from "../src/modules/crm/companies.service.js";
import { pool } from "../src/shared/db.js";
import { AppError } from "../src/shared/errors.js";

/** Minimal RFC-4180 reader: quoted fields, embedded commas, doubled quotes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim()));
}

const TRUTHY = new Set(["yes", "y", "true", "1"]);
const norm = (h: string) => h.trim().toLowerCase().replace(/[\s-]+/g, "_");

function buildInput(get: (col: string) => string): unknown {
  const address: Record<string, string> = {};
  for (const k of ["line1", "line2", "city", "district", "pincode"]) {
    const v = get(k);
    if (v) address[k] = v;
  }
  const treatment = get("treatment") || get("gst_treatment");
  const gstin = get("gstin");
  const stateCode = get("state_code") || get("state");
  const notes = get("notes");
  return {
    name: get("name"),
    isCustomer: true,
    ...(TRUTHY.has(get("supplier").toLowerCase()) ? { isSupplier: true } : {}),
    ...(treatment ? { gstTreatment: treatment.toLowerCase() } : {}),
    ...(gstin ? { gstin: gstin.toUpperCase() } : {}),
    ...(stateCode ? { stateCode } : {}),
    ...(Object.keys(address).length ? { billingAddress: address } : {}),
    ...(notes ? { notes } : {}),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const dryRun = args.includes("--dry-run");
  const userArg = args.indexOf("--user");
  const userEmail = userArg >= 0 ? args[userArg + 1] : undefined;

  if (!file) {
    console.error("usage: npm run import:customers -- <file.csv> [--dry-run] [--user admin@example.com]");
    process.exit(2);
  }
  if (!fs.existsSync(file)) {
    console.error(`No such file: ${file}`);
    process.exit(2);
  }

  // Every write is attributed to a real user — the audit trigger records it.
  const { rows: [actor] } = await pool.query<{ id: string; email: string }>(
    userEmail
      ? `SELECT u.id, u.email FROM users u WHERE u.email = lower($1) AND u.is_active`
      : `SELECT u.id, u.email FROM users u JOIN roles r ON r.id = u.role_id
          WHERE r.name = 'admin' AND u.is_active ORDER BY u.created_at LIMIT 1`,
    userEmail ? [userEmail] : [],
  );
  if (!actor) {
    console.error(userEmail ? `No active user '${userEmail}'.` : "No active admin user to attribute the import to.");
    process.exit(2);
  }

  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  if (rows.length < 2) {
    console.error("The file needs a header row and at least one data row.");
    process.exit(2);
  }
  const headers = rows[0]!.map(norm);
  if (!headers.includes("name")) {
    console.error(`No 'name' column. Found: ${headers.join(", ")}`);
    process.exit(2);
  }

  console.log(`${dryRun ? "DRY RUN — nothing will be saved.\n" : ""}Importing as ${actor.email}\n`);

  let created = 0, skipped = 0, failed = 0;
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i]!;
    const get = (col: string): string => {
      const at = headers.indexOf(col);
      return at >= 0 ? (cells[at] ?? "").trim() : "";
    };
    const line = i + 1;                       // 1-based, counting the header
    const rawName = get("name") || `(row ${line})`;

    const parsed = CreateCompany.safeParse(buildInput(get));
    if (!parsed.success) {
      failed++;
      const why = parsed.error.issues
        .map((iss) => `${iss.path.join(".") || "row"}: ${iss.message}`)
        .join("; ");
      console.log(`  ✗ line ${line}  ${rawName} — ${why}`);
      continue;
    }

    if (await findCompanyByExactName(parsed.data.name)) {
      skipped++;
      console.log(`  – line ${line}  ${parsed.data.name} — already on file, skipped`);
      continue;
    }

    if (dryRun) {
      created++;
      console.log(`  ✓ line ${line}  ${parsed.data.name} — would be created`);
      continue;
    }

    try {
      await createCompany(parsed.data, actor.id);
      created++;
      console.log(`  ✓ line ${line}  ${parsed.data.name}`);
    } catch (e) {
      failed++;
      const msg = e instanceof AppError ? e.message : String(e);
      console.log(`  ✗ line ${line}  ${parsed.data.name} — ${msg}`);
    }
  }

  console.log(
    `\n${dryRun ? "Would create" : "Created"} ${created}, skipped ${skipped} already on file, ${failed} failed.`,
  );
  if (failed) console.log("Fix the failed lines and run the same file again — the rest are skipped as duplicates.");

  // Right after a real import, this is the number that decides whether the
  // 500-row list cap matters yet (TODOS.md #5).
  const { rows: [count] } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM companies WHERE is_customer`);
  console.log(`Customers on file: ${count!.n}`);
  if (Number(count!.n) > 400) {
    console.log("That is close to the 500-row list cap — see TODOS.md #5 before the master screen starts truncating.");
  }

  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
