import { useEffect, useMemo, useState } from "react";
import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type {
  ActivationBlockingConnection,
  AppConfigResponse,
  BacklogItem,
  CapacityLine,
  CapacityResponse,
  ChangelogDetail,
  ChangelogEntryView,
  ClosureStatsResponse,
  DeveloperCapacityBreakdown,
  DeveloperSegmentKind,
  DeveloperTicketSegment,
  RetroPreviewResponse,
  RetroSeedCandidate,
  Sprint,
  SprintItemDetail,
  SprintPeopleResponse,
  SprintUpdateRun,
} from "@osp/contracts";
import { api, ApiError, type OffSprintTimeResponse } from "../api-client";
import { useAsync, type AsyncResult } from "../lib/useAsync";
import { formatDate, formatHours, formatSignedHours, isDimmedStatus, relativeTime } from "../lib/format";
import type { AssignablePerson } from "../lib/capacity";
import {
  applyAvailability,
  backlogPeople,
  capacityLineKey,
  capacityNumbersTitle,
  isUnassignedBucketLine,
  mergeCapacityLines,
  round1,
} from "../lib/capacity";
import {
  DOUBLE_COUNT_TOOLTIP,
  doubleCountGroups,
  withDoubleCount,
  type DoubleCountFields,
  type DoubleCountGroup,
} from "../lib/doubleCounting";
import { Async, EmptyState, ErrorBox, Modal, Panel } from "./ui";
import { useCan } from "../lib/role";
import { SprintSelect } from "./SprintSelect";
import { opWorkPackageUrl } from "./BacklogScreen";
import { CarryOverButton, MultiSprintBadge } from "./CarryOverControl";

/** How many backlog cards to render before asking the planner to refine (SPEC §4). */
const BACKLOG_RENDER_CAP = 50;

/**
 * Present a sprint status for the board UI (SPEC §5, extended SPEC_04 §6): a
 * locked sprint reads as its `lock_reason`, else "closed" reads as "Finished".
 */
function statusLabel(sprint: Pick<Sprint, "status" | "is_locked" | "lock_reason">): string {
  if (sprint.is_locked) {
    return sprint.lock_reason === "finished" ? "Finished" : "Locked (end date)";
  }
  return sprint.status === "closed" ? "Finished" : sprint.status;
}

/** Badge color class: locked reads the same as "closed" (both read-only). */
function statusBadgeClass(sprint: Pick<Sprint, "status" | "is_locked">): string {
  return sprint.is_locked || sprint.status === "closed" ? "closed" : "open";
}

/** True once the board must render read-only (SPEC_04 §6): locked, or the
 * pre-Increment-4 "closed" status for sprints that never went through /finish. */
function isReadOnly(sprint: Pick<Sprint, "status" | "is_locked">): boolean {
  return sprint.is_locked || sprint.status === "closed";
}

/**
 * Increment 31 (docs/INCREMENT_31_CONTRACTS.md §4 point 3) — the freeze/grace
 * badge next to the status badge: once `frozen_at` is set the sprint is
 * "frozen" (numbers immutable, no longer updates from OP); before that, a
 * closed sprint shows "grace until <date>" computed client-side from
 * `locked_at + freeze_grace_days` (§2b's own deadline rule — the sweep owns
 * the actual freeze, this is read-only presentation of the same arithmetic).
 * Deliberately omits the badge (never guesses a date) when the sprint isn't
 * closed yet, or `locked_at`/`freeze_grace_days` aren't available.
 */
function freezeBadge(
  sprint: Pick<Sprint, "status" | "frozen_at" | "locked_at">,
  freezeGraceDays: number | undefined,
): { label: string; title?: string } | undefined {
  if (sprint.frozen_at != null) {
    return {
      label: "frozen",
      title: "Numbers are frozen; the sprint no longer updates from OpenProject. Reactivate to unfreeze.",
    };
  }
  if (sprint.status !== "closed" || sprint.locked_at == null || freezeGraceDays == null) return undefined;
  const locked = new Date(sprint.locked_at);
  if (Number.isNaN(locked.getTime())) return undefined;
  const deadline = new Date(locked.getTime() + freezeGraceDays * 24 * 60 * 60 * 1000);
  return { label: `grace until ${formatDate(deadline.toISOString())}` };
}

/**
 * SPEC_11 §8b: reactivation is only OFFERED while today's date falls inside
 * the sprint's own [start_date, end_date] window (inclusive) — mirrors
 * EndDateWarning's date-comparison style below (string + T00:00:00/T23:59:59,
 * compared against the real browser clock) rather than inventing a new date
 * util. Past the end date, reactivation isn't shown at all (SPEC_11 §12.1).
 */
function isWithinSprintWindow(sprint: Pick<Sprint, "start_date" | "end_date">, now: number = Date.now()): boolean {
  const start = new Date(`${sprint.start_date}T00:00:00`);
  const end = new Date(`${sprint.end_date}T23:59:59`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false;
  return start.getTime() <= now && now <= end.getTime();
}

/**
 * SPEC_05 §1/§4/§9.1: does this sprint item still belong in the active list?
 * Classic `removed` (pre-activation / drift-reconciled) always drops out.
 * `removed_mid_sprint` drops out too UNLESS time was already logged against
 * the ticket — then it stays, rendered greyed-out with a blue border, purely
 * for historical visibility (it no longer counts as committed work).
 *
 * SPEC_07 §5: sourced straight off a `SprintItemDetail` (outcome + spent_hours
 * both live on the same row now), so this no longer needs a separate
 * wp_op_id → spent_hours map cross-referenced against the backlog.
 */
function isVisibleInSprintDetail(item: Pick<SprintItemDetail, "outcome" | "spent_hours">): boolean {
  if (item.outcome === "removed") return false;
  if (item.outcome === "removed_mid_sprint") return (item.spent_hours ?? 0) > 0;
  return true;
}

/** Increment 33 (docs/INCREMENT_33_CONTRACTS.md §5) — sentinel `<select>`
 * value for the "Unassigned" bucket of the sprint-member person filter. */
const SPRINT_FILTER_UNASSIGNED = "unassigned";

/**
 * Increment 33 (§5): stable identity key for the sprint board's per-assignee
 * filter — mirrors how the board keys assignees elsewhere (`capacityLineKey`/
 * `assigneeKey` in lib/capacity.ts): the OP user id when present (so two
 * differently-cased/spelled captures of the same person still collapse to one
 * option), else the trimmed/lower-cased name (so a legacy name-only row still
 * gets its own stable option), else the shared "unassigned" bucket.
 */
function sprintMemberFilterKey(item: Pick<SprintItemDetail, "assignee_op_id" | "assignee_name">): string {
  if (item.assignee_op_id != null) return `id:${item.assignee_op_id}`;
  if (item.assignee_name != null) return `name:${item.assignee_name.trim().toLowerCase()}`;
  return SPRINT_FILTER_UNASSIGNED;
}

/**
 * SPEC §8 Sprint board: drag & drop work packages from the backlog into the
 * selected sprint, with a per-assignee + aggregate capacity indicator and an
 * overload warning. Membership is fetched PER SPRINT via GET /sprints/:id/items
 * (not the backlog's global `in_sprint` flag, which is true for ANY open sprint
 * and would make two concurrent sprints show the same items). Optimistic on drop.
 */
export function SprintBoardScreen({
  sprints,
  selectedSprintId,
  onSelectSprint,
  onSprintsChanged,
  refreshKey,
  baseUrl,
  onGoToSetup,
}: {
  sprints: Sprint[];
  selectedSprintId: number | undefined;
  onSelectSprint: (id: number) => void;
  onSprintsChanged: () => void;
  refreshKey: number;
  /**
   * SPEC_09 §4: fallback OP base URL for ticket deep links when a row has no
   * `connection_base_url` of its own (legacy rows) — normally the "current"
   * connection, mirroring BacklogScreen's `baseUrl` prop.
   */
  baseUrl?: string;
  /** SPEC_09 §1: lets the activation-blocked banner jump straight to Setup to reconnect. */
  onGoToSetup?: () => void;
}) {
  // Union of ALL imported projects — a sprint may span multiple projects.
  const backlog = useAsync(() => api.getBacklog({}), [refreshKey]);
  const sprint = sprints.find((s) => s.id === selectedSprintId);

  // Increment 13 (REVISED, SPEC_13 §1a/§3): every person GET /people knows
  // about for this sprint — name, hours, tickets, and op_user_id WHEN known.
  // Only meaningful for a retrospective sprint (a normal sprint's roster is
  // always live-OP-id-derived, never name-only), and — unlike retro/preview
  // and retro/seed — this is a plain informational GET, NOT gated to
  // "planning" (SPEC_13 §5's state-machine fix is about mutating/planning-
  // only endpoints; this one is safe to read in any sprint status, same as
  // the capacity-audit trail). Shared by the Capacity panel (to know which
  // connection a name-only line belongs to, for the optional "Link to OP
  // account" action) and the low-key "People in this sprint" summary.
  const sprintPeopleState = useAsync<SprintPeopleResponse>(
    () => (sprint?.is_retrospective ? api.getSprintPeople(sprint.id) : Promise.resolve([])),
    [sprint?.id, sprint?.is_retrospective, refreshKey],
  );

  // Hoisted out of `Board` (SPEC_05 §6.1) so the "Sprint details" panel — which
  // now also hosts the lifecycle controls (Activate/Update/Finish/Back to
  // planning) — can render promptly once a sprint is selected, without waiting
  // on the (potentially large) backlog fetch that gates `Board` below.
  //
  // SPEC_07 §5: this now fetches the ENRICHED, dismissal-immune endpoint
  // directly — the sprint's own roster is sourced entirely from here (never
  // cross-referenced against the backlog's dismissal-filtered `items`), so an
  // active/closed sprint can't visually lose an item just because it was
  // removed from the Backlog screen.
  const sprintItemsDetailedState = useAsync(
    () => (sprint ? api.getSprintItemsDetailed(sprint.id) : Promise.resolve([])),
    [sprint?.id, refreshKey],
  );
  const capacityState = useAsync<CapacityResponse | undefined>(
    () => (sprint ? api.getCapacity(sprint.id) : Promise.resolve(undefined)),
    [sprint?.id, refreshKey],
  );

  // SPEC_11 §2: a transient success banner for "Delete sprint" — lives here
  // (not inside SprintDetailsPanel) so it survives the panel briefly showing
  // "Create or select a sprint" while `sprints`/`selectedSprintId` catch up.
  const [notice, setNotice] = useState<string | undefined>();
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(undefined), 4000);
    return () => window.clearTimeout(t);
  }, [notice]);

  return (
    <>
      {notice ? (
        <div className="msg ok" role="status" style={{ marginBottom: 16 }}>
          {notice}
        </div>
      ) : null}

      <Panel
        title="Sprint board"
        actions={<SprintSelect sprints={sprints} value={selectedSprintId} onChange={onSelectSprint} />}
      >
        <CreateSprintForm onCreated={onSprintsChanged} />
      </Panel>

      {sprint == null ? (
        <Panel>
          <EmptyState>Create or select a sprint to start planning.</EmptyState>
        </Panel>
      ) : (
        <SprintDetailsPanel
          sprint={sprint}
          sprintItemsDetailedState={sprintItemsDetailedState}
          capacity={capacityState.data}
          onChanged={onSprintsChanged}
          refreshKey={refreshKey}
          onGoToSetup={onGoToSetup}
          onDeleted={(exportPath) => {
            setNotice(
              exportPath
                ? `"${sprint.name}" was deleted. Backed up to: ${exportPath}`
                : `"${sprint.name}" was deleted.`,
            );
            onSprintsChanged();
          }}
        />
      )}

      {sprint == null ? null : (
        <RetroPlanningPanel
          sprint={sprint}
          onChanged={onSprintsChanged}
          refreshKey={refreshKey}
          // SPEC_13 §1a/§3: the neutral "People in this sprint" summary — a
          // low-key convenience view, not the primary retro-planning flow.
          peopleState={sprintPeopleState}
        />
      )}

      {sprint == null ? null : (
        <Async state={backlog} loadingLabel="Loading backlog…">
          {(items) => (
            <Board
              key={sprint.id}
              sprint={sprint}
              sprints={sprints}
              items={items}
              sprintItemsDetailedState={sprintItemsDetailedState}
              capacityState={capacityState}
              sprintPeople={sprintPeopleState.data ?? []}
              onBacklogReload={() => backlog.reload()}
              onSprintsChanged={onSprintsChanged}
              refreshKey={refreshKey}
              baseUrl={baseUrl}
            />
          )}
        </Async>
      )}
    </>
  );
}

