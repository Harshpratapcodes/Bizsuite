import express from "express";
import { z } from "zod";
import { AppError } from "./shared/errors.js";
import { pool } from "./shared/db.js";
import { login, logout } from "./core/auth.js";
import { requireAuth, readCookie, sessionCookieOptions, clearCookieOptions, SESSION_COOKIE } from "./core/middleware.js";
import { itemsRouter } from "./modules/inventory/items.routes.js";
import { companiesRouter } from "./modules/crm/companies.routes.js";
import { invoicingRouter } from "./modules/invoicing/invoicing.routes.js";
import { paymentsRouter } from "./modules/invoicing/payments.routes.js";
import { accountingRouter } from "./modules/accounting/accounting.routes.js";

/**
 * Mount-only composition root (eng review D6): auth endpoints + one router per
 * module. Business routes live in src/modules/<module>/<name>.routes.ts.
 */
const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------
const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const { email, password } = LoginSchema.parse(req.body);
    const result = await login(email, password, {
      ip: req.ip,
      userAgent: req.header("user-agent"),
    });
    if (!result) throw new AppError("INVALID_CREDENTIALS", "Invalid email or password", 401);
    res.cookie(SESSION_COOKIE, result.token, sessionCookieOptions());
    res.json({ user: result.user });
  } catch (e) { next(e); }
});

app.post("/api/auth/logout", async (req, res, next) => {
  try {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) await logout(token);
    res.clearCookie(SESSION_COOKIE, clearCookieOptions());
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// ---------------------------------------------------------------------------
// Module routers
// ---------------------------------------------------------------------------
app.use("/api/inventory/items", itemsRouter);
app.use("/api/crm/companies", companiesRouter);
app.use("/api/invoicing/invoices", invoicingRouter);
app.use("/api/invoicing/payments", paymentsRouter);
app.use("/api/accounting", accountingRouter);

app.get("/healthz", async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true });
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof z.ZodError) {
    return res.status(422).json({ error: { code: "VALIDATION", details: err.flatten() } });
  }
  const e = err instanceof AppError ? err : new AppError("INTERNAL", "Internal error", 500);
  res.status(e.status).json({ error: { code: e.code, message: e.message } });
});

export { app };

// Start the HTTP listener only when run as the entry point (not when imported
// by tests, which start their own ephemeral listener).
import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => console.log(`bizsuite listening on :${port}`));
}
