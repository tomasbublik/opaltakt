/** Presentation helpers shared across screens. Pure + unit-tested. */

/** Format a nullable hours value as e.g. "8h", "6.5h", or an em dash when unknown. */
export function formatHours(h: number | null | undefined): string {
  if (h === null || h === undefined || Number.isNaN(h)) return "—";
  return `${Number.isInteger(h) ? h : Number(h.toFixed(1))}h`;
}

/** Human "X min ago" style label for a last-synced timestamp. */
export function relativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "never";
  const diffMs = now.getTime() - then;
  if (diffMs < 0) return "just now";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} d ago`;
}

/** Format a numeric percentage (0..100) or em dash. */
export function formatPct(p: number | null | undefined): string {
  if (p === null || p === undefined || Number.isNaN(p)) return "—";
  return `${Math.round(p)}%`;
}

/**
 * Increment 16 (SPEC_16 §2) — an hours value with the sign ALWAYS explicit:
 * "+19h" (gained), "−6h" (lost, proper minus sign U+2212 per SPEC_16's own
 * examples), "0h" (no net change, no sign). Used for the capacity bar's
 * signed "±scope change" number — never for a plain non-signed hours value
 * (use `formatHours` for those).
 */
export function formatSignedHours(h: number | null | undefined): string {
  if (h === null || h === undefined || Number.isNaN(h)) return "—";
  if (h === 0) return formatHours(0);
  const sign = h > 0 ? "+" : "−";
  return `${sign}${formatHours(Math.abs(h))}`;
}

/**
 * Increment 16 (SPEC_16 §4) — British date format DD/MM/YYYY, from an ISO
 * date (`YYYY-MM-DD`) or ISO datetime string. Parses the leading
 * YYYY-MM-DD digits directly rather than round-tripping through `Date`
 * (which would apply the browser's local-timezone offset to a date-only
 * value and could shift the displayed day — the same real-clock-vs-
 * scenario-calendar class of bug this codebase has hit before).
 */
export function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return "—";
  const [, y, mo, d] = m;
  return `${d}/${mo}/${y}`;
}

/**
 * SPEC_11 §3/#6: statuses whose work already moved past "in progress" —
 * ticket rows/cards for these should visually recede (reduced opacity) so
 * New/Confirmed/In progress stand out as what still needs attention. Case-
 * insensitive because OP status names can vary in casing across servers.
 */
const DIMMED_STATUS_NAMES = new Set(["developed", "tested", "resolved"]);

export function isDimmedStatus(statusName: string | null | undefined): boolean {
  return statusName != null && DIMMED_STATUS_NAMES.has(statusName.toLowerCase());
}
