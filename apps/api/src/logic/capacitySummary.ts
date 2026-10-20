import {
  capacityEffectiveRole,
  type CapacityResponse,
  type PersonRole,
  type SprintItem,
  type TeamMember,
  type TicketBaseline,
  type WorkPackageCache,
} from "@osp/contracts";
import type { Repositories } from "@osp/db";
import type { OpClient } from "@osp/op-client";
import { AppError } from "../errors";
import { effectiveEstimate } from "./estimate";
import { computeCapacity, type CapacityItemInput } from "./capacity";
import { buildPersonResolver } from "./personResolver";
import { classifyWithRole, isDoneBucket } from "./doneRole";
import { createUserNameResolver } from "./userNames";
import { createIdentityResolver, type IdentityResolver } from "./identityResolver";
import { computeClosureStats } from "./closureStats";
import { HIDDEN_BACKLOG_STATUSES } from "./backlogStatus";

/**
 * Increment 36 (docs/INCREMENT_36_CONTRACTS.md §2; CAPACITY_BAR_RULES §6
 * invariant 5) — the capacity computation behind `GET /sprints/:id/capacity`,
 * extracted out of `routes/index.ts` so `logic/statusReport.ts` can reuse the
 * EXACT SAME assembly for the sprint status PDF's capacity table — never a
 * second computation. `routes/index.ts`'s own `buildCapacityResponse` is now a
 * thin wrapper around `computeSprintCapacity`, supplying its REAL vault-backed
 * OP-client resolvers so `GET /sprints/:id/capacity`'s behaviour stays
 * byte-identical (proven by the pre-existing route tests, left unedited).
 *
 * The only OP-dependent parts are a best-effort user-name fallback and the
 * retrospective-planning roster's identity resolution — both already resilient
 * by design (`createUserNameResolver(null)` / a resolver whose OP client
 * couldn't be built are documented, intended uses, not degraded edge cases).
 * That resilience is what lets `logic/statusReport.ts` supply `localOnlyDeps`
 * below and get the SAME numbers with NO live OP call at all, honouring this
 * increment's "no OP calls needed" guardrail.
 */

export interface ConnectionResolverDeps {
  repos: Repositories;
  /**
   * Resolve a ready OP client for ONE connection. Reject/throw when
   * unavailable — every caller here already wraps the attempt in try/catch
   * and falls back to a client-less resolver, so rejecting is always safe.
   * `localOnlyCapacityDeps` below passes a resolver that always rejects, so
   * NO live OP call is ever attempted.
   */
  buildClientForConnection: (connectionId: number) => Promise<OpClient>;
}

/**
 * SPEC_13 §1/§3 — a lazily-built identity resolver per connection (the OP user
 * directory + that connection's aliases), memoized per caller. Resilient: if
 * the OP client can't be built (locked vault / disabled connection / no OP
 * calls allowed in this context) the directory is empty, but DB aliases still
 * resolve, so a READ endpoint never 500s just because the user list is
 * momentarily unreachable.
 */
export function makeConnectionResolvers(
  deps: ConnectionResolverDeps,
  wps: readonly WorkPackageCache[],
): (connId: number) => Promise<IdentityResolver> {
  const { repos, buildClientForConnection } = deps;
  // Group the sprint's cached work packages by connection so each resolver's
  // NON-admin index is seeded from that connection's assignee columns + the
  // memberships of the projects those tickets live in (SPEC_11 §1 scoping —
  // never enumerating other connections/projects).
  const wpsByConn = new Map<number, WorkPackageCache[]>();
  for (const w of wps) {
    if (w.connection_id == null) continue;
    const list = wpsByConn.get(w.connection_id);
    if (list) list.push(w);
    else wpsByConn.set(w.connection_id, [w]);
  }
  const cache = new Map<number, Promise<IdentityResolver>>();
  return (connId: number) => {
    let r = cache.get(connId);
    if (!r) {
      r = (async () => {
        let op: OpClient | null = null;
        try {
          op = await buildClientForConnection(connId);
        } catch {
          op = null;
        }
        const aliases = await repos.userNameAliases.listByConnection(connId);
        const connWps = wpsByConn.get(connId) ?? [];
        const nameIdHints = connWps
          .filter((w) => w.assignee_op_id != null && w.assignee_name)
          .map((w) => ({ op_user_id: w.assignee_op_id as number, name: w.assignee_name as string }));
        const projectOpIds = [
          ...new Set(connWps.map((w) => w.project_op_id).filter((p): p is number => p != null)),
        ];
        return createIdentityResolver(op, aliases, { nameIdHints, projectOpIds });
      })();
      cache.set(connId, r);
    }
    return r;
  };
}

