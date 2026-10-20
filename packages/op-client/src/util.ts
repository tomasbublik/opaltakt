/**
 * Small pure helpers shared by the client and (re-exported) by @osp/sync.
 * No I/O here — parsing OP HAL values into the plain shapes the cache uses.
 */

/**
 * Parse an ISO-8601 duration (as OpenProject emits for estimatedTime /
 * remainingTime / spentTime / time-entry hours) into a number of hours.
 *
 * Handles weeks/days/hours/minutes/seconds, e.g. "PT8H", "PT2H30M",
 * "PT0H", "P1DT4H", "PT45M". Days are treated as 24h and weeks as 168h per
 * the ISO-8601 calendar convention. Returns null for null/empty/invalid input.
 */
export function parseIsoDuration(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const m =
    /^P(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
      value,
    );
  if (m === null) return null;
  const [, w, d, h, min, s] = m;
  // A bare "P" (no components) is invalid.
  if (w === undefined && d === undefined && h === undefined && min === undefined && s === undefined) {
    return null;
  }
  const hours =
    (w ? Number(w) * 168 : 0) +
    (d ? Number(d) * 24 : 0) +
    (h ? Number(h) : 0) +
    (min ? Number(min) / 60 : 0) +
    (s ? Number(s) / 3600 : 0);
  return hours;
}

/**
 * Extract the trailing numeric id from an OpenProject HAL href, e.g.
 * "/api/v3/projects/3" → 3, "/api/v3/work_packages/1001" → 1001.
 * Returns null for null/absent/non-numeric hrefs.
 */
export function parseOpId(href: string | null | undefined): number | null {
  if (href === null || href === undefined || href === "") return null;
  const m = /\/(\d+)(?:\?.*)?$/.exec(href);
  if (m === null) return null;
  return Number(m[1]);
}
