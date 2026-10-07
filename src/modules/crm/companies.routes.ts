import { Router } from "express";
import { CreateCompany, UpdateCompany } from "@bizsuite/contracts";
import { requireAuth, actorId } from "../../core/middleware.js";
import { requirePermission } from "../../core/rbac.js";
import {
  createCompany, listCompanies, getCompany, updateCompany, findCompanyByExactName,
} from "./companies.service.js";

/**
 * Companies master (customers & suppliers). Request shapes live in
 * @bizsuite/contracts (D7) — the SPA validates with the same objects, so the
 * GSTIN rule and the state-code rule cannot drift between form and server.
 *
 * Search is name OR GSTIN: two customers with similar names are told apart by
 * the one identifier that is never ambiguous.
 */
export const companiesRouter = Router();

companiesRouter.get("/", requireAuth, requirePermission("crm", "read"), async (req, res, next) => {
  try {
    // ?name= is an EXACT, case-insensitive lookup ignoring the role/active
    // filters. The quick-add modal uses it to recover from a DUPLICATE_NAME:
    // ?q= is a substring search that can match several companies, so picking
    // one of those could flip the wrong record's flags (eng review D15).
    if (typeof req.query.name === "string") {
      const hit = await findCompanyByExactName(req.query.name);
      return res.json(hit ? [hit] : []);
    }
    const role = req.query.role === "customer" || req.query.role === "supplier" ? req.query.role : undefined;
    return res.json(await listCompanies({
      role,
      activeOnly: req.query.active === "true",
      search: typeof req.query.q === "string" ? req.query.q : undefined,
    }));
  } catch (e) { next(e); }
});

companiesRouter.post("/", requireAuth, requirePermission("crm", "write"), async (req, res, next) => {
  try {
    const input = CreateCompany.parse(req.body);
    res.status(201).json(await createCompany(input, actorId(req)));
  } catch (e) { next(e); }
});

companiesRouter.get("/:id", requireAuth, requirePermission("crm", "read"), async (req, res, next) => {
  try { res.json(await getCompany(req.params.id!)); } catch (e) { next(e); }
});

companiesRouter.patch("/:id", requireAuth, requirePermission("crm", "write"), async (req, res, next) => {
  try {
    const patch = UpdateCompany.parse(req.body);
    res.json(await updateCompany(req.params.id!, patch, actorId(req)));
  } catch (e) { next(e); }
});
