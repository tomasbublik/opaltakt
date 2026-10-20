import { randomBytes, timingSafeEqual } from "node:crypto";
import fastifyCookie from "@fastify/cookie";
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from "fastify";
import {
  effectiveRole,
  RouteAccess,
  type AppRole,
  type AuthLogoutResponse,
  type AuthMeResponse,
} from "@osp/contracts";
import { AppError } from "../errors";
import type { AuthConfig, EntraAuthConfig } from "./config";
import { createEntraOidcProvider, pkce, type IdTokenClaims, type OidcProvider } from "./oidc";
import { sanitizeReturnTo } from "./returnTo";
import {
  createSealedCodec,
  LOGIN_COOKIE,
  LOGIN_TTL_SECONDS,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  type LoginPayload,
  type SealedCodec,
  type SessionPayload,
} from "./session";

export { resolveAuthConfig, AuthConfigError, type AuthConfig } from "./config";
export { sanitizeReturnTo } from "./returnTo";
export type { OidcProvider, IdTokenClaims } from "./oidc";
export { SESSION_COOKIE, LOGIN_COOKIE } from "./session";

/**
 * Increment 39 (docs/INCREMENT_39_CONTRACTS.md §2–§5) — sign-in + role
 * enforcement, wired into the root Fastify instance by `buildApp` BEFORE any
 * route is registered (so the onRoute guard sees every route).
 *
 *  - onRoute: every route under /api MUST declare `config.access`; a missing
 *    or unknown value throws while the routes register, i.e. at startup —
 *    a forgotten declaration can never become an open route.
 *  - onRequest (the contract's "preHandler" gate, run one phase EARLIER on
 *    purpose: an anonymous caller is rejected before Fastify parses a body —
 *    POST /api/data/import accepts up to 64 MB — and before the SSE route
 *    hijacks the socket; responses are identical): 401 UNAUTHENTICATED /
 *    403 NO_ROLE / 403 FORBIDDEN_ROLE.
 *  - /api/auth/{me,login,callback,logout} (§4), all `public`.
 */

export interface AuthUser {
  sub: string;
  oid: string | null;
  name: string;
  email: string | null;
  roles: string[];
}

export interface RequestAuth {
  user: AuthUser;
  role: AppRole | null;
}

export interface AuthOptions {
  config: AuthConfig;
  /** entra only — defaults to the real openid-client provider. */
  oidc?: OidcProvider;
  /** Clock (epoch seconds) for cookie expiry — tests override. */
  nowSeconds?: () => number;
  /**
   * TEST SEAM (entra mode): replaces the cookie lookup entirely. Return the
   * user the request acts as, or null for anonymous. Never set in production.
   */
  resolveUser?: (req: FastifyRequest) => AuthUser | null;
}

export interface RouteAccessEntry {
  method: string;
  url: string;
  access: RouteAccess | undefined;
}

declare module "fastify" {
  interface FastifyContextConfig {
    access?: RouteAccess;
  }
  interface FastifyRequest {
    /** Resolved identity; null = anonymous (entra mode, no valid session). */
    auth: RequestAuth | null;
  }
  interface FastifyInstance {
    /** Every route registered on this app with its declared access (tests). */
    routeAccess: RouteAccessEntry[];
    /**
     * Headers that let an IN-PROCESS `app.inject()` (the periodic full-refresh
     * scheduler) act as a system Planner. The token is random per process and
     * never leaves memory.
     */
    internalAuthHeaders(): Record<string, string>;
  }
}

export const LOCAL_USER: AuthUser = {
  sub: "local",
  oid: null,
  name: "Local user",
  email: null,
  roles: ["Planner"],
};

const SYSTEM_USER: AuthUser = {
  sub: "system",
  oid: null,
  name: "System (scheduler)",
  email: null,
  roles: ["Planner"],
};

const INTERNAL_HEADER = "x-osp-internal-auth";

/** Strip query strings from logged URLs on the auth routes (codes, state). */
export function redactUrlForLog(url: string): string {
  return url.startsWith("/api/auth/") ? url.split("?")[0]! : url;
}

