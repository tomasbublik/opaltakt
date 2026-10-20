import { z } from "zod";
import type { ErrorCode } from "@osp/contracts";
import { AppError } from "../errors";

/** Parse `data` with a Zod schema, throwing a VALIDATION_ERROR AppError. */
export function parseOrThrow<S extends z.ZodTypeAny>(
  schema: S,
  data: unknown,
): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Request validation failed",
      result.error.flatten(),
    );
  }
  return result.data;
}

/** Best-effort mapping of an OP-client error to an AppError. */
export function mapOpError(err: unknown): AppError {
  const anyErr = err as { code?: string; status?: number; message?: string };
  if (anyErr?.code === "READ_ONLY_VIOLATION") {
    return new AppError("READ_ONLY_VIOLATION", anyErr.message ?? "read-only violation");
  }
  const status = anyErr?.status;
  if (status === 401 || status === 403) {
    return new AppError("OP_UNAUTHORIZED", anyErr.message ?? "OpenProject rejected the token");
  }
  if (status === 429) {
    return new AppError("OP_RATE_LIMITED", anyErr.message ?? "OpenProject rate limited");
  }
  // A 400 means OP responded and rejected OUR query (e.g. an unsupported
  // filter attribute) — the server is reachable, only the request was bad.
  // Must NOT read as "unreachable" (SPEC_07 §3) — see also
  // packages/op-client/src/instrument.ts, which keeps a 400 from flipping
  // the connection's health to fail/red for the same reason.
  if (status === 400) {
    return new AppError("OP_QUERY_INVALID", anyErr.message ?? "OpenProject rejected the query");
  }
  return new AppError("OP_UNREACHABLE", anyErr?.message ?? "OpenProject unreachable");
}

/** Parse an OP HAL "self" href like ".../api/v3/users/42" to its numeric id. */
export function idFromHref(href: string | null | undefined): number | null {
  if (!href) return null;
  const m = /\/(\d+)(?:\?.*)?$/.exec(href);
  return m ? Number(m[1]) : null;
}

export function fail(code: ErrorCode, message: string, details?: unknown): never {
  throw new AppError(code, message, details);
}
