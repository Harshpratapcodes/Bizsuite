import type { Request, Response, NextFunction } from "express";
import { pool } from "../shared/db.js";
import { AppError } from "../shared/errors.js";

/**
 * Role-based access control over the seeded `role_permissions` matrix
 * (per module: can_read / can_write / can_submit / can_cancel).
 *
 * `requirePermission` is an Express guard that must run AFTER `requireAuth`
 * (it reads req.user). It maps the requested action to its boolean column via
 * a fixed whitelist — the action never reaches SQL as free text.
 */

export type Module = "crm" | "sales" | "invoicing" | "accounting" | "inventory" | "core";
export type PermAction = "read" | "write" | "submit" | "cancel";

const ACTION_COLUMN: Record<PermAction, string> = {
  read: "can_read",
  write: "can_write",
  submit: "can_submit",
  cancel: "can_cancel",
};

/** True if the role is granted (module, action). */
export async function hasPermission(roleId: string, module: Module, action: PermAction): Promise<boolean> {
  const column = ACTION_COLUMN[action];
  const { rows: [perm] } = await pool.query<{ allowed: boolean }>(
    `SELECT ${column} AS allowed FROM role_permissions WHERE role_id = $1 AND module = $2`,
    [roleId, module],
  );
  return perm?.allowed === true;
}

/** Express guard: 403 unless the current user's role allows (module, action). */
export function requirePermission(module: Module, action: PermAction) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const user = req.user;
      if (!user) throw new AppError("UNAUTHENTICATED", "Login required", 401);
      if (!(await hasPermission(user.roleId, module, action))) {
        throw new AppError(
          "FORBIDDEN",
          `Role '${user.roleName}' is not allowed to ${action} in ${module}`,
          403,
        );
      }
      next();
    } catch (e) {
      next(e);
    }
  };
}
