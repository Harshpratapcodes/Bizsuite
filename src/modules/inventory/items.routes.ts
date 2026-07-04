import { Router } from "express";
import { z } from "zod";
import { requireAuth, actorId } from "../../core/middleware.js";
import { requirePermission } from "../../core/rbac.js";
import { createItem, listItems, getItem, updateItem } from "./items.service.js";

const money = z.string().regex(/^\d+(\.\d{1,2})?$/, "expected a decimal like 1500.00");
const qty = z.string().regex(/^\d+(\.\d{1,3})?$/);
const gstRate = z.union([z.literal(0), z.literal(0.25), z.literal(3), z.literal(5), z.literal(12), z.literal(18), z.literal(28)]);

const CreateItem = z.object({
  sku: z.string().min(1).max(64),
  name: z.string().min(1),
  description: z.string().optional(),
  uom: z.string().optional(),
  hsnSacCode: z.string().regex(/^[0-9]{4,8}$/),
  gstRate,
  isStockItem: z.boolean().optional(),
  reorderLevel: qty.optional(),
  standardSellingRate: money.optional(),
  standardBuyingRate: money.optional(),
});

const UpdateItem = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  uom: z.string().optional(),
  hsnSacCode: z.string().regex(/^[0-9]{4,8}$/).optional(),
  gstRate: gstRate.optional(),
  isStockItem: z.boolean().optional(),
  reorderLevel: qty.nullable().optional(),
  standardSellingRate: money.nullable().optional(),
  standardBuyingRate: money.nullable().optional(),
  isActive: z.boolean().optional(),
}).strict();

export const itemsRouter = Router();

itemsRouter.get("/", requireAuth, requirePermission("inventory", "read"), async (req, res, next) => {
  try {
    res.json(await listItems({
      activeOnly: req.query.active === "true",
      search: typeof req.query.q === "string" ? req.query.q : undefined,
    }));
  } catch (e) { next(e); }
});

itemsRouter.post("/", requireAuth, requirePermission("inventory", "write"), async (req, res, next) => {
  try {
    const input = CreateItem.parse(req.body);
    res.status(201).json(await createItem(input, actorId(req)));
  } catch (e) { next(e); }
});

itemsRouter.get("/:id", requireAuth, requirePermission("inventory", "read"), async (req, res, next) => {
  try { res.json(await getItem(req.params.id!)); } catch (e) { next(e); }
});

itemsRouter.patch("/:id", requireAuth, requirePermission("inventory", "write"), async (req, res, next) => {
  try {
    const patch = UpdateItem.parse(req.body);
    res.json(await updateItem(req.params.id!, patch, actorId(req)));
  } catch (e) { next(e); }
});
