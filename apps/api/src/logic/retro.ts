import type {
  BurndownResponse,
  RetroSeedBody,
  RetroSeedCandidate,
  RetroSeedResponse,
  RetroPreviewResponse,
} from "@osp/contracts";
import type {
  NewBurndownSnapshot,
  NewChangelogEntry,
  NewTicketBaseline,
  Repositories,
} from "@osp/db";
import type {
  OpActivity,
  OpClient,
  OpStatus,
  OpWorkPackage,
} from "@osp/op-client";
import {
  deriveChangelogEvents,
  fetchActivitiesByWpIds,
  fetchAllTimeEntries,
  fetchAllWorkPackages,
  parseIsoDuration,
  parseOpId,
} from "@osp/op-client";
import {
  aggregateTimeEntries,
  idealRemainingHours,
  registerSprintUpdateController,
  toWorkPackageCacheRow,
  unregisterSprintUpdateController,
} from "@osp/sync";
import { AppError } from "../errors";
import { refreshProjectsBestEffort } from "./projectRefresh";
import { runFinishStatus, withRunCancelSignal } from "./sprintUpdate";
import { buildBurndown } from "./burndown";
import { performClosure } from "./closure";
import { leafEffort } from "./doubleCounting";
import { effectiveEstimate } from "./estimate";
import { remainingStatusSet } from "./remaining";
import type {
  ReconstructedWpState,
  ReconstructEngine,
  ReconstructFallback,
} from "./reconstruct";
import { createUserNameResolver, unknownUserLabel } from "./userNames";
import { createIdentityResolver, type ResolvedIdentity } from "./identityResolver";

/**
 * SPEC_12 — retrospective planning, day-by-day replay, and history rebuild.
 *
 * The whole point (SPEC_12 §1): a ticket's state on ANY past day is
 * RECONSTRUCTABLE from its OP journals, so a retrospective sprint's baseline +
 * burndown are COMPUTED, not simulated. This module owns:
 *   - retro/seed + retro/preview: candidate tickets reconstructed to start_date,
 *   - the activation replay: day-by-day burndown_snapshot(source="reconstructed")
 *     + changelog + scope churn, ending in an auto-lock (past window) or an
 *     ordinary "active" hand-off (still-open window),
 *   - rebuild-burndown: a pure recompute over ANY sprint (never touches status).
 *
 * OP stays READ-ONLY throughout (GET-only clients). Connection scoping obeys the
 * SPEC_11 §1 invariant: only the connections the sprint's OWN tickets live on.
 */

export interface RetroDeps {
  repos: Repositories;
  reconstruct: ReconstructEngine;
  /** Resolve a timeout-wrapped, GET-only OP client for one connection (the
   * route supplies buildTimeoutClientForConnection). */
  buildClientForConnection: (connectionId: number) => Promise<OpClient>;
  now: () => Date;
}

export interface RetroService {
  /** POST /sprints/:id/retro/seed — bulk-add candidates (by version / id list),
   * each reconstructed to start_date; persists baselines + retro_seed_*. */
  seed(sprintId: number, body: RetroSeedBody): Promise<RetroSeedResponse>;
  /** GET /sprints/:id/retro/preview — read-only re-reconstruction of the current
   * items' start_date state (no writes). */
  preview(sprintId: number): Promise<RetroPreviewResponse>;
  /** POST /sprints/:id/items fork for a retrospective planning sprint: resolve
   * the ticket's start_date estimate + capture a reconstructed baseline, instead
   * of reading the live cache. Returns the planned hours to store on the item. */
  reconstructManualAdd(sprintId: number, wpOpId: number): Promise<number | null>;
  /** The activation replay (SPEC_12 §2) — finishes the run itself on both paths
   * (success/error), like runScopedActivation. */
  runReplay(sprintId: number, runId: number): Promise<void>;
  /** POST /sprints/:id/rebuild-burndown (SPEC_12 §5) — recompute the whole
   * burndown from OP history; NEVER touches sprint.status/is_locked. */
  rebuildBurndown(sprintId: number): Promise<BurndownResponse>;
}

// ── small date helpers ───────────────────────────────────────────────────────

/** Inclusive list of calendar dates (YYYY-MM-DD) between start & end. Empty
 * when end < start (e.g. a future-dated sprint whose window hasn't opened). */
function calendarDays(start: string, end: string): string[] {
  const out: string[] = [];
  if (end < start) return out;
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  for (let ms = startMs; ms <= endMs; ms += 86_400_000) {
    out.push(new Date(ms).toISOString().slice(0, 10));
  }
  return out;
}

function minDate(a: string, b: string): string {
  return a < b ? a : b;
}

/** Number of calendar days a retro replay will write (SPEC_12 §9 "day X / Y"):
 * [start_date, min(today, end_date)] inclusive — the run's total_count for the
 * activation progress bar (DAYS, not the ticket count other run kinds use). */
export function replayDayCount(startDate: string, endDate: string, today: string): number {
  return calendarDays(startDate, minDate(today, endDate)).length;
}

// ── per-ticket reconstruction inputs ─────────────────────────────────────────

interface TicketReconData {
  wpOpId: number;
  currentWp: OpWorkPackage | null;
  activities: OpActivity[];
  statusById: Map<number, OpStatus>;
}

/** One connection's slice of the sprint (the scoping invariant, SPEC_11 §1). */
interface RetroPartition {
  connectionId: number;
  op: OpClient;
  wpOpIds: number[];
}

