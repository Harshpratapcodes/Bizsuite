import { Router } from "express";
import { z } from "zod";
import { OpeningBalance, CreateAccount, CreateJournalEntry } from "@bizsuite/contracts";
import { requireAuth, actorId } from "../../core/middleware.js";
import { requirePermission } from "../../core/rbac.js";
import { enterOpeningBalance } from "./opening-balance.js";
import { khataReport, fridayDigest } from "./reports.js";
import { listAccounts, createAccount, archiveAccount, trialBalance, generalLedger } from "./accounts.service.js";
import { postManualJournal, reverseManualJournal, listManualJournals, journalDetail } from "./journals.service.js";
import { listPeriods, closePeriod, reopenPeriod } from "./periods.service.js";

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

// ---- Manual journal entries ----------------------------------------------
// Posting hits the ledger → accounting.submit; reversal → accounting.cancel (admin).
accountingRouter.post("/journals", requireAuth, requirePermission("accounting", "submit"), async (req, res, next) => {
  try {
    const input = CreateJournalEntry.parse(req.body);
    res.status(201).json(await postManualJournal(input, actorId(req)));
  } catch (e) { next(e); }
});

accountingRouter.get("/journals", requireAuth, requirePermission("accounting", "read"), async (req, res, next) => {
  try {
    const q = z.object({
      from: isoDate.optional(), to: isoDate.optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);
    res.json(await listManualJournals(q));
  } catch (e) { next(e); }
});

accountingRouter.get("/journals/:id", requireAuth, requirePermission("accounting", "read"), async (req, res, next) => {
  try { res.json(await journalDetail(req.params.id!)); } catch (e) { next(e); }
});

accountingRouter.post("/journals/:id/reverse", requireAuth, requirePermission("accounting", "cancel"), async (req, res, next) => {
  try { res.json(await reverseManualJournal(req.params.id!, actorId(req))); } catch (e) { next(e); }
});

// ---- Financial periods ----------------------------------------------------
// Anyone with accounting.read sees them; close/reopen the books → accounting.cancel (admin).
accountingRouter.get("/periods", requireAuth, requirePermission("accounting", "read"), async (_req, res, next) => {
  try { res.json(await listPeriods()); } catch (e) { next(e); }
});

accountingRouter.post("/periods/:id/close", requireAuth, requirePermission("accounting", "cancel"), async (req, res, next) => {
  try { res.json(await closePeriod(req.params.id!, actorId(req))); } catch (e) { next(e); }
});

accountingRouter.post("/periods/:id/reopen", requireAuth, requirePermission("accounting", "cancel"), async (req, res, next) => {
  try { res.json(await reopenPeriod(req.params.id!, actorId(req))); } catch (e) { next(e); }
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
