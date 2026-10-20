import type {
  ChangelogDetail,
  ClosureStatsResponse,
  DeveloperCapacityBreakdown,
  DeveloperSegmentsInput,
  DeveloperSegmentsTicketInput,
  PersonRole,
  TicketClosureDetail,
  TicketEstimateLine,
} from "@osp/contracts";
import type { FrozenSprintItemSnapshot, Repositories } from "@osp/db";
import { capacityEffectiveRole } from "@osp/contracts";
import { assigneeIntervals } from "@osp/op-client";
import { classifyWithRole } from "./doneRole";
import { developerSegmentsWithInternals } from "./developerSegments";
import { buildPersonResolver } from "./personResolver";
import { effectiveEstimate } from "./estimate";
import { computePlannedScope } from "./plannedScope";
import type { PlannedScopeItem } from "./plannedScope";
import { computeSprintMembership, multiSprintBadge } from "./multiSprint";
import { baselineRemaining } from "./closure";

/**
 * Increment 14 (SPEC_14 §3) — role-aware CLOSURE STATISTICS, computed fresh on
 * every read (no persisted cache: a `report_config` threshold or `done_rule`
 * edit is reflected immediately). Distinct from — and additive to — the OLD
 * sprint_closure_report (done/not_done/version_change, per-sprint done_status_
 * rule), which stays untouched.
 *
 * PURE STORED-DATA (SPEC_14 §4 "works backwards"): every input comes from the
 * local DB — sprint items, ticket_baseline, work_package_cache, and crucially
 * the ticket_changelog_entry `time_logged` rows (which carry actor_op_id /
 * actor_name = WHO logged, and detail {hours}) — so it works for an OLD closed
 * sprint with no live OP call. Logged-time attribution is therefore BY LOGGER
 * (SPEC_14 §3), never by assignee.
 */

type PersonKey = string;

/**
 * Increment 38 — the assignee's NAME as the baseline snapshot recorded it: the
 * reconstructed `assignee_name_raw` (retro), else the OP assignee link title
 * frozen in `raw_json` at activation. Never the live/current assignee — that
 * fallback made every ticket reassigned after activation look as if its
 * CURRENT holder had held it at the anchor (the Cameron Dalby case: his
 * whole 87 h baseline vanished from his bar). Null when the snapshot carries no
 * name (unassigned at activation, or an unparseable raw_json).
 */
function baselineAssigneeName(b: { assignee_name_raw: string | null; raw_json: string }): string | null {
  if (b.assignee_name_raw != null) return b.assignee_name_raw;
  try {
    const raw = JSON.parse(b.raw_json) as { _links?: { assignee?: { title?: unknown } } };
    const title = raw?._links?.assignee?.title;
    return typeof title === "string" && title.trim() !== "" ? title : null;
  } catch {
    return null;
  }
}

interface ResolvedPerson {
  key: PersonKey;
  member_id: number | null;
  op_user_id: number | null;
  name: string;
  role: PersonRole;
}

/**
 * Increment 37 (`docs/INCREMENT_37_CONTRACTS.md` §2.2; CAPACITY_BAR_RULES §6
 * invariant 5 extension) — the RESULT of `computeClosureStatsWithInternals`:
 * the same `ClosureStatsResponse` the plain function returns, plus the
 * per-ticket CREDITED delivered map `developerSegments` produced along the
 * way (`wp_op_id → hours`), engine-internal — not part of the HTTP contract
 * surface. Its Σ equals `stats.total_delivered_hours` by construction; a
 * ticket whose burn was dropped (no developer to credit) is simply absent.
 */
export interface ClosureStatsWithInternals {
  stats: ClosureStatsResponse;
  deliveredByTicket: ReadonlyMap<number, number>;
}

/**
 * The plain, pre-Increment-37 entry point — UNCHANGED signature and return
 * value for every existing caller (capacitySummary.ts, report.ts,
 * statusReport.ts, the GET /sprints/:id/closure-stats route). Delegates to
 * `computeClosureStatsWithInternals` so there is exactly ONE implementation.
 */
export async function computeClosureStats(
  repos: Repositories,
  sprintId: number,
  generatedAt: string,
): Promise<ClosureStatsResponse> {
  return (await computeClosureStatsWithInternals(repos, sprintId, generatedAt)).stats;
}

