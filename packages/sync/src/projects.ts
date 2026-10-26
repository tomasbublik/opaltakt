import type { OpId } from "@osp/contracts";
import type { NewProject, ProjectRepository } from "@osp/db";
import type { OpClient } from "@osp/op-client";
import { isOpCancelledError, withHardCancel } from "@osp/op-client";

/**
 * Increment 40 (docs/INCREMENT_40_CONTRACTS.md §2.A3) — keep the `project`
 * table's identifier/name fresh for every project a cache write touched.
 *
 * `work_package_cache.project_name` comes straight from each WP payload
 * (`_links.project.title`), so the project NAME never depends on this. What
 * only `GET /api/v3/projects/{id}` supplies is the IDENTIFIER (the short slug
 * from the browser URL). This refresh is therefore pure decoration and is
 * BEST-EFFORT by contract:
 *
 *  - one GET per DISTINCT project op id (GET-only, through op-client);
 *  - a 403/404/timeout/any error for one project is reported via `onSkip`
 *    and skipped — the others still refresh, and the call NEVER throws
 *    (a DB write failure is likewise reported and swallowed);
 *  - `signal` aborts the remaining work (stops quietly, `cancelled: true`);
 *  - `connectionId === null` is a NO-OP: a project op id is unique only within
 *    one server (pillar 2), so a row without its connection would be a
 *    collision-unsafe write. The connection-agnostic engine paths leave the
 *    call to the caller that stamps the connection post-hoc.
 *
 * Upsert key is `(connection_id, op_id)`; an existing row's `last_synced_at`
 * is PRESERVED (that marker belongs to the project sync, not to this lookup).
 */

/** Product default per-request timeout, same as the sync engine (SPEC_20 §6). */
const REFRESH_PROJECT_TIMEOUT_MS = 30_000;

export interface RefreshProjectsDeps {
  projects: Pick<ProjectRepository, "getByConnectionAndOpIds" | "upsertMany">;
}

export interface RefreshProjectsOptions {
  /** External cancel — stops before the next GET and aborts the in-flight one. */
  signal?: AbortSignal;
  /** Per-request timeout in ms (default 30 s). A timeout skips that project. */
  timeoutMs?: number;
  /** Called once per skipped project. Default: `console.warn`. Must not throw
   * (a throwing callback is swallowed). */
  onSkip?: (projectOpId: OpId, err: unknown) => void;
}

export interface RefreshProjectsResult {
  /** Project op ids fetched from OP and upserted. */
  refreshed: OpId[];
  /** Project op ids that failed (403/404/timeout/…) and were left untouched. */
  skipped: OpId[];
  /** True when `signal` stopped the refresh before every id was attempted. */
  cancelled: boolean;
}

const defaultOnSkip = (projectOpId: OpId, err: unknown): void => {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`[osp/sync] project ${projectOpId} refresh skipped: ${msg}`);
};

export async function refreshProjects(
  op: OpClient,
  deps: RefreshProjectsDeps,
  connectionId: number | null,
  projectOpIds: Iterable<OpId>,
  options: RefreshProjectsOptions = {},
): Promise<RefreshProjectsResult> {
  const result: RefreshProjectsResult = { refreshed: [], skipped: [], cancelled: false };
  if (connectionId === null) return result;

  // Distinct, real ids only (a WP without a project maps to project_op_id 0).
  const ids = [...new Set(projectOpIds)].filter((id) => Number.isInteger(id) && id > 0);
  if (ids.length === 0) return result;

  const { signal } = options;
  const onSkip = (id: OpId, err: unknown): void => {
    result.skipped.push(id);
    try {
      (options.onSkip ?? defaultOnSkip)(id, err);
    } catch {
      // A logging callback must never turn best-effort into a failure.
    }
  };
  // Timeout + cancel for every GET, no timeout retries: one slow project is
  // skipped, not retried three times while the caller waits.
  const client = withHardCancel(op, {
    timeoutMs: options.timeoutMs ?? REFRESH_PROJECT_TIMEOUT_MS,
    signal,
    maxRetries: 0,
  });

  let existing: Map<OpId, string | null>;
  try {
    const rows = await deps.projects.getByConnectionAndOpIds(
      ids.map((op_id) => ({ connection_id: connectionId, op_id })),
    );
    existing = new Map(rows.map((p) => [p.op_id, p.last_synced_at]));
  } catch (err) {
    for (const id of ids) onSkip(id, err);
    return result;
  }

  for (const id of ids) {
    if (signal?.aborted) {
      result.cancelled = true;
      break;
    }
    let fetched;
    try {
      fetched = await client.getProject(id);
    } catch (err) {
      if (isOpCancelledError(err) || signal?.aborted) {
        result.cancelled = true;
        break;
      }
      onSkip(id, err);
      continue;
    }
    const row: NewProject = {
      connection_id: connectionId,
      // The REQUESTED id is the identity; the payload only supplies display.
      op_id: id,
      identifier: fetched.identifier,
      name: fetched.name,
      last_synced_at: existing.get(id) ?? null,
    };
    try {
      await deps.projects.upsertMany([row]);
      result.refreshed.push(id);
    } catch (err) {
      onSkip(id, err);
    }
  }
  return result;
}
