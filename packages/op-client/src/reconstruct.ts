import { parseDetail, parseHoursLabel } from "./journal";
import { normalizeStatusName, statusCatalogFromById } from "./statusCatalog";
import type { OpActivity, OpStatus } from "./types";

/**
 * SPEC_12 §1/§3/§4 — the reconstruction engine.
 *
 * THE CORE PRINCIPLE (SPEC_12 §1): a work package's state at any past date D is
 * NOT simulated — it is COMPUTED as a deterministic fold over the ticket's real
 * OpenProject journal. Every activity's `details[]` records "Field set to X"
 * (v1's initial values) or "Field changed from X to Y" WITH a timestamp
 * (`createdAt`). Sort the activities chronologically, apply every recognized
 * field change with `createdAt <= D`, and the last value each field lands on IS
 * its value on day D. Burndown history therefore doesn't need a nightly
 * snapshot job to be recoverable — it can be recalculated from journals.
 *
 * HONESTY OVER GUESSING (SPEC_12 §4 — "Nikdy tiše nehádat"): a field with ZERO
 * journal coverage up to D cannot be reconstructed. Rather than silently
 * inventing a value, it falls back to the caller-supplied `fallback` AND is
 * listed by name in `gaps`, so a retro seed can be honestly flagged "partially
 * reconstructed" instead of quietly wrong.
 *
 * This module is PURE (no I/O). It reuses journal.ts's `parseDetail`
 * primitive — it does NOT re-implement the html/raw parsing.
 */

/** The six reconstructable fields of a work package's state on a past date. */
export interface ReconstructedWpState {
  status_name: string | null;
  assignee_name: string | null;
  assignee_op_id: number | null;
  estimated_hours: number | null;
  remaining_hours: number | null;
  version_name: string | null;
  /**
   * Field names (of the 6 above) that had ZERO journal coverage up to the
   * target date and fell back to the provided `fallback` value instead —
   * e.g. ["estimated_hours"]. Empty array when every field reconstructed
   * cleanly from journal data. NEVER silently omit a gap — see SPEC_12 §4:
   * "Nikdy tiše nehádat."
   *
   * NOTE on `assignee_op_id`: OpenProject journal text carries the assignee's
   * DISPLAY NAME (`<i>Cameron Dalby</i>`) but never a numeric id, so the id
   * itself is never journal-derivable. It is treated at the "assignee" concept
   * level: it always comes from `fallback` (the caller resolves name → id via
   * enrichment), and is flagged in `gaps` ONLY when the assignee concept had no
   * journal coverage at all (i.e. `assignee_name` is also a gap). This keeps
   * `gaps` meaningful — it flags genuinely-unknown state, not the structural
   * fact that ids live outside journals.
   */
  gaps: string[];
  /** NEW (Inc 13): true when the WP's OWN creation activity (its earliest
   * activity by createdAt — assume the activities array, once fully paginated,
   * starts from v1) is AFTER targetDate — the ticket did not exist yet. Every
   * field above is fallback data ONLY in this case and must not be treated as
   * a real (even partially-gapped) baseline by callers — route it as a scope
   * addition at its actual creation date instead (Agent B's job, mirroring
   * the existing version-scope-churn mechanism from Increment 12). */
  not_yet_created: boolean;
  /** The ticket's actual creation moment (earliest activity's createdAt),
   * when the activities array is non-empty — present regardless of
   * not_yet_created's value, purely informational. Null for an empty
   * activities array (nothing to derive a creation date from). */
  created_at: string | null;
}

/** Caller-supplied values used for any field the journal can't reconstruct. */
export interface ReconstructFallback {
  status_name: string | null;
  assignee_name: string | null;
  assignee_op_id: number | null;
  estimated_hours: number | null;
  remaining_hours: number | null;
  version_name: string | null;
}

/** ms-since-epoch for an ISO datetime; NaN for an unparseable value. */
function toMs(iso: string): number {
  return Date.parse(iso);
}

/** Chronological (ascending `createdAt`) copy — never mutates the input. */
function sortByCreatedAt(activities: OpActivity[]): OpActivity[] {
  return [...activities].sort((a, b) => toMs(a.createdAt) - toMs(b.createdAt));
}

