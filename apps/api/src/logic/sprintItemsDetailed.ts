import type { SprintItemsDetailedResponse } from "@osp/contracts";
import type { Repositories } from "@osp/db";
import { AppError } from "../errors";
import { effectiveEstimate } from "./estimate";
import { ancestorDoubleCounts } from "./doubleCounting";
import { buildMemberIndex, classifyWithRole, isDoneBucket, roleForHolder } from "./doneRole";
import { computeSprintMembership, multiSprintBadge } from "./multiSprint";
import { createProjectResolver } from "./projectRef";

/**
 * Increment 36 (docs/INCREMENT_36_CONTRACTS.md §2; CAPACITY_BAR_RULES §6
 * invariant 5) — `buildSprintItemsDetailed` extracted VERBATIM out of
 * `routes/index.ts` (where it powered `GET /sprints/:id/items/detailed` and
 * the double-count bulk-fix endpoints) so `logic/statusReport.ts` can call the
 * EXACT SAME assembly for the status PDF's ticket table — never a second
 * implementation of frozen/dimming/origin logic. Behaviour is byte-identical:
 * the pre-existing route tests (unedited) are the proof. `routes/index.ts`'s
 * own `buildSprintItemsDetailed` is now a one-line wrapper around this.
 */

/**
 * Increment 28 (INCREMENT_28_CONTRACTS §2a) — resolve `parent_op_id` edges for
 * ancestors that are NOT themselves sprint items, so a grandparent still links
 * to a grandchild when the intermediate ticket is absent from the sprint.
 * Batched one level at a time against `work_package_cache` ONLY — never an
 * OpenProject call (the read-only invariant is not even approached here). An
 * id with no cache row terminates its chain, so the loop always makes
 * progress; the level cap is a second, defensive stop for malformed data.
 */
async function resolveAncestorParents(
  repos: Repositories,
  items: readonly { wp_op_id: number; parent_op_id: number | null }[],
): Promise<Map<number, number | null>> {
  const known = new Map<number, number | null>();
  for (const it of items) known.set(it.wp_op_id, it.parent_op_id);
  for (let level = 0; level < 16; level += 1) {
    const missing = [
      ...new Set([...known.values()].filter((p): p is number => p !== null && !known.has(p))),
    ];
    if (missing.length === 0) break;
    const rows = await repos.workPackages.getManyByOpIds(missing);
    const byId = new Map(rows.map((r) => [r.op_id, r.parent_op_id]));
    for (const id of missing) known.set(id, byId.get(id) ?? null);
  }
  return known;
}

/**
 * Increment 28 (§2c): extracted VERBATIM from GET /sprints/:id/items/detailed
 * so the double-count bulk-fix endpoints (and, since Increment 36, the sprint
 * status PDF) can answer with the very same DTO the board renders — one
 * builder, never a second shape.
 */
