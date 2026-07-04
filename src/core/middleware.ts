import type { Request, Response, NextFunction } from "express";
import { AppError } from "../shared/errors.js";
import { validateSession, type AuthUser } from "./auth.js";

export const SESSION_COOKIE = "sid";

// Make the authenticated user available to route handlers.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/** Minimal cookie reader — avoids a dependency for a single cookie. */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

/** Cookie attributes shared by set and clear. `secure` only in prod (HTTPS). */
function baseCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
  };
}

/** Options for setting the session cookie (includes lifetime). */
export function sessionCookieOptions() {
  return { ...baseCookieOptions(), maxAge: 30 * 86_400_000 };
}

/** Options for clearing the session cookie (no maxAge — deprecated on clear). */
export function clearCookieOptions() {
  return baseCookieOptions();
}

/** Require a valid session; populates req.user or throws 401. */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) throw new AppError("UNAUTHENTICATED", "Login required", 401);
    const user = await validateSession(token);
    if (!user) throw new AppError("UNAUTHENTICATED", "Session invalid or expired", 401);
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
}

/** Convenience: the authenticated actor's id, guaranteed present after requireAuth. */
export function actorId(req: Request): string {
  if (!req.user) throw new AppError("UNAUTHENTICATED", "Login required", 401);
  return req.user.id;
}