/**
 * SPEC_13 §1a (revised) — auto-materialize a `team_member` for a reconstructed
 * person so their capacity is settable IMMEDIATELY (the person's identity IS
 * their name; an OP id is opportunistic). Dedup by EXACT name first (reuse the
 * same person across sprints), falling back to an existing member by op_user_id
 * when the id IS known (so a resolved person isn't split from an already-
 * provisioned member). When the id was unknown on the existing row but is now
 * resolved, enrich it in place — never leave it stale, never duplicate. The
 * per-call `cache` avoids re-hitting the DB for a person holding several tickets.
 */
export async function materializeReconstructedMember(
  repos: Repositories,
  name: string,
  opUserId: number | null,
  cache: Map<string, TeamMember>,
): Promise<TeamMember> {
  const cached = cache.get(name);
  if (cached) {
    if (opUserId != null && cached.op_user_id == null) {
      const enriched = await repos.teamMembers.upsert({
        id: cached.id,
        op_user_id: opUserId,
        name: cached.name,
        default_hours_per_day: cached.default_hours_per_day,
      });
      cache.set(name, enriched);
      return enriched;
    }
    return cached;
  }
  let existing = await repos.teamMembers.getByName(name);
  if (!existing && opUserId != null) {
    existing = await repos.teamMembers.getByOpUserId(opUserId);
  }
  if (existing) {
    if (opUserId != null && existing.op_user_id == null) {
      existing = await repos.teamMembers.upsert({
        id: existing.id,
        op_user_id: opUserId,
        name: existing.name,
        default_hours_per_day: existing.default_hours_per_day,
      });
    }
    cache.set(name, existing);
    return existing;
  }
  const created = await repos.teamMembers.upsert({
    op_user_id: opUserId,
    name,
    default_hours_per_day: 8,
  });
  cache.set(name, created);
  return created;
}

/**
 * SPEC_13 §1a/§3 (REVISED) — capacity item inputs for a retrospective PLANNING
 * sprint, from its reconstructed ticket_baseline rows (assignee as of
 * start_date), each raw journal name resolved via THE shared resolver. A
 * person's identity IS their NAME: every reconstructed name gets a team_member
 * auto-materialized (dedup by name, op_user_id enriched when known) → a FULL
 * capacity line with a settable `member_id`, NOTHING blocked on an OP id.
 * `assignee_op_id` is opportunistic (null when no id is known yet — normal,
 * non-blocking); a genuinely nameless baseline falls to the unassigned bucket.
 */
