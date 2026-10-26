import type { Repositories } from "@osp/db";
import type { OpClient } from "@osp/op-client";
import { refreshProjects } from "@osp/sync";

/**
 * Increment 40 (docs/INCREMENT_40_CONTRACTS.md §2.A3/§2.B2) — the apps/api
 * call sites that write `work_package_cache` themselves (sprint
 * activate/update/finish pass, retro add, mid-sprint add, add-by-id with a
 * post-hoc connection stamp) refresh the touched projects' `identifier`/`name`
 * right after the cache write, keyed `(connection_id, op_id)`.
 *
 * STRICTLY best-effort: `@osp/sync`'s `refreshProjects` already skips a
 * per-project 403/404/timeout; this wrapper additionally swallows anything
 * else (incl. a cancellation) so a project-metadata refresh can NEVER fail the
 * operation that triggered it. GET-only (`GET /api/v3/projects/{id}`).
 */
export async function refreshProjectsBestEffort(
  op: OpClient,
  repos: Repositories,
  connectionId: number | null,
  projectOpIds: Iterable<number | null | undefined>,
  log: (message: string) => void = (m) => console.warn(m),
): Promise<void> {
  if (connectionId == null) return;
  const ids = [
    ...new Set(
      [...projectOpIds].filter((id): id is number => typeof id === "number" && id > 0),
    ),
  ];
  if (ids.length === 0) return;
  try {
    await refreshProjects(op, repos, connectionId, ids);
  } catch (err) {
    log(
      `[projects] best-effort refresh failed for connection ${connectionId} (${ids.join(",")}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
