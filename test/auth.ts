/**
 * Auth integration test against the REAL server + PostgreSQL.
 * Flow: create user -> login (sets cookie) -> protected route with/without
 * cookie -> wrong password -> logout revokes the session.
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

/** Pull the `sid` cookie value out of a Set-Cookie header. */
function sidFrom(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const m = /(?:^|,\s*)sid=([^;]+)/.exec(setCookie);
  return m ? `sid=${m[1]}` : null;
}

async function main() {
  const email = `auth_${Date.now()}@test.com`;
  const password = "S3cretPass!";
  console.log("== SETUP: create admin user ==");
  const { id: userId } = await createUser({
    email, fullName: "Auth Tester", password, roleName: "admin",
  });
  check("user created", !!userId);

  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    console.log("== LOGIN ==");
    const loginRes = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    check("login 200", loginRes.status === 200, String(loginRes.status));
    const loginBody = await loginRes.json() as { user?: { id: string; roleName: string } };
    check("login returns user id", loginBody.user?.id === userId);
    check("login returns role", loginBody.user?.roleName === "admin", loginBody.user?.roleName ?? "");
    const cookie = sidFrom(loginRes.headers.get("set-cookie"));
    check("session cookie set (httpOnly)",
      !!cookie && /httponly/i.test(loginRes.headers.get("set-cookie") ?? ""));

    console.log("== PROTECTED ROUTE ==");
    const meOk = await fetch(`${base}/api/auth/me`, { headers: { cookie: cookie! } });
    check("/me with cookie 200", meOk.status === 200, String(meOk.status));
    const meBody = await meOk.json() as { user?: { email: string } };
    check("/me returns the right user", meBody.user?.email === email, meBody.user?.email ?? "");

    const meNoCookie = await fetch(`${base}/api/auth/me`);
    check("/me without cookie 401", meNoCookie.status === 401, String(meNoCookie.status));

    const meBadCookie = await fetch(`${base}/api/auth/me`, { headers: { cookie: "sid=garbage" } });
    check("/me with invalid cookie 401", meBadCookie.status === 401, String(meBadCookie.status));

    console.log("== WRONG PASSWORD ==");
    const badLogin = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "wrong" }),
    });
    check("wrong password 401", badLogin.status === 401, String(badLogin.status));
    check("wrong password sets no cookie", !sidFrom(badLogin.headers.get("set-cookie")));

    console.log("== LOGOUT REVOKES SESSION ==");
    const logoutRes = await fetch(`${base}/api/auth/logout`, {
      method: "POST", headers: { cookie: cookie! },
    });
    check("logout 200", logoutRes.status === 200, String(logoutRes.status));
    const meAfter = await fetch(`${base}/api/auth/me`, { headers: { cookie: cookie! } });
    check("session unusable after logout (401)", meAfter.status === 401, String(meAfter.status));

    const n = (await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM sessions WHERE user_id = $1`, [userId])).rows[0]?.n;
    check("session row deleted on logout", n === "0", n ?? "?");
  } finally {
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
