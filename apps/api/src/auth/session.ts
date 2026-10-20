import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Increment 39 (docs/INCREMENT_39_CONTRACTS.md §2) — stateless encrypted
 * cookies. AES-256-GCM with a per-purpose key derived from OSP_SESSION_SECRET
 * via HKDF-SHA256, so an `osp_login` value can never be replayed as an
 * `osp_session` (different key → authentication tag fails).
 *
 * Wire format: base64url( iv[12] ‖ tag[16] ‖ ciphertext ). The plaintext is
 * JSON that MUST carry a numeric `exp` (epoch seconds); `open()` rejects
 * anything tampered, malformed or expired by returning null — never throws.
 */

export const SESSION_COOKIE = "osp_session";
export const LOGIN_COOKIE = "osp_login";
/** §2: absolute session lifetime. */
export const SESSION_TTL_SECONDS = 8 * 60 * 60;
/** §2: pending-login lifetime. */
export const LOGIN_TTL_SECONDS = 10 * 60;

export type CookiePurpose = typeof SESSION_COOKIE | typeof LOGIN_COOKIE;

const IV_BYTES = 12;
const TAG_BYTES = 16;
const HKDF_SALT = Buffer.from("opaltakt/osp-cookie/v1");

export interface SealedCodec<T extends { exp: number }> {
  seal(payload: T): string;
  open(token: string | undefined | null): T | null;
}

export function deriveCookieKey(secret: Buffer, purpose: CookiePurpose): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, HKDF_SALT, `aes-256-gcm:${purpose}`, 32));
}

export function createSealedCodec<T extends { exp: number }>(
  secret: Buffer,
  purpose: CookiePurpose,
  nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
): SealedCodec<T> {
  const key = deriveCookieKey(secret, purpose);
  const aad = Buffer.from(purpose);
  return {
    seal(payload) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(aad);
      const ct = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64url");
    },
    open(token) {
      if (!token || typeof token !== "string") return null;
      try {
        const buf = Buffer.from(token, "base64url");
        if (buf.length <= IV_BYTES + TAG_BYTES) return null;
        const iv = buf.subarray(0, IV_BYTES);
        const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
        const ct = buf.subarray(IV_BYTES + TAG_BYTES);
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAAD(aad);
        decipher.setAuthTag(tag);
        const pt = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
        const parsed = JSON.parse(pt) as T;
        if (typeof parsed !== "object" || parsed === null) return null;
        if (typeof parsed.exp !== "number" || !Number.isFinite(parsed.exp)) return null;
        if (parsed.exp <= nowSeconds()) return null;
        return parsed;
      } catch {
        return null;
      }
    },
  };
}

/** §2 session content. */
export interface SessionPayload {
  sub: string;
  oid: string | null;
  name: string;
  email: string | null;
  roles: string[];
  exp: number;
}

/** §2 pending-login content (state, nonce, PKCE verifier, return path). */
export interface LoginPayload {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  exp: number;
}