export async function buildSprintItemsDetailed(
  repos: Repositories,
  id: number,
): Promise<SprintItemsDetailedResponse> {
  const sprint = await repos.sprints.getById(id);
  if (!sprint) throw new AppError("SPRINT_NOT_FOUND", `Sprint ${id} not found`);
  const sprintItems = await repos.sprintItems.listBySprint(id);
  const wpOpIds = sprintItems.map((it) => it.wp_op_id);
  if (wpOpIds.length === 0) return [] satisfies SprintItemsDetailedResponse;

  // Increment 31 (docs/INCREMENT_31_CONTRACTS.md §0/§2c) — a FROZEN sprint
  // reads effective_hours/assignee/status/done_bucket (+ parent/connection,
  // for the same identity/double-count stability the other two read
  // surfaces get) from the freeze-time snapshot, never the live cache.
  const isSprintFrozen = sprint.frozen_at != null;

  const [
    wps,
    baselines,
    overrides,
    dismissedIds,
    projects,
    connections,
    changelog,
    members,
    doneRules,
    frozenSnapshot,
  ] = await Promise.all([
    repos.workPackages.getManyByOpIds(wpOpIds),
    sprint.status !== "planning" ? repos.ticketBaselines.listBySprint(id) : Promise.resolve([]),
    repos.estimateOverrides.getManyByWpOpIds(wpOpIds),
    repos.backlogDismissals.listOpIds(),
    repos.projects.list(),
    repos.connections.list(),
    // SPEC_09 §2: one batched fetch of the whole sprint's changelog →
    // a wp_op_id set → has_history flag; never a per-item listByTicket (N+1).
    repos.ticketChangelog.listBySprint(id),
    // SPEC_18 §3: role-aware done-matrix inputs (both small tables; same
    // batch as computeClosureStats) → per-item done_bucket for dimming.
    repos.teamMembers.list(),
    repos.doneRules.list(),
    isSprintFrozen ? repos.sprintItems.listFrozenSnapshot(id) : Promise.resolve([]),
  ]);
  // SPEC_18 §3: build the holder→role index ONCE, outside the per-item loop.
  const memberIndex = buildMemberIndex(members);
  const historyWpIds = new Set(changelog.map((c) => c.wp_op_id));
  const wpByOpId = new Map(wps.map((w) => [w.op_id, w]));
  // Invariant 10 (CAPACITY_BAR_RULES §6.10), strengthened at integration: a
  // FROZEN sprint never reads the live cache row AT ALL — not even for
  // display passthrough fields (raw estimated_hours, cached_at, subject…).
  // Per-field snapshot preference alone left those passthroughs following
  // live mutations, so the response changed bytes while the "numbers" held.
  // Ignoring the row outright makes the frozen view ≡ the post-deletion view
  // by construction — one stable image from freeze until reactivation.
  if (isSprintFrozen) wpByOpId.clear();
  const baselineByOpId = new Map(baselines.map((b) => [b.wp_op_id, b]));
  const frozenByWp = new Map(frozenSnapshot.map((f) => [f.wp_op_id, f]));
  const ovById = new Map(overrides.map((o) => [o.wp_op_id, o]));
  const dismissed = new Set(dismissedIds);
  // Increment 40 (§2.B1): the ONE project resolver — connection-scoped keys,
  // frozen snapshot for a frozen sprint (never the live cache/project row).
  const projectResolver = createProjectResolver(projects);
  const connById = new Map(connections.map((c) => [c.id, c]));
  /** Prefer the frozen snapshot's value — ONLY when the sprint is actually
   * frozen and the snapshot itself has a non-null value (defensive
   * fallback; freeze.ts snapshots every non-removed item in practice). */
  function preferFrozenItem<T>(frozenValue: T | null | undefined, liveValue: T): T {
    return isSprintFrozen && frozenValue != null ? frozenValue : liveValue;
  }

  // Increment 28 (INCREMENT_28_CONTRACTS §2a) — ancestor-aware double-count
  // detection, computed HERE and nowhere else (the frontend's own recount is
  // deleted). Only items still IN SCOPE participate: a removed /
  // removed_mid_sprint row is no longer part of the sprint's plan, so it can
  // neither be a parent nor a child of a collision — such rows always get
  // `[]` / `null`. Increment 31 (§2c): the parent edge itself prefers the
  // frozen snapshot too, so a frozen sprint's double-count flags can't move
  // just because a cache row was deleted.
  const inScopeAncestry = sprintItems
    .filter((it) => it.outcome !== "removed" && it.outcome !== "removed_mid_sprint")
    .map((it) => ({
      wp_op_id: it.wp_op_id,
      parent_op_id: preferFrozenItem(
        frozenByWp.get(it.wp_op_id)?.frozen_parent_op_id,
        wpByOpId.get(it.wp_op_id)?.parent_op_id ?? null,
      ),
    }));
  const doubleCounts = ancestorDoubleCounts(
    inScopeAncestry,
    await resolveAncestorParents(repos, inScopeAncestry),
  );

  // Increment 34 Phase-0 STUB replacement (docs/INCREMENT_34_CONTRACTS.md
  // §3) — the real cross-sprint membership badge, batched (one shared
  // computation, same helper closureStats.ts uses for the identical field).
  const membership = await computeSprintMembership(repos, wpOpIds);

  const result: SprintItemsDetailedResponse = [];
  for (const item of sprintItems) {
    const wp = wpByOpId.get(item.wp_op_id);
    const baseline = baselineByOpId.get(item.wp_op_id);
    const frozen = frozenByWp.get(item.wp_op_id);
    // Cache row present → live data (bypasses dismissal on purpose).
    // Cache row gone (e.g. an import-removal cascade, or — Increment 31 —
    // the Import cleanup a FROZEN sprint no longer protects against) →
    // fall back to the frozen snapshot (if the sprint is frozen) or the
    // activation baseline for an already-activated sprint; a planning
    // sprint has no baseline yet, so it's simply omitted (rare: only
    // happens if the ticket's import was removed while still only
    // planned, never activated).
    if (!wp && !baseline && !frozen) continue;
    const override = ovById.get(item.wp_op_id)?.planning_hours ?? null;
    const connectionId = preferFrozenItem(frozen?.frozen_connection_id, wp?.connection_id ?? null);
    const conn = connectionId != null ? connById.get(connectionId) : undefined;
    const estimatedHours = wp?.estimated_hours ?? baseline?.estimated_hours ?? null;
    const remainingHours = wp?.remaining_hours ?? baseline?.remaining_hours ?? null;
    const statusName = preferFrozenItem(
      frozen?.frozen_status_name,
      wp?.status_name ?? baseline?.status_name ?? "",
    );
    const statusIsClosed = preferFrozenItem(
      frozen?.frozen_status_is_closed,
      wp?.status_is_closed ?? baseline?.status_is_closed ?? false,
    );
    // SPEC_18 §3: resolve the CURRENT holder's role and classify done-ness via
    // the SAME role-aware matrix Closure uses. Holder mirrors closureStats.ts
    // (baseline fallback = assignee_name_raw, NOT the display-only
    // `assignee_name` field above, which has no baseline fallback by design).
    // Increment 31 (§2c): both prefer the frozen snapshot, so done_bucket
    // (and hence is_done/dimming) can't move once frozen.
    const holderOpUserId = preferFrozenItem(
      frozen?.frozen_assignee_op_id,
      wp?.assignee_op_id ?? baseline?.assignee_op_id ?? null,
    );
    const holderName = preferFrozenItem(
      frozen?.frozen_assignee_name,
      wp?.assignee_name ?? baseline?.assignee_name_raw ?? null,
    );
    const { role: holderRole, resolvedName } = roleForHolder(holderOpUserId, holderName, memberIndex);
    const cls = classifyWithRole(
      { status_name: statusName, status_is_closed: statusIsClosed },
      holderRole,
      doneRules,
      resolvedName,
    );
    const parentOpId = preferFrozenItem(frozen?.frozen_parent_op_id, wp?.parent_op_id ?? null);
    // Increment 31 (§2c): effective_hours is the estimate of record — for a
    // frozen sprint that's `frozen_effective_hours` directly, not a
    // recomputation off (possibly gone) live estimated/remaining hours.
    // Increment 40 (§1.3): a frozen sprint's project is the freeze-time
    // snapshot ONLY (invariant 10 extended); otherwise live cache row →
    // activation baseline payload.
    const project = projectResolver.resolve(
      isSprintFrozen && frozen
        ? {
            frozen: {
              op_id: frozen.frozen_project_op_id,
              name: frozen.frozen_project_name,
              identifier: frozen.frozen_project_identifier,
            },
          }
        : { wp: wp ?? null, baselineRawJson: baseline?.raw_json ?? null, connectionId },
    );
    const effectiveHours = preferFrozenItem(
      frozen?.frozen_effective_hours,
      effectiveEstimate(estimatedHours, remainingHours, override),
    );
    result.push({
      id: wp?.id ?? item.id,
      connection_id: connectionId,
      op_id: item.wp_op_id,
      // AMENDMENT (INCREMENT_31_CONTRACTS §1): ticket_baseline has no project
      // column, so a frozen sprint with deleted cache rows needs the snapshot
      // here — `?? 0` alone failed the response schema's positive OpId.
      project_op_id: preferFrozenItem(frozen?.frozen_project_op_id, wp?.project_op_id ?? 0),
      subject: wp?.subject ?? baseline?.subject ?? `WP ${item.wp_op_id}`,
      type_name: wp?.type_name ?? "",
      status_name: statusName,
      status_is_closed: statusIsClosed,
      assignee_op_id: holderOpUserId,
      assignee_name: preferFrozenItem(frozen?.frozen_assignee_name, wp?.assignee_name ?? null),
      estimated_hours: estimatedHours,
      remaining_hours: remainingHours,
      spent_hours: wp?.spent_hours ?? baseline?.spent_hours ?? null,
      story_points: wp?.story_points ?? null,
      version_op_id: wp?.version_op_id ?? baseline?.version_op_id ?? null,
      version_name: wp?.version_name ?? null,
      priority: wp?.priority ?? null,
      parent_op_id: parentOpId,
      percentage_done: wp?.percentage_done ?? null,
      updated_at_op: wp?.updated_at_op ?? baseline?.captured_at ?? sprint.created_at,
      raw_json: wp?.raw_json ?? baseline?.raw_json ?? "{}",
      cached_at: wp?.cached_at ?? baseline?.captured_at ?? sprint.created_at,
      project_name: project.name,
      project_identifier: project.identifier,
      override_hours: override,
      effective_hours: effectiveHours,
      in_sprint: true,
      connection_base_url: conn?.base_url ?? null,
      connection_label: conn?.label ?? null,
      stale: conn === undefined ? false : !conn.enabled || conn.last_status === "fail",
      sprint_item_id: item.id,
      outcome: item.outcome,
      origin: item.origin,
      planned_hours: item.planned_hours,
      added_at: item.added_at,
      removed_at: item.removed_at,
      no_longer_in_backlog: !wp || dismissed.has(item.wp_op_id),
      has_history: historyWpIds.has(item.wp_op_id),
      done_bucket: cls.bucket,
      multi_sprint: multiSprintBadge(membership, item.wp_op_id, id),
      is_done: isDoneBucket(cls.bucket),
      holder_role: holderRole,
      ambiguous_reason: cls.ambiguous_reason,
      double_count_children: doubleCounts.get(item.wp_op_id)?.double_count_children ?? [],
      double_count_parent_of: doubleCounts.get(item.wp_op_id)?.double_count_parent_of ?? null,
    });
  }
  return result;
}
