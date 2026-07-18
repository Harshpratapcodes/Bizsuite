import { Router } from "express";
import { z } from "zod";
import { OpeningBalance, CreateAccount } from "@bizsuite/contracts";
import { requireAuth, actorId } from "../../core/middleware.js";
import { requirePermission } from "../../core/rbac.js";
import { enterOpeningBalance } from "./opening-balance.js";
import { khataReport, fridayDigest } from "./reports.js";
import { listAccounts, createAccount, archiveAccount, trialBalance, generalLedger } from "./accounts.service.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const accountingRouter = Router();

// ---- Chart of accounts ----------------------------------------------------
accountingRouter.get("/accounts", requireAuth, requirePermission("accounting", "read"), async (_req, res, next) => {
  try { res.json(await listAccounts()); } catch (e) { next(e); }
});

accountingRouter.post("/accounts", requireAuth, requirePermission("accounting", "write"), async (req, res, next) => {
  try {
    const input = CreateAccount.parse(req.body);
    res.status(201).json(await createAccount(input, actorId(req)));
  } catch (e) { next(e); }
});

accountingRouter.post("/accounts/:id/archive", requireAuth, requirePermission("accounting", "write"), async (req, res, next) => {
  try { res.json(await archiveAccount(req.params.id!, actorId(req))); } catch (e) { next(e); }
});

// ---- Ledger reports -------------------------------------------------------
accountingRouter.get("/reports/trial-balance", requireAuth, requirePermission("accounting", "read"), async (req, res, next) => {
  try {
    const asOf = z.object({ asOf: isoDate.optional() }).parse(req.query).asOf;
    res.json(await trialBalance(asOf));
  } catch (e) { next(e); }
});

accountingRouter.get("/reports/general-ledger", requireAuth, requirePermission("accounting", "read"), async (req, res, next) => {
  try {
    const q = z.object({
      account: z.string().uuid(), from: isoDate.optional(), to: isoDate.optional(),
    }).parse(req.query);
    res.json(await generalLedger(q.account, q.from, q.to));
  } catch (e) { next(e); }
});

// Opening balances post straight to the ledger → accounting.submit
// (admin + accounts roles per the seeded matrix; counter staff cannot).
accountingRouter.post("/opening-balances", requireAuth, requirePermission("accounting", "submit"), async (req, res, next) => {
  try {
    const input = OpeningBalance.parse(req.body);
    res.status(201).json(await enterOpeningBalance(input, actorId(req)));
  } catch (e) { next(e); }
});

// The khata — dad's question, as an endpoint. Reads v_party_balances.
accountingRouter.get("/reports/khata", requireAuth, requirePermission("accounting", "read"), async (_req, res, next) => {
  try { res.json(await khataReport()); } catch (e) { next(e); }
});

// Friday digest — WhatsApp-ready text + structured data.
accountingRouter.get("/reports/digest", requireAuth, requirePermission("accounting", "read"), async (_req, res, next) => {
  try { res.json(await fridayDigest()); } catch (e) { next(e); }
});
