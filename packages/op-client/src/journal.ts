import type { ChangelogDetail, ChangelogKind } from "@osp/contracts";
import type { OpActivity, OpActivityDetail, OpStatus } from "./types";

/**
 * SPEC_11 §5 — OP activity → changelog-draft derivation, rewritten against the
 * REAL production activity shape (fixture_op_activities_11762).
 *
 * WHAT CHANGED FROM THE INCREMENT-10 VERSION (and WHY it was broken):
 *   - The old `OpActivityDetail` was `{ property, old, new }` — a shape that
 *     DOES NOT EXIST in real OpenProject responses (it was written
 *     speculatively and never validated against production). Real `details[]`
 *     entries are `{ format, raw, html }` formatted-TEXT strings. Switching on
 *     `detail.property` therefore read `undefined` for EVERY real detail — the
 *     confirmed root cause of the historical `unrecognized property "undefined"`
 *     bug and of assignee/status changes silently vanishing from #11762.
 *   - `deriveDetailEvents` now PARSES the `html` (falling back to `raw`) to
 *     recover the field name (`<strong>…</strong>`) and its from/to values
 *     (`changed from <i>…</i> to <i>…</i>` / `set to <i>…</i>`, and the
 *     tag-less/`Description set (…)` variants).
 *
 * POLICY REVERSAL (SPEC_11 §5 point 4 + §12 point 5): an UNRECOGNIZED field
 * (Type, Project, Subject, Priority, Start date, % Complete, custom fields like
 * Risk Level / Found In Release, …) is NO LONGER silently dropped. It now
 * produces a generic `{ kind: "other", note: <readable text from raw> }` row so
 * nothing is lost from the history — never `undefined`, never an empty row.
 * (This intentionally reverses Increment 10's WHITELIST-AND-SKIP decision.)
 *
 * STILL TRUE: this function is PURE (no I/O, no async). Actor-name resolution
 * (real OP omits `_links.user.title`) is deliberately NOT its job — the caller
 * resolves names via GET /api/v3/users/:id (SPEC_11 §4).
 *
 * The caller (apps/api's persistScopedPass) turns each draft into one
 * ticket_changelog_entry, sharing the activity-level occurred_at/actor/
 * op_journal_id but a DISTINCT dedup_key per draft, built as
 * `journal:${activity.id}:${dedupSuffix}`.
 */

export interface ChangelogEventDraft {
  kind: ChangelogKind;
  detail: ChangelogDetail;
  /** Combine with the activity id for a full dedup_key: `journal:<activityId>:<dedupSuffix>`. */
  dedupSuffix: string;
}

/**
 * One parsed detail: the field's display name and its from/to values (text).
 * Exported so the reconstruction engine (reconstruct.ts) can fold the SAME
 * parsed events over time without duplicating the html/raw regexes here
 * (SPEC_12 §1 — "reuse the primitive, don't copy-paste the parser").
 */
export interface ParsedDetail {
  field: string;
  /** null when the activity only records a "set to" (no previous value). */
  from: string | null;
  /** null when the field was cleared / had no meaningful target text. */
  to: string | null;
}

/** Strip HTML tags and collapse whitespace to a plain-text string. */
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

/** Decode the handful of HTML entities OP emits in field/value text. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

/**
 * Parse ONE `{format, raw, html}` detail into `{field, from, to}`.
 *
 * Prefers `html` (field names have spaces — "Remaining work", "Found In
 * Release" — so <strong>/<i> boundaries are more reliable than word-splitting
 * `raw`), then falls back to `raw`-shaped regexes on the tag-stripped text for
 * the variants OP renders WITHOUT `<i>` wrappers (e.g. "Scheduling mode set to
 * Manual"). Returns null only when no field name can be recovered at all.
 */
