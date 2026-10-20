import type { OpStatus } from "./types";

/**
 * Increment 21 (SPEC_21 §3) — the ONE canonical status-name resolver, used
 * by EVERY writer of a persisted `status_name` (live sync AND journal-based
 * reconstruction). Root cause this fixes: two different code paths wrote
 * `status_name` with two different casings for the same logical status —
 * live sync from the work package's own `_links.status.title` (already
 * canonical), journal reconstruction from the LITERAL activity display text
 * (e.g. "in progress", lower-case as OP renders it) — producing duplicate
 * Status filter entries for the same status. `GET /api/v3/statuses` (name +
 * isClosed) is the single source of truth for both the correct NAME and its
 * CASING; this module resolves any raw string against it case-insensitively/
 * trimmed and returns the catalog's own canonical spelling.
 */

export interface StatusCatalog {
  /** Case-insensitive/trimmed lookup: `raw.trim().toLowerCase()` → the
   * catalog's own canonical `OpStatus`. */
  readonly byNormalizedName: ReadonlyMap<string, OpStatus>;
}

/** Build a lookup catalog from a live `GET /api/v3/statuses` collection (or
 * an already-fetched `Map<id, OpStatus>`, e.g. the `statusById` map every
 * existing call site already builds — see `toStatusList`). First-wins on a
 * duplicate normalized name (shouldn't happen in real OP data; defensive). */
export function buildStatusCatalog(statuses: Iterable<OpStatus>): StatusCatalog {
  const byNormalizedName = new Map<string, OpStatus>();
  for (const s of statuses) {
    const key = s.name.trim().toLowerCase();
    if (!byNormalizedName.has(key)) byNormalizedName.set(key, s);
  }
  return { byNormalizedName };
}

/** Convenience: build a catalog directly from the `Map<id, OpStatus>` shape
 * every existing caller (`loadStatusClosedMap`, `retro.ts`'s `loadStatusMap`)
 * already has on hand — avoids every call site re-deriving `.values()`. */
export function statusCatalogFromById(statusById: ReadonlyMap<number, OpStatus>): StatusCatalog {
  return buildStatusCatalog(statusById.values());
}

export interface NormalizedStatus {
  /** The catalog's canonical spelling when `raw` matched (case-insensitively/
   * trimmed) a known status; otherwise `raw` UNCHANGED (SPEC_21 §7 decision
   * 2 — "neznámý stav → ponechat + označit, nezahazovat": an unrecognized
   * status is preserved verbatim, never dropped or blanked). */
  name: string;
  /** False when `raw` matched no catalog entry — the caller SHOULD log a
   * warning ("mark") when this is false; there is no separate persisted/API
   * flag for it (SPEC_21 doesn't ask for one) — this return value IS the
   * mark, for whichever caller wants to surface it. */
  recognized: boolean;
}

/** Resolve `raw` to its canonical catalog spelling, case-insensitively and
 * trimmed. An empty/whitespace-only `raw` is returned unchanged (`recognized:
 * false` — nothing to look up). */
export function normalizeStatusName(raw: string, catalog: StatusCatalog): NormalizedStatus {
  const trimmed = raw.trim();
  if (trimmed === "") return { name: raw, recognized: false };
  const match = catalog.byNormalizedName.get(trimmed.toLowerCase());
  return match ? { name: match.name, recognized: true } : { name: raw, recognized: false };
}

/**
 * The ONE shared status-name comparator (Consolidation Round, Concept 3): two
 * status names are "the same status" when they match trimmed + case-folded —
 * the exact `trim().toLowerCase()` normalization the catalog keys by and that
 * ~8 sites across the app already hand-roll inline. Use this instead of a raw
 * `===` (the Increment-21 casing-divergence bug pattern) or a fresh inline
 * `trim().toLowerCase()` everywhere a persisted `status_name` is compared.
 */
export function statusNamesEqual(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
