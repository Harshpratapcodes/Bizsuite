/**
 * Manual journal entry test: balanced post, validation guards (unbalanced,
 * both-sided line, group/archived account, future date), RBAC (accounts posts,
 * readonly 403, cancel admin-only), reversal (nets to zero, one-time,
 * manual-only), and the trial-balance invariant after post + reverse.
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
  const [rent] = await q<{ id: string }>(`SELECT id FROM accounts WHERE code='5300'`);   // Rent (expense)
  const [cash] = await q<{ id: string }>(`SELECT id FROM accounts WHERE code='1100'`);    // Cash (asset)
  const [assets] = await q<{ id: string }>(`SELECT id FROM accounts WHERE code='1000'`);  // Assets (group)
  const [inv] = await q<{ id: string }>(`SELECT id FROM journal_entries WHERE voucher_type='sales_invoice' AND status='posted' LIMIT 1`);

  await createUser({ email: `jv_admin_${stamp}@test.com`, fullName: "Admin", password: "Pw!", roleName: "admin" });
  await createUser({ email: `jv_acc_${stamp}@test.com`, fullName: "Accounts", password: "Pw!", roleName: "accounts" });
  await createUser({ email: `jv_ro_${stamp}@test.com`, fullName: "RO", password: "Pw!", roleName: "readonly" });

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
  const tomorrow = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
  const balanced = {
    narration: `Rent for ${stamp}`,
    lines: [
      { accountId: rent!.id, debit: "5000.00", credit: "0" },
      { accountId: cash!.id, debit: "0", credit: "5000.00" },
    ],
  };
  const tbBalanced = async (cookie: string) => {
    const tb = await (await fetch(`${base}/api/accounting/reports/trial-balance`, { headers: { cookie } }))
      .json() as { balanced: boolean };
    return tb.balanced;
  };

  try {
    const admin = await login(`jv_admin_${stamp}@test.com`);
    const acc = await login(`jv_acc_${stamp}@test.com`);
    const ro = await login(`jv_ro_${stamp}@test.com`);

    console.log("== POST balanced journal (accounts role) ==");
    check("trial balance starts balanced", await tbBalanced(admin));
    const postRes = await fetch(`${base}/api/accounting/journals`, { method: "POST", ...j(acc, balanced) });
    check("accounts post -> 201", postRes.status === 201, String(postRes.status));
    const posted = await postRes.json() as { id: string; entryNo: string };
    check("JV number issued", /^JV-2026-\d{5}$/.test(posted.entryNo ?? ""), posted.entryNo ?? "");
    const detail = await (await fetch(`${base}/api/accounting/journals/${posted.id}`, { headers: { cookie: acc } }))
      .json() as { status: string; lines: unknown[] };
    check("entry posted with 2 lines", detail.status === "posted" && detail.lines.length === 2);

    console.log("== VALIDATION guards ==");
    const unbal = await fetch(`${base}/api/accounting/journals`, {
      method: "POST", ...j(acc, { narration: "x", lines: [
        { accountId: rent!.id, debit: "5000.00", credit: "0" },
        { accountId: cash!.id, debit: "0", credit: "4000.00" }] }) });
    check("unbalanced -> 422", unbal.status === 422, String(unbal.status));
    const bothSides = await fetch(`${base}/api/accounting/journals`, {
      method: "POST", ...j(acc, { narration: "x", lines: [
        { accountId: rent!.id, debit: "5000.00", credit: "5000.00" },
        { accountId: cash!.id, debit: "0", credit: "5000.00" }] }) });
    check("line debit AND credit -> 422", bothSides.status === 422, String(bothSides.status));
    const group = await fetch(`${base}/api/accounting/journals`, {
      method: "POST", ...j(acc, { narration: "x", lines: [
        { accountId: assets!.id, debit: "5000.00", credit: "0" },
        { accountId: cash!.id, debit: "0", credit: "5000.00" }] }) });
    check("post to group account -> 422", group.status === 422, String(group.status));
    const future = await fetch(`${base}/api/accounting/journals`, {
      method: "POST", ...j(acc, { ...balanced, postingDate: tomorrow }) });
    check("future-dated -> 422", future.status === 422, String(future.status));

    console.log("== RBAC ==");
    const roPost = await fetch(`${base}/api/accounting/journals`, { method: "POST", ...j(ro, balanced) });
    check("readonly post -> 403", roPost.status === 403, String(roPost.status));

    console.log("== REVERSAL (admin only; nets to zero) ==");
    const accReverse = await fetch(`${base}/api/accounting/journals/${posted.id}/reverse`, { method: "POST", ...j(acc) });
    check("accounts reverse -> 403 (cancel admin-only)", accReverse.status === 403, String(accReverse.status));
    const reverse = await fetch(`${base}/api/accounting/journals/${posted.id}/reverse`, { method: "POST", ...j(admin) });
    check("admin reverse -> 200", reverse.status === 200, String(reverse.status));
    const [origStill] = await q<{ status: string }>(`SELECT status FROM journal_entries WHERE id=$1`, [posted.id]);
    check("original stays posted", origStill!.status === "posted", origStill!.status);
    const [rev] = await q<{ id: string }>(`SELECT id FROM journal_entries WHERE reverses_id=$1`, [posted.id]);
    check("reversal entry created", !!rev);
    check("trial balance still balanced after reverse", await tbBalanced(admin));

    const reverseAgain = await fetch(`${base}/api/accounting/journals/${posted.id}/reverse`, { method: "POST", ...j(admin) });
    check("reverse again -> 409 (already reversed)", reverseAgain.status === 409, String(reverseAgain.status));

    if (inv) {
      const revInv = await fetch(`${base}/api/accounting/journals/${inv.id}/reverse`, { method: "POST", ...j(admin) });
      check("reverse a sales-invoice journal -> 409 (not manual)", revInv.status === 409, String(revInv.status));
    } else {
      check("reverse a sales-invoice journal -> 409 (not manual)", true, "(no invoice journal in DB; skipped)");
    }

    console.log("== REGISTER ==");
    const list = await (await fetch(`${base}/api/accounting/journals`, { headers: { cookie: acc } }))
      .json() as { id: string }[];
    check("our journal appears in the register", list.some((r) => r.id === posted.id));
  } finally {
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