export function parseDetail(detail: OpActivityDetail): ParsedDetail | null {
  const html = detail.html ?? "";
  const raw = detail.raw ?? "";

  const strongMatch = /<strong>([\s\S]*?)<\/strong>/.exec(html);
  const field = strongMatch ? decodeEntities(stripTags(strongMatch[1]!)) : null;

  // 1) html "changed from <i>FROM</i> to <i>TO</i>"
  const changedI = /changed from <i>([\s\S]*?)<\/i> to <i>([\s\S]*?)<\/i>/.exec(html);
  if (changedI && field !== null) {
    return { field, from: decodeEntities(changedI[1]!), to: decodeEntities(changedI[2]!) };
  }
  // 2) html "set to <i>TO</i>"
  const setI = /set to <i>([\s\S]*?)<\/i>/.exec(html);
  if (setI && field !== null) {
    return { field, from: null, to: decodeEntities(setI[1]!) };
  }

  // 3) tag-less variants: work from the plain text (html stripped, else raw).
  const text = stripTags(html) || raw;
  const changedTxt = /^(.+?) changed from (.+?) to (.+)$/.exec(text);
  if (changedTxt) {
    return {
      field: field ?? decodeEntities(changedTxt[1]!.trim()),
      from: decodeEntities(changedTxt[2]!.trim()),
      to: decodeEntities(changedTxt[3]!.trim()),
    };
  }
  const setTxt = /^(.+?) set to (.+)$/.exec(text);
  if (setTxt) {
    return {
      field: field ?? decodeEntities(setTxt[1]!.trim()),
      from: null,
      to: decodeEntities(setTxt[2]!.trim()),
    };
  }

  // 4) e.g. "Description set (Details)" (a diff link, no from/to text) or a
  //    field-cleared/"deleted" note: keep the field, no meaningful values.
  if (field !== null) return { field, from: null, to: null };
  return null;
}

/**
 * Parse an OP effort label ("12h", "1.5h", "1h 30m", or a bare number) into
 * hours. These are NOT ISO-8601 durations, so parseIsoDuration can't read them.
 * Returns null (never throws) when nothing numeric can be recovered.
 */
export function parseHoursLabel(label: string | null | undefined): number | null {
  if (label === null || label === undefined) return null;
  const t = label.trim();
  if (t === "") return null;
  const hMatch = /(\d+(?:\.\d+)?)\s*h/i.exec(t);
  const mMatch = /(\d+(?:\.\d+)?)\s*m(?:in)?\b/i.exec(t);
  if (hMatch || mMatch) {
    const h = hMatch ? Number(hMatch[1]) : 0;
    const m = mMatch ? Number(mMatch[1]) : 0;
    return h + m / 60;
  }
  const plain = /^\d+(?:\.\d+)?$/.exec(t);
  return plain ? Number(t) : null;
}

/** Build a name-keyed (trimmed + lowercased) status lookup from an id-keyed map. */
function statusNameLookup(statusById: Map<number, OpStatus>): Map<string, OpStatus> {
  const byName = new Map<string, OpStatus>();
  for (const status of statusById.values()) {
    byName.set(status.name.trim().toLowerCase(), status);
  }
  return byName;
}

/** Is a status DISPLAY NAME (case/space-insensitive) a closed status? undefined = unknown. */
function isClosedName(byName: Map<string, OpStatus>, name: string | null): boolean | undefined {
  if (name === null) return undefined;
  return byName.get(name.trim().toLowerCase())?.isClosed;
}

/** Slugify a field name for a stable, collision-free per-detail dedup suffix. */
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "field";
}

/** Human-readable note for a generic `other` row (never `undefined`/empty). */
function otherNote(parsed: ParsedDetail, raw: string): string {
  const r = raw.trim();
  // "Description set (…diff link…)" and field-cleared notes → clean generic text.
  if (parsed.from === null && parsed.to === null) return `${parsed.field} updated`;
  if (r !== "") return r;
  if (parsed.from !== null && parsed.to !== null) {
    return `${parsed.field} changed from ${parsed.from} to ${parsed.to}`;
  }
  if (parsed.to !== null) return `${parsed.field} set to ${parsed.to}`;
  return `${parsed.field} updated`;
}