/**
 * Reconstruct a work package's field state as of `targetDate` (inclusive) from
 * its full activity history. `activities` may be in any order — sorted
 * internally by `createdAt`. Walks every activity's `details[]` (via
 * journal.ts's shared `parseDetail`) applying each recognized field change
 * (Status/Assignee/Work/Remaining work/Version) up to AND INCLUDING
 * `targetDate`. A field with NO matching event by that date uses `fallback`'s
 * value AND is listed in `gaps`.
 *
 * `statusById` IS now consulted for the reconstructed `status_name` (Increment
 * 21 / SPEC_21). The journal only carries the LITERAL activity display text
 * (e.g. "in progress", lower-case as OP renders it), whereas live sync writes
 * the work package's own canonical `_links.status.title` ("In progress") — two
 * casings for the same logical status, which produced duplicate Status filter
 * entries. Every parsed `Status` transition's `to` text is therefore resolved
 * through `normalizeStatusName` against a catalog built once from `statusById`,
 * so the reconstructed value carries OP's canonical spelling. This SUPERSEDES
 * the earlier SPEC_12 §11 decision to keep the literal journal name verbatim —
 * done deliberately here on SPEC_21's explicit authority. An unrecognized
 * status (matching no catalog entry) is kept UNCHANGED, never dropped or
 * blanked (SPEC_21 §7 decision 2), and surfaced via a `console.warn` "mark".
 */
export function stateAtDate(
  activities: OpActivity[],
  statusById: Map<number, OpStatus>,
  targetDate: string,
  fallback: ReconstructFallback,
  /**
   * The WP's OWN authoritative creation timestamp (its HAL resource's
   * `createdAt`), when known. OPTIONAL for backward compatibility, but callers
   * SHOULD always pass it: journals only record CHANGES, never the WP's birth
   * (no "v1: Assignee set to X" entry survives in most real/mock activity
   * feeds), so a ticket that existed at `targetDate` but was never touched
   * before it would otherwise have ZERO activities up to that point — and
   * "zero activity coverage" is NOT evidence the ticket didn't exist yet. Using
   * the WP's real `createdAt` as an additional "earliest known existence"
   * signal (alongside the earliest activity) fixes exactly that false
   * positive without weakening the check for a genuinely-later-created ticket
   * (SPEC_12 §4 "honesty over guessing" cuts both ways — don't guess
   * non-existence any more than you'd guess a value).
   */
  wpCreatedAt?: string | null,
): ReconstructedWpState {
  // Built ONCE per call (not per activity/event): the canonical status catalog
  // used to resolve every journal Status transition below (Increment 21).
  const statusCatalog = statusCatalogFromById(statusById);
  const targetMs = toMs(targetDate);
  const sorted = sortByCreatedAt(activities);

  // The ticket's creation moment = its earliest activity's createdAt (v1, once
  // the history is fully paginated). `not_yet_created` is a SEPARATE, stronger
  // signal than `gaps` (SPEC_13 §2): when creation is AFTER the target date the
  // ticket simply did not exist yet, so every field below is fallback noise —
  // callers must route it as a scope addition at `created_at`, NOT as a
  // (partially-gapped) baseline. `gaps` stays exactly as useful for the NORMAL
  // case (ticket existed; some individual fields just weren't journaled).
  const createdAt = sorted.length > 0 ? sorted[0]!.createdAt : null;
  // "Earliest known existence" = the earlier of (a) the first journaled
  // activity and (b) the WP's own createdAt, when supplied. `created_at`
  // (the informational field below) stays activity-based, unchanged, so
  // existing callers that assert its exact value see no behavior change —
  // only the not_yet_created THRESHOLD gains the extra signal.
  const earliestExistenceMs =
    wpCreatedAt != null
      ? createdAt !== null
        ? Math.min(toMs(wpCreatedAt), toMs(createdAt))
        : toMs(wpCreatedAt)
      : createdAt !== null
        ? toMs(createdAt)
        : null;
  const notYetCreated = earliestExistenceMs !== null && earliestExistenceMs > targetMs;

  // Per-field reconstructed value + "did any journal event touch this field?".
  let statusName: string | null = null;
  let assigneeName: string | null = null;
  let estimatedHours: number | null = null;
  let remainingHours: number | null = null;
  let versionName: string | null = null;
  let sawStatus = false;
  let sawAssignee = false;
  let sawEstimate = false;
  let sawRemaining = false;
  let sawVersion = false;

  for (const activity of sorted) {
    // Inclusive: an activity exactly AT targetDate still applies. Ascending
    // order lets us stop at the first activity past the target.
    if (toMs(activity.createdAt) > targetMs) break;
    for (const detail of activity.details) {
      const parsed = parseDetail(detail);
      if (parsed === null) continue;
      switch (parsed.field) {
        case "Status": {
          // Canonicalize the LITERAL journal casing ("in progress") to OP's own
          // spelling ("In progress") so reconstruction and live sync agree
          // (Increment 21). `parsed.to` is null only for a cleared/odd Status
          // detail — keep that as-is (nothing to normalize).
          if (parsed.to === null) {
            statusName = null;
          } else {
            const normalized = normalizeStatusName(parsed.to, statusCatalog);
            if (!normalized.recognized) {
              // SPEC_21 §7 decision 2: keep the unknown status, don't discard —
              // just "mark" it so it's discoverable. This module is pure (no
              // I/O); a one-line warning is a low-risk way to surface it without
              // changing the return shape.
              const wpHref = activity._links.workPackage.href ?? "unknown WP";
              console.warn(
                `[reconstruct] unrecognized status "${parsed.to}" (${wpHref}) — not in status catalog; kept verbatim`,
              );
            }
            statusName = normalized.name;
          }
          sawStatus = true;
          break;
        }
        case "Assignee":
          // `to` is null for an "unassigned"/cleared event — a real value,
          // NOT a gap (we DID observe the change).
          assigneeName = parsed.to;
          sawAssignee = true;
          break;
        case "Work":
          estimatedHours = parseHoursLabel(parsed.to);
          sawEstimate = true;
          break;
        case "Remaining work":
          remainingHours = parseHoursLabel(parsed.to);
          sawRemaining = true;
          break;
        case "Version":
          versionName = parsed.to;
          sawVersion = true;
          break;
        default:
          break; // every other field is irrelevant to reconstructed state
      }
    }
  }

  const gaps: string[] = [];
  // A field either keeps its journal-reconstructed value, or falls back AND is
  // named in `gaps`. Order below is the stable, documented gap order.
  if (!sawStatus) gaps.push("status_name");
  if (!sawAssignee) gaps.push("assignee_name");
  // op_id is never in journal text — always from fallback; flagged as a gap
  // only when the assignee concept itself had no coverage (see interface doc).
  if (!sawAssignee) gaps.push("assignee_op_id");
  if (!sawEstimate) gaps.push("estimated_hours");
  if (!sawRemaining) gaps.push("remaining_hours");
  if (!sawVersion) gaps.push("version_name");

  return {
    status_name: sawStatus ? statusName : fallback.status_name,
    assignee_name: sawAssignee ? assigneeName : fallback.assignee_name,
    assignee_op_id: fallback.assignee_op_id,
    estimated_hours: sawEstimate ? estimatedHours : fallback.estimated_hours,
    remaining_hours: sawRemaining ? remainingHours : fallback.remaining_hours,
    version_name: sawVersion ? versionName : fallback.version_name,
    gaps,
    not_yet_created: notYetCreated,
    created_at: createdAt,
  };
}

