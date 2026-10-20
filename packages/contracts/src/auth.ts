import { z } from "zod";

/**
 * Increment 39 (docs/INCREMENT_39_CONTRACTS.md §1–§5) — sign-in & roles.
 *
 * `OSP_AUTH` picks the mode (no default — see apps/api/src/auth/config.ts):
 *   - `entra`: OIDC authorization-code + PKCE against Microsoft Entra ID;
 *   - `none`:  no sign-in, every request is a synthetic local Planner.
 */
export const AuthMode = z.enum(["entra", "none"]);
export type AuthMode = z.infer<typeof AuthMode>;

/** Entra App Role values (exact). `Planner` ⊇ `Viewer`. */
export const AppRole = z.enum(["Planner", "Viewer"]);
export type AppRole = z.infer<typeof AppRole>;

/**
 * Per-route access level declared in every Fastify route's `config.access`
 * (§5 — fail closed: an /api route without it refuses to start the server).
 */
export const RouteAccess = z.enum(["public", "viewer", "planner"]);
export type RouteAccess = z.infer<typeof RouteAccess>;

/** GET /api/auth/me — 200 body. */
export const AuthMeResponse = z.object({
  mode: AuthMode,
  user: z.object({
    name: z.string(),
    email: z.string().nullable(),
    /** Raw `roles` claim values (may include unknown ones). */
    roles: z.array(z.string()),
  }),
  /** Effective role: Planner if present, else Viewer, else null (→ NO_ROLE). */
  role: AppRole.nullable(),
});
export type AuthMeResponse = z.infer<typeof AuthMeResponse>;

/** POST /api/auth/logout — 200 body. `/` in `none` mode. */
export const AuthLogoutResponse = z.object({ logout_url: z.string() });
export type AuthLogoutResponse = z.infer<typeof AuthLogoutResponse>;

/** The effective role for a set of `roles` claim values (§3). */
export function effectiveRole(roles: readonly string[]): AppRole | null {
  if (roles.includes("Planner")) return "Planner";
  if (roles.includes("Viewer")) return "Viewer";
  return null;
}
