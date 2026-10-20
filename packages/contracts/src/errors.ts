import { z } from "zod";

/**
 * Canonical application error codes. The API returns these in a stable envelope
 * so the frontend can branch on `code` rather than parsing messages.
 */
export const ErrorCode = z.enum([
  // Generic
  "BAD_REQUEST",
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "CONFLICT",
  "INTERNAL",
  // Connection / OpenProject
  "NO_CONNECTION",
  "CONNECTION_NOT_FOUND",
  "CONNECTION_EXISTS", // base_url already registered (UNIQUE)
  "CONNECTION_DISABLED", // Disconnect/Connect toggle: server is temporarily off
  "IMPORT_NOT_FOUND",
  // Vault (SPEC_02 §3)
  "VAULT_LOCKED", // 423 — operation needs the unlocked vault
  "VAULT_NOT_INITIALIZED",
  "VAULT_ALREADY_INITIALIZED",
  "VAULT_INVALID_PASSPHRASE",
  "OP_UNAUTHORIZED", // invalid / expired token (OP 401/403)
  "OP_UNREACHABLE", // network / 5xx from OP
  "OP_RATE_LIMITED", // OP 429
  "OP_QUERY_INVALID", // OP 400 InvalidQuery — a bad request WE sent, not an unreachable server (SPEC_07 §3)
  "READ_ONLY_VIOLATION", // attempted non-GET to OP (guard tripped)
  // Sync
  "SYNC_IN_PROGRESS",
  "SYNC_FAILED",
  // Sprint domain
  "SPRINT_NOT_FOUND",
  "SPRINT_CLOSED", // mutating a closed sprint
  "WORK_PACKAGE_NOT_FOUND",
  "ITEM_ALREADY_IN_SPRINT",
  "CAPACITY_EXCEEDED", // advisory; only when strict mode requested
  "SPRINT_NOT_PLANNING", // capacity is editable only while a sprint is in planning
  // Increment 4 (SPEC_04): sprint lifecycle
  "SPRINT_NOT_ACTIVE", // update/finish called before the sprint was ever activated
  "SPRINT_FROZEN", // update run on a sprint past its post-finish grace period (Increment 31) — reactivate to unfreeze
  "SPRINT_LOCKED", // mutating a sprint after it locked (finished or end-date auto-lock)
  // Increment 9 (SPEC_09 §1): scoped/async activation
  "ACTIVATION_CONNECTIONS_UNAVAILABLE", // a connection a sprint's tickets need is disconnected/missing — surfaced BEFORE starting the run
  // Increment 12 (SPEC_12 §2): retrospective planning
  "SPRINT_NOT_RETROSPECTIVE", // retro seed/preview called on a sprint whose is_retrospective flag is false
  // Increment 39 (docs/INCREMENT_39_CONTRACTS.md §5): sign-in / roles
  "UNAUTHENTICATED", // 401 — `entra` mode and no valid session cookie
  "NO_ROLE", // 403 — signed in, but the ID token carries neither Planner nor Viewer
  "FORBIDDEN_ROLE", // 403 — a Viewer on a Planner-only route
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** Standard error response envelope for every non-2xx REST response. */
export const ErrorResponse = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    /** Optional machine-readable detail (e.g. Zod issues, offending field). */
    details: z.unknown().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;

/** Helper to construct an ErrorResponse payload. */
export function makeError(
  code: ErrorCode,
  message: string,
  details?: unknown,
): ErrorResponse {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}
