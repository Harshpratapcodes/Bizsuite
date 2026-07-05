import { Router } from "express";
import { OpeningBalance } from "@bizsuite/contracts";
import { requireAuth, actorId } from "../../core/middleware.js";
import { requirePermission } from "../../core/rbac.js";
import { enterOpeningBalance } from "./opening-balance.js";
import { khataReport, fridayDigest } from "./reports.js";

export const accountingRouter = Router();

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