export function userFromClaims(claims: IdTokenClaims): AuthUser {
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  const preferred = str(claims.preferred_username);
  const email = str(claims.email) ?? (preferred && preferred.includes("@") ? preferred : null);
  const roles = Array.isArray(claims.roles)
    ? claims.roles.filter((r): r is string => typeof r === "string")
    : [];
  return {
    sub: String(claims.sub),
    oid: str(claims.oid),
    name: str(claims.name) ?? preferred ?? email ?? String(claims.sub),
    email,
    roles,
  };
}

function toAuth(user: AuthUser): RequestAuth {
  return { user, role: effectiveRole(user.roles) };
}

export async function registerAuth(app: FastifyInstance, opts: AuthOptions): Promise<void> {
  const { config } = opts;
  const nowSeconds = opts.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const internalToken = randomBytes(32);
  const internalTokenHex = internalToken.toString("hex");

  await app.register(fastifyCookie);

  const registry: RouteAccessEntry[] = [];
  app.decorate("routeAccess", registry);
  app.decorate("internalAuthHeaders", () => ({ [INTERNAL_HEADER]: internalTokenHex }));
  app.decorateRequest("auth", null);

  // ── fail-closed route declaration guard (§5) ──────────────────────────────
  app.addHook("onRoute", (route: RouteOptions) => {
    const access = (route.config as { access?: unknown } | undefined)?.access;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const valid = RouteAccess.safeParse(access).success;
    if (!valid && route.url.startsWith("/api")) {
      throw new Error(
        `Route ${methods.join(",")} ${route.url} declares no valid config.access ` +
          `("public" | "viewer" | "planner") — refusing to start (INCREMENT_39 §5: fail closed).`,
      );
    }
    for (const m of methods) {
      registry.push({ method: String(m), url: route.url, access: valid ? (access as RouteAccess) : undefined });
    }
  });

  let sessionCodec: SealedCodec<SessionPayload> | null = null;
  let loginCodec: SealedCodec<LoginPayload> | null = null;
  let oidc: OidcProvider | null = null;
  if (config.mode === "entra") {
    sessionCodec = createSealedCodec<SessionPayload>(config.sessionSecret, SESSION_COOKIE, nowSeconds);
    loginCodec = createSealedCodec<LoginPayload>(config.sessionSecret, LOGIN_COOKIE, nowSeconds);
    oidc = opts.oidc ?? createEntraOidcProvider(config);
  }

  function isInternal(req: FastifyRequest): boolean {
    const h = req.headers[INTERNAL_HEADER];
    if (typeof h !== "string" || h.length !== internalTokenHex.length) return false;
    const given = Buffer.from(h, "hex");
    return given.length === internalToken.length && timingSafeEqual(given, internalToken);
  }

  function resolveAuth(req: FastifyRequest): RequestAuth | null {
    if (isInternal(req)) return toAuth(SYSTEM_USER);
    if (config.mode === "none") return toAuth(LOCAL_USER);
    if (opts.resolveUser) {
      const u = opts.resolveUser(req);
      return u ? toAuth(u) : null;
    }
    const s = sessionCodec!.open(req.cookies?.[SESSION_COOKIE]);
    if (!s) return null;
    return toAuth({
      sub: s.sub,
      oid: s.oid,
      name: s.name,
      email: s.email,
      roles: Array.isArray(s.roles) ? s.roles.filter((r) => typeof r === "string") : [],
    });
  }

  // ── enforcement (§5) ──────────────────────────────────────────────────────
  app.addHook("onRequest", async (req) => {
    // Unmatched URL → the 404 handler; nothing to protect, nothing leaks.
    if (!req.routeOptions.url) return;
    req.auth = resolveAuth(req);
    const access = req.routeOptions.config?.access;
    if (access === "public") return;
    // `viewer` / `planner` — and, fail-closed, anything undeclared.
    if (!req.auth) throw new AppError("UNAUTHENTICATED", "Sign in required");
    if (!req.auth.role) {
      throw new AppError(
        "NO_ROLE",
        "Your account has no OpalTakt role (Planner or Viewer) — ask the administrator for access",
      );
    }
    if (access !== "viewer" && req.auth.role !== "Planner") {
      throw new AppError("FORBIDDEN_ROLE", "This action requires the Planner role");
    }
  });

  // ── §4 endpoints ──────────────────────────────────────────────────────────
  const pub = { config: { access: "public" as const } };
  const secure = config.mode === "entra" && config.publicUrl.startsWith("https://");
  const sessionCookieOpts = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    path: "/",
  };
  const loginCookieOpts = { ...sessionCookieOpts, path: "/api/auth" };

  await app.register(
    async (r) => {
      r.get("/me", pub, async (req): Promise<AuthMeResponse> => {
        const auth = req.auth;
        if (!auth) throw new AppError("UNAUTHENTICATED", "Not signed in");
        return {
          mode: config.mode,
          user: { name: auth.user.name, email: auth.user.email, roles: auth.user.roles },
          role: auth.role,
        };
      });

      r.get("/login", pub, async (req, reply) => {
        if (config.mode === "none") return reply.redirect("/", 302);
        const q = (req.query ?? {}) as Record<string, unknown>;
        const returnTo = sanitizeReturnTo(q.returnTo);
        const verifier = pkce.verifier();
        const state = pkce.state();
        const nonce = pkce.nonce();
        const codeChallenge = await pkce.challenge(verifier);
        const url = oidc!.authorizationUrl({
          redirectUri: redirectUri(config),
          state,
          nonce,
          codeChallenge,
        });
        reply.setCookie(
          LOGIN_COOKIE,
          loginCodec!.seal({ state, nonce, verifier, returnTo, exp: nowSeconds() + LOGIN_TTL_SECONDS }),
          { ...loginCookieOpts, maxAge: LOGIN_TTL_SECONDS },
        );
        return reply.redirect(url, 302);
      });

      r.get("/callback", pub, async (req, reply) => {
        if (config.mode === "none") return reply.redirect("/", 302);
        const fail = (code: string): FastifyReply => {
          reply.clearCookie(LOGIN_COOKIE, loginCookieOpts);
          return reply.redirect(`/?auth_error=${encodeURIComponent(code)}`, 302);
        };
        const pending = loginCodec!.open(req.cookies?.[LOGIN_COOKIE]);
        const q = (req.query ?? {}) as Record<string, unknown>;
        if (typeof q.error === "string") {
          req.log.warn({ idp_error: q.error.slice(0, 64) }, "sign-in: identity provider returned an error");
          return fail(q.error === "access_denied" ? "access_denied" : "idp_error");
        }
        if (!pending) return fail("login_expired");
        // The redirect_uri sent to the token endpoint is derived from this URL,
        // so it is built from OSP_PUBLIC_URL — never from the request Host.
        const rawQuery = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
        const callbackUrl = new URL(`${redirectUri(config)}${rawQuery}`);
        let claims: IdTokenClaims;
        try {
          claims = await oidc!.exchange(callbackUrl, {
            state: pending.state,
            nonce: pending.nonce,
            codeVerifier: pending.verifier,
          });
        } catch (err) {
          // Name/code only — never the error object (may carry response bodies).
          const e = err as { name?: string; code?: string };
          req.log.warn({ err_name: e?.name, err_code: e?.code }, "sign-in: callback validation failed");
          return fail("callback_failed");
        }
        const user = userFromClaims(claims);
        const session: SessionPayload = { ...user, exp: nowSeconds() + SESSION_TTL_SECONDS };
        reply.clearCookie(LOGIN_COOKIE, loginCookieOpts);
        reply.setCookie(SESSION_COOKIE, sessionCodec!.seal(session), {
          ...sessionCookieOpts,
          maxAge: SESSION_TTL_SECONDS,
        });
        return reply.redirect(sanitizeReturnTo(pending.returnTo), 302);
      });

      r.post("/logout", pub, async (_req, reply): Promise<AuthLogoutResponse> => {
        if (config.mode === "none") return { logout_url: "/" };
        reply.clearCookie(SESSION_COOKIE, sessionCookieOpts);
        return { logout_url: oidc!.endSessionUrl(`${config.publicUrl}/`) };
      });
    },
    { prefix: "/api/auth" },
  );
}

export function redirectUri(config: EntraAuthConfig): string {
  return `${config.publicUrl}/api/auth/callback`;
}

/**
 * Increment 39 — may this request cause OpenProject traffic? Only a Planner
 * (incl. the `none`-mode local user and the in-process scheduler). A Viewer
 * must never cause ANY OP call (§5 principle), so viewer-readable routes whose
 * computation can opportunistically reach OP (capacity, sprint people) fall
 * back to their local-only paths for anyone else. Fail closed: no auth → no.
 */
export function mayContactOp(req: FastifyRequest): boolean {
  return req.auth?.role === "Planner";
}
