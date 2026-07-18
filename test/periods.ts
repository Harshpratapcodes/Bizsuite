/**
 * Financial periods test: list, RBAC (close is admin-only), and the LOCK —
 * closing a period rejects any posting dated inside it (PERIOD_CLOSED),
 * reopening allows it again, other periods stay unaffected. Leaves every
 * period open at the end.
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

async function main() {
  const stamp = Date.now();
  const [rent] = await q<{ id: string }>(`SELECT id FROM accounts WHERE code='5300'`);
  const [cash] = await q<{ id: string }>(`SELECT id FROM accounts WHERE code='1100'`);
  const [apr] = await q<{ id: string }>(`SELECT id FROM financial_periods WHERE name='Apr 2026'`);

  await createUser({ email: `fp_admin_${stamp}@test.com`, fullName: "Admin", password: "Pw!", roleName: "admin" });
  await createUser({ email: `fp_acc_${stamp}@test.com`, fullName: "Accounts", password: "Pw!", roleName: "accounts" });
  await createUser({ email: `fp_ro_${stamp}@test.com`, fullName: "RO", password: "Pw!", roleName: "readonly" });

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
  const today = new Date().toISOString().slice(0, 10);
  const jv = (date: string) => ({
    postingDate: date, narration: `Period test ${stamp}`,
    lines: [{ accountId: rent!.id, debit: "1000.00", credit: "0" },
            { accountId: cash!.id, debit: "0", credit: "1000.00" }],
  });
  const post = (cookie: string, date: string) =>
    fetch(`${base}/api/accounting/journals`, { method: "POST", ...j(cookie, jv(date)) });
  const closeApr = (cookie: string) => fetch(`${base}/api/accounting/periods/${apr!.id}/close`, { method: "POST", ...j(cookie) });
  const reopenApr = (cookie: string) => fetch(`${base}/api/accounting/periods/${apr!.id}/reopen`, { method: "POST", ...j(cookie) });

  try {
    const admin = await login(`fp_admin_${stamp}@test.com`);
    const acc = await login(`fp_acc_${stamp}@test.com`);
    const ro = await login(`fp_ro_${stamp}@test.com`);

    console.log("== LIST ==");
    const list = await (await fetch(`${base}/api/accounting/periods`, { headers: { cookie: ro } }))
      .json() as { name: string; status: string }[];
    check("12 periods, readable by readonly", list.length === 12);
    check("Apr 2026 present and open", list.find((p) => p.name === "Apr 2026")?.status === "open");

    console.log("== posting into an OPEN period works ==");
    check("post dated 2026-04-15 -> 201", (await post(acc, "2026-04-15")).status === 201);

    console.log("== close is admin-only ==");
    check("accounts close -> 403", (await closeApr(acc)).status === 403);
    check("admin close Apr -> 200", (await closeApr(admin)).status === 200);
    check("close again -> 409", (await closeApr(admin)).status === 409);

    console.log("== posting into a CLOSED period is blocked ==");
    const blocked = await post(acc, "2026-04-16");
    check("post dated 2026-04-16 -> 422", blocked.status === 422, String(blocked.status));
    const body = await blocked.json() as { error?: { code?: string } };
    check("error code PERIOD_CLOSED", body.error?.code === "PERIOD_CLOSED", body.error?.code ?? "");
    check("posting into today's (open) period still works", (await post(acc, today)).status === 201);

    console.log("== reopen restores posting ==");
    check("admin reopen Apr -> 200", (await reopenApr(admin)).status === 200);
    check("reopen again -> 409", (await reopenApr(admin)).status === 409);
    check("post dated 2026-04-17 after reopen -> 201", (await post(acc, "2026-04-17")).status === 201);
  } finally {
    // safety: ensure Apr is left open even if an assertion above threw
    await pool.query(`UPDATE financial_periods SET status='open', closed_by=NULL, closed_at=NULL WHERE id=$1`, [apr!.id]);
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
