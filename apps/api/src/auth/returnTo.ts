/**
 * Increment 39 §4 — open-redirect protection for `?returnTo=`.
 *
 * Only a same-origin RELATIVE path survives (`/…`); anything else — absolute
 * URLs, protocol-relative `//host`, backslash tricks (`/\host`, which browsers
 * normalise to `//host`), control characters, non-strings — collapses to `/`.
 * The result is re-serialised from a URL parse against a sentinel origin, so
 * what we emit is exactly what a browser would resolve to on our own origin.
 */
const SENTINEL = "http://returnto.invalid";
const MAX_LEN = 2048;

export function sanitizeReturnTo(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_LEN) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return "/";
  try {
    const u = new URL(raw, SENTINEL);
    if (u.origin !== SENTINEL) return "/";
    const out = `${u.pathname}${u.search}${u.hash}`;
    if (!out.startsWith("/") || out.startsWith("//")) return "/";
    return out;
  } catch {
    return "/";
  }
}
