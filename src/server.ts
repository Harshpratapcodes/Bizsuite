import express from "express";
import { z } from "zod";
import { createDraftInvoice, invoiceLifecycle } from "./modules/invoicing/service.js";
import { AppError } from "./shared/errors.js";
import { pool } from "./shared/db.js";
import { login, logout } from "./core/auth.js";
import { requireAuth, actorId, readCookie, sessionCookieOptions, clearCookieOptions, SESSION_COOKIE } from "./core/middleware.js";
import { requirePermission } from "./core/rbac.js";
import { itemsRouter } from "./modules/inventory/items.routes.js";
import { companiesRouter } from "./modules/crm/companies.routes.js";

const app = express();
app.use(express.json());

// The authenticated actor for a request — populated by requireAuth from the
// session cookie. Audit triggers attribute changes to this user via app.user_id.
const actor = (req: express.Request): string => actorId(req);

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
// Master-data routes
// ---------------------------------------------------------------------------
app.use("/api/inventory/items", itemsRouter);
app.use("/api/crm/companies", companiesRouter);

const InvoiceSchema = z.object({
  customerId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  placeOfSupply: z.string().length(2),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  lines: z.array(z.object({
    itemId: z.string().uuid(),
    description: z.string().min(1),
    hsn: z.string().regex(/^[0-9]{4,8}$/),
    qty: z.string().regex(/^\d+(\.\d{1,3})?$/),
    rate: z.string().regex(/^\d+(\.\d{1,2})?$/),
    discountPct: z.number().min(0).max(100).optional(),
    gstRate: z.number(),
  })).min(1),
});

app.post("/api/invoicing/invoices", requireAuth, requirePermission("invoicing", "write"), async (req, res, next) => {
  try {
    const input = InvoiceSchema.parse(req.body);
    res.status(201).json(await createDraftInvoice(input, actor(req)));
  } catch (e) { next(e); }
});

app.post("/api/invoicing/invoices/:id/submit", requireAuth, requirePermission("invoicing", "submit"), async (req, res, next) => {
  try { res.json(await invoiceLifecycle.submit(req.params.id!, actor(req))); }
  catch (e) { next(e); }
});

app.post("/api/invoicing/invoices/:id/cancel", requireAuth, requirePermission("invoicing", "cancel"), async (req, res, next) => {
  try { res.json(await invoiceLifecycle.cancel(req.params.id!, actor(req))); }
  catch (e) { next(e); }
});

app.get("/api/invoicing/invoices/:id", requireAuth, requirePermission("invoicing", "read"), async (req, res, next) => {
  try {
    const { rows: [inv] } = await pool.query(
      `SELECT i.*, o.amount_paid, o.outstanding, o.payment_status
         FROM invoices i LEFT JOIN v_invoice_outstanding o ON o.id = i.id
        WHERE i.id = $1`, [req.params.id]);
    if (!inv) throw new AppError("NOT_FOUND", "Invoice not found", 404);
    res.json(inv);
  } catch (e) { next(e); }
});

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
