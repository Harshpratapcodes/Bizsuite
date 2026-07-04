export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public details?: unknown,
  ) {
    super(message);
  }
}

/** Map errors raised by our schema triggers to typed application errors. */
export function fromPgError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const e = err as { code?: string; message?: string };
  switch (e.code) {
    case "P0003":
      return new AppError("INSUFFICIENT_STOCK", e.message ?? "Insufficient stock", 409);
    case "P0002":
      return new AppError("UNKNOWN_SERIES", e.message ?? "Unknown document series", 500);
    case "P0001":
      return new AppError("IMMUTABLE", e.message ?? "Record is immutable", 409);
    case "23514":
      return new AppError("CONSTRAINT_VIOLATION", e.message ?? "Constraint violation", 422);
    default:
      return new AppError("INTERNAL", e.message ?? "Internal error", 500);
  }
}