export function createRetroService(deps: RetroDeps): RetroService {
  const { repos, reconstruct } = deps;
  const nowIso = (): string => deps.now().toISOString();

  function fallbackFromWp(
    wp: OpWorkPackage | null,
    statusById: Map<number, OpStatus>,
  ): ReconstructFallback {
    if (!wp) {
      return {
        status_name: null,
        assignee_name: null,
        assignee_op_id: null,
        estimated_hours: null,
        remaining_hours: null,
        version_name: null,
      };
    }
    const statusId = parseOpId(wp._links.status?.href ?? null);
    const status = statusId !== null ? statusById.get(statusId) : undefined;
    return {
      status_name: wp._links.status?.title ?? status?.name ?? null,
      assignee_name: wp._links.assignee?.title ?? null,
      assignee_op_id: parseOpId(wp._links.assignee?.href ?? null),
      estimated_hours: parseIsoDuration(wp.estimatedTime),
      remaining_hours: parseIsoDuration(wp.remainingTime),
      version_name: wp._links.version?.title ?? null,
    };
  }

  /** Distinct OP project ids referenced by a set of work packages — the
   * projects whose memberships feed the identity index (SPEC_13 §1a), staying
   * within the sprint's own scope (no connection/project enumeration). */
  function projectOpIdsOf(wps: readonly OpWorkPackage[]): number[] {
    const ids = new Set<number>();
    for (const wp of wps) {
      const pid = parseOpId(wp._links.project?.href ?? null);
      if (pid !== null) ids.add(pid);
    }
    return [...ids];
  }

  /** name→isClosed lookup (case-insensitive) merged across connections. */
  function statusClosedByName(maps: Map<number, OpStatus>[]): Map<string, boolean> {
    const out = new Map<string, boolean>();
    for (const m of maps) {
      for (const s of m.values()) out.set(s.name.trim().toLowerCase(), s.isClosed);
    }
    return out;
  }

  /**
   * Remap ReconstructedWpState's OWN gap field names (estimated_hours /
   * assignee_name / status_name / …) onto RetroSeedCandidate's field names
   * (estimate_at_start_date / assignee_at_start_date / status_at_start_date).
   * Not a 1:1 rename: `assignee_op_id` folds into `assignee_at_start_date`
   * (per Agent A — an id is never journal-derivable, so it's flagged only when
   * the assignee NAME also gapped); remaining_hours/version_name have no
   * candidate field, so they pass through verbatim (still surfaced, never
   * silently dropped — SPEC_12 §4). Deduped, order preserved.
   */
  function mapGapNames(gaps: string[]): string[] {
    const rename: Record<string, string> = {
      estimated_hours: "estimate_at_start_date",
      assignee_name: "assignee_at_start_date",
      assignee_op_id: "assignee_at_start_date",
      status_name: "status_at_start_date",
    };
    const out: string[] = [];
    for (const g of gaps) {
      const mapped = rename[g] ?? g;
      if (!out.includes(mapped)) out.push(mapped);
    }
    return out;
  }

  function toCandidate(
    wpOpId: number,
    subject: string,
    state: ReconstructedWpState,
    identity: ResolvedIdentity,
  ): RetroSeedCandidate {
    return {
      wp_op_id: wpOpId,
      subject,
      estimate_at_start_date: state.estimated_hours,
      // SPEC_13 §1b: a `merge_into_name` alias folds this journal name under a
      // canonical (current) display name — show THAT so preview and the capacity
      // roster group the person identically.
      assignee_at_start_date: identity.canonical_name ?? state.assignee_name,
      status_at_start_date: state.status_name,
      reconstructed: state.gaps.length > 0,
      gaps: mapGapNames(state.gaps),
      // SPEC_13 §1: identity resolved FRESH from the journal name via the ONE
      // shared resolver (exact user match → alias → unresolved). Never the live
      // assignee id.
      assignee_op_id_at_start_date: identity.op_user_id,
      assignee_resolution: identity.resolution,
      // SPEC_13 §2: a ticket created AFTER start_date wasn't a baseline — flag
      // it so the UI shows "created <created_at_op>" and the replay routes it as
      // a scope addition at its creation date, not a misleading baseline row.
      created_after_start_date: state.not_yet_created,
      created_at_op: state.created_at,
    };
  }

  function buildReconBaseline(args: {
    sprintId: number;
    wpOpId: number;
    capturedAt: string;
    subject: string;
    state: ReconstructedWpState;
    currentWp: OpWorkPackage | null;
    closedByName: Map<string, boolean>;
    origin: "baseline" | "added_mid_sprint";
  }): NewTicketBaseline {
    const { state, currentWp } = args;
    const statusKey = (state.status_name ?? "").trim().toLowerCase();
    // Resolve the version op id only when the reconstructed version_name still
    // matches the live WP's version (best-effort — journals give us the NAME).
    const liveVersionName = currentWp?._links.version?.title ?? null;
    const versionOpId =
      currentWp && liveVersionName === state.version_name
        ? parseOpId(currentWp._links.version?.href ?? null)
        : null;
    return {
      sprint_id: args.sprintId,
      wp_op_id: args.wpOpId,
      captured_at: args.capturedAt,
      subject: args.subject,
      status_name: state.status_name ?? "",
      status_is_closed: args.closedByName.get(statusKey) ?? false,
      assignee_op_id: state.assignee_op_id,
      accountable_op_id: null,
      original_assignee_op_id: state.assignee_op_id,
      estimated_hours: state.estimated_hours,
      remaining_hours: state.remaining_hours,
      spent_hours: null,
      version_op_id: versionOpId,
      raw_json: JSON.stringify({ reconstructed_at: args.capturedAt, state }),
      origin: args.origin,
      reconstructed: state.gaps.length > 0,
      reconstruction_gaps_json:
        state.gaps.length > 0 ? JSON.stringify(mapGapNames(state.gaps)) : null,
      // SPEC_13 §1: store the RAW journal name; identity is re-resolved at read
      // time (never trust the baked assignee_op_id for a retro row), so a later
      // alias applies retroactively without re-running reconstruction.
      assignee_name_raw: state.assignee_name,
    };
  }

  // ── connection resolution (SPEC_11 §1 scoping invariant) ───────────────────

  /** Which connection to query for a version/id-list SEED: the connection the
   * sprint's already-cached candidate tickets belong to, else the current one. */
  async function resolveSeedConnectionId(sprintId: number): Promise<number> {
    const items = await repos.sprintItems.listBySprint(sprintId);
    const wpIds = items.map((i) => i.wp_op_id);
    if (wpIds.length > 0) {
      const cached = await repos.workPackages.getManyByOpIds(wpIds);
      const withConn = cached.find((w) => w.connection_id != null);
      if (withConn?.connection_id != null) return withConn.connection_id;
    }
    const current = await repos.connections.getCurrent();
    if (!current) throw new AppError("NO_CONNECTION", "No OpenProject connection configured");
    return current.id;
  }

  /** Partition the sprint's current items by their cached connection (falling
   * back to the current connection), NEVER enumerating all connections. */
  async function partitionSprint(wpOpIds: number[]): Promise<RetroPartition[]> {
    if (wpOpIds.length === 0) return [];
    const cached = await repos.workPackages.getManyByOpIds(wpOpIds);
    const connByWp = new Map(cached.map((w) => [w.op_id, w.connection_id]));
    const current = await repos.connections.getCurrent();
    const byConn = new Map<number, number[]>();
    for (const wp of wpOpIds) {
      const cid = connByWp.get(wp) ?? current?.id ?? null;
      if (cid === null) continue;
      const list = byConn.get(cid);
      if (list) list.push(wp);
      else byConn.set(cid, [wp]);
    }
    if (byConn.size === 0) {
      throw new AppError("NO_CONNECTION", "No OpenProject connection configured");
    }
    const parts: RetroPartition[] = [];
    for (const [cid, ids] of byConn) {
      parts.push({ connectionId: cid, op: await deps.buildClientForConnection(cid), wpOpIds: ids });
    }
    return parts;
  }

  async function loadStatusMap(op: OpClient): Promise<Map<number, OpStatus>> {
    const statuses = await op.getStatuses();
    const byId = new Map<number, OpStatus>();
    for (const s of statuses._embedded.elements) byId.set(s.id, s);
    return byId;
  }

  /**
   * Fetch per-ticket OP data for a set of partitions (SPEC_12 §4 cost note:
   * activities + time entries + current WP PER TICKET IN THE SPRINT ONLY),
   * refresh the scoped work_package_cache with the live state, and aggregate
   * time entries into a per-day logged map. Concurrency is bounded by the OP
   * client's own limit (fetchActivitiesByWpIds fans out via Promise.all).
   */
  async function gatherReplayData(parts: RetroPartition[]): Promise<{
    ticketData: Map<number, TicketReconData>;
    loggedByDay: Map<string, number>;
    closedByName: Map<string, boolean>;
    parts: RetroPartition[];
  }> {
    const ticketData = new Map<number, TicketReconData>();
    const loggedByDay = new Map<string, number>();
    const statusMaps: Map<number, OpStatus>[] = [];
    for (const part of parts) {
      const statusById = await loadStatusMap(part.op);
      statusMaps.push(statusById);
      const [wps, activitiesByWp, timeEntries] = await Promise.all([
        fetchAllWorkPackages(part.op, {
          filters: [{ id: { operator: "=", values: part.wpOpIds.map(String) } }],
          pageSize: 100,
        }),
        fetchActivitiesByWpIds(part.op, part.wpOpIds),
        fetchAllTimeEntries(part.op, {
          filters: [
            { entity_type: { operator: "=", values: ["WorkPackage"] } },
            { entity_id: { operator: "=", values: part.wpOpIds.map(String) } },
          ],
        }),
      ]);
      const wpById = new Map(wps.map((w) => [w.id, w]));
      // Refresh the scoped cache with CURRENT state so closure/capacity/board
      // read fresh data (mirrors the sprint-update UPDATE CORE step B).
      const agg = aggregateTimeEntries(timeEntries);
      if (wps.length > 0) {
        await repos.workPackages.upsertMany(
          wps.map((wp) =>
            toWorkPackageCacheRow(wp, statusById, agg.byWorkPackage.get(wp.id) ?? null, part.connectionId),
          ),
        );
        // Increment 40 (§2.A3): best-effort project identifier/name refresh.
        await refreshProjectsBestEffort(part.op, repos, part.connectionId, projectOpIdsOf(wps));
      }
      for (const [day, hours] of agg.byDay) {
        loggedByDay.set(day, (loggedByDay.get(day) ?? 0) + hours);
      }
      for (const wpId of part.wpOpIds) {
        ticketData.set(wpId, {
          wpOpId: wpId,
          currentWp: wpById.get(wpId) ?? null,
          activities: activitiesByWp.get(wpId) ?? [],
          statusById,
        });
      }
    }
    return { ticketData, loggedByDay, closedByName: statusClosedByName(statusMaps), parts };
  }

  // ── the day-by-day burndown writer (shared by replay + rebuild) ────────────

  /**
   * Write burndown_snapshot(source="reconstructed") for every calendar day in
   * [start_date, min(today, end_date)]. `inScopeAt` gates a ticket's membership
   * on a day (baseline from start; a churn-added ticket only from its entry
   * date). `progress` (optional) reports day X / Y (SPEC_12 §9).
   */
  async function writeReconstructedBurndown(args: {
    sprintId: number;
    startDate: string;
    endDate: string;
    lastDay: string;
    baselineTotal: number;
    ticketData: Map<number, TicketReconData>;
    loggedByDay: Map<string, number>;
    closedByName: Map<string, boolean>;
    remainingSet: Set<string>;
    inScopeAt: (wpOpId: number, day: string) => boolean;
    progress?: (dayIndex: number, totalDays: number) => Promise<void>;
  }): Promise<void> {
    const days = calendarDays(args.startDate, args.lastDay);
    let runningLogged = 0;
    for (const [idx, day] of days.entries()) {
      const dayInstant = `${day}T23:59:59Z`;
      let remaining = 0;
      let doneCount = 0;
      let totalCount = 0;
      for (const [wpId, data] of args.ticketData) {
        if (!args.inScopeAt(wpId, day)) continue;
        totalCount += 1;
        const state = reconstruct.stateAtDate(
          data.activities,
          data.statusById,
          dayInstant,
          fallbackFromWp(data.currentWp, data.statusById),
          data.currentWp?.createdAt ?? null,
        );
        const statusKey = (state.status_name ?? "").trim().toLowerCase();
        if (args.closedByName.get(statusKey) ?? false) doneCount += 1;
        // Remaining (blue): dev-pending status AND a non-null estimate (SPEC_11 §6).
        if (args.remainingSet.has(statusKey) && state.estimated_hours != null) {
          remaining += state.remaining_hours ?? 0;
        }
      }
      // Logged (burnup): cumulative Σ time entries start_date <= spentOn <= day,
      // monotonic (SPEC_11 §7 — never regress). The lower bound mirrors the
      // live computeSnapshot (packages/sync): long-lived production tickets
      // carry years of pre-sprint logged history that must not offset the
      // burnup — it answers "how much was worked DURING the sprint".
      let logged = 0;
      for (const [d, h] of args.loggedByDay) if (d >= args.startDate && d <= day) logged += h;
      if (logged < runningLogged) logged = runningLogged;
      else runningLogged = logged;
      const ideal = idealRemainingHours({
        totalPlanned: args.baselineTotal,
        startDate: args.startDate,
        endDate: args.endDate,
        date: day,
      });
      const row: NewBurndownSnapshot = {
        sprint_id: args.sprintId,
        snapshot_date: day,
        remaining_hours: remaining,
        logged_hours: logged,
        ideal_hours: ideal,
        done_count: doneCount,
        total_count: totalCount,
        source: "reconstructed",
      };
      await repos.burndown.upsert(row);
      if (args.progress) await args.progress(idx + 1, days.length);
    }
  }

  /** Derive + persist changelog for one partition across the whole replay window
   * (every activity since `sinceInstant`), reusing the SAME deriveChangelogEvents
   * path as a normal update pass (SPEC_12 §2). */
  async function persistReplayChangelog(
    part: RetroPartition,
    ticketData: Map<number, TicketReconData>,
    sprintId: number,
    updateRunId: number,
    sinceInstant: string,
  ): Promise<number> {
    const sinceDate = sinceInstant.slice(0, 10);
    const nameResolver = createUserNameResolver(part.op);
    const rows: NewChangelogEntry[] = [];
    const resolveActor = async (
      href: string | null,
      title: string | null | undefined,
      opId: number | null,
    ): Promise<string | null> => {
      if (href === null) return null;
      if (title) return title;
      if (opId === null) return null;
      return (await nameResolver.resolve(opId)) ?? unknownUserLabel(opId);
    };
    for (const wpId of part.wpOpIds) {
      const data = ticketData.get(wpId);
      if (!data) continue;
      if (data.currentWp) {
        const aId = parseOpId(data.currentWp._links.assignee?.href ?? null);
        if (aId !== null) nameResolver.seed(aId, data.currentWp._links.assignee?.title ?? null);
      }
      for (const act of data.activities) {
        if (act.createdAt < sinceInstant) continue;
        const actorHref = act._links.user.href;
        const actorOpId = parseOpId(actorHref);
        const actorName = await resolveActor(actorHref, act._links.user.title, actorOpId);
        for (const ev of deriveChangelogEvents(act, data.statusById)) {
          rows.push({
            sprint_id: sprintId,
            wp_op_id: wpId,
            update_run_id: updateRunId,
            occurred_at: act.createdAt,
            actor_op_id: actorOpId,
            actor_name: actorName,
            kind: ev.kind,
            detail_json: JSON.stringify(ev.detail),
            source: "journal",
            op_journal_id: act.id,
            // Sprint-prefixed (not bare `journal:${act.id}:...`): real OP
            // activity ids are globally unique, but the SAME wp replayed into
            // TWO sprints (or the mock's own per-scenario-load activity-id
            // reset, SPEC_15 Phase 2 finding) could otherwise collide on the
            // global dedup_key unique index and silently DROP a genuine event.
            dedup_key: `s${sprintId}:journal:${act.id}:${ev.dedupSuffix}`,
          });
        }
      }
    }
    // time_logged from time entries (spentOn >= start) — a second scoped read.
    const timeEntries = await fetchAllTimeEntries(part.op, {
      filters: [
        { entity_type: { operator: "=", values: ["WorkPackage"] } },
        { entity_id: { operator: "=", values: part.wpOpIds.map(String) } },
      ],
    });
    const wpIdSet = new Set(part.wpOpIds);
    for (const e of timeEntries) {
      const wpId = parseOpId(e._links.workPackage?.href ?? null);
      if (wpId === null || !wpIdSet.has(wpId)) continue;
      if (e.spentOn < sinceDate) continue;
      const actorHref = e._links.user.href;
      const actorOpId = parseOpId(actorHref);
      rows.push({
        sprint_id: sprintId,
        wp_op_id: wpId,
        update_run_id: updateRunId,
        occurred_at: e.createdAt ?? `${e.spentOn}T12:00:00Z`,
        actor_op_id: actorOpId,
        actor_name: await resolveActor(actorHref, e._links.user.title, actorOpId),
        kind: "time_logged",
        detail_json: JSON.stringify({
          kind: "time_logged",
          hours: parseIsoDuration(e.hours) ?? 0,
          spent_on: e.spentOn,
        }),
        source: "time_entry",
        op_journal_id: null,
        dedup_key: `s${sprintId}:time_entry:${e.id}`,
      });
    }
    return rows.length > 0 ? await repos.ticketChangelog.insertMany(rows) : 0;
  }

  // ── seed / preview reconstruction of a candidate set ───────────────────────

  /**
   * Reconstruct a set of (wpId → currentWp) to `startInstant` and, when
   * `persist`, add sprint_item + ticket_baseline rows (origin="baseline").
   * Returns the per-ticket candidate previews.
   */
  async function reconstructCandidates(args: {
    sprintId: number;
    startInstant: string;
    op: OpClient;
    connectionId: number;
    candidates: OpWorkPackage[];
    statusById: Map<number, OpStatus>;
    persist: boolean;
  }): Promise<RetroSeedCandidate[]> {
    const closedByName = statusClosedByName([args.statusById]);
    const wpIds = args.candidates.map((w) => w.id);
    const activitiesByWp = await fetchActivitiesByWpIds(args.op, wpIds);
    // SPEC_13 §1a: the ONE identity resolver, per connection. Its name→id index
    // is composed from NON-admin sources — the candidates' own assignee/
    // accountable links + this project's memberships — plus this connection's
    // aliases. Shared verbatim with preview + capacity so identity is identical.
    const resolver = await createIdentityResolver(
      args.op,
      await repos.userNameAliases.listByConnection(args.connectionId),
      { workPackages: args.candidates, projectOpIds: projectOpIdsOf(args.candidates) },
    );
    const out: RetroSeedCandidate[] = [];
    const baselineRows: NewTicketBaseline[] = [];
    for (const wp of args.candidates) {
      const activities = activitiesByWp.get(wp.id) ?? [];
      const state = reconstruct.stateAtDate(
        activities,
        args.statusById,
        args.startInstant,
        fallbackFromWp(wp, args.statusById),
        wp.createdAt ?? null,
      );
      out.push(toCandidate(wp.id, wp.subject, state, resolver.resolve(state.assignee_name)));
      if (!args.persist) continue;
      // Refresh cache (so board/backlog see the candidate — incl. `tested`
      // tickets that the backlog filter would otherwise hide, SPEC_12 §2).
      await repos.workPackages.upsertMany([
        toWorkPackageCacheRow(wp, args.statusById, null, args.connectionId),
      ]);
      // SPEC_13 §2: a ticket created AFTER start_date is NOT a baseline — route
      // it as a scope addition at its creation date (origin="added_mid_sprint"),
      // reusing the EXACT same mechanism version-scope churn uses. Its "at
      // start_date" fields are informational only; no baseline row at start.
      if (state.not_yet_created && state.created_at) {
        await reAddAsMidSprint(
          args.sprintId,
          wp.id,
          state.created_at,
          { wpOpId: wp.id, currentWp: wp, activities, statusById: args.statusById },
          closedByName,
        );
        continue;
      }
      baselineRows.push(
        buildReconBaseline({
          sprintId: args.sprintId,
          wpOpId: wp.id,
          capturedAt: args.startInstant,
          subject: wp.subject,
          state,
          currentWp: wp,
          closedByName,
          origin: "baseline",
        }),
      );
      // sprint_item: origin=baseline, planned_hours = reconstructed estimate.
      const existing = await repos.sprintItems.getBySprintAndWp(args.sprintId, wp.id);
      if (!existing) {
        await repos.sprintItems.add({
          sprint_id: args.sprintId,
          wp_op_id: wp.id,
          planned_hours: state.estimated_hours,
          outcome: "planned",
          origin: "baseline",
        });
      } else if (existing.outcome === "removed" || existing.outcome === "removed_mid_sprint") {
        await repos.sprintItems.setOutcome(existing.id, "planned", null);
      }
    }
    if (baselineRows.length > 0) await repos.ticketBaselines.upsertMany(baselineRows);
    // Increment 40 (§2.A3): refresh the touched projects' identifier/name —
    // best-effort, never fails the seed.
    if (args.persist && args.candidates.length > 0) {
      await refreshProjectsBestEffort(
        args.op,
        repos,
        args.connectionId,
        projectOpIdsOf(args.candidates),
      );
    }
    return out;
  }

  // ── guard helpers ──────────────────────────────────────────────────────────

  async function requireRetroPlanning(sprintId: number) {
    const sprint = await repos.sprints.getById(sprintId);
    if (!sprint) throw new AppError("SPRINT_NOT_FOUND", `Sprint ${sprintId} not found`);
    if (sprint.status !== "planning") {
      throw new AppError(
        "SPRINT_NOT_PLANNING",
        `Sprint "${sprint.name}" is not in planning (status: ${sprint.status})`,
        { sprintName: sprint.name },
      );
    }
    if (!sprint.is_retrospective) {
      throw new AppError(
        "SPRINT_NOT_RETROSPECTIVE",
        `Sprint "${sprint.name}" is not a retrospective sprint`,
        { sprintName: sprint.name },
      );
    }
    return sprint;
  }

  return {
    async seed(sprintId: number, body: RetroSeedBody): Promise<RetroSeedResponse> {
      const sprint = await requireRetroPlanning(sprintId);
      const startInstant = `${sprint.start_date}T23:59:59Z`;
      const connectionId = await resolveSeedConnectionId(sprintId);
      const op = await deps.buildClientForConnection(connectionId);
      const statusById = await loadStatusMap(op);

      let candidates: OpWorkPackage[] = [];
      if (body.kind === "version") {
        // Match the version by NAME (sprint ↔ version, SPEC_12 §2 path A), then
        // fetch every WP with it REGARDLESS of current status.
        const versions = await op.getVersions();
        const version = versions._embedded.elements.find((v) => v.name === body.value);
        if (version) {
          candidates = await fetchAllWorkPackages(op, {
            filters: [{ version: { operator: "=", values: [String(version.id)] } }],
          });
        }
      } else {
        const ids = body.value
          .split(/[\s,]+/)
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isInteger(n) && n > 0);
        if (ids.length > 0) {
          candidates = await fetchAllWorkPackages(op, {
            filters: [{ id: { operator: "=", values: ids.map(String) } }],
          });
        }
      }

      const result = await reconstructCandidates({
        sprintId,
        startInstant,
        op,
        connectionId,
        candidates,
        statusById,
        persist: true,
      });
      // Record how this sprint was seeded (SPEC_12 §7) — only on seed.
      await repos.sprints.update(sprintId, {
        retro_seed_kind: body.kind,
        retro_seed_value: body.value,
      });
      return { sprint_id: sprintId, candidates: result };
    },

    async preview(sprintId: number): Promise<RetroPreviewResponse> {
      const sprint = await requireRetroPlanning(sprintId);
      const startInstant = `${sprint.start_date}T23:59:59Z`;
      const items = (await repos.sprintItems.listBySprint(sprintId)).filter(
        (i) => i.outcome !== "removed" && i.outcome !== "removed_mid_sprint",
      );
      const wpOpIds = items.map((i) => i.wp_op_id);
      if (wpOpIds.length === 0) {
        return { sprint_id: sprintId, start_date: sprint.start_date, items: [] };
      }
      const parts = await partitionSprint(wpOpIds);
      const out: RetroSeedCandidate[] = [];
      for (const part of parts) {
        const statusById = await loadStatusMap(part.op);
        const wps = await fetchAllWorkPackages(part.op, {
          filters: [{ id: { operator: "=", values: part.wpOpIds.map(String) } }],
          pageSize: 100,
        });
        const wpById = new Map(wps.map((w) => [w.id, w]));
        const activitiesByWp = await fetchActivitiesByWpIds(part.op, part.wpOpIds);
        // SPEC_13 §1a: SAME resolver construction as seed/capacity (same non-admin
        // sources) — this is what makes the name→identity map identical across
        // all three views.
        const resolver = await createIdentityResolver(
          part.op,
          await repos.userNameAliases.listByConnection(part.connectionId),
          { workPackages: wps, projectOpIds: projectOpIdsOf(wps) },
        );
        for (const wpId of part.wpOpIds) {
          const wp = wpById.get(wpId) ?? null;
          const state = reconstruct.stateAtDate(
            activitiesByWp.get(wpId) ?? [],
            statusById,
            startInstant,
            fallbackFromWp(wp, statusById),
            wp?.createdAt ?? null,
          );
          out.push(
            toCandidate(wpId, wp?.subject ?? `WP ${wpId}`, state, resolver.resolve(state.assignee_name)),
          );
        }
      }
      return { sprint_id: sprintId, start_date: sprint.start_date, items: out };
    },

    async reconstructManualAdd(sprintId: number, wpOpId: number): Promise<number | null> {
      const sprint = await repos.sprints.getById(sprintId);
      if (!sprint) throw new AppError("SPRINT_NOT_FOUND", `Sprint ${sprintId} not found`);
      const startInstant = `${sprint.start_date}T23:59:59Z`;
      // Resolve the ticket's connection from cache (else current) — scoping invariant.
      const cached = await repos.workPackages.getByOpId(wpOpId);
      const connectionId =
        cached?.connection_id ?? (await repos.connections.getCurrent())?.id ?? null;
      if (connectionId === null) {
        throw new AppError("NO_CONNECTION", "No OpenProject connection configured");
      }
      const op = await deps.buildClientForConnection(connectionId);
      const statusById = await loadStatusMap(op);
      const wps = await fetchAllWorkPackages(op, {
        filters: [{ id: { operator: "=", values: [String(wpOpId)] } }],
        pageSize: 1,
      });
      const wp = wps[0] ?? null;
      if (!wp) throw new AppError("WORK_PACKAGE_NOT_FOUND", `Work package ${wpOpId} not found in OpenProject`);
      await repos.workPackages.upsertMany([
        toWorkPackageCacheRow(wp, statusById, null, connectionId),
      ]);
      // Increment 40 (§2.A3): best-effort project identifier/name refresh.
      await refreshProjectsBestEffort(op, repos, connectionId, projectOpIdsOf([wp]));
      const activities = (await fetchActivitiesByWpIds(op, [wpOpId])).get(wpOpId) ?? [];
      const state = reconstruct.stateAtDate(
        activities,
        statusById,
        startInstant,
        fallbackFromWp(wp, statusById),
        wp.createdAt ?? null,
      );
      await repos.ticketBaselines.upsertMany([
        buildReconBaseline({
          sprintId,
          wpOpId,
          capturedAt: startInstant,
          subject: wp.subject,
          state,
          currentWp: wp,
          closedByName: statusClosedByName([statusById]),
          origin: "baseline",
        }),
      ]);
      const override = await repos.estimateOverrides.getByWpOpId(wpOpId);
      return effectiveEstimate(
        state.estimated_hours,
        state.remaining_hours,
        override?.planning_hours ?? null,
      );
    },

    async runReplay(sprintId: number, runId: number): Promise<void> {
      // Consolidation Round (Concept 8) — retro replay is a sprint_update_run
      // too; register a hard-cancel controller so a hung/overlong replay can be
      // physically cancelled (parity with sync + the live lifecycle). Every
      // partition client is wrapped with the run's cancel signal
      // (withRunCancelSignal, shared with sprintUpdate.ts). Unregistered in the
      // finally — the controller must never outlive the run.
      const controller = new AbortController();
      registerSprintUpdateController(runId, controller);
      try {
        const sprint = await repos.sprints.getById(sprintId);
        if (!sprint) throw new AppError("SPRINT_NOT_FOUND", `Sprint ${sprintId} not found`);
        const startInstant = `${sprint.start_date}T23:59:59Z`;
        const items = (await repos.sprintItems.listBySprint(sprintId)).filter(
          (i) => i.outcome !== "removed" && i.outcome !== "removed_mid_sprint",
        );
        const wpOpIds = items.map((i) => i.wp_op_id);
        const rawParts = wpOpIds.length > 0 ? await partitionSprint(wpOpIds) : [];
        const parts = rawParts.map((p) => ({
          ...p,
          op: withRunCancelSignal(p.op, controller.signal),
        }));
        const gathered = await gatherReplayData(parts);
        const { ticketData, loggedByDay, closedByName } = gathered;

        // Reconstruct each ticket's state at start_date (baseline anchor).
        const startState = new Map<number, ReconstructedWpState>();
        for (const [wpId, data] of ticketData) {
          startState.set(
            wpId,
            reconstruct.stateAtDate(
              data.activities,
              data.statusById,
              startInstant,
              fallbackFromWp(data.currentWp, data.statusById),
              data.currentWp?.createdAt ?? null,
            ),
          );
        }

        // Ensure a baseline row exists for every item (a manual-add path may have
        // captured it already; re-capture is an idempotent upsert). captured_at =
        // start_date (SPEC_12 §2 step 1).
        const baselineRows: NewTicketBaseline[] = [];
        for (const [wpId, data] of ticketData) {
          const state = startState.get(wpId)!;
          baselineRows.push(
            buildReconBaseline({
              sprintId,
              wpOpId: wpId,
              capturedAt: startInstant,
              subject: data.currentWp?.subject ?? `WP ${wpId}`,
              state,
              currentWp: data.currentWp,
              closedByName,
              origin: "baseline",
            }),
          );
        }
        if (baselineRows.length > 0) await repos.ticketBaselines.upsertMany(baselineRows);

        const entryDate = new Map<number, string>();
        const exitDate = new Map<number, string>();
        for (const wpId of ticketData.keys()) entryDate.set(wpId, sprint.start_date);

        // ── Created-after-start_date tickets (SPEC_13 §2) ────────────────────
        // A ticket that didn't exist at start_date is NOT a baseline: enter it
        // as a scope addition (origin="added_mid_sprint") at its creation date,
        // via the SAME reAddAsMidSprint mechanism as version churn — so it's
        // excluded from baseline_total and renders as a red increment.
        for (const [wpId, data] of ticketData) {
          const st = startState.get(wpId)!;
          if (st.not_yet_created && st.created_at) {
            entryDate.set(wpId, st.created_at.slice(0, 10));
            await reAddAsMidSprint(sprintId, wpId, st.created_at, data, closedByName);
          }
        }

        // ── Scope churn (SPEC_12 §3), only for a version-seeded sprint ────────
        // entryDate[wp] defaults to start_date; a ticket that entered the sprint's
        // version AFTER start_date becomes an added_mid_sprint increment at that
        // date (not baseline), and a "left" event descopes it (removed_mid_sprint)
        // from exitDate onward — mirroring the LIVE (non-retro) burndown path
        // (packages/sync's computeSnapshot), which excludes removed_mid_sprint
        // items entirely once removed. Half-open interval [entryDate, exitDate):
        // the ticket still counts on its departure day's eve, not from exitDate on.
        // (entryDate/exitDate declared above — created-after tickets already
        // seeded their entry date there.)
        if (sprint.retro_seed_kind === "version" && sprint.retro_seed_value) {
          for (const [wpId, data] of ticketData) {
            const events = reconstruct.versionScopeEvents(data.activities, sprint.retro_seed_value);
            const after = events.filter((e) => e.occurred_at.slice(0, 10) > sprint.start_date);
            const entered = after.find((e) => e.direction === "entered");
            const left = after.find((e) => e.direction === "left");
            if (entered) {
              const enteredDate = entered.occurred_at.slice(0, 10);
              entryDate.set(wpId, enteredDate);
              const item = await repos.sprintItems.getBySprintAndWp(sprintId, wpId);
              if (item) await repos.sprintItems.setOutcome(item.id, "planned", null);
              // Re-capture the baseline at the entry date, origin=added_mid_sprint,
              // and flip the sprint_item's origin via a fresh add is not possible
              // (no origin setter) — the baseline origin + capacity red rely on
              // the item.origin, so we delete+re-add the item as added_mid_sprint.
              await reAddAsMidSprint(sprintId, wpId, entered.occurred_at, data, closedByName);
            } else if (left) {
              exitDate.set(wpId, left.occurred_at.slice(0, 10));
              const item = await repos.sprintItems.getBySprintAndWp(sprintId, wpId);
              if (item) await repos.sprintItems.setOutcome(item.id, "removed_mid_sprint", left.occurred_at);
            }
          }
        }

        // ── Freeze baseline total = Σ baseline items' effective hours @ start ──
        const overrides = await repos.estimateOverrides.getManyByWpOpIds([...ticketData.keys()]);
        const ovById = new Map(overrides.map((o) => [o.wp_op_id, o]));
        const baselineTotal = leafEffort(
          [...ticketData.entries()]
            .filter(([wpId]) => entryDate.get(wpId) === sprint.start_date)
            .map(([wpId, data]) => ({
              wp_op_id: wpId,
              parent_op_id: parseOpId(data.currentWp?._links.parent?.href ?? null),
              hours: effectiveEstimate(
                startState.get(wpId)!.estimated_hours,
                startState.get(wpId)!.remaining_hours,
                ovById.get(wpId)?.planning_hours ?? null,
              ),
            })),
        ).total;

        // ── Flip planning→active FIRST (sets activated_at + baseline_total) ────
        await repos.sprints.activate(sprintId, startInstant, baselineTotal);

        // ── Day-by-day replay (source="reconstructed") ────────────────────────
        const today = nowIso().slice(0, 10);
        const lastDay = minDate(today, sprint.end_date);
        const remainingRules = await repos.remainingStatusRules.listBySprint(sprintId);
        const remainingSet = remainingStatusSet(remainingRules);
        await writeReconstructedBurndown({
          sprintId,
          startDate: sprint.start_date,
          endDate: sprint.end_date,
          lastDay,
          baselineTotal,
          ticketData,
          loggedByDay,
          closedByName,
          remainingSet,
          inScopeAt: (wpId, day) => {
            const entry = entryDate.get(wpId) ?? sprint.start_date;
            const exit = exitDate.get(wpId);
            return entry <= day && (exit === undefined || day < exit);
          },
          // Progress "day X / Y" (SPEC_12 §9). NOTE: for a retro activation,
          // total_count is the number of DAYS to replay, NOT the ticket count that
          // every OTHER run kind uses — the frontend's day-X/Y progress falls out
          // of the same polling UI.
          progress: (dayIndex, totalDays) =>
            repos.sprintUpdateRuns.progress(runId, dayIndex, totalDays),
        });

        // ── Changelog across the whole window (same deriveChangelogEvents path) ─
        let changesCount = 0;
        for (const part of gathered.parts) {
          changesCount += await persistReplayChangelog(part, ticketData, sprintId, runId, startInstant);
        }

        // ── End of replay (SPEC_12 §2) ────────────────────────────────────────
        // Past window → auto-lock via the EXISTING closure path; still-open →
        // stay active and behave as a normal live sprint from today onward.
        if (sprint.end_date < today) {
          await performClosure(repos, sprintId, nowIso(), "end_date");
        }
        // retro_replayed_at marks the replay finished (both paths count).
        await repos.sprints.update(sprintId, { retro_replayed_at: nowIso() });
        await repos.sprintUpdateRuns.finish(
          runId,
          "success",
          calendarDays(sprint.start_date, lastDay).length,
          changesCount,
          null,
          nowIso(),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // A user-requested hard cancel finishes "aborted", not "error".
        await repos.sprintUpdateRuns.finish(runId, runFinishStatus(err), null, null, message, nowIso());
      } finally {
        unregisterSprintUpdateController(runId);
      }
    },

    async rebuildBurndown(sprintId: number): Promise<BurndownResponse> {
      const sprint = await repos.sprints.getById(sprintId);
      if (!sprint) throw new AppError("SPRINT_NOT_FOUND", `Sprint ${sprintId} not found`);
      const items = (await repos.sprintItems.listBySprint(sprintId)).filter(
        (i) => i.outcome !== "removed" && i.outcome !== "removed_mid_sprint",
      );
      const wpOpIds = items.map((i) => i.wp_op_id);
      // Increment 25 (SPEC_25 §4): an added_retroactively item only entered scope
      // on its OWN backdated added_at day — so it must NOT count on earlier
      // burndown days (the scope bump lands on the real day, not day 1). Every
      // other origin keeps counting on every day (unchanged: inScopeAt→true).
      const itemByWp = new Map(items.map((i) => [i.wp_op_id, i] as const));
      const parts = wpOpIds.length > 0 ? await partitionSprint(wpOpIds) : [];
      const { ticketData, loggedByDay, closedByName } = await gatherReplayData(parts);

      // Ideal anchors on the frozen baseline once activated, else the live
      // committed total (identical fallback to GET /burndown / computeSnapshot).
      const baselineTotal =
        sprint.baseline_total_hours ?? items.reduce((s, it) => s + (it.planned_hours ?? 0), 0);
      const today = nowIso().slice(0, 10);
      const lastDay = minDate(today, sprint.end_date);
      const remainingSet = remainingStatusSet(await repos.remainingStatusRules.listBySprint(sprintId));
      // Entry date = start for every item (no version churn on a plain rebuild —
      // SPEC_12 §12 limitation for non-version sprints; a rebuild is status-neutral).
      await writeReconstructedBurndown({
        sprintId,
        startDate: sprint.start_date,
        endDate: sprint.end_date,
        lastDay,
        baselineTotal,
        ticketData,
        loggedByDay,
        closedByName,
        remainingSet,
        inScopeAt: (wpId, day) => {
          const item = itemByWp.get(wpId);
          if (item?.origin !== "added_retroactively") return true;
          return day >= item.added_at.slice(0, 10);
        },
      });
      // NEVER touches sprint.status/is_locked (SPEC_12 §5 / SPEC_11 §8a).
      const snapshots = await repos.burndown.listBySprint(sprintId);
      return buildBurndown(sprint, baselineTotal, snapshots);
    },
  };

  /** Delete + re-add a sprint item as origin="added_mid_sprint" (there's no
   * origin setter) and re-capture its baseline at the entry date — so retro
   * scope churn renders red exactly like a live mid-sprint add (SPEC_12 §3). */
  async function reAddAsMidSprint(
    sprintId: number,
    wpOpId: number,
    enteredInstant: string,
    data: TicketReconData,
    closedByName: Map<string, boolean>,
  ): Promise<void> {
    const existing = await repos.sprintItems.getBySprintAndWp(sprintId, wpOpId);
    const state = reconstruct.stateAtDate(
      data.activities,
      data.statusById,
      enteredInstant,
      fallbackFromWp(data.currentWp, data.statusById),
      data.currentWp?.createdAt ?? null,
    );
    if (existing) await repos.sprintItems.deleteMany([existing.id]);
    // SPEC_16 §5: route the reconstructed estimate through effectiveEstimate so a
    // retro mid-sprint re-add honours a local override and the remaining-work
    // preference, exactly like every other add/baseline path (this previously
    // used state.estimated_hours raw, silently bypassing even the override).
    const override = await repos.estimateOverrides.getByWpOpId(wpOpId);
    await repos.sprintItems.add({
      sprint_id: sprintId,
      wp_op_id: wpOpId,
      planned_hours: effectiveEstimate(
        state.estimated_hours,
        state.remaining_hours,
        override?.planning_hours ?? null,
      ),
      outcome: "planned",
      origin: "added_mid_sprint",
    });
    await repos.ticketBaselines.upsertMany([
      buildReconBaseline({
        sprintId,
        wpOpId,
        capturedAt: enteredInstant,
        subject: data.currentWp?.subject ?? `WP ${wpOpId}`,
        state,
        currentWp: data.currentWp,
        closedByName,
        origin: "added_mid_sprint",
      }),
    ]);
  }
}