function Board({
  sprint,
  sprints,
  items,
  sprintItemsDetailedState,
  capacityState,
  sprintPeople,
  onBacklogReload,
  onSprintsChanged,
  refreshKey,
  baseUrl,
}: {
  sprint: Sprint;
  /** Increment 34 (docs/INCREMENT_34_CONTRACTS.md §5): the full sprint list
   * (any status), needed to offer eligible carry-over targets on a
   * sprint-member card once this sprint is closed/locked. */
  sprints: Sprint[];
  items: BacklogItem[];
  sprintItemsDetailedState: AsyncResult<SprintItemDetail[]>;
  capacityState: AsyncResult<CapacityResponse | undefined>;
  /** SPEC_13 §1a/§3: this sprint's GET /people rows — lets a capacity line
   * with op_user_id null find the connection_id it needs to offer the
   * optional "Link to OP account" action. Empty for a non-retrospective
   * sprint (fetch is skipped entirely one level up). */
  sprintPeople: SprintPeopleResponse;
  onBacklogReload: () => void;
  /** SPEC_11 §8b: Reactivate needs to refresh the SHARED sprint list
   * (is_locked/status live one level up). Increment 28 (§1): also the
   * App-level refreshKey-bump — every mutation in this component that can
   * change effectiveEstimate or sprint membership calls this too, not just
   * the local `refresh()` triad below. */
  onSprintsChanged: () => void;
  /** Increment 28 (§1): closes the one real gap in the "three states share
   * refreshKey" claim — `closureStatsState` below used to be keyed on
   * `sprint.id` alone, so a refreshKey bump from OUTSIDE this component
   * (e.g. BacklogScreen's estimate override, on a different tab) never
   * reached the developer-segment bars. Now it does. */
  refreshKey: number;
  baseUrl?: string;
}) {
  // Membership + display data for THIS sprint, sourced directly from the
  // ENRICHED endpoint (SPEC_07 §5) — never from cross-referencing the
  // dismissal-filtered backlog `items` by op_id, so a ticket dismissed from
  // the Backlog screen can never make its already-committed sprint card
  // disappear. Fetched one level up (SprintBoardScreen) and passed down.
  const detailedItems: SprintItemDetail[] = sprintItemsDetailedState.data ?? [];

  // Increment 15 (SPEC_15): GET /sprints/:id/closure-stats also carries, per
  // developer, the real-work-driven `segments` the capacity bar renders
  // (CapacityPanel below) — additive to the existing baseline-only
  // CapacityLine bar, which stays the fallback for non-developers or while
  // this hasn't loaded yet. Read-only, safe in any sprint status (same as
  // ClosureScreen's own fetch of the same endpoint).
  const closureStatsState = useAsync<ClosureStatsResponse | undefined>(
    () => (sprint ? api.getClosureStats(sprint.id) : Promise.resolve(undefined)),
    [sprint.id, refreshKey],
  );

  // Increment 32 (docs/INCREMENT_32_CONTRACTS.md §4/§5) — "Outside the
  // sprint": fetched eagerly (not lazily behind a click, unlike
  // CapacityAuditToggle below) because the collapsed header still needs to
  // show a total-hours figure without the planner having to expand it first.
  // Keyed on sprint.id + refreshKey exactly like capacityState/closureStatsState,
  // so a sprint switch refetches and every refresh() call below picks up a
  // fresh report too.
  const offSprintTimeState = useAsync<OffSprintTimeResponse | undefined>(
    () => (sprint ? api.getOffSprintTime(sprint.id) : Promise.resolve(undefined)),
    [sprint.id, refreshKey],
  );

  // Optimistic in-sprint override, cleared whenever fresh data arrives.
  const [pending, setPending] = useState<Record<number, boolean>>({});
  const [error, setError] = useState<Error | undefined>();
  useEffect(() => setPending({}), [items, sprintItemsDetailedState.data]);

  // Ticket changelog modal target (SPEC_04 §6) — only offered for items
  // currently in an ACTIVATED sprint (activated_at != null) that actually
  // have history (SPEC_09 §2). connectionBaseUrl carries the ticket's own
  // source server (SPEC_09 §4) so the modal's "open in OP" link is correct.
  const [changelogTarget, setChangelogTarget] = useState<
    { wpId: number; subject: string; connectionBaseUrl: string | null } | undefined
  >();

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  // SPEC_05 §1/§9.1 visibility rule, now evaluated straight off the detailed
  // rows — outcome and spent_hours already live on the same object.
  // Increment 28 (§2a): wrapped through `withDoubleCount` so every downstream
  // consumer (the WpCard badges, the CapacityPanel warning) reads the SAME
  // backend-computed `double_count_children`/`double_count_parent_of` — no
  // second, client-side parent/child recomputation anywhere in this file.
  const visibleDetailed = useMemo(
    () => detailedItems.filter(isVisibleInSprintDetail).map(withDoubleCount),
    [detailedItems],
  );
  const detailedByOp = useMemo(
    () => new Map(visibleDetailed.map((it) => [it.op_id, it])),
    [visibleDetailed],
  );

  // Union of backlog candidates and actual sprint members, keyed by op_id.
  // Detail data wins for anything that's an actual (visible) sprint member —
  // this is what keeps a backlog-dismissed-but-still-committed ticket in the
  // union even though it's no longer present in `items` (SPEC_07 §5).
  const byOp = useMemo(() => {
    const m = new Map<number, BacklogItem | SprintItemDetail>();
    for (const it of items) m.set(it.op_id, it);
    for (const it of visibleDetailed) m.set(it.op_id, it);
    return m;
  }, [items, visibleDetailed]);

  const view = useMemo(
    () =>
      [...byOp.entries()].map(([opId, base]) => {
        const detail = detailedByOp.get(opId);
        return {
          ...base,
          op_id: opId,
          in_sprint: pending[opId] ?? detailedByOp.has(opId),
          // Present only once the item is actually in this sprint (SPEC_05 §3).
          origin: detail?.origin,
          historicalRemoved: detail?.outcome === "removed_mid_sprint",
          // SPEC_07 §5: surfaced as a badge, never used to hide the item.
          noLongerInBacklog: detail?.no_longer_in_backlog ?? false,
          // SPEC_09 §2: gates the History button — only render it when the
          // ticket actually has changelog entries for this sprint.
          hasHistory: detail?.has_history ?? false,
          // Increment 28 (§2a): only ever non-empty/non-null for an item
          // actually IN this sprint (`detail` comes from the enriched
          // detailed-items endpoint) — a plain backlog candidate never
          // carries double-counting data, by construction.
          double_count_children: detail?.double_count_children ?? [],
          double_count_parent_of: detail?.double_count_parent_of ?? null,
        };
      }),
    [byOp, detailedByOp, pending],
  );
  const inSprint = view.filter((it) => it.in_sprint);
  // SPEC_09 §5/§6: the Sprint board's OWN backlog panel hides tickets whose
  // source connection is disconnected/unreachable entirely (unlike the
  // standalone Backlog screen, which keeps showing them dimmed) — planning
  // should only ever draw from live data.
  const backlogItems = view.filter((it) => !it.in_sprint && !it.stale);

  // Increment 33 (docs/INCREMENT_33_CONTRACTS.md §5) — "Filter sprint tickets
  // by assignee": narrows ONLY the sprint-member card list rendered below
  // (2a) — the backlog column, capacity lines, off-sprint section, and every
  // header total/count in this component keep reading `inSprint` itself,
  // never `filteredInSprint`. Purely client-side, no API change (§5 point 1).
  const [assigneeFilter, setAssigneeFilter] = useState("");
  // SPEC_10 §c pattern (same one CapacityPanel's `added` state below uses):
  // an explicit reset keyed on the sprint id, since a stale `Board` instance
  // can in principle be reused across a sprint switch even though today it's
  // also remounted via the parent's `key={sprint.id}` — belt and braces.
  useEffect(() => setAssigneeFilter(""), [sprint.id]);

  // Options derived from the CURRENT sprint roster (`inSprint`, unfiltered)
  // so the option list itself never shrinks once a filter is applied: distinct
  // assignees name asc, "Unassigned" appended last only when at least one
  // member item genuinely has no assignee.
  const assigneeFilterOptions = useMemo(() => {
    const byKey = new Map<string, string>();
    let hasUnassigned = false;
    for (const it of inSprint) {
      const key = sprintMemberFilterKey(it);
      if (key === SPRINT_FILTER_UNASSIGNED) {
        hasUnassigned = true;
        continue;
      }
      if (!byKey.has(key)) byKey.set(key, it.assignee_name ?? `User #${it.assignee_op_id}`);
    }
    const sorted = [...byKey.entries()].sort((a, b) => a[1].localeCompare(b[1]));
    return hasUnassigned ? [...sorted, [SPRINT_FILTER_UNASSIGNED, "Unassigned"] as [string, string]] : sorted;
  }, [inSprint]);

  const filteredInSprint = useMemo(
    () => (assigneeFilter ? inSprint.filter((it) => sprintMemberFilterKey(it) === assigneeFilter) : inSprint),
    [inSprint, assigneeFilter],
  );

  // SPEC_04 §6: locked (or legacy pre-Increment-4 "closed") sprints are read-only —
  // no drag/drop, no move buttons. The ticket changelog stays viewable regardless.
  // Increment 39 (§6): a Viewer gets the same fully read-only board as a locked
  // sprint (no drag/drop, no Add/Return/Carry, no add-by-id, no double-count fixes).
  const canPlan = useCan("plan");
  const locked = isReadOnly(sprint) || !canPlan;

  // Real assignees from the project backlog — the planner can set availability for
  // these people even before any of their work is dragged into the sprint.
  const people = useMemo(() => backlogPeople(items), [items]);

  // Increment 28 (docs/INCREMENT_28_CONTRACTS.md §1): the local triad below
  // was already correct for THIS mount (immediate feedback, no flash) — the
  // bug was every OTHER mutation site that bypassed it (an estimate override
  // on the separate Backlog tab, the §2c bulk fixes below). Now `refresh()`
  // ALSO bumps the shared App-level refreshKey (`onSprintsChanged`), so it is
  // the ONE call every membership/estimate-affecting mutation in this
  // component funnels through — never a bespoke reload() elsewhere.
  function refresh() {
    sprintItemsDetailedState.reload();
    capacityState.reload();
    closureStatsState.reload();
    offSprintTimeState.reload();
    onBacklogReload();
    onSprintsChanged();
  }

  async function move(wpId: number, into: boolean) {
    if (locked) return;
    setPending((p) => ({ ...p, [wpId]: into }));
    setError(undefined);
    try {
      if (into) await api.addSprintItem(sprint.id, { wp_op_id: wpId });
      else await api.removeSprintItem(sprint.id, wpId);
      refresh();
    } catch (err) {
      // Revert optimistic change on failure.
      setPending((p) => {
        const next = { ...p };
        delete next[wpId];
        return next;
      });
      if (err instanceof ApiError && err.body?.error.code === "ITEM_ALREADY_IN_SPRINT") {
        refresh();
      } else {
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  function onDragEnd(e: DragEndEvent) {
    const wpId = Number(e.active.id);
    const over = e.over?.id;
    if (over === "sprint") void move(wpId, true);
    else if (over === "backlog") void move(wpId, false);
  }

  // Increment 28 (§2a): double-counting groups, straight off the backend's
  // own ancestor-aware detection (`double_count_children` on each enriched
  // sprint item) — no client-side parent/child recomputation any more.
  const doubleCountGroupsList = useMemo(() => doubleCountGroups(visibleDetailed), [visibleDetailed]);

  // Increment 28 (§2d): "jump to ticket" target for a warning-group id —
  // scrolls the matching WpCard into view and highlights it briefly.
  const [highlightedOpId, setHighlightedOpId] = useState<number | undefined>();
  function scrollToTicket(opId: number) {
    setHighlightedOpId(opId);
    document.getElementById(`wp-card-${opId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => setHighlightedOpId((cur) => (cur === opId ? undefined : cur)), 2500);
  }

  // Wait for this sprint's membership before rendering columns, so items never
  // flash in the wrong column while GET /sprints/:id/items/detailed is in flight.
  if (sprintItemsDetailedState.error) {
    return (
      <Panel>
        <ErrorBox error={sprintItemsDetailedState.error} onRetry={() => sprintItemsDetailedState.reload()} />
      </Panel>
    );
  }
  if (sprintItemsDetailedState.data === undefined) {
    return (
      <Panel>
        <EmptyState>Loading sprint…</EmptyState>
      </Panel>
    );
  }

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      {error ? <div style={{ marginBottom: 12 }}><ErrorBox error={error} onRetry={() => setError(undefined)} /></div> : null}

      <LockBanner sprint={sprint} />
      <ReactivateControl sprint={sprint} onChanged={onSprintsChanged} />
      <EndDateWarning sprint={sprint} />

      {/* SPEC_25 §3 point 4: only for planning/active — same gate as drag/drop
          (`locked` === `isReadOnly(sprint)`). The backend rejects a locked
          sprint with SPRINT_LOCKED regardless (addByIdErrorMessage handles
          that), so this is a preemptive UX nicety, not the only guard. */}
      {!locked ? <AddTicketByIdForm sprintId={sprint.id} onAdded={refresh} /> : null}

      <CapacityPanel
        sprintId={sprint.id}
        status={sprint.status}
        isRetrospective={sprint.is_retrospective}
        capacity={capacityState.data}
        capacityError={capacityState.error}
        onReloadCapacity={() => capacityState.reload()}
        perDeveloper={closureStatsState.data?.per_developer}
        doubleCountGroups={doubleCountGroupsList}
        doubleCountLocked={locked}
        onScrollToTicket={scrollToTicket}
        onDoubleCountFixed={refresh}
        people={people}
        sprintPeople={sprintPeople}
        onLinked={onSprintsChanged}
        offSprintTime={offSprintTimeState.data}
      />

      <div className="board" style={canPlan ? undefined : { gridTemplateColumns: "1fr" }}>
        {canPlan ? (
          <BacklogColumn items={backlogItems} disabled={locked} onMove={(id) => move(id, true)} baseUrl={baseUrl} />
        ) : null}
        <DropColumn
          id="sprint"
          title={`${sprint.name} (${inSprint.length})`}
          filters={
            inSprint.length > 0 ? (
              <div className="row" style={{ marginBottom: 8 }}>
                <select
                  aria-label="Filter sprint tickets by assignee"
                  value={assigneeFilter}
                  onChange={(e) => setAssigneeFilter(e.target.value)}
                >
                  <option value="">All people</option>
                  {assigneeFilterOptions.map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            ) : null
          }
        >
          {inSprint.length === 0 ? (
            <EmptyState>{canPlan ? "Drag work packages here to plan the sprint." : "No tickets in this sprint."}</EmptyState>
          ) : filteredInSprint.length === 0 ? (
            <EmptyState>No sprint tickets match this filter.</EmptyState>
          ) : (
            filteredInSprint.map((it) => (
              <WpCard
                key={it.op_id}
                item={it}
                disabled={locked || it.historicalRemoved}
                onMove={() => move(it.op_id, false)}
                moveLabel="← Return"
                // SPEC_25 §5 (confirmed decision): a retroactively-added ticket
                // gets the IDENTICAL "Added" badge as an ordinary mid-sprint
                // addition — no separate "retro" label. `added_retroactively`
                // stays purely a data-level distinction (audit/backdating).
                added={it.origin === "added_mid_sprint" || it.origin === "added_retroactively"}
                historicalRemoved={it.historicalRemoved}
                noLongerInBacklog={it.noLongerInBacklog}
                highlighted={it.op_id === highlightedOpId}
                baseUrl={baseUrl}
                // SPEC_09 §2: only offered for an activated sprint's ticket
                // that actually has changelog history — never just to open
                // on "No history yet."
                onOpenChangelog={
                  sprint.activated_at && it.hasHistory
                    ? () =>
                        setChangelogTarget({
                          wpId: it.op_id,
                          subject: it.subject,
                          connectionBaseUrl: it.connection_base_url,
                        })
                    : undefined
                }
                // Increment 34 (§5): "Carry over" is only ever offered for an
                // actual sprint member (never a backlog candidate), and only
                // rendered by WpCard once `sourceLocked` + `!is_done` both
                // hold — passed unconditionally here, the gating lives in
                // WpCard itself so it stays next to the badge/button markup.
                sprints={sprints}
                sourceSprintId={sprint.id}
                sourceLocked={locked}
                onCarried={refresh}
              />
            ))
          )}
        </DropColumn>
      </div>

      {changelogTarget ? (
        <ChangelogPanel
          sprintId={sprint.id}
          wpId={changelogTarget.wpId}
          subject={changelogTarget.subject}
          ticketUrl={
            changelogTarget.connectionBaseUrl ?? baseUrl
              ? opWorkPackageUrl((changelogTarget.connectionBaseUrl ?? baseUrl) as string, changelogTarget.wpId)
              : undefined
          }
          onClose={() => setChangelogTarget(undefined)}
        />
      ) : null}
    </DndContext>
  );
}

/** SPEC_04 §6: prominent, unmissable read-only banner once a sprint is locked. */
function LockBanner({ sprint }: { sprint: Sprint }) {
  if (!sprint.is_locked) return null;
  return (
    <div className="msg ok" role="status" style={{ marginBottom: 16 }}>
      🔒{" "}
      {sprint.lock_reason === "finished"
        ? "This sprint is finished and locked — read-only."
        : "This sprint locked automatically at its end date — read-only."}{" "}
      Locked {relativeTime(sprint.locked_at)}.
    </div>
  );
}

/** SPEC_04 §6 nice-to-have: flag an active, unlocked sprint whose end date has
 * already passed — it will lock automatically on the next scheduled update. */
function EndDateWarning({ sprint }: { sprint: Sprint }) {
  if (sprint.is_locked || sprint.status !== "active") return null;
  const end = new Date(`${sprint.end_date}T23:59:59`);
  if (Number.isNaN(end.getTime()) || end.getTime() > Date.now()) return null;
  return (
    <div className="msg warn" role="alert" style={{ marginBottom: 16 }}>
      End date has passed — this sprint will lock automatically on the next scheduled update.
    </div>
  );
}

/**
 * Increment 25 (SPEC_25 §3/§6/§9) — the exact, stable copy for each error
 * code `POST /sprints/:id/items/by-id` can throw. Deliberately overrides the
 * generic `errorMessage()`/`ErrorBox` rendering (which would just echo the
 * server's own message + code) with wording specific to THIS action, per
 * SPEC_25 §3 point 4 / §9's confirmed decisions — most notably SPRINT_LOCKED,
 * which must point at Reactivate (the actual way forward, ReactivateControl
 * above) rather than a bare "locked" message. Unknown/unmapped codes and
 * non-ApiError failures fall through to the error as-is, still rendered by
 * the shared ErrorBox.
 */
function addByIdErrorMessage(err: unknown): Error {
  if (err instanceof ApiError) {
    switch (err.body?.error.code) {
      case "SPRINT_LOCKED":
        return new Error("This sprint is locked — reactivate it first.");
      case "SPRINT_CLOSED":
        return new Error("This sprint is closed — reactivate it first.");
      case "CONNECTION_DISABLED":
        return new Error("That connection is disabled — enable it or pick another.");
      case "WORK_PACKAGE_NOT_FOUND":
        return new Error("No work package with that ID was found on the selected server.");
      case "ITEM_ALREADY_IN_SPRINT":
        return new Error("This ticket is already in the sprint.");
      case "NO_CONNECTION":
        return new Error("No connection is configured — add one in Setup first.");
      default:
        return err;
    }
  }
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Increment 25 (SPEC_25 §1/§3) — "add ticket by ID" directly into the sprint,
 * for a ticket that was completed entirely outside normal tracking (done/
 * tested, never surfaced in the backlog — SPEC_25 §1's "noční AU ticket" use
 * case). Only rendered for a planning/active sprint (Board gates this on
 * `!locked`, the same `isReadOnly` condition that already disables drag/drop
 * — SPEC_25 §3 point 4 confirms the backend rejects a locked sprint with
 * SPRINT_LOCKED anyway, so this is belt-and-braces UX, not the only guard).
 *
 * The server picker (SPEC_25 §3 point 2) is only shown once 2+ connections
 * exist — with exactly one, `connection_id` is simply omitted and the
 * backend defaults to "the current connection" (same convention as every
 * other connection-optional endpoint, e.g. RetroSeedForm's version lookup).
 * Once added, the ticket looks EXACTLY like an ordinary mid-sprint addition
 * (SPEC_25 §5) — this form has no special "retro" affordance of its own.
 */
function AddTicketByIdForm({ sprintId, onAdded }: { sprintId: number; onAdded: () => void }) {
  const connectionsState = useAsync(() => api.getConnections(), []);
  const connections = connectionsState.data ?? [];

  const [wpId, setWpId] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  const [notice, setNotice] = useState<string | undefined>();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const id = Number(wpId);
    if (!Number.isInteger(id) || id <= 0) {
      setError(new Error("Enter a valid ticket ID."));
      setNotice(undefined);
      return;
    }
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await api.addSprintItemById(sprintId, {
        wp_op_id: id,
        connection_id: connectionId ? Number(connectionId) : undefined,
      });
      setNotice(`#${id} added to the sprint.`);
      setWpId("");
      onAdded();
    } catch (err) {
      setError(addByIdErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginBottom: 16 }} data-testid="add-ticket-by-id">
      <form className="row" style={{ alignItems: "flex-end", flexWrap: "wrap" }} onSubmit={(e) => void submit(e)}>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="add-by-id-wp">Add ticket by ID</label>
          <input
            id="add-by-id-wp"
            type="number"
            min={1}
            step={1}
            style={{ width: 120 }}
            placeholder="e.g. 12345"
            value={wpId}
            disabled={busy}
            onChange={(e) => setWpId(e.target.value)}
          />
        </div>
        {connections.length > 1 ? (
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="add-by-id-connection">Server</label>
            <select
              id="add-by-id-connection"
              aria-label="Server"
              value={connectionId}
              disabled={busy}
              onChange={(e) => setConnectionId(e.target.value)}
            >
              <option value="">Current connection</option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label ?? c.base_url}
                  {!c.enabled ? " (disabled)" : ""}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <button type="submit" className="btn small" disabled={busy || !wpId.trim()}>
          {busy ? "Adding…" : "Add ticket"}
        </button>
      </form>
      {notice ? (
        <div className="msg ok" role="status" style={{ marginTop: 8 }}>
          {notice}
        </div>
      ) : null}
      {error ? (
        <div style={{ marginTop: 8 }}>
          <ErrorBox error={error} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * SPEC_11 §8b: "escape hatch" alongside LockBanner — lets a locked sprint
 * come back to "active" (update/add/remove work again), gated on the
 * start–end window (isWithinSprintWindow above) and a yes/no confirm modal.
 * Recorded server-side as a sprint_update_run (kind="reactivate") for audit.
 */
function ReactivateControl({ sprint, onChanged }: { sprint: Sprint; onChanged: () => void }) {
  const canPlan = useCan("plan");
  const [showConfirm, setShowConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | undefined>();

  if (!canPlan || !sprint.is_locked || !isWithinSprintWindow(sprint)) return null;

  async function confirm() {
    setBusy(true);
    setError(undefined);
    try {
      await api.reactivateSprint(sprint.id, { triggered_by: "manual" });
      setShowConfirm(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <button type="button" className="btn small" onClick={() => setShowConfirm(true)} disabled={busy}>
        Reactivate
      </button>
      {error ? <div style={{ marginTop: 8 }}><ErrorBox error={error} /></div> : null}
      {showConfirm ? (
        <Modal title="Reactivate sprint?" onClose={() => (busy ? undefined : setShowConfirm(false))}>
          <p>
            Are you sure? <strong>{sprint.name}</strong> will return to <em>active</em> — Update Sprint, adding, and
            removing items work again until it's finished or locks again.
          </p>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="btn small secondary" disabled={busy} onClick={() => setShowConfirm(false)}>
              No
            </button>
            <button type="button" className="btn small" disabled={busy} onClick={() => void confirm()}>
              {busy ? "Reactivating…" : "Yes, reactivate"}
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

/**
 * SPEC_11 §2: red "Delete sprint" + yes/no confirm modal, available in EVERY
 * sprint status (planning/active/finished/locked) — a hard delete of the
 * sprint and all of ITS local history (items, baseline, changelog, burndown,
 * capacity, closure report). Never touches OP or the backlog cache.
 *
 * SPEC_12 §6: a JSON backup is written to `exports/` BEFORE the cascade runs
 * (server-side, always — the delete never proceeds if the export itself
 * fails to write). The confirm step can only describe that generically
 * (the exact filename isn't known yet); once the delete succeeds, the modal
 * stays open one more beat to show the ACTUAL `export_path` from the
 * response before closing — SPEC_12 §6: "Cesta se ukáže v potvrzovacím
 * modalu i po smazání."
 *
 * IMPORTANT (both live-verify catches, keep both fixes together):
 * 1. `onDeleted` is deliberately NOT called right after the API call
 *    succeeds — it's what tells SprintBoardScreen to call `onSprintsChanged()`,
 *    which refetches the shared sprint list. Once that list no longer contains
 *    THIS sprint, the parent stops rendering this very button (and its modal)
 *    — calling it eagerly made the "Backed up to: <path>" screen below unmount
 *    before it ever painted. So `onDeleted` fires only once the user dismisses
 *    the post-delete screen (closeModal), by which point they've already read
 *    the export path.
 * 2. "Did the delete succeed" is tracked by its OWN boolean (`deleted`), not
 *    by whether `exportPath` is truthy. Caught live against a backend build
 *    that hadn't wired `export_path` into the response yet (Agent B's side,
 *    SPEC_12 §6): the DELETE call succeeded (200, sprint gone server-side),
 *    but `export_path` came back empty/undefined, so a truthy check on it
 *    silently fell back to re-rendering "Delete sprint?" — hiding a delete
 *    that had already happened, and leaving the button clickable again for a
 *    now-nonexistent sprint (a second click 404s SPRINT_NOT_FOUND).
 */
function DeleteSprintButton({ sprint, onDeleted }: { sprint: Sprint; onDeleted: (exportPath: string) => void }) {
  const canPlan = useCan("plan");
  const [showConfirm, setShowConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  // Deliberately a SEPARATE boolean from `exportPath` (not a truthy check on
  // the path itself) — live-verify caught a real bug here: while the backend
  // doesn't yet send `export_path` (mid-build), the response still resolves
  // successfully with an empty/undefined path, and a truthy check silently
  // fell back to re-rendering the "Delete sprint?" confirm step, hiding a
  // delete that had already happened. `deleted` tracks ONLY "did the API call
  // succeed", independent of whatever the path string turns out to be.
  const [deleted, setDeleted] = useState(false);
  const [exportPath, setExportPath] = useState<string | undefined>();

  async function confirm() {
    setBusy(true);
    setError(undefined);
    try {
      const res = await api.deleteSprint(sprint.id);
      setExportPath(res.export_path);
      setDeleted(true);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  }

  function closeModal() {
    if (busy) return;
    setShowConfirm(false);
    if (deleted) onDeleted(exportPath ?? "");
    setDeleted(false);
    setExportPath(undefined);
  }

  if (!canPlan) return null;

  return (
    <>
      <button type="button" className="btn danger" onClick={() => setShowConfirm(true)}>
        Delete sprint
      </button>
      {showConfirm ? (
        <Modal title={deleted ? "Sprint deleted" : "Delete sprint?"} onClose={closeModal}>
          {deleted ? (
            <>
              <p>
                <strong>{sprint.name}</strong> was permanently deleted.
              </p>
              <p className="msg ok" role="status" data-testid="delete-export-path">
                {exportPath ? <>Backed up to: <code>{exportPath}</code></> : "Backed up (export path not reported)."}
              </p>
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <button type="button" className="btn small" onClick={closeModal}>
                  Done
                </button>
              </div>
            </>
          ) : (
            <>
              <p>
                Are you sure? This permanently deletes <strong>{sprint.name}</strong> and all of its history — items,
                baseline, changelog, burndown, capacity, and any closure report. OpenProject is not touched.
              </p>
              <p className="muted" style={{ fontSize: 12 }}>
                A JSON backup will be saved to <code>exports/</code> before deleting.
              </p>
              {error ? <div style={{ marginBottom: 12 }}><ErrorBox error={error} /></div> : null}
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <button type="button" className="btn small secondary" disabled={busy} onClick={() => setShowConfirm(false)}>
                  No
                </button>
                <button type="button" className="btn small danger" disabled={busy} onClick={() => void confirm()}>
                  {busy ? "Deleting…" : "Yes, delete"}
                </button>
              </div>
            </>
          )}
        </Modal>
      ) : null}
    </>
  );
}

/**
 * SPEC_12 §2/§9: "Retrospective planning" checkbox — editable ONLY while the
 * sprint is still "planning" (PATCH is_retrospective 409s server-side once
 * it isn't, and once activated the flag is immutable — see
 * UpdateSprintBody's contract comment). Once it's checked (still planning),
 * shows the seed UI (RetroSeedForm) and — for ANY retrospective sprint, seeded
 * or not (path C: manually added from the backlog) — the start_date preview
 * (RetroPreviewSection), so reconstruction gaps are visible before the user
 * commits via Activate.
 *
 * SPEC_13 §5 (structural fix, not a per-button patch): the planning-only
 * network call this panel makes (retro preview) lives ENTIRELY inside
 * RetroPreviewSection, which is only ever mounted while `editable` — so once
 * the sprint leaves planning, that call stops firing altogether (the
 * component unmounts) instead of quietly re-firing on every `refreshKey`
 * bump and 409ing with SPRINT_NOT_PLANNING. A retro sprint that has left
 * planning collapses to a compact read-only note instead (the
 * "Retrospective" badge itself lives one level up, in SprintDetailsPanel).
 *
 * SPEC_13 §1a/§3 (REVISED): the "People in this sprint" summary is NOT
 * planning-gated — GET /people is a plain informational read, valid in any
 * sprint status (mirrors the capacity-audit trail's own "never gated on
 * sprint status" pattern) — so it's shown for ANY retrospective sprint,
 * regardless of `editable`.
 */
function RetroPlanningPanel({
  sprint,
  onChanged,
  refreshKey,
  peopleState,
}: {
  sprint: Sprint;
  onChanged: () => void;
  refreshKey: number;
  /** SPEC_13 §1a/§3: this sprint's GET /people rows, fetched one level up
   * (shared with the Capacity panel's "Link to OP account" action). */
  peopleState: AsyncResult<SprintPeopleResponse>;
}) {
  const canPlan = useCan("plan");
  // Increment 39: a Viewer sees the retro state but cannot edit/seed/preview
  // (the seed and preview routes contact OpenProject — Planner only).
  const editable = sprint.status === "planning" && canPlan;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | undefined>();

  async function toggle(checked: boolean) {
    setBusy(true);
    setError(undefined);
    try {
      await api.updateSprint(sprint.id, { is_retrospective: checked });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  }

  // Nothing to show for an ordinary sprint once it's left planning — the
  // "Retrospective" badge (SprintDetailsPanel) is the only trace that
  // remains for one that WAS retrospective.
  if (!editable && !sprint.is_retrospective) return null;
  const planningStage = sprint.status === "planning";

  return (
    <Panel title="Retrospective planning">
      <label className="row" style={{ alignItems: "center", gap: 8, marginBottom: 0 }}>
        <input
          type="checkbox"
          aria-label="Retrospective planning"
          checked={sprint.is_retrospective}
          disabled={!editable || busy}
          onChange={(e) => void toggle(e.target.checked)}
        />
        Retrospective planning
      </label>
      <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        {editable
          ? `Fill this sprint with tickets exactly as they looked on its start date (${formatDate(sprint.start_date)}), then replay OP history day by day on Activate.`
          : canPlan
            ? "Only settable while the sprint is in planning."
            : "Read-only — retrospective planning is set up by a Planner."}
      </p>

      {error ? <div style={{ marginBottom: 12 }}><ErrorBox error={error} /></div> : null}

      {editable && sprint.is_retrospective ? <RetroSeedForm sprint={sprint} onSeeded={onChanged} /> : null}

      {editable && sprint.is_retrospective ? (
        <RetroPreviewSection sprintId={sprint.id} startDate={sprint.start_date} refreshKey={refreshKey} />
      ) : sprint.is_retrospective && !planningStage ? (
        <p className="muted" style={{ fontSize: 12, marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
          The start_date preview is only available while this sprint is in planning — the reconstructed baseline is
          now locked in.
        </p>
      ) : null}

      {sprint.is_retrospective ? <SprintPeoplePanel state={peopleState} /> : null}
    </Panel>
  );
}

/**
 * SPEC_12 §2/§12.1: candidate seeding, version-from-OP as the default/primary
 * path (dropdown, populated the same way ImportScreen does — GET /projects
 * then GET /versions?projectId&connectionId, SPEC_12 §9's "reuse that data
 * source"), pasted ticket IDs as the secondary fallback. Either calls
 * POST /sprints/:id/retro/seed, which adds sprint_item rows AND returns the
 * same per-ticket preview GET .../retro/preview would — but the persistent
 * preview table (RetroPreviewTable) is the one source of truth rendered here,
 * refreshed via `onSeeded` so it also picks up manually-added items later.
 */
function RetroSeedForm({ sprint, onSeeded }: { sprint: Sprint; onSeeded: () => void }) {
  const projectsState = useAsync(() => api.getProjects(), []);
  const projects = projectsState.data ?? [];

  const [projectKey, setProjectKey] = useState("");
  const [versionValue, setVersionValue] = useState("");
  const [idsText, setIdsText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  const [seededCount, setSeededCount] = useState<number | undefined>();

  const selectedProject = useMemo(
    () => projects.find((p) => `${p.connection_id ?? "unknown"}:${p.op_id}` === projectKey),
    [projects, projectKey],
  );

  const versionsState = useAsync(
    () =>
      selectedProject
        ? api.getVersions(selectedProject.op_id, selectedProject.connection_id ?? undefined)
        : Promise.resolve([]),
    [selectedProject?.op_id, selectedProject?.connection_id],
  );
  const versions = versionsState.data ?? [];

  async function seed(kind: "version" | "ids", value: string) {
    setBusy(true);
    setError(undefined);
    setSeededCount(undefined);
    try {
      const res = await api.seedRetro(sprint.id, { kind, value });
      setSeededCount(res.candidates.length);
      onSeeded();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 4, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
      <div className="row" style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="retro-project">Project (for version list)</label>
          <select
            id="retro-project"
            value={projectKey}
            disabled={busy}
            onChange={(e) => {
              setProjectKey(e.target.value);
              setVersionValue("");
            }}
          >
            <option value="">Select a project…</option>
            {projects.map((p) => (
              <option
                key={`${p.connection_id ?? "unknown"}:${p.op_id}`}
                value={`${p.connection_id ?? "unknown"}:${p.op_id}`}
              >
                {p.name}
                {p.connection_label ? ` (${p.connection_label})` : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="retro-version">Version</label>
          <select
            id="retro-version"
            aria-label="Version"
            value={versionValue}
            disabled={busy || !selectedProject || versionsState.loading}
            onChange={(e) => setVersionValue(e.target.value)}
          >
            <option value="">
              {!selectedProject
                ? "Select a project first"
                : versionsState.loading
                  ? "Loading versions…"
                  : "Select a version…"}
            </option>
            {versions.map((v) => (
              <option key={v.op_id} value={v.name}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className="btn small"
          disabled={busy || !versionValue}
          onClick={() => void seed("version", versionValue)}
        >
          {busy ? "Seeding…" : "Seed sprint from version"}
        </button>
      </div>

      <div className="field" style={{ marginTop: 12, marginBottom: 0 }}>
        <label htmlFor="retro-ids">Or paste ticket IDs (comma/whitespace-separated) — fallback for tickets not in a version</label>
        <textarea
          id="retro-ids"
          rows={2}
          style={{ width: "100%" }}
          placeholder="e.g. 11762, 11763, 11770"
          value={idsText}
          disabled={busy}
          onChange={(e) => setIdsText(e.target.value)}
        />
        <div style={{ marginTop: 6 }}>
          <button
            type="button"
            className="btn small secondary"
            disabled={busy || !idsText.trim()}
            onClick={() => void seed("ids", idsText)}
          >
            {busy ? "Seeding…" : "Seed sprint from IDs"}
          </button>
        </div>
      </div>

      {error ? <div style={{ marginTop: 8 }}><ErrorBox error={error} /></div> : null}
      {seededCount != null ? (
        <div className="msg ok" role="status" style={{ marginTop: 8 }}>
          Seeded {seededCount} ticket{seededCount === 1 ? "" : "s"} as of {formatDate(sprint.start_date)}.
        </div>
      ) : null}
    </div>
  );
}

/**
 * SPEC_13 §5: hosts the start_date preview, fetching it exactly once — ONLY
 * ever mounted while the sprint is still "planning" (see RetroPlanningPanel
 * above), so leaving planning unmounts this and the network call it makes
 * stops firing, structurally (no SPRINT_NOT_PLANNING from a stale
 * auto-refetch).
 *
 * SPEC_13 §1/§1a (REVISED): no longer also hosts an "unresolved names"
 * pairing UI — a journal-derived name is never blocked on pairing, so
 * there's nothing here left to unblock. The optional "Link to OP account"
 * action now lives directly on the relevant capacity line (CapacityPanel).
 */
function RetroPreviewSection({
  sprintId,
  startDate,
  refreshKey,
}: {
  sprintId: number;
  startDate: string;
  refreshKey: number;
}) {
  const previewState = useAsync(() => api.getRetroPreview(sprintId), [sprintId, refreshKey]);
  return <RetroPreviewTable state={previewState} startDate={startDate} />;
}

/**
 * SPEC_12 §2/§4/§9, SPEC_13 §1/§2: "this is what it looked like on
 * start_date" — read via GET /sprints/:id/retro/preview (fetched by the
 * parent, RetroPreviewSection). Every row shows a REASON, not a generic
 * warning (SPEC_13 §2 point 4): a ticket created after start_date reads as
 * "created …", a genuinely reconstructed row lists its specific gap fields.
 */
function RetroPreviewTable({
  state,
  startDate,
}: {
  state: AsyncResult<RetroPreviewResponse>;
  startDate: string;
}) {
  return (
    <div style={{ marginTop: 16 }}>
      <h3 style={{ fontSize: 12, margin: "0 0 8px", color: "var(--muted)" }}>Preview as of {formatDate(startDate)}</h3>
      <Async
        state={state}
        loadingLabel="Loading preview…"
        isEmpty={(d) => d.items.length === 0}
        empty={<EmptyState>No items yet — seed the sprint from a version/ID list, or add tickets from the backlog.</EmptyState>}
      >
        {(data) => (
          <div style={{ overflowX: "auto" }}>
            <div className="table-scroll">
<table className="grid" data-testid="retro-preview-table">
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>Estimate</th>
                  <th>Assignee</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((it) => (
                  <RetroPreviewRow key={it.wp_op_id} item={it} />
                ))}
              </tbody>
            </table>
</div>
          </div>
        )}
      </Async>
    </div>
  );
}

/** SPEC_13 §2 point 4: the specific reason a row isn't a clean baseline —
 * "created after start_date" (not baseline at all, will land as an addition)
 * is rendered distinctly from a genuinely `reconstructed` row, which lists
 * its actual gap fields inline (not hidden behind a hover-only tooltip). */
function RetroReasonBadge({ item }: { item: RetroSeedCandidate }) {
  if (item.created_after_start_date) {
    const createdDate = item.created_at_op ? formatDate(item.created_at_op) : null;
    return (
      <span
        className="badge"
        title="This ticket did not exist yet at the sprint's start date — every 'at start date' field above is informational fallback only. It will appear as a scope addition on Activate, never as baseline."
      >
        Created{createdDate ? ` ${createdDate}` : ""} — after sprint start (addition, not baseline)
      </span>
    );
  }
  if (item.reconstructed) {
    return (
      <span
        className="badge"
        title={
          item.gaps.length > 0
            ? `Partially reconstructed — no journal data for: ${item.gaps.join(", ")}`
            : "Partially reconstructed from OP journals"
        }
      >
        ⚠ partially reconstructed{item.gaps.length > 0 ? `: ${item.gaps.join(", ")}` : ""}
      </span>
    );
  }
  return null;
}

function RetroPreviewRow({ item }: { item: RetroSeedCandidate }) {
  // SPEC_13 §1 (REVISED): identity IS the name — a journal-derived name
  // reads as a completely normal name here, never a flagged/blocking state.
  // `assignee_resolution` is kept only as a subtle, non-blocking indicator
  // (informational metadata, SPEC_13 §1b) — never styled like an error.
  const noLinkedAccount = item.assignee_resolution === "unresolved";
  return (
    <tr>
      <td>
        #{item.wp_op_id} {item.subject}
      </td>
      <td>{formatHours(item.estimate_at_start_date)}</td>
      <td>
        {item.assignee_at_start_date ?? "Unassigned"}
        {noLinkedAccount ? (
          <span
            className="muted"
            style={{ fontSize: 10, marginLeft: 6 }}
            title={`"${item.assignee_at_start_date}" has no linked OP account yet — this is normal and doesn't block capacity planning.`}
          >
            (no linked account)
          </span>
        ) : null}
      </td>
      <td>{item.status_at_start_date ?? "—"}</td>
      <td>
        <RetroReasonBadge item={item} />
      </td>
    </tr>
  );
}

/**
 * SPEC_13 §1a/§3 (REVISED): a low-key, purely informational "People in this
 * sprint" list — GET /sprints/:id/people, every retro-reconstructed name
 * with its hours/ticket count and linked OP account WHEN known. Deliberately
 * NOT framed as a "problems to fix" queue (there is no more "unresolved,
 * blocked" state, SPEC_13 §1a) — no action is required here; linking an
 * account is a separate, optional action offered directly on the relevant
 * capacity line (see LinkToOpAccountControl in CapacityPanel below).
 */
function SprintPeoplePanel({ state }: { state: AsyncResult<SprintPeopleResponse> }) {
  const people = state.data ?? [];
  // Nothing to flash while the first fetch is still in flight, and nothing
  // to show once it's clear this sprint has no retro-reconstructed people.
  if (state.data === undefined && !state.error) return null;
  if (people.length === 0 && !state.error) return null;

  return (
    <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--border)" }} data-testid="sprint-people-panel">
      <h3 style={{ fontSize: 12, margin: "0 0 8px", color: "var(--muted)" }}>People in this sprint</h3>
      {state.error ? <ErrorBox error={state.error} onRetry={state.reload} /> : null}
      {people.map((p) => (
        <div
          key={`${p.connection_id}:${p.name}`}
          className="row"
          style={{ alignItems: "center", marginBottom: 4, fontSize: 12 }}
        >
          <span>{p.name}</span>
          <span className="muted">
            {formatHours(p.hours)} across {p.ticket_count} ticket{p.ticket_count === 1 ? "" : "s"}
          </span>
          <span className="muted">
            {p.op_user_id != null ? `Linked to OP user #${p.op_user_id}` : "No linked OP account"}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * SPEC §6 / SPEC_05 §6.1: prominent sprint dates + status + useful counts near
 * the top of the board — AND (Increment 5 UI fix) the lifecycle action controls
 * (Activate / Update Sprint / Finish / Back to planning), so it's unambiguous
 * that they act on THIS, currently-displayed sprint. Renders as soon as a
 * sprint is selected — itemCount/planned hours fill in once their (hoisted,
 * shared-with-Board) async fetches resolve, but the controls themselves never
 * wait on that, so they don't flash away behind a slow backlog/items load.
 */
function SprintDetailsPanel({
  sprint,
  sprintItemsDetailedState,
  capacity,
  onChanged,
  refreshKey,
  onGoToSetup,
  onDeleted,
}: {
  sprint: Sprint;
  sprintItemsDetailedState: AsyncResult<SprintItemDetail[]>;
  capacity: CapacityResponse | undefined;
  onChanged: () => void;
  refreshKey: number;
  onGoToSetup?: () => void;
  /** SPEC_11 §2: fires once DELETE /sprints/:id succeeds. SPEC_12 §6: carries
   * the pre-delete JSON export's path so the caller can surface it. */
  onDeleted: (exportPath: string) => void;
}) {
  // Same "still visible?" rule as the board columns (SPEC_05 §1/§9.1 /
  // SPEC_07 §5), so the count here always matches what the sprint column
  // actually shows — sourced straight off the detailed rows, no cross-
  // referencing against the (dismissal-filtered) backlog needed anymore.
  const itemCount = useMemo(() => {
    if (sprintItemsDetailedState.data === undefined) return undefined;
    return sprintItemsDetailedState.data.filter(isVisibleInSprintDetail).length;
  }, [sprintItemsDetailedState.data]);

  // SPEC_05 §2: current total with a delta vs. baseline once one exists
  // (post-activation). Shown as the +added/-removed split summed across
  // capacity lines — reads clearer than a single signed number, and matches
  // the spec's own example ("140 h (+18 / -12)").
  const addedTotal = capacity ? round1(capacity.lines.reduce((s, l) => s + l.added_hours, 0)) : 0;
  const removedTotal = capacity ? round1(capacity.lines.reduce((s, l) => s + l.removed_hours, 0)) : 0;
  const showDelta = capacity?.baseline_total_hours != null && (addedTotal > 0 || removedTotal > 0);

  // Increment 31 (docs/INCREMENT_31_CONTRACTS.md §4 point 3): app-wide config
  // fetched ONCE (empty deps — it's not sprint- or refreshKey-scoped) purely
  // to compute the grace-period deadline client-side; `freezeBadge` above
  // already degrades to "no badge" if this hasn't resolved yet.
  const configState = useAsync<AppConfigResponse | undefined>(() => api.getConfig(), []);
  const badge = freezeBadge(sprint, configState.data?.freeze_grace_days);

  return (
    <Panel title="Sprint details" actions={<DeleteSprintButton sprint={sprint} onDeleted={onDeleted} />}>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <div className="stat">
          <span className="stat-value">
            <span className={`badge ${statusBadgeClass(sprint)}`} data-testid="sprint-status">
              {statusLabel(sprint)}
            </span>
            {sprint.is_retrospective ? (
              <span
                className="badge"
                data-testid="retro-badge"
                title="Filled and activated from OP history (reconstructed), not planned live"
                style={{ marginLeft: 6 }}
              >
                Retrospective
              </span>
            ) : null}
            {badge ? (
              <span className="badge" data-testid="freeze-badge" title={badge.title} style={{ marginLeft: 6 }}>
                {badge.label}
              </span>
            ) : null}
          </span>
          <span className="stat-label">Status</span>
        </div>
        <div className="stat">
          <span className="stat-value" data-testid="sprint-start">{formatDate(sprint.start_date)}</span>
          <span className="stat-label">Start</span>
        </div>
        <div className="stat">
          <span className="stat-value" data-testid="sprint-end">{formatDate(sprint.end_date)}</span>
          <span className="stat-label">End</span>
        </div>
        <div className="stat">
          <span className="stat-value">{itemCount ?? "—"}</span>
          <span className="stat-label">Items in sprint</span>
        </div>
        <div className="stat">
          <span className="stat-value" data-testid="planned-hours-delta">
            {formatHours(capacity?.total_planned_hours ?? null)}
            {showDelta ? (
              <span className="muted" style={{ fontSize: 13, fontWeight: 400, marginLeft: 4 }}>
                ({addedTotal > 0 ? `+${formatHours(addedTotal)}` : ""}
                {addedTotal > 0 && removedTotal > 0 ? " / " : ""}
                {removedTotal > 0 ? `-${formatHours(removedTotal)}` : ""})
              </span>
            ) : null}
          </span>
          <span className="stat-label">Planned hours</span>
        </div>
      </div>

      <div style={{ marginTop: 8 }}>
        <SprintControls sprint={sprint} onChanged={onChanged} refreshKey={refreshKey} onGoToSetup={onGoToSetup} />
      </div>
    </Panel>
  );
}

/**
 * Increment 17 (SPEC_17 §1) — tooltip glosses per DeveloperSegmentKind,
 * matching the spec's own §1 table wording as closely as possible so Phase 2
 * review can sanity-check word-for-word. British English (Increment 16 §4
 * convention, carried forward).
 */
const SEGMENT_KIND_LABEL: Record<DeveloperSegmentKind, string> = {
  // Unreachable in practice — `segmentTooltip()` below special-cases
  // `baseline_worked` itself (planned / logged-and-worked / retained,
  // depending on state and logged hours) before ever consulting this map;
  // kept only so the Record type stays total over all 6 kinds.
  baseline_worked: "baseline",
  handoff: "handed off to another developer",
  removed: "removed from the sprint, no work done",
  acquired: "took on mid-sprint and logged work",
  idle: "acquired mid-sprint, not yet logged",
  churned: "left mid-sprint, no work done",
};

/**
 * Increment 17 (SPEC_17 §1/§7 decision #2) — which bar style a segment kind
 * uses. `baseline_worked` (a) is green; `removed`/`churned` (d/g) share solid
 * blue ("gone, blue" — same visual, different Planned/Change contribution
 * internally, see DeveloperCapacityBreakdown's contract doc); `acquired` (e)
 * is red.
 *
 * Increment 26 (docs/CAPACITY_BAR_RULES.md §2/§6 invariant #1) ABOLISHED the
 * old grey-hatched `baseline_idle` state: a baseline ticket a developer still
 * holds is now `baseline_worked` — and therefore plain green — REGARDLESS of
 * whether they've logged any time on it yet. Only TWO genuinely distinct
 * hatch treatments remain: `handoff` (c, blue hatch — replaces Increment 15's
 * plain grey `redistributed`, a real visual change per SPEC_17) and `idle`
 * (f, amber hatch — mid-sprint acquired, not baseline, not yet logged,
 * informative only). See styles.css's `.bar-handoff`/`.bar-idle` doc comment
 * for why the two hatches read as visually distinct (different hue AND
 * angle).
 */
function segmentKindClass(kind: DeveloperSegmentKind): string {
  switch (kind) {
    case "baseline_worked":
      return "bar-green";
    case "handoff":
      return "bar-handoff";
    case "removed":
    case "churned":
      return "bar-blue";
    case "acquired":
      return "bar-red";
    case "idle":
      return "bar-idle";
  }
}

/** Increment 15 (SPEC_15 §2/§4): one ticket segment's tooltip — subject, the
 * kind label, estimate vs. logged, and (when present) the engine's own
 * `reason`/`current_holder_name`+role, e.g. for redistributed/idle/churned
 * rows where "who has it now" is the whole point. */
function segmentTooltip(seg: DeveloperTicketSegment, isPlanning: boolean): string {
  // SPEC_24 §2/§3: in planning, every segment is the reused `baseline_worked`
  // kind but means "planned", not "logged and worked" (nothing has been
  // logged yet, by definition) — the fixed SEGMENT_KIND_LABEL wording would be
  // actively misleading here, so swap it for a state-correct gloss.
  // Increment 26: in active/closed, `baseline_worked` also covers the
  // zero-logged "retained baseline" case (the former `baseline_idle`) — the
  // fixed "logged and worked" wording would be misleading there too, so gloss
  // by whether this dev has actually logged anything yet.
  const label =
    seg.kind === "baseline_worked"
      ? isPlanning
        ? "planned"
        : seg.logged_hours > 0
          ? "baseline, logged and worked"
          : "baseline, retained (not yet logged)"
      : SEGMENT_KIND_LABEL[seg.kind];
  const parts = [
    `#${seg.wp_op_id} ${seg.subject}`,
    label,
    `estimate ${formatHours(seg.estimate_hours)} · logged ${formatHours(seg.logged_hours)}`,
  ];
  if (seg.reason) parts.push(seg.reason);
  if (seg.current_holder_name) {
    const roleSuffix =
      seg.current_holder_role && seg.current_holder_role !== "unset" ? ` (${seg.current_holder_role})` : "";
    parts.push(`currently held by: ${seg.current_holder_name}${roleSuffix}`);
  }
  return parts.join(" — ");
}

/** Increment 15 (SPEC_15 §2/§4): a segment's "visual width" — its estimate
 * (the bar-length-of-record, SPEC_15 §2/§4 "délka baru = odhad") PLUS any
 * overshoot extension (logged past the estimate, `delivered`/`acquired_worked`
 * only, per SEGMENT_LOGGED_MARKER_KINDS via `show_logged_marker`). */
function developerSegmentVisualWidth(seg: DeveloperTicketSegment): number {
  const base = seg.estimate_hours ?? 0;
  const overshoot = seg.show_logged_marker ? Math.max(0, seg.logged_hours - base) : 0;
  return base + overshoot;
}

/** Same "denominator never collapses to zero" principle as SPEC_13 §4's
 * existing barDenominator: sized off whatever's actually visually drawn
 * (segments + overshoot + the aggregate removed-from-sprint blue span),
 * never off available_hours alone. */
function developerSegmentBarDenominator(
  segments: readonly DeveloperTicketSegment[],
  availableHours: number,
  extraHours = 0,
): number {
  const total = segments.reduce((s, seg) => s + developerSegmentVisualWidth(seg), 0);
  return Math.max(availableHours, total + extraHours, 1);
}

/**
 * Increment 15 (SPEC_15 §2/§4) — renders ONE developer's real-work-driven
 * capacity bar as a row of per-ticket segments (replaces the aggregate
 * green/grey/blue/red spans for a developer with `segments` data). Each
 * segment is `estimate_hours` long (SPEC_15 "délka baru = odhad, marker =
 * realita"); `baseline_worked`/`acquired` segments (SPEC_17 §1 kind names)
 * additionally show the "logged" marker — an inner line when logged <=
 * estimate, or a hatched
 * overshoot EXTENSION past the segment when logged > estimate — deliberately
 * a different visual (see `.bar-logged-marker`/`.bar-overshoot` in
 * styles.css) from the pre-existing `.bar-marker` (which means "this
 * person's available-hours reference line", a different concept entirely).
 */
function DeveloperSegmentBar({
  segments,
  denom,
  testKeyPrefix,
  isPlanning,
}: {
  segments: readonly DeveloperTicketSegment[];
  denom: number;
  testKeyPrefix: string;
  isPlanning: boolean;
}) {
  const pctOfBar = (h: number) => (h / denom) * 100;
  return (
    <>
      {segments.map((seg, i) => {
        const base = seg.estimate_hours ?? 0;
        const overshoot = seg.show_logged_marker ? Math.max(0, seg.logged_hours - base) : 0;
        const visualWidth = base + overshoot;
        const wrapperWidthPct = pctOfBar(visualWidth);
        const basePctOfWrapper = visualWidth > 0 ? (base / visualWidth) * 100 : 100;
        const overshootPctOfWrapper = visualWidth > 0 ? (overshoot / visualWidth) * 100 : 0;
        // Only when logged <= estimate (no overshoot span) is there room to
        // draw the marker INSIDE the segment, at the logged/estimate position.
        const showInnerMarker = seg.show_logged_marker && overshoot === 0 && base > 0;
        const innerMarkerLeftPct = showInnerMarker ? (seg.logged_hours / base) * 100 : 0;
        return (
          <span
            key={`${seg.wp_op_id}-${seg.kind}-${i}`}
            className="bar-ticket-seg"
            style={{ width: `${wrapperWidthPct}%` }}
            data-testid={`${testKeyPrefix}-seg-${seg.wp_op_id}-wrap`}
          >
            <span
              className={`bar-seg ${segmentKindClass(seg.kind)}`}
              style={{ width: `${basePctOfWrapper}%` }}
              title={segmentTooltip(seg, isPlanning)}
              data-testid={`${testKeyPrefix}-seg-${seg.wp_op_id}-${seg.kind}`}
            />
            {overshoot > 0 ? (
              // A segment with NO estimate at all paints its ENTIRE logged
              // time as this span — that is "we never estimated this", not a
              // genuine estimate overrun, so it gets its own wording and a
              // muted style (`.bar-overshoot-noestimate`) to keep the two
              // visually distinct (the Jan Belka #11166 confusion: 14.5h of
              // "overshoot" on the bar vs 0 on Closure's done-only OVERSHOOT).
              <span
                className={`bar-seg bar-overshoot${seg.estimate_hours == null ? " bar-overshoot-noestimate" : ""}`}
                style={{ width: `${overshootPctOfWrapper}%` }}
                data-testid={`${testKeyPrefix}-seg-${seg.wp_op_id}-overshoot`}
                title={
                  seg.estimate_hours == null
                    ? `No estimate — ${formatHours(seg.logged_hours)} logged`
                    : `Overshoot: logged ${formatHours(seg.logged_hours)} vs. estimate ${formatHours(base)} (+${formatHours(overshoot)})`
                }
              />
            ) : null}
            {showInnerMarker ? (
              <span
                className="bar-logged-marker"
                style={{ left: `${innerMarkerLeftPct}%` }}
                data-testid={`${testKeyPrefix}-seg-${seg.wp_op_id}-logged-marker`}
                title={`Logged ${formatHours(seg.logged_hours)} of estimate ${formatHours(base)}`}
              />
            ) : null}
          </span>
        );
      })}
    </>
  );
}

function CapacityPanel({
  sprintId,
  status,
  isRetrospective,
  capacity,
  capacityError,
  onReloadCapacity,
  perDeveloper,
  doubleCountGroups,
  doubleCountLocked,
  onScrollToTicket,
  onDoubleCountFixed,
  people,
  sprintPeople,
  onLinked,
  offSprintTime,
}: {
  sprintId: number;
  status: Sprint["status"];
  /** SPEC_13 §6: gates the "Capacity edit history" audit trail toggle — only
   * a retrospective sprint ever writes to capacity_edit_audit. */
  isRetrospective: boolean;
  capacity: CapacityResponse | undefined;
  capacityError: Error | undefined;
  onReloadCapacity: () => void;
  /** Increment 15 (SPEC_15): GET /sprints/:id/closure-stats's per_developer —
   * real-work-driven `segments` for the capacity bar (a strict superset of
   * the CapacityLine roster, keyed by the same op_user_id/member_id/name
   * identity). Undefined while loading/erroring/unfetched — every line then
   * falls back to the pre-Increment-15 baseline-only rendering unchanged. */
  perDeveloper: DeveloperCapacityBreakdown[] | undefined;
  /** Increment 28 (§2a/§2d): backend-computed parent→children double-count
   * groups for this sprint (ancestor-aware) — the ONE source, never a
   * client-side recomputation. */
  doubleCountGroups: DoubleCountGroup[];
  /** Increment 28 (§2c): a locked sprint still shows the badges/warning, but
   * never the one-click fix buttons (the backend also 409s SPRINT_LOCKED —
   * this is a UX nicety, not the only guard). */
  doubleCountLocked: boolean;
  /** Increment 28 (§2d): scrolls the matching WpCard into view + highlights it. */
  onScrollToTicket: (opId: number) => void;
  /** Increment 28 (§2c): fires after a successful remove-parents/remove-children
   * call — routes through the SAME full invalidation as every other
   * membership-changing mutation in this screen (`refresh()`, §1). */
  onDoubleCountFixed: () => void;
  people: AssignablePerson[];
  /** SPEC_13 §1a/§3: this sprint's GET /people rows — used ONLY to look up
   * which connection a name-only line (op_user_id null) belongs to, for the
   * optional "Link to OP account" action below. */
  sprintPeople: SprintPeopleResponse;
  /** SPEC_13 §1b: fires after a successful POST /user-aliases so capacity
   * (and the People summary) refreshes and picks up the new op_user_id. */
  onLinked: () => void;
  /** Increment 32 (docs/INCREMENT_32_CONTRACTS.md §4/§5): the "Outside the
   * sprint" report — undefined while loading/unfetched (renders nothing). */
  offSprintTime: OffSprintTimeResponse | undefined;
}) {
  const canPlan = useCan("plan");
  const planning = status === "planning";
  // Increment 39: a Viewer never edits capacity (nor links/removes people).
  const editable = planning && canPlan;
  // Increment 15 (SPEC_15): index the new per-developer breakdown by the SAME
  // key CapacityLine rows use (capacityLineKey reads only op_user_id/member_id,
  // which DeveloperCapacityBreakdown also carries) — one lookup per row below.
  const perDeveloperByKey = useMemo(
    () => new Map((perDeveloper ?? []).map((d) => [capacityLineKey(d), d])),
    [perDeveloper],
  );
  // Locally-edited availability (strings for controlled inputs), seeded from the
  // persisted server values whenever fresh capacity arrives.
  const [avail, setAvail] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<Error | undefined>();
  // People the planner explicitly added this session via "Add person". We no longer
  // auto-seed every backlog assignee — that made testers with no sprint work reappear
  // and be un-removable. Added people surface as editable zero lines.
  const [added, setAdded] = useState<AssignablePerson[]>([]);

  // SPEC_10 §c: SprintBoardScreen (and this panel with it) is a long-lived
  // component that never unmounts on sprint switch — useAsync keeps the PREVIOUS
  // sprint's stale data in place while the new sprint's capacity is in flight, so
  // there's no natural remount to clear session-local state. Without this, a
  // person added-this-session while viewing sprint X would still render as an
  // "added" row after switching to sprint Y. Scope `added` to the sprint it was
  // built for.
  useEffect(() => {
    setAdded([]);
  }, [sprintId]);

  // Rows shown = server capacity lines (people with sprint items and/or a saved
  // capacity row) UNION the people added this session. De-duplicated by op_user_id.
  const lines = useMemo(
    () => (capacity ? mergeCapacityLines(capacity.lines, added) : []),
    [capacity, added],
  );

  // "Add person" options: project backlog assignees not already shown as a line.
  const shownIds = useMemo(
    () => new Set(lines.filter((l) => l.op_user_id != null).map((l) => l.op_user_id as number)),
    [lines],
  );
  const addOptions = useMemo(
    () => people.filter((p) => !shownIds.has(p.op_user_id)),
    [people, shownIds],
  );

  useEffect(() => {
    if (!capacity) return;
    const seed: Record<string, string> = {};
    for (const l of capacity.lines) {
      seed[capacityLineKey(l)] = l.available_hours > 0 ? String(l.available_hours) : "";
    }
    setAvail(seed);
  }, [capacity]);

  // Overlay typed availability for live overload feedback (server planned load stands).
  const cap = useMemo(() => {
    if (!capacity) return undefined;
    const overrides: Record<string, number> = {};
    for (const [k, v] of Object.entries(avail)) overrides[k] = Number(v) || 0;
    return applyAvailability(lines, overrides);
  }, [capacity, lines, avail]);

  // SPEC_13 §1a/§3 (REVISED): a real person is identified by op_user_id WHEN
  // known, else by member_id (the roster row the backend provisions for a
  // journal-only name — see CapacityLine's contract doc). Only the genuine
  // unassigned bucket (both null) is excluded from persistence entirely.
  function toMemberPayload(l: CapacityLine) {
    return {
      ...(l.member_id != null ? { member_id: l.member_id } : { op_user_id: l.op_user_id as number }),
      name: l.name,
      available_hours: Number(avail[capacityLineKey(l)]) || 0,
      pto_days: 0,
    };
  }

  async function save() {
    if (!capacity) return;
    setBusy(true);
    setSaveError(undefined);
    try {
      // Persist every real person (incl. newly-seeded backlog people and
      // name-only retro lines with no op_user_id yet) with their possibly-
      // just-typed availability. The server provisions a member per id/name.
      const members = lines.filter((l) => !isUnassignedBucketLine(l)).map(toMemberPayload);
      await api.setCapacity(sprintId, { members });
      onReloadCapacity();
    } catch (err) {
      setSaveError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  }

  function addPerson(opUserId: number) {
    const person = addOptions.find((p) => p.op_user_id === opUserId);
    if (person) setAdded((prev) => [...prev, person]);
  }

  // Remove a person with no work in this sprint (planned 0). Persists the removal by
  // saving capacity for the REMAINING real people — replaceForSprint then deletes the
  // removed person's saved row, so they don't reappear after the capacity reload.
  async function remove(target: CapacityLine) {
    if (!capacity || isUnassignedBucketLine(target)) return;
    setBusy(true);
    setSaveError(undefined);
    try {
      const targetKey = capacityLineKey(target);
      const members = lines
        .filter((l) => !isUnassignedBucketLine(l) && capacityLineKey(l) !== targetKey)
        .map(toMemberPayload);
      await api.setCapacity(sprintId, { members });
      setAdded((prev) => prev.filter((p) => p.op_user_id !== target.op_user_id));
      onReloadCapacity();
    } catch (err) {
      setSaveError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  }

  if (capacityError) {
    return (
      <Panel title="Capacity">
        <ErrorBox error={capacityError} onRetry={onReloadCapacity} />
      </Panel>
    );
  }
  if (!capacity || !cap) {
    return (
      <Panel title="Capacity">
        <EmptyState>Loading capacity…</EmptyState>
      </Panel>
    );
  }

  // SPEC_13 §1b: which connection a name-only line belongs to, so "Link to
  // OP account" knows the `connection_id` POST /user-aliases needs (a
  // CapacityLine itself carries no connection_id — GET /people is the only
  // source that has it, since aliases are connection-scoped).
  const nameToConnectionId = new Map(sprintPeople.map((p) => [p.name, p.connection_id]));

  return (
    <Panel title="Capacity">
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="stat">
          {/* Read straight off the server's `scope_planned_hours` (the raw
              CapacityResponse prop), deliberately NOT the client-recomputed
              `cap.total_planned_hours` (a narrower, developer-workload-
              filtered figure used only for the overload check) — so it
              never depends on unsaved local availability edits.
              Increment 30 (`CAPACITY_BAR_RULES.md` §5/§6 invariant 7/8):
              `scope_planned_hours` is now CURRENT SCOPE, computed via the
              same canonical pipeline as `ClosureStatsResponse.total_planned_hours`,
              so the two always agree by construction. It is Σ of the
              developer rows rendered below ONLY — the label says so, because
              non-developer and unassigned rows also render below (SPEC_14 §2:
              not plannable capacity) and a user who summed every visible row
              instead of just the developer ones would not reproduce this
              number (invariant 8). */}
          <span
            className="stat-value"
            title="Sum of the developer rows below only. Non-developer and unassigned rows are shown for visibility but are not plannable capacity, so their hours are excluded here."
          >
            {formatHours(capacity.scope_planned_hours)}
          </span>
          <span className="stat-label">Planned (developers)</span>
        </div>
        <div className="stat">
          {/* Increment 17 (SPEC_17 §2/§4a): read straight off the SAME
              CapacityResponse's `scope_delivered_hours` — the server's
              precomputed Σ DELIVERED across developers, computed via the
              exact same shared pipeline as Closure's own "Delivered", so the
              two always agree by construction. No separate closure-stats
              cross-reference needed any more (Increment 16 read
              `closureStatsState.data?.total_delivered_hours` here instead —
              this field didn't exist on CapacityResponse yet then). Grows
              over time as a still-running sprint delivers. */}
          <span className="stat-value">{formatHours(capacity.scope_delivered_hours)}</span>
          <span className="stat-label">Delivered</span>
        </div>
        <div className="stat">
          <span className="stat-value">{formatHours(cap.total_available_hours)}</span>
          <span className="stat-label">Available</span>
        </div>
        {editable ? (
          <button type="button" className="btn small" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save capacity"}
          </button>
        ) : (
          <span className="muted" style={{ alignSelf: "center" }}>
            {planning ? "Capacity is read-only for your role." : "Capacity is locked once the sprint leaves planning."}
          </span>
        )}
      </div>

      {editable ? (
        <p className="muted" style={{ marginTop: 0, marginBottom: 12, fontSize: 12 }}>
          Enter each person's available hours for this sprint, then Save capacity.
        </p>
      ) : null}

      {saveError ? <div style={{ marginBottom: 12 }}><ErrorBox error={saveError} /></div> : null}

      {cap.overloaded ? (
        <div className="msg warn" role="alert">
          Overloaded — planned work exceeds available capacity.
        </div>
      ) : null}
      <DoubleCountWarning
        sprintId={sprintId}
        groups={doubleCountGroups}
        locked={doubleCountLocked}
        onScrollToTicket={onScrollToTicket}
        onFixed={onDoubleCountFixed}
      />

      {cap.lines.length === 0 ? (
        <EmptyState>No assignable people in this project yet — sync the backlog first.</EmptyState>
      ) : (
        cap.lines.map((line) => {
          const key = capacityLineKey(line);
          // SPEC_13 §1a/§3 (REVISED): the genuine "no assignee at all" bucket
          // has NEITHER op_user_id NOR member_id. A name-only retro line
          // (op_user_id null, real member_id) is a normal, fully-functional
          // person — NOT the unassigned bucket — see CapacityLine's contract doc.
          const unassigned = isUnassignedBucketLine(line);
          // Increment 15 (SPEC_15): a developer WITH real-work-driven segment
          // data gets the richer per-ticket bar below instead of the
          // aggregate-only baseline/added/removed/redistributed one — a
          // non-developer, the unassigned bucket, or "not loaded yet" all
          // fall straight through to the pre-Increment-15 rendering.
          const devBreakdown = perDeveloperByKey.get(key);
          const hasDevSegments = !unassigned && line.is_developer && (devBreakdown?.segments.length ?? 0) > 0;
          // SPEC_05 §2/§5: stacked green (baseline still in scope) / blue (baseline
          // cut, rendered as a bordered "used to be green" marker, positioned right
          // where the green would have continued) / red (added, on top). All three
          // are relative to `available_hours` (the reference line, unchanged). Before
          // a baseline exists (still planning — server sends 0/0/0 segments) fall back
          // to a single green bar sized by `planned_hours`, exactly like before.
          //
          // SPEC_09 §3/§4/§8: grey layers INSIDE the baseline — it's the part of a
          // baseline ticket that's no longer "live green" because it's done or was
          // reassigned (redistributed_out_hours, kept on the ORIGINAL owner's bar so
          // the bar stays exactly baseline_hours long), plus whatever this person
          // received from someone else's baseline (redistributed_in_hours, purely
          // additive — may push the bar past 100%, same as an overloaded red segment
          // already could). A pure receiver (baseline 0, only redistributed_in) must
          // still get the segmented view, not the pre-activation single-green fallback.
          const hasSegments =
            line.baseline_hours + line.added_hours > 0 ||
            line.removed_hours > 0 ||
            line.redistributed_out_hours > 0 ||
            line.redistributed_in_hours > 0;
          const greenHours = hasSegments
            ? Math.max(0, line.baseline_hours - line.removed_hours - line.redistributed_out_hours)
            : line.planned_hours;
          const greyHours = hasSegments ? line.redistributed_out_hours + line.redistributed_in_hours : 0;
          const blueHours = hasSegments ? line.removed_hours : 0;
          const redHours = hasSegments ? line.added_hours : 0;
          // SPEC_13 §4: segments render proportional to the REAL allocated
          // hours, never to `available_hours` alone — a bug made every bar
          // collapse to zero width whenever available_hours was 0 (exactly
          // what an un-set-availability retro roster produces), even though
          // real planned hours existed. `available_hours` is now only an
          // optional reference marker line drawn on top; the denominator
          // grows to fit whatever's actually allocated (never zero).
          const segmentsTotal = greenHours + greyHours + blueHours + redHours;
          // Increment 15: a dev-segment bar sizes itself off its OWN per-ticket
          // visual widths (estimate + any overshoot extension), not the old
          // aggregate green/grey/blue/red sums — same "denominator never
          // collapses to zero" principle as SPEC_13 §4 above.
          // CAPACITY_BAR_RULES §2 (blue): a baseline ticket REMOVED from scope
          // after activation must stay visible as a blue reduction. A removed
          // item is (correctly) filtered out of the closure segments — its
          // reduction lives in the capacity line's own `removed_hours` — so a
          // developer's per-ticket segment bar appends ONE aggregate blue span
          // for it. Before the identity unification most people had no closure
          // row at all (role never set → silently dropped), so the plain
          // fallback bar below rendered the blue instead and this gap never
          // showed; now that per-developer rows exist for everyone the segment
          // bar has to honour §2 itself.
          const removedBlueHours = hasDevSegments ? line.removed_hours : 0;
          const barDenominator = hasDevSegments
            ? developerSegmentBarDenominator(devBreakdown!.segments, line.available_hours, removedBlueHours)
            : Math.max(line.available_hours, segmentsTotal, 1);
          const pctOf = (h: number) => (h / barDenominator) * 100;
          const availableMarkerPct =
            line.available_hours > 0 ? Math.min((line.available_hours / barDenominator) * 100, 100) : null;
          const barTitle = hasDevSegments
            ? undefined // each ticket segment carries its own tooltip instead
            : hasSegments
              ? `baseline ${formatHours(line.baseline_hours)}, +${formatHours(line.added_hours)} added, -${formatHours(line.removed_hours)} removed` +
                (greyHours > 0 ? `, ${formatHours(greyHours)} redistributed` : "")
              : undefined;
          const greyTitleParts: string[] = [];
          if (line.redistributed_out_hours > 0) {
            greyTitleParts.push(`Worked or reassigned: ${formatHours(line.redistributed_out_hours)}`);
          }
          if (line.redistributed_in_hours > 0) {
            greyTitleParts.push(`Received work: ${formatHours(line.redistributed_in_hours)}`);
          }
          const greyTitle = greyTitleParts.length > 0 ? greyTitleParts.join(" · ") : undefined;
          // Removable only while planning, only real people (not the unassigned
          // bucket), and only when they have NO work in this sprint. Uses the
          // server's has_sprint_work flag — a 0-estimate sprint task still counts
          // as work (planned_hours 0 would wrongly look removable and reappear).
          const removable = editable && !unassigned && !line.has_sprint_work;
          // SPEC_13 §1a (REVISED): identity IS the name — every line renders
          // through the SAME normal treatment regardless of op_user_id. A
          // name-only line gets NO special/blocking visual treatment, just an
          // optional, low-key "Link to OP account" affordance next to the name.
          const needsLink = !unassigned && line.op_user_id == null;
          // SPEC_14 §2 consequence #1: "capacity = Developers only" — a
          // tester/customer/other line (role known, not "developer") is real
          // work that already left the developer's hands, so it still shows
          // its name/hours (never hidden), but renders GREY and is never
          // availability-editable — planning capacity is meaningless for a
          // role that has none. The genuine unassigned bucket keeps its own
          // pre-existing treatment (it has no role at all), not this one.
          const nonDeveloper = !unassigned && !line.is_developer;
          return (
            <div
              className={`capacity-line${nonDeveloper ? " capacity-line-nondev" : ""}`}
              key={key}
              data-testid={nonDeveloper ? `capacity-line-nondev-${key}` : undefined}
            >
              <span style={{ width: 160, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <span>{line.name}</span>
                {nonDeveloper ? (
                  <span
                    className="badge"
                    title="Not a Developer — no planned capacity; shown for visibility only (SPEC_14 §2)."
                  >
                    {line.role}
                  </span>
                ) : null}
                {needsLink && canPlan ? (
                  <LinkToOpAccountControl
                    line={line}
                    connectionId={nameToConnectionId.get(line.name)}
                    options={people}
                    onLinked={onLinked}
                  />
                ) : null}
              </span>
              <div
                className={`bar ${line.overloaded ? "bar-over" : ""}`}
                aria-label={`load for ${line.name}`}
                title={barTitle}
                data-testid={hasDevSegments ? `dev-segment-bar-${key}` : undefined}
              >
                {hasDevSegments ? (
                  <>
                    <DeveloperSegmentBar
                      segments={devBreakdown!.segments}
                      denom={barDenominator}
                      testKeyPrefix={key}
                      isPlanning={planning}
                    />
                    {removedBlueHours > 0 ? (
                      <span
                        className="bar-seg bar-blue"
                        style={{ width: `${pctOf(removedBlueHours)}%` }}
                        title={`Removed from sprint after activation: ${formatHours(removedBlueHours)}`}
                        data-testid={`${key}-removed-from-sprint`}
                      />
                    ) : null}
                  </>
                ) : (
                  <>
                    <span className="bar-seg bar-green" style={{ width: `${pctOf(greenHours)}%` }} />
                    <span className="bar-seg bar-grey" style={{ width: `${pctOf(greyHours)}%` }} title={greyTitle} />
                    <span className="bar-seg bar-blue" style={{ width: `${pctOf(blueHours)}%` }} />
                    <span className="bar-seg bar-red" style={{ width: `${pctOf(redHours)}%` }} />
                  </>
                )}
                {availableMarkerPct != null ? (
                  <span
                    className="bar-marker"
                    style={{ left: `${availableMarkerPct}%` }}
                    title={`Available: ${formatHours(line.available_hours)}`}
                  />
                ) : null}
              </div>
              <span
                style={{ width: 210, textAlign: "right" }}
                className={line.overloaded ? "" : "muted"}
                title={
                  // Increment 30 (`CAPACITY_BAR_RULES.md` §5/§6 invariant 9):
                  // `planned_hours` is now CURRENT SCOPE (baseline_worked +
                  // acquired + idle — whatever this developer holds right
                  // now), always >= 0 (BUG 2, still holds: nothing ever
                  // subtracts from it). `baseline_hours` is what `planned_hours`
                  // meant before Increment 30 (Σ baseline_worked only) — kept
                  // as its OWN labelled figure because it's what `Change` is
                  // measured against, never composed with it: `Baseline +
                  // Change` balances, `Planned + Change` double-counts (Planned
                  // already contains every post-activation movement).
                  // Increment 38 — each number now carries its definition
                  // (`capacityNumbersTitle`, CAPACITY_BAR_RULES §5b).
                  hasDevSegments
                    ? capacityNumbersTitle({
                        baseline: formatHours(devBreakdown!.baseline_hours),
                        planned: formatHours(devBreakdown!.planned_hours),
                        change: formatSignedHours(devBreakdown!.scope_change_hours),
                        capacity: formatHours(line.available_hours),
                      })
                    : nonDeveloper || unassigned
                      ? `Not counted in the header's "Planned (developers)" total above — non-developer/unassigned rows are shown for visibility only.`
                      : undefined
                }
              >
                {hasDevSegments
                  ? `${formatHours(devBreakdown!.baseline_hours)} / ${formatHours(devBreakdown!.planned_hours)} / ${formatSignedHours(devBreakdown!.scope_change_hours)} / ${formatHours(line.available_hours)}`
                  : `${formatHours(line.planned_hours)} / ${formatHours(line.available_hours)}`}
              </span>
              {unassigned ? (
                // The unassigned bucket has no op_user_id, so it can't be persisted.
                <span style={{ width: 72 }} className="muted">—</span>
              ) : nonDeveloper ? (
                // SPEC_14 §2 consequence #1: a non-Developer has no
                // plannable capacity — never an editable input, regardless
                // of sprint status.
                <span
                  style={{ width: 72 }}
                  className="muted"
                  title="Not availability-editable — this role has no planned capacity."
                >
                  —
                </span>
              ) : (
                <input
                  aria-label={`available hours for ${line.name}`}
                  type="number"
                  step="1"
                  style={{ width: 72 }}
                  readOnly={!editable}
                  disabled={!editable}
                  value={avail[key] ?? ""}
                  placeholder="hrs"
                  onChange={(e) => setAvail((a) => ({ ...a, [key]: e.target.value }))}
                />
              )}
              {removable ? (
                <button
                  type="button"
                  className="btn small secondary"
                  aria-label={`Remove ${line.name}`}
                  title={`Remove ${line.name}`}
                  disabled={busy}
                  onClick={() => void remove(line)}
                  style={{ width: 28 }}
                >
                  ×
                </button>
              ) : editable ? (
                <span style={{ width: 28 }} />
              ) : null}
            </div>
          );
        })
      )}

      {editable && addOptions.length > 0 ? (
        <div className="row" style={{ marginTop: 12, alignItems: "center" }}>
          <select
            aria-label="Add person"
            value=""
            disabled={busy}
            onChange={(e) => {
              const id = Number(e.target.value);
              if (id) addPerson(id);
            }}
          >
            <option value="">Add person…</option>
            {addOptions.map((p) => (
              <option key={p.op_user_id} value={p.op_user_id}>{p.name}</option>
            ))}
          </select>
          <span className="muted" style={{ fontSize: 12 }}>
            Add someone to plan their availability before assigning work.
          </span>
        </div>
      ) : null}

      {isRetrospective ? <CapacityAuditToggle sprintId={sprintId} /> : null}

      <OffSprintTimeSection data={offSprintTime} />
    </Panel>
  );
}

/**
 * Increment 32 (docs/INCREMENT_32_CONTRACTS.md §5) — "Outside the sprint":
 * developers visibly work on tickets that never made it into the sprint.
 * Collapsible, collapsed by default. Two empty states, deliberately
 * different (contract §5 read alongside the orchestration prompt):
 *   - no rows AND `fetched_at` is null (an active sprint that simply hasn't
 *     had an update pass yet) → a one-line muted note, so the feature is
 *     discoverable rather than silently absent.
 *   - no rows AND `fetched_at` is set (a real fetch found genuinely nothing)
 *     → renders nothing at all, exactly like DoubleCountWarning above when
 *     there's nothing to warn about.
 * `data` undefined (still loading, or no sprint selected) also renders
 * nothing — same posture as every other still-loading sub-panel here.
 */
function OffSprintTimeSection({ data }: { data: OffSprintTimeResponse | undefined }) {
  const [expanded, setExpanded] = useState(false);
  const [expandedPeople, setExpandedPeople] = useState<Set<number>>(new Set());

  if (!data) return null;

  if (data.per_person.length === 0) {
    if (data.fetched_at === null) {
      return (
        <p className="muted" style={{ marginTop: 12, marginBottom: 0, fontSize: 12 }} data-testid="off-sprint-time-empty">
          No off-sprint work recorded yet — it refreshes with each sprint update.
        </p>
      );
    }
    return null;
  }

  function togglePerson(opUserId: number) {
    setExpandedPeople((prev) => {
      const next = new Set(prev);
      if (next.has(opUserId)) next.delete(opUserId);
      else next.add(opUserId);
      return next;
    });
  }

  return (
    <div style={{ marginTop: 12 }} data-testid="off-sprint-time-section">
      <button
        type="button"
        className="btn small secondary"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        data-testid="off-sprint-time-toggle"
      >
        Outside the sprint — {formatHours(data.total_hours)} {expanded ? "▲" : "▼"}
      </button>
      <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
        {formatDate(data.window.from)}–{formatDate(data.window.to)} · as of {relativeTime(data.fetched_at)}
      </span>
      {expanded ? (
        <div style={{ marginTop: 8 }} data-testid="off-sprint-time-people">
          {data.per_person.map((p) => (
            <div key={p.op_user_id} style={{ marginBottom: 4 }}>
              <button
                type="button"
                className="link-button"
                onClick={() => togglePerson(p.op_user_id)}
                aria-expanded={expandedPeople.has(p.op_user_id)}
                data-testid={`off-sprint-time-person-${p.op_user_id}`}
              >
                {expandedPeople.has(p.op_user_id) ? "▾" : "▸"} {p.name} — {formatHours(p.total_hours)}
              </button>
              {expandedPeople.has(p.op_user_id) ? (
                <ul
                  className="muted"
                  style={{ margin: "4px 0 0 18px", padding: 0, fontSize: 12 }}
                  data-testid={`off-sprint-time-tickets-${p.op_user_id}`}
                >
                  {p.tickets.map((t) => (
                    <li key={t.wp_op_id}>
                      #{t.wp_op_id} {t.subject ?? ""} — {formatHours(t.hours)}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Increment 28 (docs/INCREMENT_28_CONTRACTS.md §2d) — a plain text/button
 * control rendering a ticket id, styled as an inline link. Clicking it jumps
 * to (and briefly highlights) the matching WpCard, wherever it is on screen.
 */
function TicketJumpLink({ opId, onJump }: { opId: number; onJump: (opId: number) => void }) {
  return (
    <button
      type="button"
      className="link-button"
      aria-label={`Jump to ticket #${opId}`}
      onClick={() => onJump(opId)}
    >
      #{opId}
    </button>
  );
}

/**
 * Increment 28 (docs/INCREMENT_28_CONTRACTS.md §2c) — one-click fix action:
 * "Remove parent(s) from sprint" (PRIMARY, recommended — plan at leaf level,
 * confirmed decision §5) or "Remove children from sprint" (secondary). Both
 * are destructive removals from the sprint (the EXISTING per-item removal
 * semantics, SPEC_05's `removed_mid_sprint` on an active sprint), so both
 * require a confirm modal naming exactly which tickets go — following
 * DeleteSprintButton's modal pattern above, never `window.confirm`. Not
 * rendered at all on a locked sprint (`DoubleCountWarning` below gates it) —
 * the backend also 409s SPRINT_LOCKED, this is belt-and-braces UX.
 */
function DoubleCountFixButton({
  kind,
  sprintId,
  opIds,
  onFixed,
}: {
  kind: "parents" | "children";
  sprintId: number;
  /** Exactly which wp_op_ids this action removes — named in the confirm modal. */
  opIds: number[];
  onFixed: () => void;
}) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | undefined>();

  if (opIds.length === 0) return null;

  const label = kind === "parents" ? "Remove parent(s) from sprint" : "Remove children from sprint";
  const noun = kind === "parents" ? "parent" : "child";
  const plural = opIds.length === 1 ? noun : `${noun}s`;

  async function confirm() {
    setBusy(true);
    setError(undefined);
    try {
      if (kind === "parents") await api.removeDoubleCountParents(sprintId);
      else await api.removeDoubleCountChildren(sprintId);
      setShowConfirm(false);
      onFixed();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={`btn small${kind === "children" ? " secondary" : ""}`}
        onClick={() => setShowConfirm(true)}
      >
        {label}
      </button>
      {showConfirm ? (
        <Modal title={`Remove ${opIds.length} ${plural} from the sprint?`} onClose={() => (busy ? undefined : setShowConfirm(false))}>
          <p>
            This removes the following ticket{opIds.length === 1 ? "" : "s"} from the sprint:{" "}
            <strong>{opIds.map((id) => `#${id}`).join(", ")}</strong>.
          </p>
          <p className="muted" style={{ fontSize: 12 }}>
            {kind === "parents"
              ? "Recommended: keeps only the leaf-level tickets, so hours are counted exactly once. Logged time already on these tickets is kept (SPEC_05), just no longer committed."
              : "The parent ticket(s) stay in the sprint; their child tickets are removed. Logged time already on these tickets is kept (SPEC_05), just no longer committed."}
          </p>
          {error ? <div style={{ marginBottom: 12 }}><ErrorBox error={error} /></div> : null}
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="btn small secondary" disabled={busy} onClick={() => setShowConfirm(false)}>
              No
            </button>
            <button type="button" className="btn small danger" disabled={busy} onClick={() => void confirm()}>
              {busy ? "Removing…" : "Yes, remove"}
            </button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

/**
 * Increment 28 (docs/INCREMENT_28_CONTRACTS.md §2a/§2c/§2d) — replaces the old
 * count-only "Double counting: N item(s)…" message. Renders the CONCRETE
 * groups the backend detected (`#11165 (parent) → #11810, #11811`, one line
 * per group), each id a jump-to-ticket control, plus the two one-click fix
 * actions — hidden entirely on a locked sprint (badges/warning still show,
 * per the confirmed decision in §2c).
 */
function DoubleCountWarning({
  sprintId,
  groups,
  locked,
  onScrollToTicket,
  onFixed,
}: {
  sprintId: number;
  groups: DoubleCountGroup[];
  locked: boolean;
  onScrollToTicket: (opId: number) => void;
  onFixed: () => void;
}) {
  if (groups.length === 0) return null;
  const parentIds = groups.map((g) => g.parent_op_id);
  const childIds = [...new Set(groups.flatMap((g) => g.child_op_ids))];

  return (
    <div className="msg warn" role="alert" data-testid="double-count-warning">
      <p style={{ margin: "0 0 8px" }} title={DOUBLE_COUNT_TOOLTIP}>
        Double counting — hours may be counted twice. Plan at leaf level:
      </p>
      {groups.map((g) => (
        <div key={g.parent_op_id} data-testid={`double-count-group-${g.parent_op_id}`} style={{ marginBottom: 4 }}>
          <TicketJumpLink opId={g.parent_op_id} onJump={onScrollToTicket} /> (parent) →{" "}
          {g.child_op_ids.map((id, i) => (
            <span key={id}>
              {i > 0 ? ", " : ""}
              <TicketJumpLink opId={id} onJump={onScrollToTicket} />
            </span>
          ))}
        </div>
      ))}
      {!locked ? (
        <div className="row" style={{ marginTop: 8 }}>
          <DoubleCountFixButton kind="parents" sprintId={sprintId} opIds={parentIds} onFixed={onFixed} />
          <DoubleCountFixButton kind="children" sprintId={sprintId} opIds={childIds} onFixed={onFixed} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * SPEC_13 §1b: the OPTIONAL "Link to OP account" action for a name-only
 * capacity line (op_user_id null, real member_id) — collapsed to a small,
 * unobtrusive button by default (never a prominent warning), expands to the
 * same "pick an AssignablePerson" pattern the "Add person" control already
 * uses. POSTs /user-aliases with `{ connection_id, journal_name: line.name,
 * op_user_id }`; the line was ALREADY fully functional before this, so a
 * successful link is purely enrichment — `onLinked` just bumps the shared
 * refreshKey so this line's op_user_id shows up on the next capacity/people
 * read, not an unlock of anything that was blocked.
 */
function LinkToOpAccountControl({
  line,
  connectionId,
  options,
  onLinked,
}: {
  line: CapacityLine;
  /** Undefined when GET /people hasn't surfaced a connection for this name
   * yet (e.g. a non-retrospective sprint, or the fetch hasn't landed) —
   * the action stays visible but disabled rather than disappearing, since
   * that's a transient/edge case, not a reason to hide an optional action. */
  connectionId: number | undefined;
  options: AssignablePerson[];
  onLinked: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | undefined>();

  async function link(opUserId: number) {
    if (connectionId == null) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.createUserAlias({ connection_id: connectionId, journal_name: line.name, op_user_id: opUserId });
      setOpen(false);
      onLinked();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="btn small secondary"
        style={{ fontSize: 10, padding: "1px 6px" }}
        disabled={connectionId == null}
        title={
          connectionId == null
            ? `"${line.name}" isn't linked to an OP account yet. This is optional and never blocks planning.`
            : `Optionally link "${line.name}" to a specific OP account.`
        }
        onClick={() => setOpen(true)}
      >
        Link OP account
      </button>
    );
  }

  return (
    <span className="row" style={{ alignItems: "center", gap: 4, marginBottom: 0 }}>
      <select
        aria-label={`Link ${line.name} to`}
        value=""
        disabled={busy}
        onChange={(e) => {
          const id = Number(e.target.value);
          if (id) void link(id);
        }}
      >
        <option value="">{busy ? "Linking…" : "Select OP account…"}</option>
        {options.map((p) => (
          <option key={p.op_user_id} value={p.op_user_id}>
            {p.name}
          </option>
        ))}
      </select>
      <button type="button" className="btn small secondary" disabled={busy} onClick={() => setOpen(false)}>
        Cancel
      </button>
      {error ? <span className="muted" style={{ fontSize: 10 }}>{error.message}</span> : null}
    </span>
  );
}

/**
 * SPEC_13 §6: read-only trail of capacity edits made to a retrospective
 * sprint AFTER it left planning. Fetched lazily (only once expanded) — this
 * is history, not a planning-only action, so it's deliberately NOT gated on
 * `editable`/sprint status the way retro preview is (SPEC_13 §5); it's just
 * never fetched until the user asks to see it.
 */
function CapacityAuditToggle({ sprintId }: { sprintId: number }) {
  const [shown, setShown] = useState(false);
  const state = useAsync(() => (shown ? api.getCapacityAudit(sprintId) : Promise.resolve([])), [sprintId, shown]);

  return (
    <div style={{ marginTop: 12 }}>
      <button type="button" className="btn small secondary" onClick={() => setShown((s) => !s)}>
        {shown ? "Hide capacity edit history" : "Capacity edit history"}
      </button>
      {shown ? (
        <div style={{ marginTop: 8 }}>
          <Async
            state={state}
            loadingLabel="Loading edit history…"
            isEmpty={(d) => d.length === 0}
            empty={<EmptyState>No capacity edits recorded after planning yet.</EmptyState>}
          >
            {(entries) => (
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }} data-testid="capacity-audit-list">
                {entries.map((e) => (
                  <li key={e.id}>
                    {relativeTime(e.edited_at)} — <code>{e.changes_json}</code>
                  </li>
                ))}
              </ul>
            )}
          </Async>
        </div>
      ) : null}
    </div>
  );
}

/** SPEC §4: the backlog can hold hundreds of WPs — make it searchable + filterable. */
function BacklogColumn({
  items,
  disabled,
  onMove,
  baseUrl,
}: {
  items: (BacklogItem & { in_sprint: boolean })[];
  disabled: boolean;
  onMove: (wpId: number) => void;
  baseUrl?: string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: "backlog" });
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [assigneeFilter, setAssigneeFilter] = useState("");

  const statuses = useMemo(() => {
    // Increment 21: dedup case-insensitively/trimmed so a stray casing
    // mismatch in the underlying data never renders as two options for the
    // same logical status — mirrors the server-driven filter-options
    // endpoint BacklogScreen.tsx already uses (Increment 19).
    const byKey = new Map<string, string>();
    for (const i of items) {
      const key = i.status_name.trim().toLowerCase();
      if (!byKey.has(key)) byKey.set(key, i.status_name);
    }
    return [...byKey.values()].sort((a, b) => a.localeCompare(b));
  }, [items]);
  const assignees = useMemo(
    () => [...new Set(items.map((i) => i.assignee_name ?? "Unassigned"))].sort((a, b) => a.localeCompare(b)),
    [items],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const idQ = q.replace(/^#/, "");
    return items.filter((it) => {
      // Increment 19 (SPEC_19 §1.2): case-insensitive/trimmed match as an
      // extra safety net against the same exact-match class of bug fixed in
      // BacklogScreen.tsx — this column's own smaller filter pair.
      if (
        statusFilter &&
        (it.status_name ?? "").trim().toLowerCase() !== statusFilter.trim().toLowerCase()
      )
        return false;
      if (
        assigneeFilter &&
        (it.assignee_name ?? "Unassigned").trim().toLowerCase() !== assigneeFilter.trim().toLowerCase()
      )
        return false;
      if (!q) return true;
      const subjectHit = it.subject.toLowerCase().includes(q);
      const idHit = idQ !== "" && String(it.op_id).includes(idQ);
      return subjectHit || idHit;
    });
  }, [items, query, statusFilter, assigneeFilter]);

  const shown = filtered.slice(0, BACKLOG_RENDER_CAP);

  return (
    <div>
      <h3 style={{ fontSize: 13, margin: "0 0 8px", color: "var(--muted)" }}>Backlog ({items.length})</h3>

      <div className="row" style={{ marginBottom: 8, flexWrap: "wrap" }}>
        <input
          aria-label="Search backlog"
          placeholder="Search subject or #id"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: 1, minWidth: 160 }}
        />
        <select aria-label="Filter by status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          {statuses.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <select aria-label="Filter by assignee" value={assigneeFilter} onChange={(e) => setAssigneeFilter(e.target.value)}>
          <option value="">All assignees</option>
          {assignees.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
      </div>

      <div className="muted" style={{ marginBottom: 8, fontSize: 12 }}>
        Showing {shown.length} of {filtered.length}
        {filtered.length !== items.length ? ` (filtered from ${items.length})` : ""}
      </div>

      <div ref={setNodeRef} className={`dropzone ${isOver ? "over" : ""}`} data-testid="drop-backlog">
        {items.length === 0 ? (
          <EmptyState>Everything is in the sprint.</EmptyState>
        ) : filtered.length === 0 ? (
          <EmptyState>No backlog items match your search.</EmptyState>
        ) : (
          <>
            {shown.map((it) => (
              <WpCard
                key={it.op_id}
                item={it}
                disabled={disabled}
                onMove={() => onMove(it.op_id)}
                moveLabel="Add →"
                baseUrl={baseUrl}
              />
            ))}
            {filtered.length > shown.length ? (
              <div className="muted" style={{ padding: 8, fontSize: 12 }}>
                …refine your search to see the remaining {filtered.length - shown.length}.
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function DropColumn({
  id,
  title,
  filters,
  children,
}: {
  id: string;
  title: string;
  /** Increment 33 (§5): optional controls rendered between the title and the
   * dropzone itself (e.g. the sprint board's per-assignee filter select) —
   * deliberately OUTSIDE the droppable area, never part of `children`. */
  filters?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div>
      <h3 style={{ fontSize: 13, margin: "0 0 8px", color: "var(--muted)" }}>{title}</h3>
      {filters}
      <div ref={setNodeRef} className={`dropzone ${isOver ? "over" : ""}`} data-testid={`drop-${id}`}>
        {children}
      </div>
    </div>
  );
}

function WpCard({
  item,
  disabled,
  onMove,
  moveLabel,
  onOpenChangelog,
  added = false,
  historicalRemoved = false,
  noLongerInBacklog = false,
  highlighted = false,
  baseUrl,
  sprints,
  sourceSprintId,
  sourceLocked = false,
  onCarried,
}: {
  /**
   * SPEC_18 §3: `is_done`/`done_bucket` only exist once the row has joined
   * the sprint's own detail response (`SprintItemDetail`) — a plain backlog
   * candidate (not yet in this sprint) never has them, so they're optional
   * here rather than widening `BacklogItem` itself.
   *
   * Increment 28 (§2a): same treatment for `double_count_children`/
   * `double_count_parent_of` — only ever populated for an item actually IN
   * this sprint (see `view`'s mapping in `Board` above); `Partial<>` so a
   * plain backlog candidate stays valid without them.
   *
   * Increment 34 (§3): `multi_sprint` is the same story — only populated for
   * an actual sprint member (it flows straight off `SprintItemDetail` via
   * `view`'s `...base` spread in `Board`), null/undefined for a backlog
   * candidate, which renders no badge at all.
   */
  item: BacklogItem &
    Partial<Pick<SprintItemDetail, "is_done" | "done_bucket" | "ambiguous_reason" | "multi_sprint">> &
    Partial<DoubleCountFields>;
  disabled: boolean;
  onMove: () => void;
  moveLabel: string;
  /** Present only for items in an ACTIVATED sprint (SPEC_04 §6). */
  onOpenChangelog?: () => void;
  /** SPEC_05 §3/§5: added to an already-active sprint (origin=added_mid_sprint). */
  added?: boolean;
  /**
   * SPEC_05 §1/§4/§9.1: outcome=removed_mid_sprint but kept visible because time
   * was already logged. Greyed out + blue-bordered, no drag/no move button (the
   * caller also passes `disabled`, this only controls the visual treatment).
   */
  historicalRemoved?: boolean;
  /**
   * SPEC_07 §5: this ticket is no longer present in the live backlog (locally
   * dismissed, or its cache row is gone) but stays committed to this sprint —
   * a badge only, never used to hide the card.
   */
  noLongerInBacklog?: boolean;
  /** Increment 28 (§2d): true for the ~2.5s after the user clicks a "jump to
   * ticket" control in the double-counting warning targeting THIS card. */
  highlighted?: boolean;
  /** SPEC_09 §4: fallback base URL when `item.connection_base_url` is null. */
  baseUrl?: string;
  /**
   * Increment 34 (§5): "Carry over" is only ever offered for an actual
   * sprint-member card (never a backlog candidate — `BacklogColumn` never
   * passes these four props), and only once `sourceLocked` AND the item is
   * not done. `sprints`/`sourceSprintId`/`onCarried` are all required
   * together with `sourceLocked` for the button to render; any one missing
   * (e.g. a backlog candidate, which has no `sourceSprintId`) hides it.
   */
  sprints?: Sprint[];
  sourceSprintId?: number;
  /** True once the CURRENT (source) sprint is closed/locked (SPEC §5). */
  sourceLocked?: boolean;
  onCarried?: () => void;
}) {
  // SPEC_09 §4: deep-link the title to the ticket's OWN source server, never
  // the "current" connection — falls back to `baseUrl` only for legacy rows
  // with no recorded connection.
  const linkBase = item.connection_base_url ?? baseUrl;
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: String(item.op_id),
    disabled,
  });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, opacity: isDragging ? 0.5 : 1 }
    : undefined;
  // SPEC_18 §2/§3: for an item already IN this sprint, dimming follows the
  // SAME role-aware done-matrix as Closure (`is_done`, computed server-side
  // by `classifyWithRole` off status + current holder's role) — never a
  // partial hardcoded status list again. `is_done` is undefined for a plain
  // backlog CANDIDATE (not yet committed to this sprint, so it never went
  // through the sprint's own `/items/detailed` enrichment) — a candidate has
  // no "current sprint" for a holder's role to be relevant to, so it falls
  // back to the old dev-done status heuristic (SPEC_11 §3/#6) instead of
  // going unstyled. Skipped when `card-removed` already applies its own
  // (different) muted treatment, so the two dimming rules never stack
  // unpredictably on the same card.
  const cardClass = [
    "card",
    historicalRemoved ? "card-removed" : "",
    !historicalRemoved && (item.is_done ?? isDimmedStatus(item.status_name)) ? "status-dimmed" : "",
    // Increment 28 (§2d): transient highlight after a "jump to ticket" click
    // from the double-counting warning — see Board's `scrollToTicket`.
    highlighted ? "card-highlight" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      ref={setNodeRef}
      // Increment 28 (§2d): scroll target for the double-counting warning's
      // jump-to-ticket controls — a plain DOM id, distinct from the testid
      // below (which is used for lookups in tests, not scrolling).
      id={`wp-card-${item.op_id}`}
      className={cardClass}
      style={style}
      data-testid={`wp-card-${item.op_id}`}
    >
      <div style={{ display: "flex", alignItems: "start", gap: 8 }}>
        <span
          className="grabbable"
          aria-label={`drag ${item.subject}`}
          {...(disabled ? {} : listeners)}
          {...attributes}
          style={{ flex: 1 }}
        >
          <div className="card-title">
            {linkBase ? (
              <a
                href={opWorkPackageUrl(linkBase, item.op_id)}
                target="_blank"
                rel="noopener noreferrer"
                title={`Open #${item.op_id} in OpenProject`}
                onClick={(e) => e.stopPropagation()}
              >
                #{item.op_id} {item.subject}
              </a>
            ) : (
              <>#{item.op_id} {item.subject}</>
            )}
          </div>
          <div className="card-meta">
            <span className={`badge ${item.status_is_closed ? "closed" : "open"}`}>{item.status_name}</span>
            {added ? <span className="badge added">added</span> : null}
            {historicalRemoved ? <span className="badge removed">removed</span> : null}
            {noLongerInBacklog ? (
              <span
                className="badge"
                title="This ticket is no longer in the backlog (removed/dismissed) but stays committed to this sprint"
              >
                no longer in backlog
              </span>
            ) : null}
            {item.done_bucket === "ambiguous" ? (
              <span
                className="badge"
                title="Role not set for the current holder — can't determine if this is done"
              >
                role?
              </span>
            ) : null}
            {/* Increment 28 (§2a/§2b) — badges on BOTH sides of a
                double-counting relationship, backend-detected (ancestor-aware),
                never a client-side recomputation. */}
            {item.double_count_children && item.double_count_children.length > 0 ? (
              <span className="badge" title={DOUBLE_COUNT_TOOLTIP}>
                Parent of {item.double_count_children.map((id) => `#${id}`).join(", ")}
              </span>
            ) : null}
            {item.double_count_parent_of != null ? (
              <span className="badge" title={DOUBLE_COUNT_TOOLTIP}>
                Child of #{item.double_count_parent_of}
              </span>
            ) : null}
            <MultiSprintBadge badge={item.multi_sprint} />
            <span>{item.assignee_name ?? "Unassigned"}</span>
            <span>{formatHours(item.effective_hours)}</span>
          </div>
        </span>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {onOpenChangelog ? (
            <button
              type="button"
              className="btn small secondary"
              aria-label={`View changelog for #${item.op_id}`}
              onClick={onOpenChangelog}
            >
              History
            </button>
          ) : null}
          {!disabled ? (
            <button type="button" className="btn small secondary" onClick={onMove}>
              {moveLabel}
            </button>
          ) : null}
          {/* Increment 34 (§5): the source sprint is closed/locked AND this
              ticket is not done — offer to carry it into an open sprint.
              `item.is_done` defaults to false-ish (undefined) for a plain
              backlog candidate, but those never receive sourceSprintId, so
              this can never render there regardless. */}
          {sourceLocked && item.is_done === false && sprints && sourceSprintId != null && onCarried ? (
            <CarryOverButton
              sprints={sprints}
              sourceSprintId={sourceSprintId}
              wpOpId={item.op_id}
              onCarried={onCarried}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** SPEC_04 §6: human rendering per ChangelogDetail kind — display-ready, no ids. */
function formatChangelogDetail(d: ChangelogDetail): string {
  switch (d.kind) {
    case "time_logged":
      return `logged ${formatHours(d.hours)} on ${d.spent_on}`;
    case "status_changed":
      return `status: ${d.from} → ${d.to}`;
    case "assignee_changed":
      return `assignee: ${d.from ?? "Unassigned"} → ${d.to ?? "Unassigned"}`;
    case "accountable_changed":
      return `accountable: ${d.from ?? "Unassigned"} → ${d.to ?? "Unassigned"}`;
    case "closed":
      return `🔒 closed (${d.status})`;
    case "estimate_changed":
      return `estimate: ${formatHours(d.from)} → ${formatHours(d.to)}`;
    case "remaining_changed":
      return `remaining: ${formatHours(d.from)} → ${formatHours(d.to)}`;
    case "version_changed":
      return `version: ${d.from ?? "—"} → ${d.to ?? "—"}`;
    case "other":
      return d.note;
    case "scope_added":
      // Increment 25 (SPEC_25 §4): a retroactive add carries `backdated_to`
      // (the calendar day scope actually changed, e.g. the ticket's first
      // logged time) — phrased distinctly so the changelog is honest about
      // WHEN this happened, not just that it did. Absent for an ordinary
      // mid-sprint add, where occurred_at already IS the scope-change day.
      return d.backdated_to
        ? `added to sprint retroactively (as of ${formatDate(d.backdated_to)})${d.hours != null ? ` (${formatHours(d.hours)})` : ""}`
        : `added to sprint${d.hours != null ? ` (${formatHours(d.hours)})` : ""}`;
    case "scope_removed":
      return `removed from sprint${d.hours != null ? ` (${formatHours(d.hours)})` : ""}`;
    case "comment_added":
      return "💬 comment added";
  }
}

function ChangelogRow({ entry }: { entry: ChangelogEntryView }) {
  return (
    <div className="changelog-row">
      <span className="changelog-who">{entry.actor_name ?? "—"}</span>
      <span className="changelog-what">{formatChangelogDetail(entry.detail)}</span>
      <span className="muted" title={entry.occurred_at}>{relativeTime(entry.occurred_at)}</span>
    </div>
  );
}

/** SPEC_14 §1: session-remembered changelog order — sessionStorage so the
 * choice survives closing/reopening the modal within the same browser
 * session (not necessarily across a reload), without needing any global
 * app state. Falls back to "newest" (the new default) whenever storage is
 * unavailable/throws (e.g. a locked-down test environment). */
const CHANGELOG_ORDER_KEY = "osp-changelog-order";

function readStoredChangelogOrder(): "newest" | "oldest" {
  try {
    return sessionStorage.getItem(CHANGELOG_ORDER_KEY) === "oldest" ? "oldest" : "newest";
  } catch {
    return "newest";
  }
}

function writeStoredChangelogOrder(order: "newest" | "oldest"): void {
  try {
    sessionStorage.setItem(CHANGELOG_ORDER_KEY, order);
  } catch {
    // Storage unavailable/full — the toggle still works for this render.
  }
}

/**
 * SPEC_04 §6 ticket changelog panel: GET /sprints/:id/tickets/:wpId/changelog,
 * with time_logged entries visually separated from status/assignee/
 * accountable/estimate/etc. changes.
 *
 * SPEC_14 §1: the API itself is UNCHANGED — it still returns oldest-first.
 * Ordering is a pure frontend display concern: default to newest-first
 * (reversed client-side) with a toggle to flip back to oldest-first, its
 * choice remembered for the session via sessionStorage.
 */
function ChangelogPanel({
  sprintId,
  wpId,
  subject,
  ticketUrl,
  onClose,
}: {
  sprintId: number;
  wpId: number;
  subject: string;
  /** SPEC_09 §4: deep link to the ticket on its OWN source server, if resolvable. */
  ticketUrl?: string;
  onClose: () => void;
}) {
  const state = useAsync(() => api.getTicketChangelog(sprintId, wpId), [sprintId, wpId]);
  const [order, setOrder] = useState<"newest" | "oldest">(readStoredChangelogOrder);

  function toggleOrder() {
    setOrder((prev) => {
      const next = prev === "newest" ? "oldest" : "newest";
      writeStoredChangelogOrder(next);
      return next;
    });
  }

  return (
    <Modal title={`#${wpId} ${subject} — changelog`} onClose={onClose}>
      {ticketUrl ? (
        <div style={{ marginBottom: 12 }}>
          <a href={ticketUrl} target="_blank" rel="noopener noreferrer">
            Open #{wpId} in OpenProject ↗
          </a>
        </div>
      ) : null}
      <div className="row" style={{ justifyContent: "flex-end", marginBottom: 8 }}>
        <button
          type="button"
          className="btn small secondary"
          data-testid="changelog-order-toggle"
          onClick={toggleOrder}
        >
          {order === "newest" ? "Newest first" : "Oldest first"} — switch to{" "}
          {order === "newest" ? "oldest first" : "newest first"}
        </button>
      </div>
      <Async
        state={state}
        loadingLabel="Loading changelog…"
        isEmpty={(entries) => entries.length === 0}
        empty={<EmptyState>No history yet.</EmptyState>}
      >
        {(entries) => {
          // API always returns oldest-first; "newest" is a client-side reverse.
          const ordered = order === "newest" ? [...entries].reverse() : entries;
          const changes = ordered.filter((e) => e.kind !== "time_logged");
          const timeLogged = ordered.filter((e) => e.kind === "time_logged");
          return (
            <div>
              {changes.length > 0 ? (
                <div>
                  <h4 style={{ fontSize: 12, margin: "0 0 6px", color: "var(--muted)" }}>Changes</h4>
                  {changes.map((e) => (
                    <ChangelogRow key={e.id} entry={e} />
                  ))}
                </div>
              ) : null}
              {timeLogged.length > 0 ? (
                <div style={{ marginTop: changes.length > 0 ? 16 : 0 }}>
                  <h4 style={{ fontSize: 12, margin: "0 0 6px", color: "var(--muted)" }}>Time logged</h4>
                  {timeLogged.map((e) => (
                    <ChangelogRow key={e.id} entry={e} />
                  ))}
                </div>
              ) : null}
            </div>
          );
        }}
      </Async>
    </Modal>
  );
}

function CreateSprintForm({ onCreated }: { onCreated: () => void }) {
  const canPlan = useCan("plan");
  const [name, setName] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | undefined>();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.createSprint({ name, start_date: start, end_date: end, capacity_mode: "per_person" });
      setName("");
      setStart("");
      setEnd("");
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  }

  if (!canPlan) return null;

  return (
    <form className="row" onSubmit={submit} style={{ marginBottom: 8 }}>
      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor="s-name">New Sprint Name</label>
        <input id="s-name" required placeholder="e.g. Sprint 42" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor="s-start">Start</label>
        <input id="s-start" type="date" required value={start} onChange={(e) => setStart(e.target.value)} />
      </div>
      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor="s-end">End</label>
        <input id="s-end" type="date" required value={end} onChange={(e) => setEnd(e.target.value)} />
      </div>
      <button className="btn" type="submit" disabled={busy || !name || !start || !end}>
        {busy ? "Creating…" : "Create sprint"}
      </button>
      {error ? <ErrorBox error={error} /> : null}
    </form>
  );
}

/** Short "N change(s)" / "no changes" / "update failed" summary for a run. */
function runOutcome(run: SprintUpdateRun): string {
  if (run.status === "error") return "update failed";
  if (run.status === "running") return "updating…";
  const n = run.changes_count ?? 0;
  return n > 0 ? `${n} change${n === 1 ? "" : "s"}` : "no changes";
}

function SprintControls({
  sprint,
  onChanged,
  refreshKey,
  onGoToSetup,
}: {
  sprint: Sprint;
  onChanged: () => void;
  refreshKey: number;
  /** SPEC_09 §1: jumps to Setup so a blocking connection can be reconnected. */
  onGoToSetup?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  // Live "X/Y tickets" progress while an Update Sprint OR Activate run is in
  // flight, mirroring Header.tsx's sync progress bar — polled via GET
  // /sprints/:id/updates while `busy` is true. The progress bar JSX itself
  // (below) doesn't care which action started it.
  const [progress, setProgress] = useState<{ processed: number; total: number | null } | null>(null);
  // SPEC_09 §1/§4: pre-activation validation failure — a server the sprint's
  // tickets actually need is disconnected/missing/vault-locked. Surfaced
  // BEFORE the (now async) activation run even starts.
  const [blockingConnections, setBlockingConnections] = useState<ActivationBlockingConnection[] | undefined>();

  // Update-run history drives "last updated X ago" + the last run's outcome.
  // Only meaningful once the sprint has been activated.
  const updatesState = useAsync(
    () => (sprint.activated_at ? api.getSprintUpdates(sprint.id) : Promise.resolve([])),
    [sprint.id, sprint.activated_at, refreshKey],
  );
  const lastRun = updatesState.data?.[0];

  async function backToPlanning() {
    setBusy(true);
    setError(undefined);
    try {
      await api.updateSprint(sprint.id, { status: "planning" });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  }

  // SPEC_09 §1: activation is now SCOPED + ASYNC — it runs as a background
  // job (baseline otisk, journals, time entries) with an "X/Y tickets"
  // progress, exactly like updateNow() below. The sprint's `status` does NOT
  // flip to "active" in the POST response anymore; it flips only once the
  // background run actually finishes. `POST /activate` resolves with the
  // run's INITIAL state (typically status "running"), not its final one, so
  // unlike updateSprintRun (which the server keeps the HTTP call open for
  // until the whole pass is done) we keep polling GET /sprints/:id/updates
  // ourselves until that same run settles (status leaves "running") before
  // treating the button interaction as done and calling onChanged().
  async function activate() {
    setBusy(true);
    setError(undefined);
    setBlockingConnections(undefined);
    let resolveSettled: ((run: SprintUpdateRun) => void) | undefined;
    const settled = new Promise<SprintUpdateRun>((resolve) => {
      resolveSettled = resolve;
    });
    const poll = window.setInterval(() => {
      void api.getSprintUpdates(sprint.id).then((runs) => {
        const run = runs.find((r) => r.status === "running") ?? runs[0];
        if (!run) return;
        setProgress({ processed: run.wp_count ?? 0, total: run.total_count });
        if (run.status !== "running") resolveSettled?.(run);
      });
    }, 500);
    try {
      // The dedicated endpoint (SPEC_04 §4): captures the ticket_baseline
      // otisk and writes the first burndown point.
      const initial = await api.activateSprint(sprint.id);
      const finalRun = initial.status === "running" ? await settled : initial;
      if (finalRun.status === "error") {
        setError(new Error(finalRun.error ?? "Sprint activation failed"));
      }
      onChanged();
      updatesState.reload();
    } catch (err) {
      // SPEC_09 §1/§4: a connection the sprint's tickets need isn't usable —
      // surfaced BEFORE the run starts, with enough detail to offer Reconnect.
      // Same envelope/UX convention as other API errors (ErrorBox/errorMessage
      // in ui.tsx), plus a dedicated list of the blocking server(s).
      if (err instanceof ApiError && err.body?.error.code === "ACTIVATION_CONNECTIONS_UNAVAILABLE") {
        const details = err.body.error.details as { connections?: ActivationBlockingConnection[] } | undefined;
        setBlockingConnections(details?.connections ?? []);
      } else {
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      window.clearInterval(poll);
      setProgress(null);
      setBusy(false);
    }
  }

  async function updateNow() {
    setBusy(true);
    setError(undefined);
    const poll = window.setInterval(() => {
      void api.getSprintUpdates(sprint.id).then((runs) => {
        const run = runs.find((r) => r.status === "running") ?? runs[0];
        if (run) setProgress({ processed: run.wp_count ?? 0, total: run.total_count });
      });
    }, 500);
    try {
      await api.updateSprintRun(sprint.id);
      onChanged();
      updatesState.reload();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      window.clearInterval(poll);
      setProgress(null);
      setBusy(false);
    }
  }

  // Finish sprint = the PRIMARY lifecycle action (SPEC_04 §6 task 4 decision):
  // hits the new /finish endpoint, which does a final update pass and
  // irreversibly locks the board (lock_reason="finished"), then generates the
  // closure report. ClosureScreen.tsx deliberately keeps calling the
  // pre-existing POST /close instead — it's unchanged, still idempotent, and
  // now shares the exact same closure algorithm as /finish (Agent B extracted
  // it), so the two screens' reports always agree. That makes ClosureScreen a
  // "view / regenerate the report" screen rather than a second way to finish.
  async function finish() {
    if (
      !window.confirm(
        "Finish this sprint? This locks the board (no further changes) and generates the closure report.",
      )
    )
      return;
    setBusy(true);
    setError(undefined);
    try {
      await api.finishSprint(sprint.id);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  }

  const locked = isReadOnly(sprint);
  // Increment 39: lifecycle buttons are Planner-only; a Viewer keeps the
  // read-only "last updated" line and the status PDF.
  const canPlan = useCan("plan");

  // Shared "X/Y" progress indicator (SPEC_09 §1): drives BOTH the Activate
  // (while sprint.status is still "planning" — it only flips to "active"
  // once the background run succeeds) and Update Sprint actions, keyed
  // purely on `busy && progress !== null`, not on which button started it.
  // `sprint.status` distinguishes the two for the label.
  //
  // SPEC_12 §2/§9: deliberately unit-less ("X/Y", not "X/Y tickets") — for a
  // retrospective sprint's Activate, Agent B's `total_count` means "days to
  // replay", not ticket count. A generic ratio reads correctly either way
  // without the frontend needing to know which meaning applies.
  const progressBar =
    busy && progress !== null ? (
      <span
        data-testid="sprint-update-progress"
        aria-label="sprint update progress"
        style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 140,
            height: 6,
            background: "var(--border)",
            borderRadius: 999,
            overflow: "hidden",
            display: "inline-block",
          }}
        >
          <span
            style={{
              display: "block",
              height: "100%",
              width:
                progress.total != null && progress.total > 0
                  ? `${Math.round((progress.processed / progress.total) * 100)}%`
                  : "40%",
              background: "var(--primary)",
              transition: "width .3s",
            }}
          />
        </span>
        <span className="muted">
          {sprint.status === "planning" ? "Activating" : "Updating"} {progress.processed}/{progress.total ?? "…"}
        </span>
      </span>
    ) : null;

  // Status badge + dates are shown once already, in the enclosing "Sprint
  // details" stat row (SPEC_05 §6.1) — no need to repeat them here.
  return (
    <div className="row" style={{ alignItems: "center", flexWrap: "wrap" }}>
      {canPlan && !locked && sprint.status === "planning" ? (
        <>
          <button type="button" className="btn small" disabled={busy} onClick={() => void activate()}>
            {busy ? "Activating…" : "Activate"}
          </button>
          {progressBar}
        </>
      ) : null}

      {!locked && sprint.status === "active" ? (
        <>
          {canPlan ? (
            <button type="button" className="btn small secondary" disabled={busy} onClick={() => void updateNow()}>
              {busy ? "Updating…" : "Update Sprint"}
            </button>
          ) : null}
          {progressBar ?? (
            <span className="muted" style={{ fontSize: 12 }}>
              {lastRun
                ? `Last updated ${relativeTime(lastRun.finished_at ?? lastRun.started_at)} — ${runOutcome(lastRun)}`
                : "Not updated yet"}
            </span>
          )}
          {canPlan ? (
            <>
              <button type="button" className="btn small" disabled={busy} onClick={() => void finish()}>
                Finish sprint
              </button>
              <button type="button" className="btn small secondary" disabled={busy} onClick={() => void backToPlanning()}>
                Back to planning
              </button>
            </>
          ) : null}
        </>
      ) : null}

      {locked && lastRun ? (
        <span className="muted" style={{ fontSize: 12 }}>
          Final update: {runOutcome(lastRun)}
        </span>
      ) : null}

      {/* Increment 36 (docs/INCREMENT_36_CONTRACTS.md §3): deliberately OUTSIDE every
          status/locked conditional above — "generate at any moment" is the whole point
          (planning, active, finished, frozen all show it). */}
      <ExportStatusPdfButton sprintId={sprint.id} />

      {blockingConnections && blockingConnections.length > 0 ? (
        <div
          className="msg warn"
          role="alert"
          data-testid="activation-blocked"
          style={{ flexBasis: "100%", marginTop: 8 }}
        >
          <strong>Can&apos;t activate yet</strong> — reconnect the following server(s) first (activation only
          needs the servers this sprint&apos;s tickets actually come from):
          <ul style={{ margin: "4px 0 8px" }}>
            {blockingConnections.map((c) => (
              <li key={c.connection_id}>
                {c.label ?? c.base_url} — {blockingReasonLabel(c.reason)}
              </li>
            ))}
          </ul>
          {onGoToSetup ? (
            <button type="button" className="btn small secondary" onClick={onGoToSetup}>
              Go to Setup to reconnect
            </button>
          ) : null}
        </div>
      ) : null}

      {error ? <ErrorBox error={error} /> : null}
    </div>
  );
}

/**
 * Increment 36 (docs/INCREMENT_36_CONTRACTS.md §3): "Export status PDF" — visible for
 * EVERY sprint state (planning/active/finished/frozen; SprintControls renders this
 * unconditionally, outside its status-gated blocks). Same busy/error tracking shape as
 * ReportsScreen.tsx's GeneratePdfButton — `api.downloadSprintStatusPdf` triggers a normal
 * browser download as its side effect, this component just surfaces busy/error around it.
 */
function ExportStatusPdfButton({ sprintId }: { sprintId: number }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | undefined>();

  async function generate() {
    setBusy(true);
    setError(undefined);
    try {
      await api.downloadSprintStatusPdf(sprintId);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <button
        type="button"
        className="btn small secondary"
        disabled={busy}
        onClick={() => void generate()}
        data-testid="export-status-pdf"
      >
        {busy ? "Exporting…" : "Export status PDF"}
      </button>
      {error ? (
        <span className="muted" style={{ fontSize: 11, color: "var(--danger)" }} data-testid="export-status-pdf-error">
          {error.message}
        </span>
      ) : null}
    </span>
  );
}

/** SPEC_09 §1/§4: human copy for why a needed connection can't be used right now. */
function blockingReasonLabel(reason: ActivationBlockingConnection["reason"]): string {
  switch (reason) {
    case "disabled":
      return "disconnected";
    case "not_found":
      return "connection no longer exists";
    case "vault_locked":
      return "vault is locked";
  }
}
