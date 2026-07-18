/**
 * Accounting core test: chart of accounts (tree, create with inherited root
 * type, archive guards) + the two ledger reports (Trial Balance must balance,
 * General Ledger for the Debtors control account). Over real HTTP + RBAC.
 */
import type { AddressInfo } from "node:net";
import { app } from "../src/server.js";
import { createUser } from "../src/core/auth.js";
import { pool } from "../src/shared/db.js";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${detail}`); }
}
function sidFrom(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const m = /(?:^|,\s*)sid=([^;]+)/.exec(setCookie);
  return m ? `sid=${m[1]}` : null;
}
const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await pool.query<T>(sql, params)).rows;

interface Acc { id: string; code: string; rootType: string; reportType: string; isGroup: boolean; isActive: boolean; systemKey: string | null; }

async function main() {
  const stamp = Date.now();
  const [incomeGroup] = await q<{ id: string }>(`SELECT id FROM accounts WHERE code='4000'`);   // Income (group)
  const [salesLeaf]   = await q<{ id: string }>(`SELECT id FROM accounts WHERE code='4100'`);    // Sales (ledger)
  const [debtors]     = await q<{ id: string }>(`SELECT id FROM accounts WHERE system_key='debtors'`);

  await createUser({ email: `ac_admin_${stamp}@test.com`, fullName: "Admin", password: "Pw!", roleName: "admin" });
  await createUser({ email: `ac_ro_${stamp}@test.com`, fullName: "RO", password: "Pw!", roleName: "readonly" });

  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  async function login(email: string): Promise<string> {
    const res = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "Pw!" }),
    });
    return sidFrom(res.headers.get("set-cookie"))!;
  }
  const j = (cookie: string, body?: unknown) => ({
    headers: { cookie, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  try {
    const admin = await login(`ac_admin_${stamp}@test.com`);
    const ro = await login(`ac_ro_${stamp}@test.com`);

    console.log("== CHART OF ACCOUNTS (tree) ==");
    const list = await (await fetch(`${base}/api/accounting/accounts`, { headers: { cookie: admin } })).json() as Acc[];
    const assets = list.find((a) => a.code === "1000");
    check("seeded root 'Assets' present", !!assets && assets.isGroup, JSON.stringify(assets));
    check("Assets root_type=asset → Balance Sheet", assets?.rootType === "asset" && assets?.reportType === "Balance Sheet", assets?.reportType ?? "");
    const sales = list.find((a) => a.code === "4100");
    check("Sales → Profit and Loss", sales?.reportType === "Profit and Loss", sales?.reportType ?? "");
    check("Debtors is a system account", list.find((a) => a.systemKey === "debtors") !== undefined);

    console.log("== CREATE ACCOUNT (inherits parent root type) ==");
    const code = `TST${stamp}`;
    const createRes = await fetch(`${base}/api/accounting/accounts`, {
      method: "POST", ...j(admin, { parentId: incomeGroup!.id, code, name: "Test Income Ledger" }) });
    check("admin create -> 201", createRes.status === 201, String(createRes.status));
    const created = await createRes.json() as { id: string };
    const list2 = await (await fetch(`${base}/api/accounting/accounts`, { headers: { cookie: admin } })).json() as Acc[];
    const mine = list2.find((a) => a.id === created.id);
    check("new account inherits root_type income", mine?.rootType === "income", mine?.rootType ?? "");

    const badParent = await fetch(`${base}/api/accounting/accounts`, {
      method: "POST", ...j(admin, { parentId: salesLeaf!.id, code: `${code}X`, name: "Bad" }) });
    check("create under non-group parent -> 422", badParent.status === 422, String(badParent.status));

    const roCreate = await fetch(`${base}/api/accounting/accounts`, {
      method: "POST", ...j(ro, { parentId: incomeGroup!.id, code: `${code}Y`, name: "RO" }) });
    check("readonly create -> 403", roCreate.status === 403, String(roCreate.status));

    console.log("== ARCHIVE guards ==");
    const arch = await fetch(`${base}/api/accounting/accounts/${created.id}/archive`, { method: "POST", ...j(admin) });
    check("archive own account -> 200", arch.status === 200, String(arch.status));
    const list3 = await (await fetch(`${base}/api/accounting/accounts`, { headers: { cookie: admin } })).json() as Acc[];
    check("archived account is inactive", list3.find((a) => a.id === created.id)?.isActive === false);
    const archSys = await fetch(`${base}/api/accounting/accounts/${debtors!.id}/archive`, { method: "POST", ...j(admin) });
    check("archive system account -> 409", archSys.status === 409, String(archSys.status));

    console.log("== TRIAL BALANCE must balance ==");
    const tb = await (await fetch(`${base}/api/accounting/reports/trial-balance`, { headers: { cookie: admin } }))
      .json() as { totalDebit: string; totalCredit: string; balanced: boolean; rows: unknown[] };
    check("trial balance balanced flag", tb.balanced === true, `${tb.totalDebit} vs ${tb.totalCredit}`);
    check("total debit == total credit", tb.totalDebit === tb.totalCredit, `${tb.totalDebit} vs ${tb.totalCredit}`);
    check("readonly can read trial balance", (await fetch(`${base}/api/accounting/reports/trial-balance`, { headers: { cookie: ro } })).status === 200);

    console.log("== GENERAL LEDGER (Debtors control) ==");
    const gl = await (await fetch(`${base}/api/accounting/reports/general-ledger?account=${debtors!.id}`, { headers: { cookie: admin } }))
      .json() as { account: { code: string }; rows: unknown[]; closing: string };
    check("GL account is Debtors (1300)", gl.account.code === "1300", gl.account.code ?? "");
    check("GL returns rows array", Array.isArray(gl.rows));
    check("GL has a closing balance", typeof gl.closing === "string");
  } finally {
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