async function buildRetroPlanningCapItems(
  repos: Repositories,
  baselines: TicketBaseline[],
  items: SprintItem[],
  wpById: Map<number, WorkPackageCache>,
  resolverFor: (connId: number) => Promise<IdentityResolver>,
): Promise<CapacityItemInput[]> {
  const baselineByWp = new Map(baselines.map((b) => [b.wp_op_id, b]));
  const overrides = await repos.estimateOverrides.getManyByWpOpIds(items.map((i) => i.wp_op_id));
  const ovById = new Map(overrides.map((o) => [o.wp_op_id, o]));
  const currentConn = await repos.connections.getCurrent();
  const memberCache = new Map<string, TeamMember>();
  const out: CapacityItemInput[] = [];
  for (const it of items) {
    const b = baselineByWp.get(it.wp_op_id);
    // Only reconstructed items participate in the retro roster (a plain manual
    // add on a retro sprint gets a reconstructed baseline too — see retro.ts).
    if (!b) continue;
    const wp = wpById.get(it.wp_op_id);
    const connId = wp?.connection_id ?? currentConn?.id ?? null;
    const identity =
      connId !== null
        ? (await resolverFor(connId)).resolve(b.assignee_name_raw)
        : {
            op_user_id: null,
            resolution: (b.assignee_name_raw ? "unresolved" : null) as "unresolved" | null,
            canonical_name: null as string | null,
          };
    // Display name (canonical when a rename alias folds it).
    const personName = identity.canonical_name ?? b.assignee_name_raw;
    // Auto-materialize a member per NAME → a settable member_id, no blocking.
    const member = personName
      ? await materializeReconstructedMember(repos, personName, identity.op_user_id, memberCache)
      : null;
    out.push({
      wp_op_id: it.wp_op_id,
      parent_op_id: wp?.parent_op_id ?? null,
      // Resolved id (exact/alias) or null; NEVER the live assignee.
      assignee_op_id: identity.op_user_id,
      assignee_name: personName,
      planned_hours: effectiveEstimate(
        b.estimated_hours,
        b.remaining_hours,
        ovById.get(it.wp_op_id)?.planning_hours ?? null,
      ),
      origin: it.origin,
      outcome: it.outcome,
      // SPEC_13 §1a: the materialized member keys this person's line so an
      // id-less name still gets a full, capacity-settable line of its own.
      member_id: member?.id ?? null,
      // SPEC_14 §2: the reconstructed person's role (unset → developer here).
      role: member ? capacityEffectiveRole(member.role) : undefined,
    });
  }
  return out;
}

export interface CapacityComputationDeps extends ConnectionResolverDeps {
  /**
   * Best-effort resolver for the CURRENT connection's OP client, used only for
   * the display-name fallback (SPEC_11 §4) — never throws, `null` means "no
   * live OP call" (locked vault / no connection / this context disallows OP
   * calls entirely).
   */
  tryOpClient: () => Promise<OpClient | null>;
}

/**
 * The full `GET /sprints/:id/capacity` computation (SPEC §7, SPEC_14 §2,
 * SPEC_17 §4a, CAPACITY_BAR_RULES §5/§6), parameterized over its OP-client
 * dependencies so it can run identically from the route (real vault-backed
 * resolvers) or from the status PDF (no OP calls at all, per this
 * increment's guardrail — see `localOnlyCapacityDeps`).
 */
