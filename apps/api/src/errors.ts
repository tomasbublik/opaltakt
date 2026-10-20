import type { FastifyReply } from "fastify";
import { type ErrorCode, makeError } from "@osp/contracts";

/**
 * Application error type + mapping to the frozen ErrorResponse envelope and
 * HTTP status codes (@osp/contracts). Handlers throw AppError; the Fastify
 * error handler serializes it.
 */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL: 500,
  NO_CONNECTION: 409,
  CONNECTION_NOT_FOUND: 404,
  CONNECTION_EXISTS: 409,
  CONNECTION_DISABLED: 409,
  IMPORT_NOT_FOUND: 404,
  VAULT_LOCKED: 423,
  VAULT_NOT_INITIALIZED: 409,
  VAULT_ALREADY_INITIALIZED: 409,
  VAULT_INVALID_PASSPHRASE: 401,
  OP_UNAUTHORIZED: 401,
  OP_UNREACHABLE: 502,
  OP_RATE_LIMITED: 429,
  OP_QUERY_INVALID: 400,
  READ_ONLY_VIOLATION: 500,
  SYNC_IN_PROGRESS: 409,
  SYNC_FAILED: 502,
  SPRINT_NOT_FOUND: 404,
  SPRINT_CLOSED: 409,
  WORK_PACKAGE_NOT_FOUND: 404,
  ITEM_ALREADY_IN_SPRINT: 409,
  CAPACITY_EXCEEDED: 409,
  SPRINT_NOT_PLANNING: 409,
  SPRINT_NOT_ACTIVE: 409,
  SPRINT_FROZEN: 409,
  SPRINT_LOCKED: 409,
  ACTIVATION_CONNECTIONS_UNAVAILABLE: 409,
  SPRINT_NOT_RETROSPECTIVE: 409,
  UNAUTHENTICATED: 401,
  NO_ROLE: 403,
  FORBIDDEN_ROLE: 403,
};

export function statusForCode(code: ErrorCode): number {
  return STATUS_BY_CODE[code] ?? 500;
}

export function sendError(
  reply: FastifyReply,
  code: ErrorCode,
  message: string,
  details?: unknown,
): FastifyReply {
  return reply.code(statusForCode(code)).send(makeError(code, message, details));
}
