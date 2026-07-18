import type { ApiErrorBody } from "@bizsuite/contracts";

/**
 * Thin fetch wrapper. Same-origin cookies carry the session; every non-2xx
 * becomes an ApiError with the server's typed code, which screens map to
 * plain-language messages (staff-usable bar: no raw codes in the UI).
 */
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    credentials: "same-origin",
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (body ?? {}) as Partial<ApiErrorBody>;
    throw new ApiError(
      err.error?.code ?? "UNKNOWN",
      err.error?.message ?? `Request failed (${res.status})`,
      res.status,
      err.error?.details,
    );
  }
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
};

/** Plain-language messages for the error codes staff will actually hit. */
const FRIENDLY: Record<string, string> = {
  INVALID_CREDENTIALS: "Wrong email or password.",
  UNAUTHENTICATED: "You are logged out. Please log in again.",
  FORBIDDEN: "Your account is not allowed to do this. Ask the admin.",
  INSUFFICIENT_STOCK: "Not enough stock for this sale. Check quantity or stock register.",
  OPENING_EXISTS: "This customer already has an opening balance. It must be reversed before entering a new one.",
  OVER_ALLOCATED: "The invoice-wise split is more than the payment amount.",
  INVALID_ALLOCATION: "One of the invoice allocations is not valid (wrong customer, or more than what's outstanding).",
  INVALID_AMOUNT: "The amount must be more than zero.",
  INVALID_STATE: "This document was already processed. Refresh to see its current state.",
  ALREADY_ORDERED: "This quotation already has a sales order.",
  ALREADY_BILLED: "This sales order has already been invoiced.",
  HAS_INVOICES: "Cancel the invoices raised against this order first.",
  PERIOD_CLOSED: "That accounting period is closed. Use a different date, or ask an admin to reopen it.",
  INVALID_DATE: "The invoice date cannot be in the future.",
  NOT_CONFIGURED: "Company details are not set up yet. Ask the admin to fill in company settings.",
  IMMUTABLE: "This document is locked after submission. Corrections need an admin reversal.",
  CONSTRAINT_VIOLATION: "This entry breaks a bookkeeping rule. Check the quantities and amounts.",
  DUPLICATE_NAME: "A customer with this name already exists.",
  NOT_FOUND: "Not found. It may have been changed elsewhere — refresh.",
  VALIDATION: "Some fields are not filled correctly. Check the highlighted fields.",
};

export function friendlyMessage(e: unknown): string {
  if (e instanceof ApiError) return FRIENDLY[e.code] ?? e.message;
  if (e instanceof Error) return e.message;
  return "Something went wrong.";
}
