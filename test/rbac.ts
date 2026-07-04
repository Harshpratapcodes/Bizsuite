/**
 * RBAC test: the seeded role_permissions matrix + the HTTP guard on the
 * invoice routes. We verify both the data-level check (hasPermission) and that
 * the Express guard returns 403 before any handler work when a role lacks the
 * action — and lets an allowed role through (past the gate) to the handler.
 */
import type { AddressInfo } from "node:net";
import { app } from "../src/server.js";
import { createUser } from "../src/core/auth.js";
import { hasPermission } from "../src/core/rbac.js";
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

async function roleId(name: string): Promise<string> {
  return (await pool.query<{ id: string }>(`SELECT id FROM roles WHERE name=$1`, [name])).rows[0]!.id;
}

async function main() {
  const stamp = Date.now();
  const admin = { email: `rbac_admin_${stamp}@test.com`, password: "Pw!", role: "admin" };
  const sales = { email: `rbac_sales_${stamp}@test.com`, password: "Pw!", role: "sales" };
  const readonly = { email: `rbac_ro_${stamp}@test.com`, password: "Pw!", role: "readonly" };
  for (const u of [admin, sales, readonly]) {
    await createUser({ email: u.email, fullName: u.role, password: u.password, roleName: u.role });
  }

  console.log("== MATRIX (data level) ==");
  const adminRole = await roleId("admin");
  const salesRole = await roleId("sales");
  const roRole = await roleId("readonly");
  check("admin can submit invoicing", await hasPermission(adminRole, "invoicing", "submit"));
  check("admin can cancel invoicing", await hasPermission(adminRole, "invoicing", "cancel"));
  check("sales can write invoicing draft", await hasPermission(salesRole, "invoicing", "write"));
  check("sales CANNOT submit invoicing", !(await hasPermission(salesRole, "invoicing", "submit")));
  check("sales CANNOT cancel invoicing", !(await hasPermission(salesRole, "invoicing", "cancel")));
  check("readonly can read invoicing", await hasPermission(roRole, "invoicing", "read"));
  check("readonly CANNOT write invoicing", !(await hasPermission(roRole, "invoicing", "write")));

  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  async function loginCookie(email: string, password: string): Promise<string> {
    const res = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    return sidFrom(res.headers.get("set-cookie"))!;
  }

  try {
    console.log("== HTTP GUARD ==");
    const adminCookie = await loginCookie(admin.email, admin.password);
    const salesCookie = await loginCookie(sales.email, sales.password);
    const roCookie = await loginCookie(readonly.email, readonly.password);
    const fakeId = crypto.randomUUID();

    // sales lacks invoicing.submit -> blocked at the gate (403), no handler run
    const salesSubmit = await fetch(`${base}/api/invoicing/invoices/${fakeId}/submit`, {
      method: "POST", headers: { cookie: salesCookie },
    });
    check("sales submit -> 403", salesSubmit.status === 403, String(salesSubmit.status));

    // admin has invoicing.submit -> passes the gate; handler 404s on missing invoice
    const adminSubmit = await fetch(`${base}/api/invoicing/invoices/${fakeId}/submit`, {
      method: "POST", headers: { cookie: adminCookie },
    });
    check("admin submit passes gate (not 403)", adminSubmit.status !== 403, String(adminSubmit.status));
    check("admin submit reaches handler -> 404 missing invoice", adminSubmit.status === 404, String(adminSubmit.status));

    // sales lacks invoicing.cancel
    const salesCancel = await fetch(`${base}/api/invoicing/invoices/${fakeId}/cancel`, {
      method: "POST", headers: { cookie: salesCookie },
    });
    check("sales cancel -> 403", salesCancel.status === 403, String(salesCancel.status));

    // readonly lacks invoicing.write -> create draft blocked at gate
    const roCreate = await fetch(`${base}/api/invoicing/invoices`, {
      method: "POST", headers: { cookie: roCookie, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    check("readonly create draft -> 403", roCreate.status === 403, String(roCreate.status));

    // sales has invoicing.write -> passes gate; empty body fails zod (422), proving gate passed
    const salesCreate = await fetch(`${base}/api/invoicing/invoices`, {
      method: "POST", headers: { cookie: salesCookie, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    check("sales create draft passes gate (not 403)", salesCreate.status !== 403, String(salesCreate.status));
    check("sales create draft reaches validation -> 422", salesCreate.status === 422, String(salesCreate.status));

    // unauthenticated -> 401 (auth runs before rbac)
    const anon = await fetch(`${base}/api/invoicing/invoices/${fakeId}/submit`, { method: "POST" });
    check("unauthenticated submit -> 401", anon.status === 401, String(anon.status));
  } finally {
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