/** A version_changed transition into or out of a target sprint version. */
export interface VersionScopeEvent {
  occurred_at: string; // ISO datetime (the activity's createdAt)
  direction: "entered" | "left";
}

/**
 * SPEC_12 §3 — version-based scope-churn detection.
 *
 * Since a sprint maps 1:1 to an OP version (`Sprint 3.5.039` ↔ version
 * `3.5.039`), a WP's `Version changed …` journal events tell you exactly when
 * it entered or left the sprint's scope retrospectively:
 *   - a change whose NEW value becomes `targetVersionName` → "entered" (Agent
 *     B's mid-sprint-added / red segment, `added_at` = the event's date);
 *   - a change whose OLD value was `targetVersionName` and new value isn't →
 *     "left" (Agent B's removed / blue segment).
 *
 * The INITIAL "Version set to …" entry (v1, `from === null`) establishes the
 * baseline and is NEVER an event: a ticket that already carried the target
 * version at creation and never changed it is baseline, not churn (so this
 * returns []). Only genuine "changed from X to Y" transitions emit events.
 * Returns [] when the WP's version never touches `targetVersionName`.
 */
export function versionScopeEvents(
  activities: OpActivity[],
  targetVersionName: string,
): VersionScopeEvent[] {
  const events: VersionScopeEvent[] = [];
  for (const activity of sortByCreatedAt(activities)) {
    for (const detail of activity.details) {
      const parsed = parseDetail(detail);
      if (parsed === null || parsed.field !== "Version") continue;
      // Initial "set to" (from === null) is baseline establishment, not churn.
      if (parsed.from === null) continue;
      const wasTarget = parsed.from === targetVersionName;
      const isTarget = parsed.to === targetVersionName;
      if (!wasTarget && isTarget) {
        events.push({ occurred_at: activity.createdAt, direction: "entered" });
      } else if (wasTarget && !isTarget) {
        events.push({ occurred_at: activity.createdAt, direction: "left" });
      }
    }
  }
  return events;
}
