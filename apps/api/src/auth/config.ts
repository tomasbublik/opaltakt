/**
 * Increment 39 (docs/INCREMENT_39_CONTRACTS.md §1) — auth configuration.
 *
 * `OSP_AUTH` is REQUIRED, with no default — same philosophy as `PORT`
 * (index.ts) and `DATABASE_URL` (server.ts): a forgotten setting must fail
 * loudly at boot, never silently deploy an open app. In `entra` mode every
 * Entra/session variable is required too, and the error lists ALL missing
 * ones at once.
 *
 * Pure function over an env object so it is unit-testable without spawning a
 * process. Never echoes a secret value in an error message.
 */

export interface NoneAuthConfig {
  mode: "none";
}

export interface EntraAuthConfig {
  mode: "entra";
  tenantId: string;
  clientId: string;
  /** Never logged, never returned by any endpoint. */
  clientSecret: string;
  /** Browser-facing origin, no trailing slash (e.g. `http://localhost:5173`). */
  publicUrl: string;
  /** Raw key material decoded from OSP_SESSION_SECRET (≥ 32 bytes). */
  sessionSecret: Buffer;
}

export type AuthConfig = NoneAuthConfig | EntraAuthConfig;

export const ENTRA_REQUIRED_VARS = [
  "OSP_ENTRA_TENANT_ID",
  "OSP_ENTRA_CLIENT_ID",
  "OSP_ENTRA_CLIENT_SECRET",
  "OSP_PUBLIC_URL",
  "OSP_SESSION_SECRET",
] as const;

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_SESSION_SECRET_BYTES = 32;

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
}

/** Decode a base64 (or base64url) secret; null when it is not valid base64. */
function decodeBase64(raw: string): Buffer | null {
  const s = raw.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return null;
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function resolveAuthConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined>): AuthConfig {
  const mode = env.OSP_AUTH;
  if (!mode) {
    throw new AuthConfigError(
      "OSP_AUTH is not set — refusing to start (INCREMENT_39 §1: there is no " +
        "default, a forgotten setting must never silently deploy an open app). " +
        "Set OSP_AUTH=entra (Microsoft Entra ID sign-in) or OSP_AUTH=none " +
        "(no sign-in, everyone is a Planner — local single-user use only).",
    );
  }
  if (mode === "none") return { mode: "none" };
  if (mode !== "entra") {
    throw new AuthConfigError(
      `OSP_AUTH="${mode}" is not a known mode — refusing to start. Use "entra" or "none".`,
    );
  }

  const missing = ENTRA_REQUIRED_VARS.filter((k) => !env[k] || !env[k]!.trim());
  if (missing.length > 0) {
    throw new AuthConfigError(
      `OSP_AUTH=entra but required variable(s) are not set: ${missing.join(", ")} — refusing to start.`,
    );
  }

  const problems: string[] = [];
  const tenantId = env.OSP_ENTRA_TENANT_ID!.trim();
  const clientId = env.OSP_ENTRA_CLIENT_ID!.trim();
  if (!GUID_RE.test(tenantId)) problems.push("OSP_ENTRA_TENANT_ID must be a GUID");
  if (!GUID_RE.test(clientId)) problems.push("OSP_ENTRA_CLIENT_ID must be a GUID");

  let publicUrl = env.OSP_PUBLIC_URL!.trim();
  try {
    const u = new URL(publicUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      problems.push("OSP_PUBLIC_URL must be an http(s) URL");
    } else if (u.pathname !== "/" || u.search || u.hash) {
      problems.push("OSP_PUBLIC_URL must be a bare origin (no path, query or fragment)");
    }
    publicUrl = u.origin;
  } catch {
    problems.push("OSP_PUBLIC_URL is not a valid URL");
  }

  const secret = decodeBase64(env.OSP_SESSION_SECRET!);
  if (!secret || secret.length < MIN_SESSION_SECRET_BYTES) {
    // Never echo the value.
    problems.push(
      `OSP_SESSION_SECRET must be base64 of at least ${MIN_SESSION_SECRET_BYTES} random bytes ` +
        "(e.g. `openssl rand -base64 48`)",
    );
  }

  if (problems.length > 0) {
    throw new AuthConfigError(`OSP_AUTH=entra misconfigured — refusing to start: ${problems.join("; ")}.`);
  }

  return {
    mode: "entra",
    tenantId,
    clientId,
    clientSecret: env.OSP_ENTRA_CLIENT_SECRET!,
    publicUrl,
    sessionSecret: secret!,
  };
}
