import { Router } from "express";
import { z } from "zod";
import { requireAuth, actorId } from "../../core/middleware.js";
import { requirePermission } from "../../core/rbac.js";
import { createCompany, listCompanies, getCompany, updateCompany } from "./companies.service.js";

const gstin = z.string().regex(/^[0-9]{2}[A-Z0-9]{13}$/, "invalid GSTIN format");
const treatment = z.enum(["registered", "unregistered", "overseas", "sez"]);
const address = z.record(z.unknown());

const CreateCompany = z.object({
  name: z.string().min(1),
  gstin: gstin.optional(),
  gstTreatment: treatment.optional(),
  stateCode: z.string().length(2).optional(),
  industry: z.string().optional(),
  website: z.string().optional(),
  billingAddress: address.optional(),
  shippingAddress: address.optional(),
  notes: z.string().optional(),
  isCustomer: z.boolean().optional(),
  isSupplier: z.boolean().optional(),
}).refine((c) => c.gstTreatment !== "registered" || !!c.gstin, {
  message: "registered companies require a GSTIN", path: ["gstin"],
});

const UpdateCompany = z.object({
  name: z.string().min(1).optional(),
  gstin: gstin.nullable().optional(),
  gstTreatment: treatment.optional(),
  stateCode: z.string().length(2).nullable().optional(),
  industry: z.string().nullable().optional(),
  website: z.string().nullable().optional(),
  billingAddress: address.optional(),
  shippingAddress: address.optional(),
  notes: z.string().nullable().optional(),
  isCustomer: z.boolean().optional(),
  isSupplier: z.boolean().optional(),
  isActive: z.boolean().optional(),
}).strict();

export const companiesRouter = Router();

companiesRouter.get("/", requireAuth, requirePermission("crm", "read"), async (req, res, next) => {
  try {
    const role = req.query.role === "customer" || req.query.role === "supplier" ? req.query.role : undefined;
    res.json(await listCompanies({
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
