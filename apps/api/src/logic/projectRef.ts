import type { Project } from "@osp/contracts";
import { parseOpId } from "@osp/op-client";

/**
 * Increment 40 (docs/INCREMENT_40_CONTRACTS.md §2.B1) — THE one resolver of a
 * ticket's OpenProject project. Every surface (backlog, items/detailed,
 * closure stats, freeze capture, both PDFs) obtains `{op_id, name,
 * identifier}` here; no surface keeps its own `Map(op_id → name)` (§0 pillar
 * 4). Pure — no I/O: callers load `repos.projects.list()` once per request.
 *
 * Identity is the project's `op_id`, scoped by connection (§0 pillar 2): a
 * numeric project id is unique only WITHIN one server, so the `project` row is
 * looked up by `${connection_id}:${op_id}` (`none:<id>` for legacy rows). Name
 * and identifier are display-only and never used as a key.
 *
 * Chain:
 *  1. `frozen` — the freeze-time snapshot (§0 pillar 3). When a caller passes
 *     it (only for a frozen sprint), it is returned AS-IS: neither the live
 *     cache nor the live `project` table is consulted, so a later rename,
 *     cache deletion or project-row deletion cannot move a frozen sprint
 *     (CAPACITY_BAR_RULES §6 invariant 10, extended).
 *  2. `wp` — the live cache row: op_id = `project_op_id` (0 → null), name =
 *     the connection-scoped project row's name falling back to the WP
 *     payload's `_links.project.title` (`project_name`), identifier = the
 *     project row's identifier. The row wins on name because it is refreshed
 *     on every sync run touching the project, while a cached WP title only
 *     moves when the TICKET changes (a project rename does not bump the WP's
 *     updatedAt, so incremental syncs never re-read it).
 *  3. `baselineRawJson` — the activation-time payload's `_links.project`
 *     (href → op_id, title → name), identifier via the same keyed lookup with
 *     `connectionId`.
 *  4. all null (renders `—`).
 */
export interface ProjectRef {
  op_id: number | null;
  name: string | null;
  identifier: string | null;
}

export interface ProjectRefInput {
  frozen?: { op_id: number | null; name: string | null; identifier: string | null } | null;
  wp?: { connection_id: number | null; project_op_id: number; project_name: string | null } | null;
  baselineRawJson?: string | null;
  connectionId?: number | null;
}

export interface ProjectResolver {
  resolve(input: ProjectRefInput): ProjectRef;
  /** The connection-scoped `project` row for `(connectionId, opId)`, with the
   * narrow legacy rule (connection-less ⇒ `none:<id>` row, else the UNIQUE
   * row carrying that op_id, else none). Exposed for callers that hold a
   * project op_id without a ticket (e.g. the version export link). */
  lookup(connectionId: number | null | undefined, opId: number | null | undefined): Project | null;
}

const EMPTY: ProjectRef = Object.freeze({ op_id: null, name: null, identifier: null });

/** `${connection_id}:${op_id}` — `none:<id>` for a legacy connection-less row.
 * Same format as `FilterOptionEntry.key` (Increment 23). */
export function projectKey(connectionId: number | null | undefined, opId: number): string {
  return `${connectionId ?? "none"}:${opId}`;
}

function positiveOpId(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

function nonEmpty(s: string | null | undefined): string | null {
  return typeof s === "string" && s.trim() !== "" ? s : null;
}

/** `_links.project {href,title}` of a stored WP payload; nulls on any parse
 * failure (a corrupt baseline never fails a read). */
export function projectLinkFromRawJson(
  rawJson: string | null | undefined,
): { op_id: number | null; title: string | null } {
  if (!rawJson) return { op_id: null, title: null };
  try {
    const parsed = JSON.parse(rawJson) as {
      _links?: { project?: { href?: string | null; title?: string | null } | null };
    } | null;
    const link = parsed?._links?.project;
    if (!link) return { op_id: null, title: null };
    return {
      op_id: positiveOpId(parseOpId(link.href ?? null)),
      title: nonEmpty(typeof link.title === "string" ? link.title : null),
    };
  } catch {
    return { op_id: null, title: null };
  }
}

export function createProjectResolver(projects: readonly Project[]): ProjectResolver {
  const byKey = new Map<string, Project>();
  const byOpId = new Map<number, Project[]>();
  for (const p of projects) {
    byKey.set(projectKey(p.connection_id, p.op_id), p);
    const list = byOpId.get(p.op_id);
    if (list) list.push(p);
    else byOpId.set(p.op_id, [p]);
  }

  function lookup(connectionId: number | null | undefined, opId: number | null | undefined): Project | null {
    const id = positiveOpId(opId);
    if (id == null) return null;
    if (connectionId != null) return byKey.get(projectKey(connectionId, id)) ?? null;
    // Legacy connection-less input: an explicit `none:<id>` row, else the
    // bare op_id ONLY when exactly one row carries it (ambiguity ⇒ none —
    // never guess across servers).
    const legacy = byKey.get(projectKey(null, id));
    if (legacy) return legacy;
    const candidates = byOpId.get(id) ?? [];
    return candidates.length === 1 ? candidates[0]! : null;
  }

  function resolve(input: ProjectRefInput): ProjectRef {
    if (input.frozen) {
      return {
        op_id: positiveOpId(input.frozen.op_id),
        name: nonEmpty(input.frozen.name),
        identifier: nonEmpty(input.frozen.identifier),
      };
    }
    if (input.wp) {
      const opId = positiveOpId(input.wp.project_op_id);
      if (opId != null) {
        const row = lookup(input.wp.connection_id, opId);
        return {
          op_id: opId,
          name: nonEmpty(row?.name) ?? nonEmpty(input.wp.project_name),
          identifier: nonEmpty(row?.identifier),
        };
      }
      // project_op_id 0 (no link on the payload): fall through to the baseline.
    }
    if (input.baselineRawJson) {
      const link = projectLinkFromRawJson(input.baselineRawJson);
      if (link.op_id != null || link.title != null) {
        const row = lookup(input.connectionId ?? input.wp?.connection_id ?? null, link.op_id);
        return {
          op_id: link.op_id,
          name: nonEmpty(row?.name) ?? link.title,
          identifier: nonEmpty(row?.identifier),
        };
      }
    }
    // A wp row with op_id 0 but a payload title still has a name to show.
    const wpName = nonEmpty(input.wp?.project_name);
    if (wpName) return { op_id: null, name: wpName, identifier: null };
    return { ...EMPTY };
  }

  return { resolve, lookup };
}

/** Display label per §1.2 for PDFs / the board: identifier → name → null. */
export function projectShortLabel(ref: ProjectRef): string | null {
  return ref.identifier ?? ref.name;
}

/** Stable connection-scoped key of a resolved ref (null when op_id unknown). */
export function projectRefKey(connectionId: number | null | undefined, ref: ProjectRef): string | null {
  return ref.op_id != null ? projectKey(connectionId, ref.op_id) : null;
}
