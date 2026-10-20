import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { makeError } from "@osp/contracts";
import { redactUrlForLog, registerAuth, type AuthOptions } from "./auth/index";
import type { AppDeps } from "./deps";
import { AppError, statusForCode } from "./errors";
import { createDataRoutes } from "./routes/data";
import { createRoutes } from "./routes/index";
import { versionInfo } from "./version";

/**
 * Build the Fastify app around injected dependencies (SPEC §7). Registers all
 * REST routes under /api and a consistent error handler that serializes
 * AppError / ZodError into the frozen ErrorResponse envelope.
 */
export interface BuildAppOptions {
  /**
   * Increment 39 — REQUIRED (no default, fail closed): which auth mode the app
   * runs in. index.ts resolves it from OSP_AUTH; the vitest harness injects it.
   */
  auth: AuthOptions;
}

export async function buildApp(deps: AppDeps, options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      // Never log an OIDC callback's `code`/`state` (or any auth query string).
      serializers: {
        req: (req) => ({
          method: req.method,
          url: redactUrlForLog(req.url),
          host: req.host,
          remoteAddress: req.ip,
          remotePort: req.socket?.remotePort,
        }),
      },
    },
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply
        .code(statusForCode(err.code))
        .send(makeError(err.code, err.message, err.details));
    }
    if (err instanceof ZodError) {
      return reply
        .code(400)
        .send(makeError("VALIDATION_ERROR", "Request validation failed", err.flatten()));
    }
    // Fastify's own validation / not-found style errors.
    const e = err as { statusCode?: number; message?: string };
    const statusCode = e.statusCode ?? 500;
    if (statusCode === 404) {
      return reply.code(404).send(makeError("NOT_FOUND", e.message ?? "Not found"));
    }
    if (statusCode >= 400 && statusCode < 500) {
      return reply
        .code(statusCode)
        .send(makeError("BAD_REQUEST", e.message ?? "Bad request"));
    }
    app.log.error(err);
    return reply.code(500).send(makeError("INTERNAL", "Internal server error"));
  });

  app.setNotFoundHandler((req, reply) => {
    return reply
      .code(404)
      .send(makeError("NOT_FOUND", `Route ${req.method} ${req.url} not found`));
  });

  // Increment 39 §5 — MUST precede every route registration (the onRoute guard
  // only sees routes registered after it) and FOLLOW the error/not-found
  // handlers (encapsulated plugins capture the error handler at registration).
  await registerAuth(app, options.auth);

  app.get("/health", { config: { access: "public" } }, async () => ({ status: "ok" as const }));
  app.get("/api/version", { config: { access: "public" } }, async () => versionInfo());

  await app.register(createRoutes(deps), { prefix: "/api" });
  // Increment 27 — JSON export/import (Settings → Data). Registered separately
  // because it takes the raw Drizzle handle rather than the repositories.
  await app.register(createDataRoutes({ db: deps.db, now: deps.now }), {
    prefix: "/api",
  });

  return app;
}