/**
 * One detail → 0 or more drafts. Known fields map to their typed kind (a status
 * transition INTO a closed status also emits a `closed` companion); everything
 * else becomes a generic `other` row carrying readable text (SPEC_11 §5 p4).
 * Never throws.
 */
function deriveDetailEvents(
  detail: OpActivityDetail,
  statusById: Map<number, OpStatus>,
): ChangelogEventDraft[] {
  const parsed = parseDetail(detail);
  if (parsed === null) {
    // Truly unparseable (no field name at all) — still surface the raw text so
    // nothing is lost, rather than dropping it or emitting `undefined`.
    const note = (detail.raw ?? "").trim();
    if (note === "") return [];
    return [{ kind: "other", detail: { kind: "other", note }, dedupSuffix: "other" }];
  }

  const { field, from, to } = parsed;

  switch (field) {
    case "Status": {
      const events: ChangelogEventDraft[] = [
        {
          kind: "status_changed",
          detail: { kind: "status_changed", from: from ?? "", to: to ?? "" },
          dedupSuffix: "status_changed",
        },
      ];
      // "closed" companion — check the TO status DISPLAY NAME against a
      // name-keyed lookup (real details carry no status id). Only when the
      // transition is INTO closed (from wasn't already closed). Unknown name →
      // skip silently, never throw.
      const byName = statusNameLookup(statusById);
      if (isClosedName(byName, to) === true && isClosedName(byName, from) !== true) {
        events.push({
          kind: "closed",
          detail: { kind: "closed", status: to ?? "" },
          dedupSuffix: "closed",
        });
      }
      return events;
    }
    case "Assignee":
      return [
        {
          kind: "assignee_changed",
          detail: { kind: "assignee_changed", from, to },
          dedupSuffix: "assignee_changed",
        },
      ];
    case "Accountable":
      return [
        {
          kind: "accountable_changed",
          detail: { kind: "accountable_changed", from, to },
          dedupSuffix: "accountable_changed",
        },
      ];
    case "Work":
      return [
        {
          kind: "estimate_changed",
          detail: {
            kind: "estimate_changed",
            from: parseHoursLabel(from),
            to: parseHoursLabel(to),
          },
          dedupSuffix: "estimate_changed",
        },
      ];
    case "Remaining work":
      return [
        {
          kind: "remaining_changed",
          detail: {
            kind: "remaining_changed",
            from: parseHoursLabel(from),
            to: parseHoursLabel(to),
          },
          dedupSuffix: "remaining_changed",
        },
      ];
    case "Version":
      return [
        {
          kind: "version_changed",
          detail: { kind: "version_changed", from, to },
          dedupSuffix: "version_changed",
        },
      ];
    default:
      // Unrecognized field (SPEC_11 §5 p4 / §12 p5): a generic, readable row —
      // NEVER silently dropped, NEVER `undefined`. Field-slugged suffix keeps
      // several unknown fields on ONE activity from colliding on dedup_key.
      return [
        {
          kind: "other",
          detail: { kind: "other", note: otherNote(parsed, detail.raw ?? "") },
          dedupSuffix: `other:${slug(field)}`,
        },
      ];
  }
}

/**
 * Derive every changelog draft for ONE OP activity: every `details[]` entry (in
 * order — status_changed can carry its own trailing "closed" companion), THEN a
 * `comment_added` draft when the activity carries non-empty comment text (real
 * OP puts `comment.raw:""` on pure field-change activities). Order matters for
 * display (field changes before the comment) even though all drafts share the
 * same `occurred_at`.
 */
export function deriveChangelogEvents(
  activity: OpActivity,
  statusById: Map<number, OpStatus>,
): ChangelogEventDraft[] {
  const events: ChangelogEventDraft[] = [];
  for (const detail of activity.details) {
    events.push(...deriveDetailEvents(detail, statusById));
  }
  if (activity.comment !== null && (activity.comment.raw ?? "").trim() !== "") {
    events.push({ kind: "comment_added", detail: { kind: "comment_added" }, dedupSuffix: "comment" });
  }
  return events;
}