export async function computeClosureStatsWithInternals(
  repos: Repositories,
  sprintId: number,
  generatedAt: string,
): Promise<ClosureStatsWithInternals> {
  // ── THE canonical person identity (HANDOFF unification; golden tests
  //    `identity-golden*.test.ts`). One resolver, built from team_member +
  //    user_name_alias + every (name ↔ id) pair the sprint's own data teaches
  //    (cached WP assignees, frozen baselines, time-log actors), applied BEFORE
  //    keying — so `id:1:64` / `id:-:64` (connection unknown, e.g. a purged
  //    cache row) / `nm:Jan Belka` (id unknown) are ONE key, and Closure can
  //    never render one person as multiple rows again. The old local
  //    `resolvePerson` fragmented exactly like that in production and is
  //    deleted; `createPersonResolver` (packages/contracts) is the single
  //    implementation every surface shares. Cross-connection numeric
  //    collisions stay split (Concept 4 — the resolver's contradiction guard).
  const resolver = await buildPersonResolver(repos);
  // Not a second definition — a direct alias of THE canonical resolution.
  // (The resolver already emits the shared "Unknown user (<id>)" label shape,
  // never a fabricated "User <id>" — the Increment-13 invariant.)
  const resolvePerson = (
    connectionId: number | null,
    opUserId: number | null,
    name: string | null,
  ): ResolvedPerson | null => resolver.resolve(connectionId, opUserId, name);

  // ── Items + their frozen baselines + live cache image ─────────────────────
  // Increment 35 (docs/INCREMENT_35_CONTRACTS.md §3) — the UNFILTERED row set
  // is kept around (as `allSprintItems`) so the scope-origin split below can
  // include `removed_mid_sprint` items (SPEC_05 §1 — committed, worked, then
  // descoped; their logged hours are real) without a second query. `items`
  // keeps its long-standing in-scope filter for every OTHER computation in
  // this function.
  const allSprintItems = await repos.sprintItems.listBySprint(sprintId);
  const items = allSprintItems.filter(
    (i) => i.outcome !== "removed" && i.outcome !== "removed_mid_sprint",
  );
  const wps = await repos.workPackages.getManyByOpIds(items.map((i) => i.wp_op_id));
  const wpById = new Map(wps.map((w) => [w.op_id, w]));
  // Teach the resolver every (name ↔ id) pair this sprint's data knows, BEFORE
  // any resolution: cached assignees (connection known) and frozen baseline
  // assignees. This replaces the old order-dependent `nameToOpUserFromLogs`
  // (BUG 1 / SPEC_17 §3 key alignment) — time-log actors are learned in a
  // dedicated pre-scan below, so resolution no longer depends on loop order.
  for (const w of wps) {
    if (w.assignee_op_id != null && w.assignee_name != null) {
      resolver.learn({
        name: w.assignee_name,
        op_user_id: w.assignee_op_id,
        connection_id: w.connection_id ?? null,
      });
    }
  }
  const baselines = await repos.ticketBaselines.listBySprint(sprintId);
  const baselineByWp = new Map(baselines.map((b) => [b.wp_op_id, b]));
  for (const b of baselines) {
    const opId = b.assignee_op_id ?? b.original_assignee_op_id;
    if (opId != null && b.assignee_name_raw != null) {
      resolver.learn({
        name: b.assignee_name_raw,
        op_user_id: opId,
        connection_id: wpById.get(b.wp_op_id)?.connection_id ?? null,
      });
    }
  }

  // Fetched here (rather than down near baselineAnchor, where it used to be
  // read for the first time) because Increment 31's frozen-snapshot gate,
  // right below, needs `sprint.frozen_at` before anything else in this
  // function runs.
  const sprint = await repos.sprints.getById(sprintId);

  // ── Increment 31 (docs/INCREMENT_31_CONTRACTS.md §0/§2c) — a FROZEN sprint
  //    reads its numbers from the freeze-time snapshot, never the live cache,
  //    so `work_package_cache` mutating or being deleted (Import cleanup)
  //    afterward moves NOTHING (CAPACITY_BAR_RULES §6 invariant 10). Loaded
  //    unconditionally (cheap, one indexed query) and only CONSULTED when the
  //    sprint is actually frozen — see `preferFrozen` below. Learn every
  //    (name ↔ id) pair the snapshot itself knows too, so identity resolution
  //    stays stable even once the cache row it originally came from is gone.
  const isFrozen = sprint?.frozen_at != null;
  const frozenByWp: Map<number, FrozenSprintItemSnapshot> = isFrozen
    ? new Map((await repos.sprintItems.listFrozenSnapshot(sprintId)).map((f) => [f.wp_op_id, f]))
    : new Map();
  for (const f of frozenByWp.values()) {
    if (f.frozen_assignee_op_id != null && f.frozen_assignee_name != null) {
      resolver.learn({
        name: f.frozen_assignee_name,
        op_user_id: f.frozen_assignee_op_id,
        connection_id: f.frozen_connection_id,
      });
    }
  }
  // Invariant 10 (CAPACITY_BAR_RULES §6.10), strengthened at integration: a
  // FROZEN sprint never consults the live cache row at all — the per-field
  // snapshot preference already pinned every NUMBER, but display passthroughs
  // (subject, …) and the logger-connection lookups would still follow live
  // mutations. Dropping the map makes the frozen response ≡ the post-deletion
  // response by construction. (The name↔id pairs the rows taught were learned
  // above, BEFORE this point — identity resolution keeps its full knowledge.)
  if (isFrozen) wpById.clear();
  /** Prefer the frozen snapshot's value over a live one — ONLY when the
   * sprint is actually frozen, and only when the snapshot itself has a
   * non-null value (a defensive fallback for the "item existed but was
   * somehow never snapshotted" edge case, never expected in practice since
   * freeze.ts snapshots every non-removed item). */
  function preferFrozen<T>(frozenValue: T | null | undefined, liveValue: T): T {
    return isFrozen && frozenValue != null ? frozenValue : liveValue;
  }
  // Increment 28 (INCREMENT_28_CONTRACTS §1a): local estimate overrides, so the
  // estimate of record below resolves through the SAME effectiveEstimate as the
  // rest of the app (CAPACITY_BAR_RULES §3, binding).
  const estimateOverrides = await repos.estimateOverrides.getManyByWpOpIds(
    allSprintItems.map((i) => i.wp_op_id),
  );
  const overrideByWp = new Map(estimateOverrides.map((o) => [o.wp_op_id, o.planning_hours]));
  /**
   * Increment 38 — the estimate a baseline ticket carried AT ACTIVATION, i.e.
   * what its holder was signed up for (`CAPACITY_BAR_RULES.md` §5 Baseline):
   * effectiveEstimate over the frozen `ticket_baseline` snapshot. A retro
   * sprint's snapshot figure is the reconstructed `planned_hours` (the same
   * exception the estimate of record makes); no usable snapshot → the
   * add-time `planned_hours`. Null (non-baseline) lets the engine fall back.
   */
  const baselineCommitHours = (
    it: { wp_op_id: number; planned_hours: number | null },
    b: { origin: string; estimated_hours: number | null; remaining_hours: number | null } | null,
  ): number | null => {
    if (sprint?.is_retrospective === true || b == null || b.origin !== "baseline") {
      return it.planned_hours;
    }
    return (
      effectiveEstimate(b.estimated_hours, b.remaining_hours, overrideByWp.get(it.wp_op_id) ?? null) ??
      it.planned_hours
    );
  };
  const rules = await repos.doneRules.list();
  const { overshoot_threshold_pct } = await repos.reportConfig.get();

  // ── Increment 15 — developer-segments engine input assembly (SPEC_15 §5/§6).
  //    The baseline anchor is start_date for a retrospective sprint, else the
  //    activation moment (activated_at); holder-at-anchor = the baseline dev.
  //    END OF start_date (T23:59:59Z), NOT midnight — matches retro.ts's own
  //    `startInstant` convention exactly (its /retro/seed + activate/replay
  //    baseline reconstruction), so a day-0 event (mock/OP mutation timestamps
  //    land at T09:00:00Z+) is visible to BOTH the persisted ticket_baseline
  //    AND this engine's own assignee-interval fold — a midnight anchor would
  //    silently exclude every same-day event from "at/before the anchor". ──
  const baselineAnchor =
    sprint == null
      ? `${generatedAt}`
      : sprint.is_retrospective
        ? `${sprint.start_date}T23:59:59Z`
        : (sprint.activated_at ?? `${sprint.start_date}T23:59:59Z`);
  const roleByPerson: Record<PersonKey, PersonRole> = {};
  const personMeta: Record<
    PersonKey,
    { name: string; op_user_id: number | null; member_id: number | null }
  > = {};
  const registerPerson = (p: ResolvedPerson): void => {
    // The ENGINE's role map gets the capacity-surface EFFECTIVE role
    // (unset/unknown → developer — the same default /capacity has always
    // applied via `capacityRoleForMemberRole`), so a person /capacity counts
    // can never be invisible here (invariant 5; the Zbynek Trnka defect).
    // Ticket CLASSIFICATION (classifyWithRole) keeps the RAW role — there
    // "unset" must stay ambiguous ("admit, don't infer").
    roleByPerson[p.key] = capacityEffectiveRole(p.role);
    personMeta[p.key] = { name: p.name, op_user_id: p.op_user_id, member_id: p.member_id };
  };
  const dev_done_statuses = rules
    .filter((r) => r.kind === "always_done")
    .map((r) => r.status_name);
  // Per-ticket timelines/status transitions, folded from the stored changelog.
  const assigneeEventsByWp = new Map<
    number,
    Array<{ from: string | null; to: string | null; at: string }>
  >();
  const statusTransByWp = new Map<
    number,
    Array<{ from: string | null; to: string; at: string }>
  >();
  const firstLoggedByWpByPerson = new Map<number, Map<PersonKey, string>>();

  // ── Logged time, from stored time_logged changelog rows (attribution by the
  //    person who LOGGED it). Build per-wp totals, per-wp dev-only totals, and
  //    per (wp, logger) hours (for per-developer accuracy on done tickets). ──
  const changelog = await repos.ticketChangelog.listBySprint(sprintId);
  // Pre-scan: learn every time-log actor's (name ↔ id) pair BEFORE any
  // resolution (BUG 1 / SPEC_17 §3 key alignment, now order-independent —
  // the old in-loop learning meant a holder resolved BEFORE the teaching log
  // row was reached kept the wrong key).
  for (const e of changelog) {
    if (e.kind !== "time_logged") continue;
    if (e.actor_op_id != null && e.actor_name != null) {
      resolver.learn({
        name: e.actor_name,
        op_user_id: e.actor_op_id,
        connection_id: wpById.get(e.wp_op_id)?.connection_id ?? null,
      });
    }
  }
  const loggedByWp = new Map<number, number>();
  const devLoggedByWp = new Map<number, number>();
  const loggedByWpByPerson = new Map<number, Map<PersonKey, number>>();
  const loggedByPerson = new Map<PersonKey, { person: ResolvedPerson; hours: number }>();
  let totalLogged = 0;
  let totalDevLogged = 0;
  for (const e of changelog) {
    const detail = JSON.parse(e.detail_json) as ChangelogDetail;
    const wp = e.wp_op_id;

    // Collect assignee/status timelines for the developerSegments engine.
    if (e.kind === "assignee_changed" && detail.kind === "assignee_changed") {
      const arr = assigneeEventsByWp.get(wp) ?? [];
      arr.push({ from: detail.from, to: detail.to, at: e.occurred_at });
      assigneeEventsByWp.set(wp, arr);
      continue;
    }
    if (e.kind === "status_changed" && detail.kind === "status_changed") {
      const arr = statusTransByWp.get(wp) ?? [];
      arr.push({ from: detail.from, to: detail.to, at: e.occurred_at });
      statusTransByWp.set(wp, arr);
      continue;
    }

    if (e.kind !== "time_logged") continue;
    if (detail.kind !== "time_logged") continue;
    // FOLLOWUPS #8 (user decision: the sprint's CALENDAR window is
    // authoritative) — Logged counts only spent_on within
    // [start_date, end_date], applied at READ time as well as at derivation:
    // rows written under the older, wider windows (replay rows reaching before
    // start_date; grace updates that vacuumed the successor sprint's work on
    // shared tickets) stay stored as history but never count here. Matches the
    // burnup's bounds exactly, so the two surfaces reconcile by construction.
    const spentOn = detail.spent_on ?? null;
    if (
      sprint != null &&
      spentOn != null &&
      (spentOn < sprint.start_date || spentOn > sprint.end_date)
    ) {
      continue;
    }
    const hours = detail.hours ?? 0;
    if (hours === 0) continue;
    loggedByWp.set(wp, (loggedByWp.get(wp) ?? 0) + hours);
    totalLogged += hours;

    // The connection is the ticket's own — a logger's identity is scoped to the
    // server their ticket lives on (null when the wp isn't in this sprint's cache
    // — the resolver folds that back onto the person's one key).
    const loggerConn = wpById.get(wp)?.connection_id ?? null;
    const logger = resolvePerson(loggerConn, e.actor_op_id, e.actor_name);
    // Identity unification: the CAPACITY role default (unset/unknown →
    // developer — `capacityRoleForMemberRole`'s long-standing rule) now applies
    // here too, so a logging person with no team_member row is counted exactly
    // like /capacity counts them instead of silently vanishing (the Zbynek
    // Trnka defect). The done-matrix below still sees the RAW role.
    const isDevLogger = logger != null && capacityEffectiveRole(logger.role) === "developer";
    if (isDevLogger) {
      devLoggedByWp.set(wp, (devLoggedByWp.get(wp) ?? 0) + hours);
      totalDevLogged += hours;
    }
    if (logger) {
      registerPerson(logger);
      const lp = loggedByPerson.get(logger.key) ?? { person: logger, hours: 0 };
      lp.hours += hours;
      loggedByPerson.set(logger.key, lp);
      let perWp = loggedByWpByPerson.get(wp);
      if (!perWp) {
        perWp = new Map();
        loggedByWpByPerson.set(wp, perWp);
      }
      perWp.set(logger.key, (perWp.get(logger.key) ?? 0) + hours);
      // Earliest logged spentOn per (wp, developer) — DELIVERED tie-break 4c.
      if (isDevLogger) {
        const spentOn = detail.spent_on;
        let perWpFirst = firstLoggedByWpByPerson.get(wp);
        if (!perWpFirst) {
          perWpFirst = new Map();
          firstLoggedByWpByPerson.set(wp, perWpFirst);
        }
        const prev = perWpFirst.get(logger.key);
        if (prev == null || Date.parse(spentOn) < Date.parse(prev)) {
          perWpFirst.set(logger.key, spentOn);
        }
      }
    }
  }

  // ── Increment 34 (docs/INCREMENT_34_CONTRACTS.md §2/§3) — cross-sprint
  //    TICKET MEMBERSHIP (multi_sprint badge inputs) + CUMULATIVE dev-logged
  //    time, batched (§0 pillar 2: local data only, never N+1). One
  //    `findByWpOpIds` + one `sprints.getById` batch (computeSprintMembership),
  //    then one `ticketChangelog.listBySprint` per DISTINCT member sprint
  //    (reusing THIS sprint's already-fetched `changelog`) — bounded by the
  //    number of sprints these tickets ever touched, never per-ticket. ──
  const wpOpIdsForItems = items.map((i) => i.wp_op_id);
  const membership = await computeSprintMembership(repos, wpOpIdsForItems);
  const changelogBySprint = new Map<number, typeof changelog>();
  changelogBySprint.set(sprintId, changelog);
  const otherMemberSprintIds = [...membership.sprintById.keys()].filter((id) => id !== sprintId);
  await Promise.all(
    otherMemberSprintIds.map(async (id) => {
      changelogBySprint.set(id, await repos.ticketChangelog.listBySprint(id));
    }),
  );
  // Per (member sprint) dev-logged hours per wp — computed on demand, cached,
  // via the SAME calendar-window + effective-role-default rule this file
  // already applies to `changelog` above (FOLLOWUPS #8 unification).
  const devLoggedByWpBySprintCache = new Map<number, Map<number, number>>();
  function devLoggedByWpForSprint(sId: number): Map<number, number> {
    const cached = devLoggedByWpBySprintCache.get(sId);
    if (cached) return cached;
    const s = membership.sprintById.get(sId);
    const cl = changelogBySprint.get(sId) ?? [];
    const m = new Map<number, number>();
    for (const e of cl) {
      if (e.kind !== "time_logged") continue;
      const detail = JSON.parse(e.detail_json) as ChangelogDetail;
      if (detail.kind !== "time_logged") continue;
      const spentOn = detail.spent_on ?? null;
      if (s != null && spentOn != null && (spentOn < s.start_date || spentOn > s.end_date)) continue;
      const hours = detail.hours ?? 0;
      if (hours === 0) continue;
      const loggerConn = wpById.get(e.wp_op_id)?.connection_id ?? null;
      const logger = resolvePerson(loggerConn, e.actor_op_id, e.actor_name);
      const isDevLogger = logger != null && capacityEffectiveRole(logger.role) === "developer";
      if (!isDevLogger) continue;
      m.set(e.wp_op_id, (m.get(e.wp_op_id) ?? 0) + hours);
    }
    devLoggedByWpBySprintCache.set(sId, m);
    return m;
  }
  const cumulativeDevLoggedByWp = new Map<number, number>();
  for (const wpId of wpOpIdsForItems) {
    const memberSprintIds = membership.sprintIdsByWp.get(wpId) ?? [sprintId];
    let sum = 0;
    for (const sId of memberSprintIds) sum += devLoggedByWpForSprint(sId).get(wpId) ?? 0;
    cumulativeDevLoggedByWp.set(wpId, sum);
  }

  // ── Per-ticket classification + estimate lines ────────────────────────────
  const done: TicketClosureDetail[] = [];
  const not_done: TicketClosureDetail[] = [];
  const rejected: TicketClosureDetail[] = [];
  const ambiguous: TicketClosureDetail[] = [];
  const anomalies: TicketClosureDetail[] = [];
  const perTicket: TicketEstimateLine[] = [];

  // Increment 15: per-ticket inputs handed to the developerSegments engine —
  // PLANNED / DELIVERED / accuracy / overshoot and the capacity-bar segments are
  // ALL computed there now (SPEC_15 §2/§3), replacing the old start-date-otisk +
  // current-holder attribution below.
  const ticketInputs: DeveloperSegmentsTicketInput[] = [];

  /**
   * Increment 30 (`docs/INCREMENT_30_CONTRACTS.md` §2) — inputs to THE canonical
   * `Planned` rule, the very same helper `computeCapacity` uses. Assembled here
   * because only this function knows each ticket's parent edge (needed by the
   * leaf double-count guard) and its CURRENT holder as the live cache sees it —
   * exactly the sources `/capacity` reads, so the two surfaces agree by
   * construction rather than by two formulas happening to land on the same
   * number (`CAPACITY_BAR_RULES.md` §0/§6.5).
   */
  const plannedScopeItems: PlannedScopeItem<PersonKey>[] = [];
  /** §2c — each ticket's authoritative CURRENT holder, shared with the engine. */
  const plannedHolderByTicket = new Map<number, PersonKey | null>();

  // Top-level estimate-accuracy accumulators (DONE tickets with an estimate).
  let doneEstSum = 0;
  let doneDevLoggedSum = 0;
  let anyDoneWithBoth = false;
  let overshootHoursSum = 0;

  for (const it of items) {
    const wp = wpById.get(it.wp_op_id) ?? null;
    const b = baselineByWp.get(it.wp_op_id) ?? null;
    const frozen = frozenByWp.get(it.wp_op_id);
    // This ticket's connection scopes every identity resolved from it (holder,
    // baseline holder, interval holders) — Concept 4 cross-connection isolation.
    // Increment 31 (§2c): a FROZEN sprint prefers frozen_connection_id — the
    // identity scope captured at freeze time, immune to a later cache purge.
    const itemConn = preferFrozen(frozen?.frozen_connection_id, wp?.connection_id ?? null);
    const subject = wp?.subject ?? b?.subject ?? `WP ${it.wp_op_id}`;
    // Increment 31 (§2c): classification status prefers the frozen snapshot.
    const status_name = preferFrozen(
      frozen?.frozen_status_name,
      wp?.status_name ?? b?.status_name ?? "",
    );
    const status_is_closed = preferFrozen(
      frozen?.frozen_status_is_closed,
      wp?.status_is_closed ?? b?.status_is_closed ?? false,
    );
    // Increment 31 (§2c): classification holder prefers the frozen snapshot.
    const holderOpUser = preferFrozen(
      frozen?.frozen_assignee_op_id,
      wp?.assignee_op_id ?? b?.assignee_op_id ?? null,
    );
    const holderName = preferFrozen(
      frozen?.frozen_assignee_name,
      wp?.assignee_name ?? b?.assignee_name_raw ?? null,
    );
    const holder = resolvePerson(itemConn, holderOpUser, holderName); // null → genuinely unassigned
    const holderRole: PersonRole | null = holder ? holder.role : null;

    const cls = classifyWithRole(
      { status_name, status_is_closed },
      holderRole,
      rules,
      holder?.name ?? null,
    );

    const detail: TicketClosureDetail = {
      wp_op_id: it.wp_op_id,
      subject,
      status_name,
      holder_name: holder?.name ?? null,
      holder_op_user_id: holder?.op_user_id ?? null,
      holder_role: holderRole,
      bucket: cls.bucket,
      ambiguous_reason: cls.ambiguous_reason,
      anomaly: cls.anomaly,
    };
    if (cls.bucket === "done") done.push(detail);
    else if (cls.bucket === "not_done") not_done.push(detail);
    else if (cls.bucket === "rejected") rejected.push(detail);
    else ambiguous.push(detail);
    if (cls.anomaly !== null) anomalies.push(detail);

    // ── Estimate of record (Increment 28, INCREMENT_28_CONTRACTS §1a) ────────
    // Was `it.planned_hours` — the snapshot frozen when the item was ADDED to
    // the sprint. That silently diverged from `docs/CAPACITY_BAR_RULES.md` §3
    // ("Bar length = effectiveEstimate"), which is binding: an estimate changed
    // after the item was added left `scope_planned_hours` (the Capacity panel's
    // "Planned" headline), Closure's totals and the GREEN BAR'S LENGTH
    // (`segments[].estimate_hours`) showing the stale value, while
    // `capacity.lines[].planned_hours` — computed from the live estimate —
    // showed the new one. That is the user's reported symptom, and no amount of
    // frontend refetching could fix it.
    //
    // Resolution is now IDENTICAL to GET /sprints/:id/items/detailed's
    // `effective_hours` (live cache row, falling back to the frozen
    // ticket_baseline for a sprint whose cache row is gone), so Closure, the
    // item list, the Capacity header and the PDF agree by construction
    // (CAPACITY_BAR_RULES §5 invariant 5).
    //
    // Two deliberate exceptions keep untouched data byte-identical:
    //   1. A RETROSPECTIVE sprint's estimate of record is a RECONSTRUCTED
    //      historical figure (retro.ts writes it into planned_hours from the
    //      ticket's state at start_date). Today's live estimate is the wrong
    //      number there by definition, so the snapshot still wins.
    //   2. No live source at all (no cache row AND no baseline row) — an old
    //      sprint whose work_package_cache rows were purged by an import
    //      removal. Falling back to the snapshot keeps such a sprint's numbers
    //      exactly as they are instead of collapsing them to null.
    //
    // Increment 31 (§2c) adds a THIRD, higher-precedence source: a FROZEN
    // sprint's estimate of record is `frozen_effective_hours`, checked BEFORE
    // the retro/no-live-source fallbacks above (a frozen sprint is, among
    // other things, provably never retrospective-in-planning — frozen only
    // ever follows a finish — so this never conflicts with exception 1).
    const liveEstimated = wp?.estimated_hours ?? b?.estimated_hours ?? null;
    const liveRemaining = wp?.remaining_hours ?? b?.remaining_hours ?? null;
    const hasLiveSource = wp != null || b != null;
    const liveEstimate =
      sprint?.is_retrospective === true || !hasLiveSource
        ? it.planned_hours
        : effectiveEstimate(liveEstimated, liveRemaining, overrideByWp.get(it.wp_op_id) ?? null);
    const estimate = preferFrozen(frozen?.frozen_effective_hours, liveEstimate);
    const wpDevLogged = devLoggedByWp.get(it.wp_op_id) ?? 0;
    const wpTotalLogged = loggedByWp.get(it.wp_op_id) ?? 0;

    // ── Increment 30 §2c/§2e — canonical Planned input, with ONE holder
    //    resolution shared with computeCapacity ──────────────────────────────
    // `items` above is already filtered to in-scope rows (removed /
    // removed_mid_sprint dropped), so every row here is in scope and holder
    // identity is the whole question.
    //
    // ⚠️ This deliberately does NOT reuse `holder` above. That one resolves
    // `wp?.assignee_op_id ?? b?.assignee_op_id` — i.e. it falls back to the
    // FROZEN BASELINE assignee when the live cache row has no assignee. For
    // classification (done bucket, holder_name, holder_role) that fallback is
    // right: an old sprint whose cache rows were purged still has to name a
    // holder. For PLANNED it is wrong, and measurably so: a developer who
    // abandoned a ticket mid-sprint (live assignee now null) kept its 6 h in
    // their Planned here, while `computeCapacity` filed the same ticket under
    // the Unassigned bucket. Two surfaces, two answers, breaking invariants 5
    // and 8. Assigned to nobody means assigned to nobody.
    //
    // §2e — `computeCapacity` has TWO holder sources, selected by sprint MODE
    // (`routes/index.ts`, `buildCapacityResponse`), and this mirrors that exact
    // selection rather than reimplementing either:
    //
    //   • a RETROSPECTIVE sprint still in PLANNING → `buildRetroPlanningCapItems`,
    //     whose roster identity is the RECONSTRUCTED start-date assignee
    //     (`ticket_baseline.assignee_name_raw`), explicitly "NOT the live/current
    //     assignee". A retro sprint is about the past — the same reasoning
    //     `CAPACITY_BAR_RULES.md` §5a already applies to the ESTIMATE. Resolved
    //     BY NAME (identity IS the name, Increment 13), which also keeps the key
    //     aligned with the interval holders, who resolve by name too.
    //   • every other sprint — including an ACTIVATED or CLOSED retrospective
    //     one, where `retroPlanning` is false — → `capItems`, i.e. the LIVE cache
    //     assignee with no baseline fallback (`wp?.assignee_op_id ?? null`).
    //     Keying this off `is_retrospective` alone would make Closure diverge
    //     from Capacity on exactly the closed retro sprints the e2e suite runs.
    const retroPlanningHolder =
      sprint?.is_retrospective === true && sprint.status === "planning";
    // Increment 31 (§2c): FROZEN takes precedence over the live-cache-only
    // rule above — `frozen_assignee_op_id/name` already IS "the current
    // holder as of freeze time" (freeze.ts wrote it from the same live-cache-
    // preferred, baseline-as-fallback resolution this file uses elsewhere),
    // so no further live/baseline fallback applies once frozen. A frozen
    // sprint can never ALSO be `retroPlanningHolder` (frozen only ever
    // follows a finish, i.e. status "closed"), so the two branches never race.
    const plannedHolder = retroPlanningHolder
      ? resolvePerson(itemConn, null, b?.assignee_name_raw ?? null)
      : isFrozen
        ? resolvePerson(itemConn, frozen?.frozen_assignee_op_id ?? null, frozen?.frozen_assignee_name ?? null)
        : resolvePerson(itemConn, wp?.assignee_op_id ?? null, wp?.assignee_name ?? null);
    // Registered so a holder who has no segment of their own (a changelog too
    // incomplete to reconstruct an interval for them) still resolves to a real
    // name and role rather than a bare key — see the roster safety net in
    // developerSegments.
    if (plannedHolder) registerPerson(plannedHolder);
    plannedHolderByTicket.set(it.wp_op_id, plannedHolder?.key ?? null);
    // Increment 31 (§2c): the leaf double-count guard's parent edge also
    // prefers the frozen snapshot, so deleting the cache row can never
    // silently un-suppress a parent/child pair that was suppressed at freeze.
    const parentOpId = preferFrozen(frozen?.frozen_parent_op_id, wp?.parent_op_id ?? null);
    plannedScopeItems.push({
      wp_op_id: it.wp_op_id,
      parent_op_id: parentOpId,
      holder_key: plannedHolder?.key ?? null,
      estimate_hours: estimate,
    });

    const isDone = cls.bucket === "done";
    // Increment 34 (§2, invariant 12): a DONE ticket's delta/overshoot measure
    // against CUMULATIVE dev-logged (Σ every member sprint's window), not this
    // sprint's window alone — equals wpDevLogged for a single-sprint ticket
    // (the membership map has exactly one entry, this sprint's own).
    const cumulativeDevLogged = cumulativeDevLoggedByWp.get(it.wp_op_id) ?? wpDevLogged;
    const delta = isDone && estimate != null ? cumulativeDevLogged - estimate : null;
    let overshootFlag: boolean | null = null;
    if (delta != null && estimate != null) {
      if (estimate > 0) overshootFlag = delta / estimate > overshoot_threshold_pct / 100;
      else overshootFlag = cumulativeDevLogged > 0; // 0-estimate + any dev time = overshoot
    }
    perTicket.push({
      wp_op_id: it.wp_op_id,
      subject,
      bucket: cls.bucket,
      // Increment 35 (docs/INCREMENT_35_CONTRACTS.md §2): the row's origin,
      // so the per-ticket table can badge added-during-sprint rows.
      origin: it.origin,
      estimate_hours: estimate,
      dev_logged_hours: wpDevLogged,
      total_logged_hours: wpTotalLogged,
      cumulative_dev_logged_hours: cumulativeDevLogged,
      multi_sprint: multiSprintBadge(membership, it.wp_op_id, sprintId),
      delta_hours: delta,
      overshoot_flag: overshootFlag,
    });

    // Top-level estimate accuracy + overshoot (DONE tickets with an estimate).
    // SPEC_14 §3: "Σ dev-logged / Σ odhad" over ALL done tickets — a done
    // ticket no developer logged time on (only a tester/customer touched it)
    // still contributes its estimate to the denominator with a 0 numerator,
    // correctly dragging the ratio down (an un-worked-by-dev "done" ticket is
    // exactly the situation this metric should flag, not silently exclude).
    // Increment 34 (§2): both sums now read CUMULATIVE dev-logged, matching
    // the per-ticket delta/overshoot_flag above.
    if (isDone && estimate != null) {
      doneEstSum += estimate;
      doneDevLoggedSum += cumulativeDevLogged;
      if (cumulativeDevLogged > 0) anyDoneWithBoth = true;
      overshootHoursSum += cumulativeDevLogged - estimate;
    }

    // ── Increment 34 (§1) — burned-remaining Delivered inputs ────────────────
    // remStart = ticket_baseline.remaining_hours (activation snapshot) ??
    // estimate-of-record; remEnd = 0 when done, else the live remaining (or
    // the freeze-snapshot value once frozen), ?? remStart when unknown.
    // A journal-gapped reconstructed baseline remaining (retro sprints where
    // no "Remaining work" journal precedes start_date — the fallback is the
    // ticket's CURRENT remaining, typically 0 after the fact) is UNKNOWN, not
    // a number: see closure.ts's baselineRemaining.
    const remainingStartHours = baselineRemaining(b) ?? (estimate ?? 0);
    const remainingEndHours = isDone
      ? 0
      : (preferFrozen(frozen?.frozen_remaining_hours, wp?.remaining_hours ?? null) ??
        remainingStartHours);

    // ── Increment 15: assemble this ticket's developerSegments input ─────────
    // Baseline-anchor holder = the frozen ORIGINAL assignee (SPEC_09 "o_t"),
    // re-resolved so its personKey aligns with logger keys. Its NAME comes from
    // assignee_name_raw (retro) or the live/cache assignee name; the id from the
    // frozen original_assignee_op_id.
    // Increment 38 — with a baseline row, BOTH id and name come from that
    // snapshot (never the live holder's name paired with the baseline id: the
    // resolver treats the name as identity, so the pair resolved to whoever
    // holds the ticket NOW). Only a ticket with no baseline row at all falls
    // back to the current holder.
    const baseOpUser = b
      ? (b.original_assignee_op_id ?? b.assignee_op_id)
      : holderOpUser;
    const baseName = b ? baselineAssigneeName(b) : holderName;
    const baseResolved = resolvePerson(itemConn, baseOpUser ?? null, baseName);
    if (baseResolved) registerPerson(baseResolved);
    const baseHolder = baseResolved
      ? { op_user_id: baseResolved.op_user_id, name: baseResolved.name }
      : { op_user_id: null, name: null };

    const resolveHolder = (
      name: string | null,
    ): { op_user_id: number | null; role: PersonRole | null } => {
      const r = resolvePerson(itemConn, null, name);
      if (r) {
        registerPerson(r);
        return { op_user_id: r.op_user_id, role: r.role };
      }
      return { op_user_id: null, role: null };
    };

    const assignee_intervals = assigneeIntervals({
      wp_op_id: it.wp_op_id,
      events: (assigneeEventsByWp.get(it.wp_op_id) ?? []).map((e) => ({
        occurred_at: e.at,
        from: e.from,
        to: e.to,
      })),
      baseline_anchor: baselineAnchor,
      created_at: b?.captured_at ?? null,
      baseline_holder_fallback: baseHolder.name,
      resolveHolder,
    });

    // Developer-only logged hours on this ticket, keyed by personKey.
    const logged_by_developer: Record<PersonKey, number> = {};
    for (const [key, hrs] of loggedByWpByPerson.get(it.wp_op_id) ?? []) {
      if (roleByPerson[key] === "developer") logged_by_developer[key] = hrs;
    }
    const first_logged_at_by_developer: Record<PersonKey, string> = {};
    for (const [key, at] of firstLoggedByWpByPerson.get(it.wp_op_id) ?? []) {
      if (roleByPerson[key] === "developer") first_logged_at_by_developer[key] = at;
    }

    // NOTE (SPEC_16 §5 — estimate_at_acquisition, deferred by decision): the
    // engine's Row-5 "estimate at moment of acquisition" (acquired_worked) still
    // falls back to the flat `estimate_hours` below. Populating a true
    // acquisition-instant value here would mean folding this sprint's
    // `estimate_changed`/`remaining_changed` changelog rows into a per-ticket
    // estimate TIMELINE and evaluating `effectiveEstimate` at each interval's
    // `from` — a new reconstruction with its own correctness surface, on a
    // load-bearing PURE-stored-data path. It's observable only when a ticket's
    // estimate CHANGES after a developer acquires it (unchanged for the Inc 15
    // s10 fixture, where acquisition-estimate == current estimate); the flat
    // fallback is exactly what Increment 15 shipped. Left as the documented
    // fallback rather than half-implemented — see the field's contract doc.
    ticketInputs.push({
      wp_op_id: it.wp_op_id,
      subject,
      connection_id: itemConn,
      estimate_hours: estimate,
      in_baseline_scope: (b?.origin ?? it.origin) === "baseline",
      baseline_commit_hours: baselineCommitHours(it, b),
      // Increment 34 (§1) — see the remainingStartHours/remainingEndHours
      // computation above.
      remaining_start_hours: remainingStartHours,
      remaining_end_hours: remainingEndHours,
      done_bucket: cls.bucket,
      assignee_intervals,
      status_transitions: statusTransByWp.get(it.wp_op_id) ?? [],
      logged_by_developer,
      first_logged_at_by_developer,
    });
  }

  // Increment 15 — the developerSegments engine (SPEC_15 §2/§3) computes every
  // per-developer number (PLANNED via Σ segment deltas, DELIVERED by max-logged
  // + status-transition tie-break, accuracy/overshoot) and the capacity-bar
  // `segments`. Role-gated inside the engine (developers only).
  // Increment 38 — baseline tickets taken out of the sprint after activation
  // still count toward what their ACTIVATION holder signed up for (Baseline)
  // and subtract from their ±Change. Holder from the baseline snapshot only;
  // connection from the frozen snapshot once frozen (invariant 10 — no cache
  // read), else the live cache row.
  const removedBaselineItems = allSprintItems.filter(
    (i) => i.outcome === "removed_mid_sprint" && i.origin === "baseline",
  );
  const removedWpById = isFrozen
    ? new Map<number, { connection_id: number | null }>()
    : new Map(
        (await repos.workPackages.getManyByOpIds(removedBaselineItems.map((i) => i.wp_op_id))).map(
          (w) => [w.op_id, w],
        ),
      );
  const removed_baseline: NonNullable<DeveloperSegmentsInput["removed_baseline"]> = [];
  for (const it of removedBaselineItems) {
    const b = baselineByWp.get(it.wp_op_id) ?? null;
    if (b == null) continue;
    const conn = isFrozen
      ? (frozenByWp.get(it.wp_op_id)?.frozen_connection_id ?? null)
      : (removedWpById.get(it.wp_op_id)?.connection_id ?? null);
    const holder = resolvePerson(
      conn,
      b.original_assignee_op_id ?? b.assignee_op_id,
      baselineAssigneeName(b),
    );
    if (!holder) continue;
    registerPerson(holder);
    removed_baseline.push({
      wp_op_id: it.wp_op_id,
      connection_id: conn,
      holder_op_user_id: holder.op_user_id,
      holder_name: holder.name,
      commit_hours: baselineCommitHours(it, b),
    });
  }

  const segmentsInput: DeveloperSegmentsInput = {
    removed_baseline,
    baseline_anchor: baselineAnchor,
    tickets: ticketInputs,
    role_by_person: roleByPerson,
    person_meta: personMeta,
    dev_done_statuses,
    // SPEC_24 §2/§3 — feeds sprint status straight into the engine so a
    // `planning` sprint's bar collapses to green-per-developer instead of
    // running the full baseline/handoff/acquired model against a fabricated
    // pre-activation anchor. `sprint` can only be null for an already-deleted
    // sprint (not reachable here), so "active" (the full model) is the safe
    // fallback rather than silently collapsing.
    sprint_status: sprint?.status ?? "active",
    // Identity unification — the engine's interval holders resolve through the
    // SAME canonical fold as loggers/current holders (one person, one key).
    resolve_key: (connectionId, opUserId, name) =>
      resolver.resolve(connectionId, opUserId, name)?.key ?? null,
  };
  // Increment 30 — the ONE canonical Planned, handed to the engine so
  // `per_developer[].planned_hours` is that number rather than a second
  // computation off the segment sums (`CAPACITY_BAR_RULES.md` §0: "never a
  // second computation").
  const plannedScope = computePlannedScope(plannedScopeItems);
  const segmentsResult = developerSegmentsWithInternals(segmentsInput, {
    planned_by_person: plannedScope.by_holder,
    holder_by_ticket: plannedHolderByTicket,
  });
  const per_developer: DeveloperCapacityBreakdown[] = segmentsResult.breakdown;
  // Increment 37 — the per-ticket credited-delivered map, threaded through to
  // the caller via `ClosureStatsWithInternals.deliveredByTicket` (Velocity's
  // per-connection breakdown; see `routes/index.ts`'s GET /velocity).
  const deliveredByTicket = segmentsResult.delivered_by_ticket;

  // "Planned" (header number 1) is DEVELOPER-SCOPED: Σ per_developer[].planned_hours.
  // Increment 30 redefined each of those to CURRENT SCOPE (the tickets the
  // developer holds right now), so a `handoff` ticket now counts on the RECEIVER
  // — under the previous definition it counted on neither side, which is why
  // this total is no longer systematically smaller than Increment 16's.
  // `CAPACITY_BAR_RULES.md` §6 invariant 8: this header is reproducible by adding
  // up the developer rows displayed beneath it, because it is literally that sum.
  // CapacityResponse.scope_planned_hours reads this SAME field off this SAME
  // computation, so the four surfaces are identical by construction.
  const totalPlanned = per_developer.reduce((s, d) => s + d.planned_hours, 0);
  // Increment 30 — the aggregate of the figure Planned used to be (Σ retained
  // baseline per developer). Kept and separately labelled: ±Change is measured
  // against it, and the burndown anchors on it (`CAPACITY_BAR_RULES.md` §5).
  const totalBaseline = per_developer.reduce((s, d) => s + d.baseline_hours, 0);
  // SPEC_16/17 — Delivered (between Planned and Logged): Σ per-developer
  // delivered_hours. Grows over time for a running sprint as work is delivered.
  const totalDelivered = per_developer.reduce((s, d) => s + d.delivered_hours, 0);

  const estimate_accuracy_pct =
    anyDoneWithBoth && doneEstSum > 0 ? (doneDevLoggedSum / doneEstSum) * 100 : null;

  // ── Increment 33 (INCREMENT_33_CONTRACTS.md §1) — off-sprint logged time,
  //    folded in HERE, at the very end, after `per_developer` exists — and
  //    nowhere upstream (§0 pillar 1: "separation is sacred"). Nothing above
  //    this point reads `off_sprint_time_entry`, so inserting/deleting those
  //    rows can only ever change the fields built below, never Planned /
  //    Baseline / Delivered / Logged / the burndown / per_developer /
  //    per_ticket — pinned by the invariant test in closureStats.test.ts. ──
  const offSprintRows = await repos.offSprintTime.listBySprint(sprintId);
  // The comparison base (decision 1b): THIS sprint's own developer-logged
  // hours, per person — reusing the actual `per_developer[].logged_hours`
  // values rather than re-deriving them (§1: "reuse the value, do not
  // re-derive"). `per_developer` carries no PersonKey, only a canonical NAME —
  // but IDENTITY_MODEL.md's golden-test guarantee ("every name appears at most
  // once per surface") makes NAME a safe, collision-free join column here,
  // since both sides resolve through the exact same `resolver` instance.
  const sprintLoggedHoursByName = new Map(per_developer.map((d) => [d.name, d.logged_hours]));
  const sprintLoggedHoursTotal = per_developer.reduce((s, d) => s + d.logged_hours, 0);

  interface OffPersonAgg {
    op_user_id: number | null;
    name: string;
    total_hours: number;
    tickets: Map<number, { subject: string | null; hours: number; connection_id: number | null }>;
  }
  const offByPersonKey = new Map<PersonKey, OffPersonAgg>();
  let offTotalHours = 0;
  for (const row of offSprintRows) {
    offTotalHours += row.hours;
    // Every row carries a real (NOT NULL) actor_op_id, so resolution never
    // fails here the way an unassigned ticket's holder can — same reasoning
    // GET /sprints/:id/off-sprint-time already relies on (routes/index.ts).
    const resolved = resolvePerson(row.connection_id, row.actor_op_id, row.actor_name);
    const opUserId = resolved?.op_user_id ?? row.actor_op_id;
    const name = resolved?.name ?? row.actor_name ?? `User ${row.actor_op_id}`;
    const key = resolved?.key ?? `id:${row.connection_id ?? "null"}:${row.actor_op_id}`;
    let agg = offByPersonKey.get(key);
    if (!agg) {
      agg = { op_user_id: opUserId, name, total_hours: 0, tickets: new Map() };
      offByPersonKey.set(key, agg);
    }
    agg.total_hours += row.hours;
    const ticket = agg.tickets.get(row.wp_op_id);
    if (ticket) {
      ticket.hours += row.hours;
      // §1: "subject (latest non-null)" — rows are read in insertion order
      // (repos.offSprintTime.listBySprint orders by id), which is the fetch
      // order of the run that wrote them; a later non-null subject overwrites
      // an earlier one, never the reverse.
      if (row.wp_subject != null) ticket.subject = row.wp_subject;
    } else {
      agg.tickets.set(row.wp_op_id, {
        subject: row.wp_subject,
        hours: row.hours,
        connection_id: row.connection_id,
      });
    }
  }

  // §1: share = off / (off + sprint); null when both sides are 0. No
  // server-side rounding — the UI formats (decision 1a).
  const sharePct = (off: number, sprintLogged: number): number | null =>
    off === 0 && sprintLogged === 0 ? null : (100 * off) / (off + sprintLogged);

  // ── Increment 35 (docs/INCREMENT_35_CONTRACTS.md §3; CAPACITY_BAR_RULES §5c
  //    + §6 invariant 13) — scope-origin split: what was committed by
  //    planning (origin `baseline`) vs what arrived during the sprint
  //    (`added_mid_sprint` | `added_retroactively`). Derived ENTIRELY from
  //    data this function already loaded — `allSprintItems` (for
  //    `origin`/`planned_hours`, unfiltered so `removed_mid_sprint` items stay
  //    in their group) and `devLoggedByWp` (this sprint's calendar-window
  //    dev-logged, already fully populated by the changelog loop above) — no
  //    new query, no second changelog walk. Items with outcome `removed`
  //    (dropped in planning — never committed scope) are excluded entirely.
  //    Purely additive: nothing computed above this block reads it, so it
  //    cannot feed back into Planned/Baseline/±Change/Delivered/Logged/
  //    burndown/velocity (invariant 13).
  const scopeOriginItems = allSprintItems.filter((i) => i.outcome !== "removed");
  function scopeOriginGroup(matches: (origin: (typeof scopeOriginItems)[number]["origin"]) => boolean): {
    ticket_count: number;
    estimate_hours: number;
    dev_logged_hours: number;
  } {
    const rows = scopeOriginItems.filter((i) => matches(i.origin));
    return {
      ticket_count: rows.length,
      // §1: null `planned_hours` contributes 0 but the ticket still counts.
      estimate_hours: rows.reduce((s, i) => s + (i.planned_hours ?? 0), 0),
      dev_logged_hours: rows.reduce((s, i) => s + (devLoggedByWp.get(i.wp_op_id) ?? 0), 0),
    };
  }
  const scopeOriginBaseline = scopeOriginGroup((o) => o === "baseline");
  const scopeOriginAdded = scopeOriginGroup(
    (o) => o === "added_mid_sprint" || o === "added_retroactively",
  );
  // §2: share = added / (baseline + added) × 100; null when the denominator is 0.
  const scopeOriginShare = (added: number, baseline: number): number | null =>
    added + baseline === 0 ? null : (100 * added) / (added + baseline);

  const offPerPerson = [...offByPersonKey.values()]
    .map((agg) => ({
      op_user_id: agg.op_user_id,
      name: agg.name,
      total_hours: agg.total_hours,
      share_pct: sharePct(agg.total_hours, sprintLoggedHoursByName.get(agg.name) ?? 0),
      tickets: [...agg.tickets.entries()]
        .map(([wpOpId, t]) => ({
          wp_op_id: wpOpId,
          subject: t.subject,
          hours: t.hours,
          connection_id: t.connection_id,
        }))
        .sort((a, b) => b.hours - a.hours || a.wp_op_id - b.wp_op_id),
    }))
    // §1: per_person ordered by total_hours desc, then name asc.
    .sort((a, b) => b.total_hours - a.total_hours || a.name.localeCompare(b.name));

  const stats: ClosureStatsResponse = {
    sprint_id: sprintId,
    generated_at: generatedAt,
    total_planned_hours: totalPlanned,
    total_baseline_hours: totalBaseline,
    total_delivered_hours: totalDelivered,
    total_logged_hours: totalLogged,
    dev_logged_hours: totalDevLogged,
    done: { count: done.length, items: done },
    not_done: { count: not_done.length, items: not_done },
    rejected: { count: rejected.length, items: rejected },
    ambiguous: { count: ambiguous.length, items: ambiguous },
    anomalies,
    estimate_accuracy_pct,
    overshoot_hours: Math.max(0, overshootHoursSum),
    overshoot_threshold_pct,
    per_developer,
    per_ticket: perTicket,
    // Increment 33 (docs/INCREMENT_33_CONTRACTS.md §1) — real aggregation over
    // off_sprint_time_entry, computed above. STRICTLY SEPARATE (§0 pillar 1):
    // none of these values feeds any figure above this point.
    off_sprint: {
      total_hours: offTotalHours,
      sprint_logged_hours: sprintLoggedHoursTotal,
      share_pct: sharePct(offTotalHours, sprintLoggedHoursTotal),
      per_person: offPerPerson,
    },
    // Increment 35 (docs/INCREMENT_35_CONTRACTS.md §3) — the real scope-origin
    // partition, computed above from `allSprintItems` + `devLoggedByWp`.
    scope_origin: {
      baseline: scopeOriginBaseline,
      added: scopeOriginAdded,
      added_logged_share_pct: scopeOriginShare(
        scopeOriginAdded.dev_logged_hours,
        scopeOriginBaseline.dev_logged_hours,
      ),
      added_estimate_share_pct: scopeOriginShare(
        scopeOriginAdded.estimate_hours,
        scopeOriginBaseline.estimate_hours,
      ),
    },
  };
  return { stats, deliveredByTicket };
}