export async function computeSprintCapacity(
  deps: CapacityComputationDeps,
  sprintId: number,
  generatedAt: string,
): Promise<CapacityResponse> {
  const { repos } = deps;
  const sprint = await repos.sprints.getById(sprintId);
  if (!sprint) throw new AppError("SPRINT_NOT_FOUND", `Sprint ${sprintId} not found`);
  const capacityRows = await repos.capacities.listBySprint(sprintId);
  const members = await repos.teamMembers.list();
  const memberById = new Map(members.map((m) => [m.id, m]));

  const allItems = (await repos.sprintItems.listBySprint(sprintId)).filter(
    (i) => i.outcome !== "removed",
  );
  const wps = await repos.workPackages.getManyByOpIds(allItems.map((i) => i.wp_op_id));
  const wpById = new Map(wps.map((w) => [w.op_id, w]));

  // Increment 31 (docs/INCREMENT_31_CONTRACTS.md §0/§2c) — a FROZEN sprint
  // (`sprint.frozen_at != null`, always "closed") reads its per-item numbers
  // from the freeze-time snapshot, never the live cache, so
  // `work_package_cache` mutating or being deleted (Import cleanup)
  // afterward moves NOTHING (CAPACITY_BAR_RULES §6 invariant 10). Named
  // `isSprintFrozen` (not `isFrozenBaseline`, an unrelated pre-existing
  // local further below) to keep the two concepts visually distinct.
  // Loaded here, BEFORE personResolver, so identity resolution can learn
  // the frozen assignees too (below).
  const isSprintFrozen = sprint.frozen_at != null;
  const frozenByWp = isSprintFrozen
    ? new Map((await repos.sprintItems.listFrozenSnapshot(sprintId)).map((f) => [f.wp_op_id, f]))
    : new Map<number, Awaited<ReturnType<typeof repos.sprintItems.listFrozenSnapshot>>[number]>();
  /** Prefer the frozen snapshot's value — ONLY when the sprint is actually
   * frozen and the snapshot itself has a non-null value (defensive
   * fallback; freeze.ts snapshots every non-removed item in practice). */
  function preferFrozenCap<T>(frozenValue: T | null | undefined, liveValue: T): T {
    return isSprintFrozen && frozenValue != null ? frozenValue : liveValue;
  }

  // Identity unification (SPEC_14 §2 role tagging, now canonical): every
  // participant resolves through THE shared person resolver — the same one
  // computeClosureStats keys by — so /capacity and /closure-stats agree on
  // who is one person BY CONSTRUCTION. A holder with no team_member row
  // still defaults to "developer" (capacityEffectiveRole — plannable, no
  // regression); GET /api/people is what materializes people for role-setting.
  const personResolver = await buildPersonResolver(repos, { wps });
  // Increment 31 (§2c) — teach it the frozen snapshot's assignees too, so a
  // frozen sprint's role/identity resolution stays stable once the live
  // cache row an assignee would otherwise be learned from is gone.
  for (const f of frozenByWp.values()) {
    if (f.frozen_assignee_op_id != null && f.frozen_assignee_name != null) {
      personResolver.learn({
        name: f.frozen_assignee_name,
        op_user_id: f.frozen_assignee_op_id,
        connection_id: f.frozen_connection_id,
      });
    }
  }
  // Invariant 10 (CAPACITY_BAR_RULES §6.10), strengthened at integration:
  // a FROZEN sprint never consults the live cache row at all — the frozen
  // response must be ≡ the post-deletion response by construction (the
  // resolver already learned every (name ↔ id) pair the rows knew, above).
  if (isSprintFrozen) wpById.clear();
  const roleForParticipant = (
    connectionId: number | null,
    opUserId: number | null,
    name: string | null,
  ): PersonRole => capacityEffectiveRole(personResolver.resolve(connectionId, opUserId, name)?.role);
  // Increment 9 (SPEC_09 §3): the frozen original owner (o_t) per baseline
  // ticket + the sprint's done rules drive the grey redistribution segments.
  // Baselines only exist once activated (empty for a planning sprint → every
  // item opts OUT of grey tracking, so planning stays pre-Increment-9).
  // SPEC_13 §3: a retrospective PLANNING sprint's roster comes from the
  // reconstructed ticket_baseline rows (assignee as of start_date), so load
  // them even in planning for that case (normally baselines only exist once
  // activated). Every other sprint keeps the pre-existing behavior.
  const retroPlanning = sprint.is_retrospective && sprint.status === "planning";
  const [baselines, doneRules] = await Promise.all([
    sprint.status !== "planning" || retroPlanning
      ? repos.ticketBaselines.listBySprint(sprintId)
      : Promise.resolve([]),
    // Concept 6 / Escalation B: the GLOBAL role-aware done_rule matrix (same
    // rules Closure + dimming use) drives the grey-redistribution is_done now,
    // NOT the per-sprint status-only done_status_rule.
    repos.doneRules.list(),
  ]);
  const baselineByOpId = new Map(baselines.map((b) => [b.wp_op_id, b]));

  // Count every item the sprint board's /items/detailed endpoint shows — a
  // cached work package with a non-hidden (not yet finished) status.
  // Deliberately NOT excluded by backlog_dismissal (SPEC_07 §5): a ticket
  // that's already committed to this sprint stays counted in capacity
  // regardless of a later Backlog-screen dismissal — the board shows it
  // (badged "no longer in backlog"), so its hours must still show too,
  // instead of silently vanishing from the load. Genuinely hidden/finished
  // statuses (e.g. Resolved) or a ticket with no cached data at all still
  // don't count — those are real completions/gaps, not dismissal noise.
  const items = allItems.filter((it) => {
    const wp = wpById.get(it.wp_op_id);
    const baseline = baselineByOpId.get(it.wp_op_id);
    const frozen = frozenByWp.get(it.wp_op_id);
    if (!wp && !baseline && !frozen) return false;
    // SPEC_09 §3 (decision #2): a FROZEN baseline commitment (activated sprint,
    // origin="baseline") stays in the load even once finished/closed — its
    // completed portion renders as grey on the owner's bar (bar stays baseline-
    // long) rather than vanishing. Only NON-baseline candidates (planning-phase
    // items, mid-sprint adds) drop out when their status is finished/hidden.
    //
    // FOLLOWUPS #6 (user decision: variant A, 2026-08-19) — `added_retroactively`
    // items bypass the hidden-status drop exactly like frozen baseline:
    // Increment 25's whole point is adding an ALREADY-DONE ticket to the
    // sprint's history, so such an item is by definition always in a
    // finished status — the SPEC_07 filter therefore dropped its capacity
    // line unconditionally while computeClosureStats (and the shared
    // scope_planned header both endpoints return) counted it, breaking
    // CAPACITY_BAR_RULES §6 invariant 8 on the user's real closed sprint
    // (header 88h ≠ Σ developer lines 80h — Dalby's #11882). The ticket
    // belongs to the sprint's committed history; its holder keeps the line.
    const isFrozenBaseline =
      sprint.status !== "planning" && (it.origin === "baseline" || it.origin === "added_retroactively");
    if (!isFrozenBaseline) {
      // Increment 31 (§2c): a FROZEN sprint's status source for this
      // filter also prefers the snapshot, so a mid-sprint-added item never
      // drops out of capacity just because its cache row was deleted.
      const statusSource = isSprintFrozen ? (frozen?.frozen_status_name ?? wp?.status_name) : wp?.status_name;
      if (statusSource === undefined) return false;
      if (HIDDEN_BACKLOG_STATUSES.has(statusSource.trim().toLowerCase())) return false;
    }
    return true;
  });
  const overrides = await repos.estimateOverrides.getManyByWpOpIds(items.map((i) => i.wp_op_id));
  const ovById = new Map(overrides.map((o) => [o.wp_op_id, o]));

  const capItems = items.map((it) => {
    const wp = wpById.get(it.wp_op_id);
    const frozen = frozenByWp.get(it.wp_op_id);
    // Increment 31 (§2c): estimate, assignee, parent and connection all
    // prefer the frozen snapshot — so /capacity and /closure-stats keep
    // agreeing by construction (CAPACITY_BAR_RULES §6.5) even once the
    // sprint is frozen and its cache rows may be mutated or gone.
    const liveEff = effectiveEstimate(
      wp?.estimated_hours ?? null,
      wp?.remaining_hours ?? null,
      ovById.get(it.wp_op_id)?.planning_hours ?? null,
    );
    const eff = preferFrozenCap(frozen?.frozen_effective_hours, liveEff);
    const assigneeOpId = preferFrozenCap(frozen?.frozen_assignee_op_id, wp?.assignee_op_id ?? null);
    const assigneeName = preferFrozenCap(frozen?.frozen_assignee_name, wp?.assignee_name ?? null);
    const connectionId = preferFrozenCap(frozen?.frozen_connection_id, wp?.connection_id ?? null);
    const parentOpId = preferFrozenCap(frozen?.frozen_parent_op_id, wp?.parent_op_id ?? null);
    const baseline = baselineByOpId.get(it.wp_op_id);
    const isBaselineOrigin = it.origin === "baseline";
    // SPEC_09 §3: opt INTO grey tracking only for baseline items that have a
    // frozen baseline row — supply o_t (may be null = unassigned at capture).
    // No baseline row → OMIT the field (undefined) so the item opts out,
    // rather than mis-bucketing it as "unassigned" (design-note point 6).
    const grey = isBaselineOrigin && baseline ? { original_assignee_op_id: baseline.original_assignee_op_id } : {};
    // is_done: a CLOSED sprint carries real outcomes ("done" set at closure);
    // an ACTIVE sprint's items are all outcome "planned" until closure, so its
    // done-ness comes from the live status VIA THE ROLE-AWARE MATRIX
    // (classifyWithRole) — the SAME classification Closure and dimming use, so
    // a developer-held ticket in a status-only "done" state stays not_done here
    // too (Concept 6 / Escalation B: ztlumený ⟺ Done v Closure). Reuses the
    // capacity line's OWN role signal (roleForParticipant) for the holder.
    // Increment 31 (§2c): a FROZEN sprint is ALWAYS "closed", so it already
    // takes the `it.outcome === "done"` branch below — local, unaffected by
    // the live cache — needing no separate frozen-status branch here.
    const done =
      isBaselineOrigin &&
      (sprint.status === "closed"
        ? it.outcome === "done"
        : wp
          ? isDoneBucket(
              classifyWithRole(
                { status_name: wp.status_name, status_is_closed: wp.status_is_closed },
                roleForParticipant(wp.connection_id ?? null, wp.assignee_op_id ?? null, wp.assignee_name ?? null),
                doneRules,
                wp.assignee_name ?? null,
              ).bucket,
            )
          : false);
    return {
      wp_op_id: it.wp_op_id,
      parent_op_id: parentOpId,
      assignee_op_id: assigneeOpId,
      assignee_name: assigneeName,
      // Identity unification: the connection scopes the assignee's identity.
      connection_id: connectionId,
      // Current effective estimate (not the add-time snapshot), so capacity load
      // tracks the backlog and reflects estimate changes after a Sync now.
      planned_hours: eff,
      // SPEC_05 §2: drive the stacked baseline/added/removed capacity segments.
      // On a planning sprint everything is origin "baseline" / not removed, so
      // the segments collapse to the plain planned load exactly as before.
      origin: it.origin,
      outcome: it.outcome,
      ...grey,
      is_done: done,
      // SPEC_14 §2: the assignee's role, so testers/customers show grey and
      // drop out of the totals (their committed hours "left the dev's hands").
      role: roleForParticipant(connectionId, assigneeOpId, assigneeName),
    };
  });

  const capMembers = capacityRows.map((c) => {
    const m = memberById.get(c.member_id);
    return {
      member_id: c.member_id,
      op_user_id: m?.op_user_id ?? null,
      name: m?.name ?? `Member ${c.member_id}`,
      available_hours: c.available_hours,
      role: capacityEffectiveRole(m?.role),
    };
  });

  // SPEC_11 §4: pre-resolve a display name for every roster participant so a
  // grey-redistribution ORIGINAL owner (no current WP, no capacity row) gets
  // a real name instead of a fabricated "User <id>". Resolution is LOCAL-first
  // (current WP assignees, capacity members, then any other cached WP assigned
  // to that id) with a best-effort op.getUser fallback that NEVER throws (a
  // locked vault / missing connection just yields "Unknown user (<id>)", so
  // this read endpoint stays resilient).
  const namesByOpUser = new Map<number, string>();
  {
    const neededIds = new Set<number>();
    for (const it of capItems) if (it.assignee_op_id != null) neededIds.add(it.assignee_op_id);
    for (const b of baselines) if (b.original_assignee_op_id != null) neededIds.add(b.original_assignee_op_id);
    if (neededIds.size > 0) {
      const resolver = createUserNameResolver(await deps.tryOpClient());
      for (const w of wps) if (w.assignee_op_id != null) resolver.seed(w.assignee_op_id, w.assignee_name);
      // Increment 31 (§2c) — seed from the frozen snapshot too, so a
      // frozen sprint's display names stay stable even once the live cache
      // row a name would otherwise come from is mutated or deleted
      // (invariant 10): resolution never falls through to a best-effort
      // `op.getUser` call (which could disagree, or fail outright under a
      // locked vault) for a name the snapshot already knows.
      for (const f of frozenByWp.values())
        if (f.frozen_assignee_op_id != null && f.frozen_assignee_name != null)
          resolver.seed(f.frozen_assignee_op_id, f.frozen_assignee_name);
      for (const c of capacityRows) {
        const m = memberById.get(c.member_id);
        if (m?.op_user_id != null) resolver.seed(m.op_user_id, m.name);
      }
      for (const id of neededIds) {
        let name = resolver.local(id);
        if (!name) {
          const hit = (await repos.workPackages.find({ assigneeOpId: id })).find((w) => w.assignee_name);
          if (hit?.assignee_name) {
            resolver.seed(id, hit.assignee_name);
            name = hit.assignee_name;
          }
        }
        if (!name) name = await resolver.resolve(id);
        if (name) namesByOpUser.set(id, name);
      }
    }
  }

  // SPEC_13 §1a/§3: for a retrospective PLANNING sprint the roster's identity
  // must come from the reconstructed start_date assignee (ticket_baseline.
  // assignee_name_raw), resolved FRESH via the ONE shared identity resolver
  // (its non-admin index built from the sprint's own cached WPs + project
  // memberships) — NOT the live/current assignee. This is what makes GET
  // /capacity's people identical to GET /retro/preview's, and every
  // reconstructed name gets a full, capacity-settable line (member auto-
  // materialized), whether or not an OP id is known.
  const capItemsFinal: CapacityItemInput[] = retroPlanning
    ? await buildRetroPlanningCapItems(repos, baselines, allItems, wpById, makeConnectionResolvers(deps, wps))
    : capItems;

  const computed = computeCapacity(sprint.capacity_mode, capMembers, capItemsFinal, namesByOpUser, personResolver);
  // SPEC_17 §4a — "jeden výpočet, čtyři plochy". The Capacity header's Planned
  // and Delivered numbers come from the SAME single computeClosureStats() run
  // the Closure card, the sprint Detail/report and the PDF all read, so the
  // four surfaces are identical BY CONSTRUCTION (not by two formulas happening
  // to agree). computeClosureStats is pure-stored-data (no OP call), cheap, and
  // already works for planning/active/closed sprints alike.
  const stats = await computeClosureStats(repos, sprintId, generatedAt);
  return {
    capacity_mode: sprint.capacity_mode,
    members: capacityRows,
    lines: computed.lines,
    total_available_hours: computed.total_available_hours,
    total_planned_hours: computed.total_planned_hours,
    // SPEC_05 §4: frozen baseline anchor (null before activation); the UI
    // renders the "+X / -Y" delta as total_planned_hours - baseline_total_hours.
    baseline_total_hours: sprint.baseline_total_hours,
    // SPEC_17 §2/§4a: header "Planned" = Σ per-developer planned_hours (rows
    // a+b), read straight off the shared closure computation so it ALWAYS
    // equals ClosureStatsResponse.total_planned_hours. Deliberately distinct
    // from total_planned_hours above (Inc 14's role/leaf-filtered workload).
    scope_planned_hours: stats.total_planned_hours,
    // SPEC_17 §2/§4a: header "Delivered" = Σ per-developer delivered_hours,
    // identical to ClosureStatsResponse.total_delivered_hours (same run). NOT
    // "první+druhé" (scope_planned + scope_change) — a common wrong guess.
    scope_delivered_hours: stats.total_delivered_hours,
  };
}

/**
 * Increment 36 — deps for a context with NO live OpenProject calls at all
 * (the status PDF, and its unit tests): `tryOpClient` always resolves `null`
 * and `buildClientForConnection` always rejects, so `computeSprintCapacity`
 * takes the exact same "OP unreachable" fallback paths it already has for a
 * locked vault / disabled connection — never a new code path, never a live
 * network call.
 */
export function localOnlyCapacityDeps(repos: Repositories): CapacityComputationDeps {
  return {
    repos,
    tryOpClient: async () => null,
    buildClientForConnection: async () => {
      throw new Error("no live OpenProject calls in this context (Increment 36 status PDF)");
    },
  };
}
