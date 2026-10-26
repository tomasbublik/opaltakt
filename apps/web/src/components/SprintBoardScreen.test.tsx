import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CapacityLine, CapacityResponse, ProjectWithConnection } from "@osp/contracts";
import {
  makeAppConfig,
  makeBacklogItem,
  makeChangelogEntry,
  makeClosureStats,
  makeConnection,
  makeDeveloperCapacityBreakdown,
  makeDeveloperTicketSegment,
  makeOffSprintTimePerson,
  makeOffSprintTimeResponse,
  makeRetroPreview,
  makeRetroSeedCandidate,
  makeRetroSeedResponse,
  makeSprint,
  makeSprintItemDetail,
  makeSprintPeopleResponse,
  makeSprintUpdateRun,
  makeUserAlias,
} from "../test/fixtures";

/** Local helper (mirrors ImportScreen.test.tsx's own) — SPEC_12 §9's version
 * dropdown reuses the same GET /projects → GET /versions chain as Import. */
function makeProjectWithConnection(over: Partial<ProjectWithConnection> = {}): ProjectWithConnection {
  return {
    id: 1,
    connection_id: 1,
    connection_base_url: "https://op.example.com",
    connection_label: null,
    op_id: 100,
    identifier: "demo",
    name: "Demo Project",
    last_synced_at: null,
    ...over,
  };
}

const { mockApi } = vi.hoisted(() => ({ mockApi: {} as Record<string, ReturnType<typeof vi.fn>> }));
vi.mock("../api-client", async (orig) => {
  const actual = await orig<typeof import("../api-client")>();
  return { ...actual, api: mockApi };
});

import { ApiError } from "../api-client";
import { SprintBoardScreen } from "./SprintBoardScreen";
import { capacityNumbersTitle } from "../lib/capacity";

/** Minimal server capacity response (only lines + totals are read by the board). */
function capacity(lines: Partial<CapacityLine>[] = []): CapacityResponse {
  const full: CapacityLine[] = lines.map((l) => ({
    member_id: null,
    op_user_id: 7,
    name: "Alice",
    available_hours: 0,
    planned_hours: 0,
    overloaded: false,
    // SPEC_05 §2 segments: default to "all planned work is baseline, no scope
    // changes" unless a test overrides — matches pre-Increment-5 semantics.
    baseline_hours: l.baseline_hours ?? l.planned_hours ?? 0,
    added_hours: 0,
    removed_hours: 0,
    // SPEC_09 §3/§4: grey redistribution segments, 0 unless a test overrides.
    redistributed_out_hours: 0,
    redistributed_in_hours: 0,
    // SPEC_14 §2: back-compat default (every pre-Increment-14 test line is a
    // Developer) — a test modelling a tester/customer/other line overrides
    // both explicitly.
    role: "developer",
    is_developer: true,
    ...l,
    // Default: a person with planned work has sprint work; override explicitly to
    // model a 0-estimate sprint task (planned 0 but still has_sprint_work).
    has_sprint_work: l.has_sprint_work ?? ((l.planned_hours ?? 0) > 0),
  }));
  // SPEC_14 §2 consequence #1: mirrors the real server's "developers only"
  // aggregate — a non-developer line is still present in `lines` but excluded
  // from the totals this fixture reports.
  const devLines = full.filter((l) => l.is_developer);
  return {
    capacity_mode: "per_person",
    members: [],
    lines: full,
    total_available_hours: devLines.reduce((s, l) => s + l.available_hours, 0),
    total_planned_hours: devLines.reduce((s, l) => s + l.planned_hours, 0),
    baseline_total_hours: null,
    // Increment 30 (`CAPACITY_BAR_RULES.md` §6 invariant 8): the header's
    // "Planned (developers)" number — Σ planned_hours over developer lines
    // ONLY, same `devLines` filter as total_planned_hours above (a real
    // server computes this via computeCapacity's canonical current-scope
    // rule, shared with ClosureStatsResponse.total_planned_hours). Mirrors
    // total_planned_hours by construction in this fixture; a test modelling
    // a non-developer line still correctly excludes their hours from both.
    scope_planned_hours: devLines.reduce((s, l) => s + l.planned_hours, 0),
    // Increment 17 (SPEC_17 §2/§4a): the header's "Delivered" number, now
    // read straight off CapacityResponse instead of closure-stats. Defaults
    // to 0 (this local fixture has no notion of "delivered" — a test that
    // exercises Delivered overrides it explicitly, same pattern as
    // baseline_total_hours above).
    scope_delivered_hours: 0,
  };
}

beforeEach(() => {
  for (const k of Object.keys(mockApi)) delete mockApi[k];
  // Default: the selected sprint has no items and empty capacity unless a test says otherwise.
  // SPEC_07 §5: sprint-column data now comes from the detailed-items endpoint,
  // not GET /sprints/:id/items — see makeSprintItemDetail in test/fixtures.ts.
  mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue([]);
  mockApi.getCapacity = vi.fn().mockResolvedValue(capacity());
  // Increment 15 (SPEC_15): default to an EMPTY per_developer so every
  // pre-existing test (none of which know about `segments`) keeps rendering
  // the old aggregate baseline-only bar unchanged — a test that wants the new
  // per-ticket segment bar overrides this explicitly with a matching
  // op_user_id/member_id/name.
  mockApi.getClosureStats = vi.fn().mockResolvedValue(makeClosureStats({ per_developer: [] }));
  // Default: no update-run history yet (only fetched at all once a sprint is activated).
  mockApi.getSprintUpdates = vi.fn().mockResolvedValue([]);
  // SPEC_13 §1a/§3: default to "nobody" — retro-identity tests override.
  mockApi.getSprintPeople = vi.fn().mockResolvedValue([]);
  // SPEC_14 §1: the changelog order toggle persists via sessionStorage — clear
  // between tests so one test's toggle choice can never leak into the next.
  sessionStorage.clear();
  // Increment 25 (SPEC_25 §3): AddTicketByIdForm always fetches connections
  // (to decide whether to show the server picker) — default to a single
  // connection so the picker stays hidden and every pre-existing test is
  // unaffected. Tests exercising the multi-server picker override this.
  mockApi.getConnections = vi.fn().mockResolvedValue([makeConnection()]);
  // Increment 31 (docs/INCREMENT_31_CONTRACTS.md §4 point 3): SprintDetailsPanel
  // fetches config once to compute the grace/freeze badge — default so every
  // pre-existing test (none of which know about it) is unaffected.
  mockApi.getConfig = vi.fn().mockResolvedValue(makeAppConfig());
  // Increment 32 (docs/INCREMENT_32_CONTRACTS.md §4/§5): the Capacity panel's
  // "Outside the sprint" section — default to "never fetched, no rows" (the
  // quietest possible state, renders a one-line empty note) so every
  // pre-existing test is unaffected. A test exercising the section overrides
  // this explicitly.
  mockApi.getOffSprintTime = vi.fn().mockResolvedValue(makeOffSprintTimeResponse());
});

function renderBoard(sprints = [makeSprint({ id: 1, name: "Sprint 1", status: "planning" })]) {
  return render(
    <SprintBoardScreen
      sprints={sprints}
      selectedSprintId={1}
      onSelectSprint={() => {}}
      onSprintsChanged={() => {}}
      refreshKey={0}
    />,
  );
}

describe("SprintBoardScreen", () => {
  it("splits backlog and sprint columns and adds an item via the API", async () => {
    const user = userEvent.setup();
    mockApi.getBacklog = vi.fn().mockResolvedValue([
      makeBacklogItem({ op_id: 1, subject: "Backlog item", assignee_op_id: 7, assignee_name: "Alice", effective_hours: 10, in_sprint: false }),
    ]);
    mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue([
      makeSprintItemDetail({ op_id: 2, subject: "Planned item", assignee_op_id: 9, assignee_name: "Bob", effective_hours: 4 }),
    ]);
    mockApi.addSprintItem = vi.fn().mockResolvedValue({});

    renderBoard();
    await waitFor(() => expect(screen.getByText(/Backlog item/)).toBeInTheDocument());
    const closureCallsBeforeMove = mockApi.getClosureStats!.mock.calls.length;

    const backlogZone = screen.getByTestId("drop-backlog");
    const sprintZone = screen.getByTestId("drop-sprint");
    expect(within(backlogZone).getByText(/Backlog item/)).toBeInTheDocument();
    expect(within(sprintZone).getByText(/Planned item/)).toBeInTheDocument();

    await user.click(within(backlogZone).getByRole("button", { name: "Add →" }));
    await waitFor(() =>
      expect(mockApi.addSprintItem).toHaveBeenCalledWith(1, { wp_op_id: 1 }),
    );
    // Regression guard: moving a ticket between backlog and sprint (drag/drop
    // and this button share the same `move()`/`refresh()` code path) must
    // re-fetch closure-stats too, not just items/capacity — otherwise the
    // "Planned" NUMBER updates but the per-developer segment BARS silently go
    // stale until a full page reload (bug reported live after Increment 25).
    await waitFor(() =>
      expect(mockApi.getClosureStats!.mock.calls.length).toBeGreaterThan(closureCallsBeforeMove),
    );
  });

  // Increment 28 (docs/INCREMENT_28_CONTRACTS.md §1): `refresh()` now ALSO
  // bumps the App-level refreshKey (`onSprintsChanged`), not just the local
  // triad above — the single shared callback every membership/estimate
  // mutation funnels through, so a mutation made elsewhere (a different tab)
  // can propagate here too.
  it("bumps the shared App-level refreshKey callback after adding an item", async () => {
    const user = userEvent.setup();
    const onSprintsChanged = vi.fn();
    mockApi.getBacklog = vi.fn().mockResolvedValue([
      makeBacklogItem({ op_id: 1, subject: "Backlog item", effective_hours: 10 }),
    ]);
    mockApi.addSprintItem = vi.fn().mockResolvedValue({});

    render(
      <SprintBoardScreen
        sprints={[makeSprint({ id: 1, name: "Sprint 1", status: "planning" })]}
        selectedSprintId={1}
        onSelectSprint={() => {}}
        onSprintsChanged={onSprintsChanged}
        refreshKey={0}
      />,
    );
    await waitFor(() => expect(screen.getByText(/Backlog item/)).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Add →" }));
    await waitFor(() => expect(mockApi.addSprintItem).toHaveBeenCalled());
    expect(onSprintsChanged).toHaveBeenCalled();
  });

  it("shows only the selected sprint's items, not items that belong to another open sprint", async () => {
    // WP 1 is a plain backlog candidate (in some OTHER sprint, or none); only
    // WP 2 belongs to the selected sprint 1's detailed-items response. WP 1
    // must stay in the backlog column — regression for the 'sprints share
    // items' bug.
    mockApi.getBacklog = vi.fn().mockResolvedValue([
      makeBacklogItem({ op_id: 1, subject: "Other sprint item", effective_hours: 5 }),
    ]);
    mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue([
      makeSprintItemDetail({ op_id: 2, subject: "This sprint item", effective_hours: 4 }),
    ]);

    renderBoard();
    await waitFor(() => expect(screen.getByText(/This sprint item/)).toBeInTheDocument());

    const backlogZone = screen.getByTestId("drop-backlog");
    const sprintZone = screen.getByTestId("drop-sprint");
    expect(within(sprintZone).getByText(/This sprint item/)).toBeInTheDocument();
    expect(within(sprintZone).queryByText(/Other sprint item/)).not.toBeInTheDocument();
    expect(within(backlogZone).getByText(/Other sprint item/)).toBeInTheDocument();
    expect(mockApi.getSprintItemsDetailed).toHaveBeenCalledWith(1);
  });

  // Increment 21 (SPEC_21): BacklogColumn's own Status dropdown built its
  // option list from a case-sensitive Set — two differently-cased
  // occurrences of the "same" logical status (a data bug, or a
  // not-yet-migrated row) rendered as two separate options. Regression proof
  // at the component level; the server-driven BacklogScreen.tsx filter
  // dropdown was already fixed in Increment 19 and is untouched here.
  it("dedupes the backlog column's Status filter options case-insensitively", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([
      makeBacklogItem({ op_id: 1, subject: "Alpha", status_name: "in progress" }),
      makeBacklogItem({ op_id: 2, subject: "Beta", status_name: "In progress" }),
    ]);

    renderBoard();
    await waitFor(() => expect(screen.getByText(/Alpha/)).toBeInTheDocument());

    const statusSelect = screen.getByLabelText("Filter by status");
    const options = within(statusSelect).getAllByRole("option");
    const progressOptions = options.filter((o) => o.textContent?.trim().toLowerCase() === "in progress");
    expect(progressOptions).toHaveLength(1);
  });

  it("shows an overload warning when planned exceeds available capacity", async () => {
    const user = userEvent.setup();
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue([
      makeSprintItemDetail({ op_id: 2, subject: "Planned item", assignee_op_id: 9, assignee_name: "Bob", effective_hours: 4 }),
    ]);
    mockApi.getCapacity = vi.fn().mockResolvedValue(
      capacity([{ op_user_id: 9, name: "Bob", planned_hours: 4, available_hours: 0 }]),
    );

    renderBoard();
    await waitFor(() => expect(screen.getByText(/Planned item/)).toBeInTheDocument());

    const availInput = screen.getByLabelText("available hours for Bob");
    await user.clear(availInput);
    await user.type(availInput, "2");

    await waitFor(() => expect(screen.getByText(/Overloaded/)).toBeInTheDocument());
  });

  // SPEC_14 §2 consequence #1 / §5: a tester/customer/other's committed
  // hours stay visible ("grey" — work that left the developer's hands) but
  // are neither availability-editable, counted in the Available total, nor
  // (Increment 30, `CAPACITY_BAR_RULES.md` §6 invariant 8) counted in the
  // header's Planned total — `scope_planned_hours` is developers-only, same
  // as `total_planned_hours`, so the header stays reproducible by summing
  // only the developer rows rendered beneath it.
  it("renders a non-developer capacity line as grey, non-editable, and excluded from both the Available and Planned totals", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue([
      makeSprintItemDetail({ op_id: 1, subject: "Dev item", assignee_op_id: 7, assignee_name: "Alice", effective_hours: 10 }),
      makeSprintItemDetail({ op_id: 2, subject: "Tester item", assignee_op_id: 11, assignee_name: "Dan", effective_hours: 40 }),
    ]);
    mockApi.getCapacity = vi.fn().mockResolvedValue(
      capacity([
        { op_user_id: 7, name: "Alice", planned_hours: 10, available_hours: 20, role: "developer", is_developer: true },
        { op_user_id: 11, name: "Dan", planned_hours: 40, available_hours: 66, role: "tester", is_developer: false },
      ]),
    );

    renderBoard();
    await waitFor(() => expect(screen.getByText(/Dev item/)).toBeInTheDocument());

    // Dan's hours are visible, marked with his role, inside the distinctly
    // grey non-developer row…
    const nonDevRow = screen.getByTestId("capacity-line-nondev-11");
    expect(within(nonDevRow).getByText("Dan")).toBeInTheDocument();
    expect(within(nonDevRow).getByText("tester")).toBeInTheDocument();
    // …but he has no editable availability input.
    expect(screen.queryByLabelText("available hours for Dan")).not.toBeInTheDocument();

    // Alice (Developer) still gets an editable input.
    expect(screen.getByLabelText("available hours for Alice")).toBeInTheDocument();

    // Increment 30 (`CAPACITY_BAR_RULES.md` §6 invariant 8): the header's
    // "Planned (developers)" is Σ of the DEVELOPER rows only — Alice's 10,
    // not Dan's 40 — so a user summing exactly the rows shown reproduces it.
    // "Available" stays developer-only too (SPEC_14 §2, unchanged): Alice's
    // 20, not Dan's 66.
    const plannedStat = screen.getByText("Planned (developers)").closest(".stat") as HTMLElement;
    const availableStat = screen.getByText("Available").closest(".stat") as HTMLElement;
    expect(within(plannedStat).getByText("10h")).toBeInTheDocument();
    expect(within(availableStat).getByText("20h")).toBeInTheDocument();
  });

  // Increment 16 (SPEC_16 §4): rendered as DD/MM/YYYY (British date format),
  // not the raw ISO string.
  it("shows the selected sprint's start and end dates as DD/MM/YYYY", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    renderBoard([makeSprint({ id: 1, name: "Sprint 1", status: "planning", start_date: "2026-08-01", end_date: "2026-08-14" })]);

    await waitFor(() => expect(screen.getByTestId("sprint-start")).toHaveTextContent("01/08/2026"));
    expect(screen.getByTestId("sprint-end")).toHaveTextContent("14/08/2026");
  });

  it("finishes an active sprint via finishSprint after confirming", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const onChanged = vi.fn();
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.finishSprint = vi.fn().mockResolvedValue({});
    mockApi.getSprintUpdates = vi.fn().mockResolvedValue([]);

    render(
      <SprintBoardScreen
        sprints={[makeSprint({ id: 1, name: "Sprint 1", status: "active", activated_at: "2026-06-01T00:00:00Z" })]}
        selectedSprintId={1}
        onSelectSprint={() => {}}
        onSprintsChanged={onChanged}
        refreshKey={0}
      />,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "Finish sprint" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Finish sprint" }));

    await waitFor(() => expect(mockApi.finishSprint).toHaveBeenCalledWith(1));
    expect(onChanged).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("shows 'Update Sprint' on an active sprint, fires updateSprintRun, and refreshes", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getSprintUpdates = vi.fn().mockResolvedValue([]);
    mockApi.updateSprintRun = vi.fn().mockResolvedValue(makeSprintUpdateRun());

    render(
      <SprintBoardScreen
        sprints={[makeSprint({ id: 1, name: "Sprint 1", status: "active", activated_at: "2026-06-01T00:00:00Z" })]}
        selectedSprintId={1}
        onSelectSprint={() => {}}
        onSprintsChanged={onChanged}
        refreshKey={0}
      />,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "Update Sprint" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Update Sprint" }));

    await waitFor(() => expect(mockApi.updateSprintRun).toHaveBeenCalledWith(1));
    expect(onChanged).toHaveBeenCalled();
  });

  it("shows a live progress bar while Update Sprint is running", async () => {
    const user = userEvent.setup();
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    let resolveRun: (value: unknown) => void = () => {};
    mockApi.updateSprintRun = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveRun = resolve;
        }),
    );
    // First call (on mount, sprint already activated) finds no runs yet; once
    // updateNow() starts polling it sees a "running" run with a known total.
    mockApi.getSprintUpdates = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        makeSprintUpdateRun({ status: "running", wp_count: 4, total_count: 9, finished_at: null }),
      ]);

    render(
      <SprintBoardScreen
        sprints={[makeSprint({ id: 1, name: "Sprint 1", status: "active", activated_at: "2026-06-01T00:00:00Z" })]}
        selectedSprintId={1}
        onSelectSprint={() => {}}
        onSprintsChanged={() => {}}
        refreshKey={0}
      />,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "Update Sprint" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Update Sprint" }));

    await waitFor(
      () => expect(screen.getByTestId("sprint-update-progress")).toHaveTextContent("Updating 4/9"),
      { timeout: 2000 },
    );

    resolveRun(makeSprintUpdateRun());
    await waitFor(() => expect(screen.queryByTestId("sprint-update-progress")).not.toBeInTheDocument());
  });

  it("shows the last update run's outcome as 'last updated X ago'", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getSprintUpdates = vi.fn().mockResolvedValue([
      makeSprintUpdateRun({ finished_at: "2026-07-01T09:30:00Z", changes_count: 3, status: "success" }),
    ]);

    renderBoard([
      makeSprint({ id: 1, name: "Sprint 1", status: "active", activated_at: "2026-06-01T00:00:00Z" }),
    ]);

    await waitFor(() => expect(mockApi.getSprintUpdates).toHaveBeenCalledWith(1));
    await waitFor(() => expect(screen.getByText(/Last updated .* — 3 changes/)).toBeInTheDocument());
  });

  it("renders a locked sprint fully read-only with the lock_reason indicator, hiding mutating controls", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue([
      makeSprintItemDetail({ op_id: 1, subject: "Sprint item", effective_hours: 5 }),
    ]);

    renderBoard([
      makeSprint({
        id: 1,
        name: "Sprint 1",
        status: "active",
        activated_at: "2026-06-01T00:00:00Z",
        is_locked: true,
        locked_at: "2026-06-14T18:00:00Z",
        lock_reason: "finished",
      }),
    ]);

    await waitFor(() => expect(screen.getAllByText("Finished").length).toBeGreaterThan(0));
    // The lock banner is part of the board's async-loaded content (gated on
    // getSprintItemsDetailed/getCapacity resolving) — wait for it rather than asserting
    // synchronously right after the header badge, which loads separately/earlier.
    await waitFor(() => expect(screen.getByText(/finished and locked/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Update Sprint" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Finish sprint" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Activate" })).not.toBeInTheDocument();
    // No move buttons on cards either — fully read-only board.
    expect(screen.queryByRole("button", { name: "← Return" })).not.toBeInTheDocument();
  });

  it("shows a 'Locked — sprint end date reached' style indicator for an end_date auto-lock", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);

    renderBoard([
      makeSprint({
        id: 1,
        name: "Sprint 1",
        status: "active",
        activated_at: "2026-06-01T00:00:00Z",
        is_locked: true,
        locked_at: "2026-06-14T23:59:59Z",
        lock_reason: "end_date",
      }),
    ]);

    await waitFor(() => expect(screen.getByText(/locked automatically at its end date/)).toBeInTheDocument());
  });

  it("opens the ticket changelog panel for an activated sprint's card and fetches via the right URL", async () => {
    const user = userEvent.setup();
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue([
      makeSprintItemDetail({ op_id: 42, subject: "Some ticket", effective_hours: 5 }),
    ]);
    mockApi.getTicketChangelog = vi.fn().mockResolvedValue([
      makeChangelogEntry({
        id: 1,
        actor_name: "Dev Dvořák",
        kind: "status_changed",
        detail: { kind: "status_changed", from: "New", to: "In progress" },
        occurred_at: "2026-06-02T10:00:00Z",
      }),
      makeChangelogEntry({
        id: 2,
        actor_name: null,
        kind: "closed",
        detail: { kind: "closed", status: "Resolved" },
        occurred_at: "2026-06-05T10:00:00Z",
      }),
      makeChangelogEntry({
        id: 3,
        actor_name: "Tereza Testerová",
        kind: "time_logged",
        detail: { kind: "time_logged", hours: 2, spent_on: "2026-06-03" },
        occurred_at: "2026-06-03T15:00:00Z",
      }),
      // SPEC_10 §d: a bare comment (no field changes) — fact + author/time only,
      // no content. Regression for the old parser's "unrecognized property
      // undefined" paskvil on entries it didn't know how to map.
      makeChangelogEntry({
        id: 4,
        actor_name: "Daniel Brabec",
        kind: "comment_added",
        detail: { kind: "comment_added" },
        occurred_at: "2026-06-04T09:00:00Z",
      }),
    ]);

    renderBoard([
      makeSprint({ id: 1, name: "Sprint 1", status: "active", activated_at: "2026-06-01T00:00:00Z" }),
    ]);

    await waitFor(() => expect(screen.getByText(/Some ticket/)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "View changelog for #42" }));

    await waitFor(() => expect(mockApi.getTicketChangelog).toHaveBeenCalledWith(1, 42));
    await waitFor(() => expect(screen.getByText(/status: New → In progress/)).toBeInTheDocument());
    expect(screen.getByText(/🔒 closed \(Resolved\)/)).toBeInTheDocument();
    expect(screen.getByText(/logged 2h on 2026-06-03/)).toBeInTheDocument();
    expect(screen.getByText(/comment added/)).toBeInTheDocument();
    expect(screen.getByText("Daniel Brabec")).toBeInTheDocument();
    expect(screen.queryByText(/unrecognized property/)).not.toBeInTheDocument();
    // actor_name null renders as an em dash.
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByText(/status: New → In progress/)).not.toBeInTheDocument());
  });

  // SPEC_14 §1: default newest-first, toggle flips it, choice remembered for
  // the session (sessionStorage) so reopening the modal keeps the toggle.
  it("defaults the changelog to newest-first, toggles order, and remembers the choice for the session", async () => {
    const user = userEvent.setup();
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue([
      makeSprintItemDetail({ op_id: 42, subject: "Some ticket", effective_hours: 5 }),
    ]);
    // API itself is unchanged — always oldest-first, as documented.
    mockApi.getTicketChangelog = vi.fn().mockResolvedValue([
      makeChangelogEntry({
        id: 1,
        kind: "status_changed",
        detail: { kind: "status_changed", from: "New", to: "In progress" },
        occurred_at: "2026-06-02T10:00:00Z",
      }),
      makeChangelogEntry({
        id: 2,
        kind: "status_changed",
        detail: { kind: "status_changed", from: "In progress", to: "Resolved" },
        occurred_at: "2026-06-05T10:00:00Z",
      }),
    ]);

    renderBoard([
      makeSprint({ id: 1, name: "Sprint 1", status: "active", activated_at: "2026-06-01T00:00:00Z" }),
    ]);
    await waitFor(() => expect(screen.getByText(/Some ticket/)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "View changelog for #42" }));
    await waitFor(() => expect(mockApi.getTicketChangelog).toHaveBeenCalledWith(1, 42));

    // Default: newest first — the 06-05 change renders before the 06-02 one.
    let rows = await screen.findAllByText(/status:/);
    expect(rows[0]).toHaveTextContent("In progress → Resolved");
    expect(rows[1]).toHaveTextContent("New → In progress");

    // Toggle flips to oldest-first.
    await user.click(screen.getByTestId("changelog-order-toggle"));
    rows = screen.getAllByText(/status:/);
    expect(rows[0]).toHaveTextContent("New → In progress");
    expect(rows[1]).toHaveTextContent("In progress → Resolved");

    // Close and reopen within the same session — "oldest" is still remembered.
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: "View changelog for #42" }));
    rows = await screen.findAllByText(/status:/);
    expect(rows[0]).toHaveTextContent("New → In progress");
    expect(rows[1]).toHaveTextContent("In progress → Resolved");
  });

  it("does not offer a changelog affordance for a sprint that has never been activated", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue([
      makeSprintItemDetail({ op_id: 1, subject: "Planning item", effective_hours: 4 }),
    ]);

    renderBoard([makeSprint({ id: 1, name: "Sprint 1", status: "planning", activated_at: null })]);

    await waitFor(() => expect(screen.getByText(/Planning item/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /View changelog/ })).not.toBeInTheDocument();
  });

  it("labels a closed sprint as Finished and keeps the board read-only", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([
      makeBacklogItem({ op_id: 1, subject: "Backlog item", effective_hours: 5, in_sprint: false }),
    ]);
    renderBoard([makeSprint({ id: 1, name: "Sprint 1", status: "closed" })]);

    await waitFor(() => expect(screen.getAllByText("Finished").length).toBeGreaterThan(0));
    // Read-only board: no move buttons rendered on cards.
    expect(screen.queryByRole("button", { name: "Add →" })).not.toBeInTheDocument();
  });

  it("saves capacity via setCapacity while planning", async () => {
    const user = userEvent.setup();
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue([
      makeSprintItemDetail({ op_id: 2, subject: "Planned item", assignee_op_id: 9, assignee_name: "Bob", effective_hours: 4 }),
    ]);
    mockApi.getCapacity = vi.fn().mockResolvedValue(
      capacity([{ op_user_id: 9, name: "Bob", planned_hours: 4, available_hours: 0 }]),
    );
    mockApi.setCapacity = vi.fn().mockResolvedValue(capacity());

    renderBoard();
    await waitFor(() => expect(screen.getByLabelText("available hours for Bob")).toBeInTheDocument());

    const availInput = screen.getByLabelText("available hours for Bob");
    await user.clear(availInput);
    await user.type(availInput, "10");
    await user.click(screen.getByRole("button", { name: "Save capacity" }));

    await waitFor(() =>
      expect(mockApi.setCapacity).toHaveBeenCalledWith(1, {
        members: [{ op_user_id: 9, name: "Bob", available_hours: 10, pto_days: 0 }],
      }),
    );
  });

  it("adds a backlog person via 'Add person' as an editable row with NO sprint items yet", async () => {
    const user = userEvent.setup();
    // Fresh sprint: no items, server capacity has no lines. The backlog assignee is
    // NOT auto-seeded — the planner must pick them from "Add person" to set availability.
    mockApi.getBacklog = vi.fn().mockResolvedValue([
      makeBacklogItem({ op_id: 1, subject: "Backlog item", assignee_op_id: 9, assignee_name: "Bob", effective_hours: 4, in_sprint: false }),
    ]);
    // getSprintItemsDetailed -> [] and getCapacity -> empty lines come from beforeEach.

    renderBoard();
    await waitFor(() => expect(screen.getByLabelText("Add person")).toBeInTheDocument());

    // No auto-seeded row before adding.
    expect(screen.queryByLabelText("available hours for Bob")).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Add person"), "9");

    const input = (await screen.findByLabelText("available hours for Bob")) as HTMLInputElement;
    expect(input).not.toHaveAttribute("readonly");
    expect(input.disabled).toBe(false);
  });

  it("saves an added backlog person's typed availability via setCapacity even with no sprint items", async () => {
    const user = userEvent.setup();
    mockApi.getBacklog = vi.fn().mockResolvedValue([
      makeBacklogItem({ op_id: 1, subject: "Backlog item", assignee_op_id: 9, assignee_name: "Bob", effective_hours: 4, in_sprint: false }),
    ]);
    mockApi.setCapacity = vi.fn().mockResolvedValue(capacity());

    renderBoard();
    await waitFor(() => expect(screen.getByLabelText("Add person")).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText("Add person"), "9");
    await user.type(await screen.findByLabelText("available hours for Bob"), "8");
    await user.click(screen.getByRole("button", { name: "Save capacity" }));

    await waitFor(() =>
      expect(mockApi.setCapacity).toHaveBeenCalledWith(1, {
        members: [{ op_user_id: 9, name: "Bob", available_hours: 8, pto_days: 0 }],
      }),
    );
  });

  it("resets session-local 'Add person' state when the selected sprint changes (SPEC_10 §c)", async () => {
    // SprintBoardScreen never unmounts across a sprint switch (useAsync keeps
    // stale data around while refetching), so `added` must be explicitly reset
    // per-sprint or a person added-this-session for sprint 1 would still render
    // as an "added" row after switching to sprint 2.
    const user = userEvent.setup();
    mockApi.getBacklog = vi.fn().mockResolvedValue([
      makeBacklogItem({ op_id: 1, subject: "Backlog item", assignee_op_id: 9, assignee_name: "Bob", effective_hours: 4, in_sprint: false }),
    ]);
    mockApi.getCapacity = vi.fn().mockImplementation((sprintId: number) =>
      Promise.resolve(capacity(sprintId === 1 ? [] : [])),
    );

    const sprint1 = makeSprint({ id: 1, name: "Sprint 1", status: "planning" });
    const sprint2 = makeSprint({ id: 2, name: "Sprint 2", status: "planning" });
    const { rerender } = render(
      <SprintBoardScreen
        sprints={[sprint1, sprint2]}
        selectedSprintId={1}
        onSelectSprint={() => {}}
        onSprintsChanged={() => {}}
        refreshKey={0}
      />,
    );

    await waitFor(() => expect(screen.getByLabelText("Add person")).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText("Add person"), "9");
    expect(await screen.findByLabelText("available hours for Bob")).toBeInTheDocument();

    // Switch to sprint 2 on the SAME mounted component (matching how App.tsx
    // re-renders SprintBoardScreen with a new selectedSprintId, no remount).
    rerender(
      <SprintBoardScreen
        sprints={[sprint1, sprint2]}
        selectedSprintId={2}
        onSelectSprint={() => {}}
        onSprintsChanged={() => {}}
        refreshKey={0}
      />,
    );

    await waitFor(() => expect(mockApi.getCapacity).toHaveBeenCalledWith(2));
    await waitFor(() =>
      expect(screen.queryByLabelText("available hours for Bob")).not.toBeInTheDocument(),
    );
    // Still addable fresh on sprint 2 — confirms it's a clean reset, not a stuck disabled state.
    expect(screen.getByLabelText("Add person")).toBeInTheDocument();
  });

  it("removes a person with no sprint work via an 'x', persisting the removal without them", async () => {
    const user = userEvent.setup();
    // Alice has no work in this sprint (planned 0) -> removable; Bob has items.
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getCapacity = vi.fn().mockResolvedValue(
      capacity([
        { op_user_id: 7, name: "Alice", planned_hours: 0, available_hours: 5 },
        { op_user_id: 9, name: "Bob", planned_hours: 4, available_hours: 10 },
      ]),
    );
    mockApi.setCapacity = vi.fn().mockResolvedValue(capacity());

    renderBoard();
    await waitFor(() => expect(screen.getByLabelText("available hours for Alice")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Remove Alice" }));

    // Removal persists the REMAINING real people (Bob only), deleting Alice's saved row.
    await waitFor(() =>
      expect(mockApi.setCapacity).toHaveBeenCalledWith(1, {
        members: [{ op_user_id: 9, name: "Bob", available_hours: 10, pto_days: 0 }],
      }),
    );
  });

  it("removes the LAST/only person (persists empty members)", async () => {
    const user = userEvent.setup();
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getCapacity = vi.fn().mockResolvedValue(
      capacity([{ op_user_id: 7, name: "Alice", planned_hours: 0, available_hours: 5 }]),
    );
    mockApi.setCapacity = vi.fn().mockResolvedValue(capacity());

    renderBoard();
    await waitFor(() => expect(screen.getByLabelText("available hours for Alice")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Remove Alice" }));

    await waitFor(() =>
      expect(mockApi.setCapacity).toHaveBeenCalledWith(1, { members: [] }),
    );
  });

  it("does not offer an 'x' for a person WITH sprint items (planned > 0)", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getCapacity = vi.fn().mockResolvedValue(
      capacity([
        { op_user_id: 7, name: "Alice", planned_hours: 0, available_hours: 5 },
        { op_user_id: 9, name: "Bob", planned_hours: 4, available_hours: 10 },
      ]),
    );

    renderBoard();
    await waitFor(() => expect(screen.getByLabelText("available hours for Bob")).toBeInTheDocument());

    // Bob has work -> no remove control; Alice (planned 0) does.
    expect(screen.queryByRole("button", { name: "Remove Bob" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Alice" })).toBeInTheDocument();
  });

  it("does not offer an 'x' for a 0-estimate sprint assignee (planned 0 but has_sprint_work)", async () => {
    // Carla is the assignee of a sprint task with no estimate → planned 0, but she
    // has work; the 'x' must NOT show (removing her would not stick — she is
    // re-derived from the sprint item). Regression for the "can't remove" report.
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getCapacity = vi.fn().mockResolvedValue(
      capacity([{ op_user_id: 7, name: "Carla", planned_hours: 0, available_hours: 5, has_sprint_work: true }]),
    );

    renderBoard();
    await waitFor(() => expect(screen.getByLabelText("available hours for Carla")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Remove Carla" })).not.toBeInTheDocument();
  });

  it("prompts to sync when the project backlog has no assignees and no capacity lines", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([
      makeBacklogItem({ op_id: 1, subject: "Orphan item", assignee_op_id: null, assignee_name: null, effective_hours: 4, in_sprint: false }),
    ]);
    // beforeEach: no sprint items, empty capacity lines.

    renderBoard();
    await waitFor(() => expect(screen.getByText(/No assignable people in this project yet/)).toBeInTheDocument());
  });

  it("makes capacity read-only (no Save) when the sprint is active", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue([
      makeSprintItemDetail({ op_id: 2, subject: "Planned item", assignee_op_id: 9, assignee_name: "Bob", effective_hours: 4 }),
    ]);
    mockApi.getCapacity = vi.fn().mockResolvedValue(
      capacity([{ op_user_id: 9, name: "Bob", planned_hours: 4, available_hours: 12 }]),
    );

    renderBoard([makeSprint({ id: 1, name: "Sprint 1", status: "active" })]);

    // Three chained async fetches (backlog → items/detailed → capacity), THEN a
    // separate effect that seeds the local `avail` state from the loaded
    // capacity (SprintBoardScreen.tsx's `useEffect(..., [capacity])`) — the
    // input can mount with an empty value one tick before that effect
    // populates it, so wait for the VALUE itself, not just the element's
    // presence, or this flakes under any scheduling jitter.
    await waitFor(
      () => expect((screen.getByLabelText("available hours for Bob") as HTMLInputElement).value).toBe("12"),
      { timeout: 4000 },
    );
    const availInput = screen.getByLabelText("available hours for Bob") as HTMLInputElement;
    expect(availInput).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "Save capacity" })).not.toBeInTheDocument();
  });

  it("filters the backlog by search text scoped to the backlog column", async () => {
    const user = userEvent.setup();
    mockApi.getBacklog = vi.fn().mockResolvedValue([
      makeBacklogItem({ op_id: 1, subject: "Alpha task", effective_hours: 1, in_sprint: false }),
      makeBacklogItem({ op_id: 2, subject: "Beta task", effective_hours: 1, in_sprint: false }),
      makeBacklogItem({ op_id: 3, subject: "Gamma work", effective_hours: 1, in_sprint: false }),
    ]);

    renderBoard();
    await waitFor(() => expect(screen.getByText(/Alpha task/)).toBeInTheDocument());

    const backlogZone = screen.getByTestId("drop-backlog");
    expect(within(backlogZone).getByText(/Beta task/)).toBeInTheDocument();

    await user.type(screen.getByLabelText("Search backlog"), "Alpha");

    await waitFor(() => expect(within(backlogZone).queryByText(/Beta task/)).not.toBeInTheDocument());
    expect(within(backlogZone).getByText(/Alpha task/)).toBeInTheDocument();
    expect(screen.getByText(/Showing 1 of 1/)).toBeInTheDocument();
  });

  it("filters the backlog by #id", async () => {
    const user = userEvent.setup();
    mockApi.getBacklog = vi.fn().mockResolvedValue([
      makeBacklogItem({ op_id: 101, subject: "Alpha task", effective_hours: 1, in_sprint: false }),
      makeBacklogItem({ op_id: 202, subject: "Beta task", effective_hours: 1, in_sprint: false }),
    ]);

    renderBoard();
    await waitFor(() => expect(screen.getByText(/Alpha task/)).toBeInTheDocument());

    await user.type(screen.getByLabelText("Search backlog"), "#202");

    const backlogZone = screen.getByTestId("drop-backlog");
    await waitFor(() => expect(within(backlogZone).queryByText(/Alpha task/)).not.toBeInTheDocument());
    expect(within(backlogZone).getByText(/Beta task/)).toBeInTheDocument();
  });

  it("creates a sprint via the API", async () => {
    const user = userEvent.setup();
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.createSprint = vi.fn().mockResolvedValue(makeSprint({ id: 2 }));

    renderBoard();
    await waitFor(() => expect(screen.getByLabelText("New Sprint Name")).toBeInTheDocument());

    await user.type(screen.getByLabelText("New Sprint Name"), "Sprint 2");
    await user.type(screen.getByLabelText("Start"), "2026-07-01");
    await user.type(screen.getByLabelText("End"), "2026-07-14");
    await user.click(screen.getByRole("button", { name: "Create sprint" }));

    await waitFor(() =>
      expect(mockApi.createSprint).toHaveBeenCalledWith({
        name: "Sprint 2",
        start_date: "2026-07-01",
        end_date: "2026-07-14",
        capacity_mode: "per_person",
      }),
    );
  });

  // SPEC_05 §6.3: the input reads as an explicit name field, with an example
  // (not a literal suggestion) as the placeholder.
  it("labels the create-sprint input 'New Sprint Name' with an 'e.g.' placeholder", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    renderBoard();

    const input = await screen.findByLabelText("New Sprint Name");
    expect(input).toHaveAttribute("placeholder", "e.g. Sprint 42");
  });

  // ── SPEC_05 §5: stacked capacity bar (green baseline / red added / blue removed) ──

  it("renders green/blue/red capacity segments proportionally and combines all three on one line", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getCapacity = vi.fn().mockResolvedValue(
      capacity([
        {
          op_user_id: 9,
          name: "Bob",
          available_hours: 20,
          planned_hours: 18, // baseline(10) - removed(4) + added(12) = 18
          baseline_hours: 10,
          added_hours: 12,
          removed_hours: 4,
          has_sprint_work: true,
        },
      ]),
    );

    renderBoard([makeSprint({ id: 1, name: "Sprint 1", status: "active", activated_at: "2026-06-01T00:00:00Z" })]);

    await waitFor(() => expect(screen.getByLabelText("load for Bob")).toBeInTheDocument());
    const bar = screen.getByLabelText("load for Bob");
    const green = bar.querySelector(".bar-green") as HTMLElement;
    const blue = bar.querySelector(".bar-blue") as HTMLElement;
    const red = bar.querySelector(".bar-red") as HTMLElement;

    // SPEC_13 §4: segments are sized off real allocated hours (never off
    // available_hours alone) — total allocated = baseline(10) + added(12) =
    // 22h, which EXCEEDS available_hours(20), so the denominator grows to 22
    // instead of clipping/overflowing at 20.
    // green = baseline(10) - removed(4) = 6 -> 6/22
    expect(Number(green.style.width.replace("%", ""))).toBeCloseTo((6 / 22) * 100, 5);
    // blue = removed(4) -> 4/22
    expect(Number(blue.style.width.replace("%", ""))).toBeCloseTo((4 / 22) * 100, 5);
    // red = added(12) -> 12/22
    expect(Number(red.style.width.replace("%", ""))).toBeCloseTo((12 / 22) * 100, 5);

    // The available_hours reference marker sits at 20/22 (~90.9%), not 100%.
    const marker = bar.querySelector(".bar-marker") as HTMLElement;
    expect(marker).toBeInTheDocument();
    expect(Number(marker.style.left.replace("%", ""))).toBeCloseTo((20 / 22) * 100, 5);

    expect(bar).toHaveAttribute("title", expect.stringContaining("baseline 10h"));
    expect(bar).toHaveAttribute("title", expect.stringContaining("+12h added"));
    expect(bar).toHaveAttribute("title", expect.stringContaining("-4h removed"));
  });

  it("still renders full, proportionally-sized segments when available_hours is 0 (SPEC_13 §4)", async () => {
    // Regression: a retro sprint whose roster never got availability entered
    // (available_hours 0) must NOT collapse every segment to 0% width just
    // because the old denominator (available_hours) was 0 — real planned
    // work must still render as a full, non-zero-width bar.
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getCapacity = vi.fn().mockResolvedValue(
      capacity([
        { op_user_id: 9, name: "Bob", available_hours: 0, planned_hours: 19, baseline_hours: 19, has_sprint_work: true },
      ]),
    );

    renderBoard([makeSprint({ id: 1, name: "Sprint 1", status: "active", activated_at: "2026-06-01T00:00:00Z" })]);

    await waitFor(() => expect(screen.getByLabelText("load for Bob")).toBeInTheDocument());
    const bar = screen.getByLabelText("load for Bob");
    const green = bar.querySelector(".bar-green") as HTMLElement;

    expect(green.style.width).toBe("100%");
    expect(bar.querySelector(".bar-marker")).not.toBeInTheDocument();
  });

  it("falls back to a single green segment sized by planned hours before a baseline exists", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getCapacity = vi.fn().mockResolvedValue(
      capacity([
        { op_user_id: 9, name: "Bob", available_hours: 10, planned_hours: 4, baseline_hours: 0, added_hours: 0, removed_hours: 0 },
      ]),
    );

    renderBoard();
    await waitFor(() => expect(screen.getByLabelText("load for Bob")).toBeInTheDocument());
    const bar = screen.getByLabelText("load for Bob");
    const green = bar.querySelector(".bar-green") as HTMLElement;
    const blue = bar.querySelector(".bar-blue") as HTMLElement;
    const red = bar.querySelector(".bar-red") as HTMLElement;

    expect(green.style.width).toBe("40%"); // 4/10 planned, pre-activation fallback
    expect(blue.style.width).toBe("0%");
    expect(red.style.width).toBe("0%");
    expect(bar).not.toHaveAttribute("title");
  });

  // ── SPEC_05 §2: current total with a delta vs. baseline ──

  it("shows the planned-hours delta once a baseline exists", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getCapacity = vi.fn().mockResolvedValue({
      ...capacity([{ op_user_id: 9, name: "Bob", available_hours: 20, planned_hours: 18, baseline_hours: 10, added_hours: 12, removed_hours: 4 }]),
      baseline_total_hours: 10,
      total_planned_hours: 18,
    });

    renderBoard([makeSprint({ id: 1, name: "Sprint 1", status: "active", activated_at: "2026-06-01T00:00:00Z" })]);

    const delta = await screen.findByTestId("planned-hours-delta");
    expect(delta).toHaveTextContent("18h");
    expect(delta).toHaveTextContent("+12h");
    expect(delta).toHaveTextContent("-4h");
  });

  it("omits the delta before activation (baseline_total_hours null)", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getCapacity = vi.fn().mockResolvedValue(capacity([{ op_user_id: 9, name: "Bob", available_hours: 20, planned_hours: 8 }]));

    renderBoard();

    const delta = await screen.findByTestId("planned-hours-delta");
    expect(delta).toHaveTextContent("8h");
    expect(delta.textContent).not.toMatch(/[+-]/);
  });

  // ── Increment 17 (SPEC_17 §2/§4a): Capacity header — Planned / Delivered / Available ──

  it("shows the Capacity header's Planned/Delivered/Available from the server, not the client-recomputed totals", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getCapacity = vi.fn().mockResolvedValue({
      ...capacity([{ op_user_id: 9, name: "Bob", available_hours: 66, planned_hours: 40 }]),
      // Deliberately DIFFERENT from total_planned_hours (developer-workload-
      // filtered) — Planned must read scope_planned_hours directly.
      scope_planned_hours: 142,
      total_planned_hours: 86,
      // Increment 17 (SPEC_17 §2/§4a): Delivered now lives on the SAME
      // CapacityResponse — no more cross-referencing closure-stats.
      scope_delivered_hours: 57,
    });

    renderBoard([makeSprint({ id: 1, name: "Sprint 1", status: "active", activated_at: "2026-06-01T00:00:00Z" })]);

    const plannedStat = await screen.findByText("Planned (developers)").then((el) => el.closest(".stat") as HTMLElement);
    const deliveredStat = screen.getByText("Delivered").closest(".stat") as HTMLElement;
    const availableStat = screen.getByText("Available").closest(".stat") as HTMLElement;
    expect(within(plannedStat).getByText("142h")).toBeInTheDocument();
    expect(within(deliveredStat).getByText("57h")).toBeInTheDocument();
    expect(within(availableStat).getByText("66h")).toBeInTheDocument();
  });

  it("shows Planned/Delivered/Available from capacity even while closure-stats (per-developer bar data) is still loading", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getCapacity = vi.fn().mockResolvedValue({
      ...capacity([{ op_user_id: 9, name: "Bob", available_hours: 20, planned_hours: 8 }]),
      scope_delivered_hours: 5,
    });
    // Never resolves — models "still loading". The header numbers must NOT
    // depend on this fetch any more (Increment 16 read Delivered off it and
    // showed "—" until it resolved; Increment 17 moved Delivered onto
    // CapacityResponse, so the header now renders as soon as capacity does).
    mockApi.getClosureStats = vi.fn().mockReturnValue(new Promise(() => {}));

    renderBoard();

    const deliveredStat = await screen.findByText("Delivered").then((el) => el.closest(".stat") as HTMLElement);
    expect(deliveredStat).toHaveTextContent("5h");
  });

  // ── SPEC_05 §1/§4/§9.1: removed-mid-sprint visibility + added badge ──

  it("keeps a removed_mid_sprint item WITH logged hours visible, greyed out with a blue border", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue([
      makeSprintItemDetail({
        op_id: 5,
        subject: "Logged-then-cut ticket",
        effective_hours: 4,
        spent_hours: 3,
        outcome: "removed_mid_sprint",
      }),
    ]);

    renderBoard([makeSprint({ id: 1, name: "Sprint 1", status: "active", activated_at: "2026-06-01T00:00:00Z" })]);

    const sprintZone = await screen.findByTestId("drop-sprint");
    expect(within(sprintZone).getByText(/Logged-then-cut ticket/)).toBeInTheDocument();
    expect(within(sprintZone).getByText("removed")).toBeInTheDocument();
    const card = within(sprintZone).getByText(/Logged-then-cut ticket/).closest(".card");
    expect(card).toHaveClass("card-removed");
    // No move/return button — it's historical, not actionable.
    expect(within(sprintZone).queryByRole("button", { name: "← Return" })).not.toBeInTheDocument();
  });

  it("hides a removed_mid_sprint item with NO logged hours from the active sprint column", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([
      makeBacklogItem({ op_id: 6, subject: "Cut before any work", effective_hours: 4, spent_hours: 0 }),
    ]);
    mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue([
      makeSprintItemDetail({ op_id: 6, subject: "Cut before any work", effective_hours: 4, spent_hours: 0, outcome: "removed_mid_sprint" }),
    ]);

    renderBoard([makeSprint({ id: 1, name: "Sprint 1", status: "active", activated_at: "2026-06-01T00:00:00Z" })]);

    // No logged time -> not treated as "in the sprint" at all; it reads like any
    // other backlog work package (same as the classic `removed` outcome today).
    const backlogZone = await screen.findByTestId("drop-backlog");
    expect(within(backlogZone).getByText(/Cut before any work/)).toBeInTheDocument();
    const sprintZone = screen.getByTestId("drop-sprint");
    expect(within(sprintZone).queryByText(/Cut before any work/)).not.toBeInTheDocument();
  });

  it("shows an 'added' badge for an item added mid-sprint", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue([
      makeSprintItemDetail({ op_id: 7, subject: "Injected urgent fix", effective_hours: 2, origin: "added_mid_sprint" }),
    ]);

    renderBoard([makeSprint({ id: 1, name: "Sprint 1", status: "active", activated_at: "2026-06-01T00:00:00Z" })]);

    const sprintZone = await screen.findByTestId("drop-sprint");
    expect(within(sprintZone).getByText(/Injected urgent fix/)).toBeInTheDocument();
    expect(within(sprintZone).getByText("added")).toBeInTheDocument();
  });

  // ── SPEC_25 §5 (confirmed decision): retroactively-added tickets reuse the
  // ordinary "Added" badge, with zero special "retro" label ──

  it("shows the SAME 'added' badge for a retroactively-added item as for an ordinary mid-sprint addition", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue([
      makeSprintItemDetail({
        op_id: 8,
        subject: "Nightly AU ticket",
        effective_hours: 3,
        origin: "added_retroactively",
      }),
    ]);

    renderBoard([makeSprint({ id: 1, name: "Sprint 1", status: "active", activated_at: "2026-06-01T00:00:00Z" })]);

    const sprintZone = await screen.findByTestId("drop-sprint");
    expect(within(sprintZone).getByText(/Nightly AU ticket/)).toBeInTheDocument();
    // Exactly the "added" badge — no separate "retro"/"retroactive" label anywhere.
    expect(within(sprintZone).getByText("added")).toBeInTheDocument();
    expect(within(sprintZone).queryByText(/retro/i)).not.toBeInTheDocument();
  });

  // ── SPEC_25 §5 / Increment 18 postmortem: verify dimming, don't assume it —
  // a retroactively-added ticket is done-by-construction and must render
  // dimmed via the EXISTING done-matrix logic (origin plays no part in it) ──

  it("dims a retroactively-added item that is done, exactly like any other done item", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue([
      makeSprintItemDetail({
        op_id: 9,
        subject: "Done nightly ticket",
        effective_hours: 3,
        origin: "added_retroactively",
        is_done: true,
        done_bucket: "done",
      }),
    ]);

    renderBoard([makeSprint({ id: 1, name: "Sprint 1", status: "active", activated_at: "2026-06-01T00:00:00Z" })]);

    const sprintZone = await screen.findByTestId("drop-sprint");
    const card = within(sprintZone).getByText(/Done nightly ticket/).closest(".card");
    expect(card).toHaveClass("status-dimmed");
  });

  // ── SPEC_25 §3/§4/§9: "Add ticket by ID" form ──

  it("adds a ticket by ID with no server picker when only one connection exists", async () => {
    const user = userEvent.setup();
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.addSprintItemById = vi.fn().mockResolvedValue(
      makeSprintItemDetail({ op_id: 555, subject: "Nightly ticket", origin: "added_retroactively" }),
    );

    renderBoard([makeSprint({ id: 1, name: "Sprint 1", status: "active" })]);

    await waitFor(() => expect(mockApi.getConnections).toHaveBeenCalled());
    // Single connection — no "Server" picker rendered.
    expect(screen.queryByLabelText("Server")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Add ticket by ID"), "555");
    await user.click(screen.getByRole("button", { name: "Add ticket" }));

    await waitFor(() =>
      expect(mockApi.addSprintItemById).toHaveBeenCalledWith(1, { wp_op_id: 555, connection_id: undefined }),
    );
    expect(await screen.findByText("#555 added to the sprint.")).toBeInTheDocument();
  });

  it("shows a server picker and forwards the chosen connection_id when 2+ connections exist", async () => {
    const user = userEvent.setup();
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getConnections = vi.fn().mockResolvedValue([
      makeConnection({ id: 1, label: "Mock", base_url: "https://mock.example.com" }),
      makeConnection({ id: 2, label: "Acme", base_url: "https://acme.example.com" }),
    ]);
    mockApi.addSprintItemById = vi.fn().mockResolvedValue(
      makeSprintItemDetail({ op_id: 777, subject: "Cross-server nightly ticket", origin: "added_retroactively" }),
    );

    renderBoard([makeSprint({ id: 1, name: "Sprint 1", status: "active" })]);

    const serverSelect = await screen.findByLabelText("Server");
    await user.selectOptions(serverSelect, "2");
    await user.type(screen.getByLabelText("Add ticket by ID"), "777");
    await user.click(screen.getByRole("button", { name: "Add ticket" }));

    await waitFor(() =>
      expect(mockApi.addSprintItemById).toHaveBeenCalledWith(1, { wp_op_id: 777, connection_id: 2 }),
    );
  });

  it("does not show the 'Add ticket by ID' form for a locked sprint", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);

    renderBoard([
      makeSprint({
        id: 1,
        name: "Sprint 1",
        status: "active",
        activated_at: "2026-06-01T00:00:00Z",
        is_locked: true,
        locked_at: "2026-06-14T18:00:00Z",
        lock_reason: "finished",
      }),
    ]);

    await waitFor(() => expect(screen.getAllByText("Finished").length).toBeGreaterThan(0));
    expect(screen.queryByLabelText("Add ticket by ID")).not.toBeInTheDocument();
  });

  it.each([
    ["SPRINT_LOCKED", "This sprint is locked — reactivate it first."],
    ["SPRINT_CLOSED", "This sprint is closed — reactivate it first."],
    ["CONNECTION_DISABLED", "That connection is disabled — enable it or pick another."],
    ["WORK_PACKAGE_NOT_FOUND", "No work package with that ID was found on the selected server."],
    ["ITEM_ALREADY_IN_SPRINT", "This ticket is already in the sprint."],
  ] as const)("shows a specific inline message when add-by-id fails with %s", async (code, message) => {
    const user = userEvent.setup();
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.addSprintItemById = vi.fn().mockRejectedValue(
      new ApiError(409, { error: { code, message: "server-side generic message" } }),
    );

    renderBoard([makeSprint({ id: 1, name: "Sprint 1", status: "active" })]);

    await waitFor(() => expect(mockApi.getConnections).toHaveBeenCalled());
    await user.type(screen.getByLabelText("Add ticket by ID"), "42");
    await user.click(screen.getByRole("button", { name: "Add ticket" }));

    expect(await screen.findByText(message)).toBeInTheDocument();
    // The friendly copy replaces the raw server message — it is never shown too.
    expect(screen.queryByText(/server-side generic message/)).not.toBeInTheDocument();
  });

  // ── SPEC_25 §4: backdated changelog phrasing for a retroactive add ──

  it("phrases a retroactive scope_added changelog entry with '(as of DD/MM/YYYY)', unlike an ordinary addition", async () => {
    const user = userEvent.setup();
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue([
      makeSprintItemDetail({ op_id: 42, subject: "Some ticket", effective_hours: 5 }),
    ]);
    mockApi.getTicketChangelog = vi.fn().mockResolvedValue([
      makeChangelogEntry({
        id: 1,
        kind: "scope_added",
        detail: { kind: "scope_added", hours: 3, backdated_to: "2026-06-04" },
        occurred_at: "2026-06-10T09:00:00Z",
      }),
      makeChangelogEntry({
        id: 2,
        kind: "scope_added",
        detail: { kind: "scope_added", hours: 2 },
        occurred_at: "2026-06-11T09:00:00Z",
      }),
    ]);

    renderBoard([
      makeSprint({ id: 1, name: "Sprint 1", status: "active", activated_at: "2026-06-01T00:00:00Z" }),
    ]);

    await waitFor(() => expect(screen.getByText(/Some ticket/)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "View changelog for #42" }));

    await waitFor(() => expect(mockApi.getTicketChangelog).toHaveBeenCalledWith(1, 42));
    expect(screen.getByText("added to sprint retroactively (as of 04/06/2026) (3h)")).toBeInTheDocument();
    expect(screen.getByText("added to sprint (2h)")).toBeInTheDocument();
  });

  // ── SPEC_05 §6.1: lifecycle controls live with "Sprint details" ──

  it("renders the lifecycle controls inside the 'Sprint details' panel, not 'Sprint board'", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    renderBoard([makeSprint({ id: 1, name: "Sprint 1", status: "planning" })]);

    const activateBtn = await screen.findByRole("button", { name: "Activate" });
    const detailsPanel = screen.getByText("Sprint details").closest("section");
    expect(detailsPanel).not.toBeNull();
    expect(within(detailsPanel as HTMLElement).getByRole("button", { name: "Activate" })).toBe(activateBtn);

    const boardPanel = screen.getByText("Sprint board").closest("section") as HTMLElement;
    expect(within(boardPanel).queryByRole("button", { name: "Activate" })).not.toBeInTheDocument();
  });

  it("renders lifecycle controls promptly, without waiting on the backlog fetch", async () => {
    // A backlog fetch that never resolves during this test — the controls must
    // still show up, because they no longer live behind that gate (SPEC_05 §6.1).
    mockApi.getBacklog = vi.fn().mockReturnValue(new Promise(() => {}));
    renderBoard([makeSprint({ id: 1, name: "Sprint 1", status: "planning" })]);

    expect(await screen.findByRole("button", { name: "Activate" })).toBeInTheDocument();
  });

  // ── SPEC_05 §6.2: lifecycle actions target the selected sprint, not a stale one ──

  it("targets the currently-selected sprint after switching + a data refresh, not a stale one", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getSprintUpdates = vi.fn().mockResolvedValue([]);
    mockApi.updateSprintRun = vi.fn().mockResolvedValue(makeSprintUpdateRun());

    const sprint1 = makeSprint({ id: 1, name: "Sprint One", status: "active", activated_at: "2026-06-01T00:00:00Z" });
    const sprint2 = makeSprint({ id: 2, name: "Sprint Two", status: "active", activated_at: "2026-06-01T00:00:00Z" });

    const { rerender } = render(
      <SprintBoardScreen
        sprints={[sprint1, sprint2]}
        selectedSprintId={1}
        onSelectSprint={() => {}}
        onSprintsChanged={onChanged}
        refreshKey={0}
      />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Update Sprint" })).toBeInTheDocument());

    // Planner selects Sprint Two...
    rerender(
      <SprintBoardScreen
        sprints={[sprint1, sprint2]}
        selectedSprintId={2}
        onSelectSprint={() => {}}
        onSprintsChanged={onChanged}
        refreshKey={0}
      />,
    );
    // ...then an unrelated refresh (e.g. the periodic poll) re-delivers a NEW
    // `sprints` array reference for the SAME sprints, simulating a re-fetch.
    rerender(
      <SprintBoardScreen
        sprints={[{ ...sprint1 }, { ...sprint2 }]}
        selectedSprintId={2}
        onSelectSprint={() => {}}
        onSprintsChanged={onChanged}
        refreshKey={1}
      />,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "Update Sprint" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Update Sprint" }));

    await waitFor(() => expect(mockApi.updateSprintRun).toHaveBeenCalledWith(2));
    expect(mockApi.updateSprintRun).not.toHaveBeenCalledWith(1);
  });

  it("shows the backend's sprintName in a lifecycle-action error instead of a bare internal id", async () => {
    const user = userEvent.setup();
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getSprintUpdates = vi.fn().mockResolvedValue([]);
    const { ApiError } = await import("../api-client");
    mockApi.updateSprintRun = vi.fn().mockRejectedValue(
      new ApiError(409, {
        error: {
          code: "SPRINT_NOT_ACTIVE",
          message: "Sprint 3.5.039 has not been activated",
          details: { sprintName: "Sprint 3.5.039" },
        },
      }),
    );

    renderBoard([makeSprint({ id: 1, name: "Sprint 3.5.039", status: "active", activated_at: "2026-06-01T00:00:00Z" })]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Update Sprint" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Update Sprint" }));

    // "Sprint 3.5.039" also legitimately appears elsewhere (the board column
    // heading) — match the specific error text, not just the sprint name.
    await waitFor(() =>
      expect(screen.getByText(/Sprint 3\.5\.039 has not been activated/)).toBeInTheDocument(),
    );
  });

  // ── SPEC_09 §1: async scoped activation with progress ──

  it("activates a planning sprint asynchronously: shows progress, settles, then refreshes", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    // POST /activate now resolves with the run's INITIAL ("running") state,
    // not its final one — the button interaction isn't "done" until the
    // frontend's own poll sees the SAME run leave "running".
    mockApi.activateSprint = vi.fn().mockResolvedValue(
      makeSprintUpdateRun({ id: 9, kind: "activation", status: "running", wp_count: 0, total_count: 5, finished_at: null }),
    );
    mockApi.getSprintUpdates = vi
      .fn()
      .mockResolvedValueOnce([
        makeSprintUpdateRun({ id: 9, kind: "activation", status: "running", wp_count: 3, total_count: 5, finished_at: null }),
      ])
      .mockResolvedValue([
        makeSprintUpdateRun({ id: 9, kind: "activation", status: "success", wp_count: 5, total_count: 5 }),
      ]);

    render(
      <SprintBoardScreen
        sprints={[makeSprint({ id: 1, name: "Sprint 1", status: "planning" })]}
        selectedSprintId={1}
        onSelectSprint={() => {}}
        onSprintsChanged={onChanged}
        refreshKey={0}
      />,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "Activate" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Activate" }));

    await waitFor(
      () => expect(screen.getByTestId("sprint-update-progress")).toHaveTextContent("Activating 3/5"),
      { timeout: 2000 },
    );
    await waitFor(
      () => expect(screen.queryByTestId("sprint-update-progress")).not.toBeInTheDocument(),
      { timeout: 2000 },
    );
    expect(onChanged).toHaveBeenCalled();
  });

  it("shows a pre-activation blocking-connections message with a Reconnect path (SPEC_09 §1/§4)", async () => {
    const user = userEvent.setup();
    const onGoToSetup = vi.fn();
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    const { ApiError } = await import("../api-client");
    mockApi.activateSprint = vi.fn().mockRejectedValue(
      new ApiError(409, {
        error: {
          code: "ACTIVATION_CONNECTIONS_UNAVAILABLE",
          message: "A required connection is unavailable",
          details: {
            connections: [
              { connection_id: 2, base_url: "https://openproject.acme.example", label: "Acme", reason: "disabled" },
            ],
          },
        },
      }),
    );

    render(
      <SprintBoardScreen
        sprints={[makeSprint({ id: 1, name: "Sprint 1", status: "planning" })]}
        selectedSprintId={1}
        onSelectSprint={() => {}}
        onSprintsChanged={() => {}}
        refreshKey={0}
        onGoToSetup={onGoToSetup}
      />,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "Activate" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Activate" }));

    await waitFor(() => expect(screen.getByTestId("activation-blocked")).toBeInTheDocument());
    expect(screen.getByTestId("activation-blocked")).toHaveTextContent("Acme");
    expect(screen.getByTestId("activation-blocked")).toHaveTextContent("disconnected");

    await user.click(screen.getByRole("button", { name: "Go to Setup to reconnect" }));
    expect(onGoToSetup).toHaveBeenCalled();
  });

  // ── SPEC_09 §2: History button gated on has_history ──

  it("hides the History button for a ticket with no changelog history", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue([
      makeSprintItemDetail({ op_id: 1, subject: "No history yet ticket", effective_hours: 3, has_history: false }),
      makeSprintItemDetail({ op_id: 2, subject: "Has history ticket", effective_hours: 3, has_history: true }),
    ]);

    renderBoard([makeSprint({ id: 1, name: "Sprint 1", status: "active", activated_at: "2026-06-01T00:00:00Z" })]);

    await waitFor(() => expect(screen.getByText(/No history yet ticket/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "View changelog for #1" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View changelog for #2" })).toBeInTheDocument();
  });

  // ── SPEC_09 §3/§4/§8: grey redistribution capacity segment ──

  it("renders a grey redistribution segment at both the sender's and the receiver's bar", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getCapacity = vi.fn().mockResolvedValue(
      capacity([
        // Jan: 30h baseline, 10h done/handed off -> 20 green + 10 grey (bar stays 30h).
        {
          op_user_id: 1,
          name: "Jan",
          available_hours: 40,
          planned_hours: 20,
          baseline_hours: 30,
          redistributed_out_hours: 10,
          has_sprint_work: true,
        },
        // Daniel: received 10h from Jan's baseline, owned nothing at activation.
        {
          op_user_id: 2,
          name: "Daniel",
          available_hours: 20,
          planned_hours: 10,
          baseline_hours: 0,
          redistributed_in_hours: 10,
          has_sprint_work: true,
        },
      ]),
    );

    renderBoard([makeSprint({ id: 1, name: "Sprint 1", status: "active", activated_at: "2026-06-01T00:00:00Z" })]);

    const janBar = await screen.findByLabelText("load for Jan");
    expect((janBar.querySelector(".bar-green") as HTMLElement).style.width).toBe("50%"); // (30-10)/40
    expect((janBar.querySelector(".bar-grey") as HTMLElement).style.width).toBe("25%"); // 10/40

    const danielBar = screen.getByLabelText("load for Daniel");
    expect((danielBar.querySelector(".bar-green") as HTMLElement).style.width).toBe("0%");
    expect((danielBar.querySelector(".bar-grey") as HTMLElement).style.width).toBe("50%"); // 10/20
  });

  // ── SPEC_09 §4: ticket links use the SOURCE server ──

  it("links a sprint card's title to its OWN source server, not the current/default connection", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue([
      makeSprintItemDetail({
        op_id: 42,
        subject: "Acme ticket",
        effective_hours: 3,
        connection_base_url: "https://openproject.acme.example",
      }),
    ]);

    render(
      <SprintBoardScreen
        sprints={[makeSprint({ id: 1, name: "Sprint 1", status: "planning" })]}
        selectedSprintId={1}
        onSelectSprint={() => {}}
        onSprintsChanged={() => {}}
        refreshKey={0}
        baseUrl="https://current.example.com"
      />,
    );

    const titleText = await screen.findByText(/Acme ticket/);
    const anchor = titleText.closest("a");
    expect(anchor).toHaveAttribute("href", "https://openproject.acme.example/work_packages/42");
    expect(anchor).toHaveAttribute("target", "_blank");
  });

  // ── SPEC_09 §5/§6: Sprint board's own backlog panel hides disconnected-source tickets ──

  it("hides disconnected-source tickets entirely from the Sprint board's own backlog panel", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([
      makeBacklogItem({ op_id: 1, subject: "Live ticket", effective_hours: 2, stale: false, in_sprint: false }),
      makeBacklogItem({ op_id: 2, subject: "Disconnected ticket", effective_hours: 2, stale: true, in_sprint: false }),
    ]);

    renderBoard();
    await waitFor(() => expect(screen.getByText(/Live ticket/)).toBeInTheDocument());

    const backlogZone = screen.getByTestId("drop-backlog");
    expect(within(backlogZone).getByText(/Live ticket/)).toBeInTheDocument();
    expect(within(backlogZone).queryByText(/Disconnected ticket/)).not.toBeInTheDocument();
    expect(screen.getByText("Backlog (1)")).toBeInTheDocument();
  });

  // ── SPEC_11 §2: Delete sprint + confirm modal ──────────────────────────────

  it("shows a Delete sprint button that only deletes after confirming Yes in the modal", async () => {
    const user = userEvent.setup();
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.deleteSprint = vi
      .fn()
      .mockResolvedValue({ sprint_id: 1, deleted: true, export_path: "exports/sprint-Sprint-1-20260715120000.json" });
    const onSprintsChanged = vi.fn();

    render(
      <SprintBoardScreen
        sprints={[makeSprint({ id: 1, name: "Sprint 1", status: "planning" })]}
        selectedSprintId={1}
        onSelectSprint={() => {}}
        onSprintsChanged={onSprintsChanged}
        refreshKey={0}
      />,
    );

    const deleteBtn = await screen.findByRole("button", { name: "Delete sprint" });
    await user.click(deleteBtn);
    expect(screen.getByRole("dialog", { name: /Delete sprint/ })).toBeInTheDocument();
    expect(mockApi.deleteSprint).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "No" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mockApi.deleteSprint).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Delete sprint" }));
    // SPEC_12 §6: the confirm step notes a backup will be written first.
    expect(screen.getByText(/JSON backup will be saved to/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Yes, delete" }));

    await waitFor(() => expect(mockApi.deleteSprint).toHaveBeenCalledWith(1));

    // SPEC_12 §6: the export path is shown inside the confirm modal itself,
    // one more beat after a successful delete — and `onSprintsChanged` must
    // NOT have fired yet, since that would refresh the shared sprint list and
    // unmount this very modal (live-verify regression: it used to fire
    // eagerly and the "Backed up to" screen never got a chance to paint).
    await waitFor(() =>
      expect(screen.getByTestId("delete-export-path")).toHaveTextContent(
        "exports/sprint-Sprint-1-20260715120000.json",
      ),
    );
    expect(onSprintsChanged).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    // Only now does the parent get told — the toast (which also carries the
    // export path) appears at this point too.
    await waitFor(() => expect(onSprintsChanged).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText(/"Sprint 1" was deleted\./)).toBeInTheDocument());
    expect(screen.getByText(/exports\/sprint-Sprint-1-20260715120000\.json/)).toBeInTheDocument();
  });

  // Regression: live-verify against a backend build that hadn't wired
  // `export_path` into DeleteSprintResponse yet (SPEC_12 §6, Agent B's side)
  // — the DELETE succeeded (200, sprint gone) but the response carried no
  // export_path, and an earlier version of this component used a truthy
  // check on `exportPath` to decide "did it work", so it silently kept
  // showing "Delete sprint?" instead of the deleted confirmation — hiding a
  // delete that had already happened.
  it("still shows the deleted confirmation when the delete succeeds but export_path is missing", async () => {
    const user = userEvent.setup();
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    // Simulates a not-yet-updated backend: 200 OK, `deleted: true`, but no
    // `export_path` field at all.
    mockApi.deleteSprint = vi.fn().mockResolvedValue({ sprint_id: 1, deleted: true });
    const onSprintsChanged = vi.fn();

    render(
      <SprintBoardScreen
        sprints={[makeSprint({ id: 1, name: "Sprint 1", status: "planning" })]}
        selectedSprintId={1}
        onSelectSprint={() => {}}
        onSprintsChanged={onSprintsChanged}
        refreshKey={0}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Delete sprint" }));
    await user.click(screen.getByRole("button", { name: "Yes, delete" }));

    await waitFor(() => expect(mockApi.deleteSprint).toHaveBeenCalledWith(1));
    // Must switch to the "deleted" screen, NOT silently stay on "Delete sprint?".
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Sprint deleted" })).toBeInTheDocument());
    expect(screen.queryByRole("dialog", { name: "Delete sprint?" })).not.toBeInTheDocument();
    expect(screen.getByTestId("delete-export-path")).toHaveTextContent("export path not reported");

    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(onSprintsChanged).toHaveBeenCalled());
    expect(screen.getByText(/"Sprint 1" was deleted\./)).toBeInTheDocument();
  });

  it("offers Delete sprint even on a locked/finished sprint", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    renderBoard([
      makeSprint({
        id: 1,
        name: "Sprint 1",
        status: "active",
        is_locked: true,
        locked_at: "2026-06-14T18:00:00Z",
        lock_reason: "finished",
      }),
    ]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete sprint" })).toBeInTheDocument());
  });

  // ── SPEC_11 §8b: Reactivate + confirm modal, gated on the start–end window ─

  it("shows Reactivate for a locked sprint whose end date hasn't passed, and reactivates on Yes", async () => {
    const user = userEvent.setup();
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.reactivateSprint = vi.fn().mockResolvedValue(makeSprint({ id: 1, status: "active", is_locked: false }));
    const onSprintsChanged = vi.fn();

    const now = new Date();
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const start = new Date(now);
    start.setDate(start.getDate() - 1);
    const end = new Date(now);
    end.setDate(end.getDate() + 1);

    render(
      <SprintBoardScreen
        sprints={[
          makeSprint({
            id: 1,
            name: "Sprint 1",
            status: "active",
            start_date: iso(start),
            end_date: iso(end),
            is_locked: true,
            locked_at: "2026-06-14T18:00:00Z",
            lock_reason: "end_date",
          }),
        ]}
        selectedSprintId={1}
        onSelectSprint={() => {}}
        onSprintsChanged={onSprintsChanged}
        refreshKey={0}
      />,
    );

    const reactivateBtn = await screen.findByRole("button", { name: "Reactivate" });
    await user.click(reactivateBtn);
    expect(screen.getByRole("dialog", { name: /Reactivate sprint/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Yes, reactivate" }));

    await waitFor(() => expect(mockApi.reactivateSprint).toHaveBeenCalledWith(1, { triggered_by: "manual" }));
    await waitFor(() => expect(onSprintsChanged).toHaveBeenCalled());
  });

  it("does not offer Reactivate once the sprint's end date is in the past", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    renderBoard([
      makeSprint({
        id: 1,
        name: "Sprint 1",
        status: "active",
        start_date: "2026-06-01",
        end_date: "2026-06-14",
        is_locked: true,
        locked_at: "2026-06-14T18:00:00Z",
        lock_reason: "end_date",
      }),
    ]);
    await waitFor(() => expect(screen.getByText(/locked automatically at its end date/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Reactivate" })).not.toBeInTheDocument();
  });

  // ── SPEC_18 §2/§3: dim cards per the role-aware done-matrix (`is_done`) ───

  // SPEC_18 §2/§3: dimming is driven entirely by the server-computed
  // role-aware `is_done` (the SAME done-matrix as Closure) — never a
  // frontend-hardcoded status list. This card component just reflects
  // whatever the server decided.
  it("dims a sprint card whose is_done is true, and never one whose is_done is false", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue([
      makeSprintItemDetail({
        op_id: 1,
        subject: "Still working",
        status_name: "In progress",
        effective_hours: 2,
        done_bucket: "not_done",
        is_done: false,
        holder_role: "developer",
      }),
      makeSprintItemDetail({
        op_id: 2,
        subject: "Wrapped up",
        status_name: "Tested",
        effective_hours: 3,
        done_bucket: "done",
        is_done: true,
        holder_role: "developer",
      }),
    ]);

    renderBoard();

    const workingCard = await screen.findByTestId("wp-card-1");
    const doneCard = await screen.findByTestId("wp-card-2");
    expect(workingCard.className).not.toMatch(/status-dimmed/);
    expect(doneCard.className).toMatch(/status-dimmed/);
  });

  // SPEC_18 §5/§6 #2: a role-dependent status held by a role-unset person
  // stays lit (never guessed) and gets a terse, muted "role?" nudge — never
  // the raw Czech server-internal `ambiguous_reason` string verbatim.
  it("shows a muted 'role?' badge, and never dims, for an ambiguous done_bucket", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue([
      makeSprintItemDetail({
        op_id: 3,
        subject: "Who owns this",
        status_name: "In progress",
        effective_hours: 2,
        done_bucket: "ambiguous",
        is_done: false,
        holder_role: "unset",
        ambiguous_reason: "role není nastavena pro X",
      }),
    ]);

    renderBoard();

    const card = await screen.findByTestId("wp-card-3");
    expect(card.className).not.toMatch(/status-dimmed/);
    const badge = await screen.findByText("role?");
    expect(badge).toBeInTheDocument();
    expect(badge).not.toHaveTextContent("role není nastavena");
    expect(badge.getAttribute("title")).not.toMatch(/role není nastavena/);
  });

  // ── SPEC_12 §2/§4/§9: retrospective planning ────────────────────────────

  describe("retrospective planning", () => {
    it("toggles is_retrospective via PATCH while planning, and shows the Retrospective badge once set", async () => {
      const user = userEvent.setup();
      mockApi.getBacklog = vi.fn().mockResolvedValue([]);
      mockApi.updateSprint = vi.fn().mockResolvedValue({});
      const onSprintsChanged = vi.fn();

      render(
        <SprintBoardScreen
          sprints={[makeSprint({ id: 1, name: "Sprint 1", status: "planning" })]}
          selectedSprintId={1}
          onSelectSprint={() => {}}
          onSprintsChanged={onSprintsChanged}
          refreshKey={0}
        />,
      );

      const checkbox = await screen.findByLabelText("Retrospective planning");
      expect(checkbox).not.toBeDisabled();
      await user.click(checkbox);

      await waitFor(() => expect(mockApi.updateSprint).toHaveBeenCalledWith(1, { is_retrospective: true }));
      await waitFor(() => expect(onSprintsChanged).toHaveBeenCalled());
    });

    it("disables the checkbox once the sprint has left planning, and still shows the badge", async () => {
      mockApi.getBacklog = vi.fn().mockResolvedValue([]);
      mockApi.getRetroPreview = vi.fn().mockResolvedValue(makeRetroPreview({ items: [] }));
      renderBoard([makeSprint({ id: 1, name: "Sprint 1", status: "active", is_retrospective: true })]);

      const checkbox = await screen.findByLabelText("Retrospective planning");
      expect(checkbox).toBeDisabled();
      expect(await screen.findByTestId("retro-badge")).toHaveTextContent("Retrospective");
    });

    // SPEC_13 §5: structural fix, not a per-button patch — once a sprint has
    // left planning, the retro panel must NEVER call the planning-only
    // preview endpoint, not even once, not even on the very update that just
    // flipped it out of planning. Regression for the stale SPRINT_NOT_PLANNING
    // 409 bug (RetroPreviewTable used to stay mounted and auto-refetch on
    // every refreshKey bump regardless of sprint.status). GET /people is NOT
    // planning-gated (SPEC_13 §1a/§3 — a plain informational read, valid in
    // any sprint status), so it's expected to keep being called here.
    it("never calls getRetroPreview for an active/locked retrospective sprint (SPEC_13 §5)", async () => {
      mockApi.getBacklog = vi.fn().mockResolvedValue([]);
      mockApi.getRetroPreview = vi.fn().mockResolvedValue(makeRetroPreview({ items: [] }));
      mockApi.getSprintPeople = vi.fn().mockResolvedValue([]);

      const { rerender } = renderBoard([
        makeSprint({ id: 1, name: "Sprint 1", status: "active", activated_at: "2026-06-01T00:00:00Z", is_retrospective: true }),
      ]);

      // Give any stray effect a chance to fire, then bump refreshKey the same
      // way an Activate/Update Sprint success does.
      await screen.findByTestId("retro-badge");
      rerender(
        <SprintBoardScreen
          sprints={[
            makeSprint({ id: 1, name: "Sprint 1", status: "active", activated_at: "2026-06-01T00:00:00Z", is_retrospective: true }),
          ]}
          selectedSprintId={1}
          onSelectSprint={() => {}}
          onSprintsChanged={() => {}}
          refreshKey={1}
        />,
      );
      await waitFor(() => expect(screen.getByTestId("retro-badge")).toBeInTheDocument());

      expect(mockApi.getRetroPreview).not.toHaveBeenCalled();
    });

    it("seeds a retrospective sprint from an OP version and shows the resulting preview", async () => {
      const user = userEvent.setup();
      mockApi.getBacklog = vi.fn().mockResolvedValue([]);
      mockApi.getProjects = vi.fn().mockResolvedValue([makeProjectWithConnection({ op_id: 100, name: "Demo Project" })]);
      mockApi.getVersions = vi.fn().mockResolvedValue([{ op_id: 10, name: "3.5.039" }]);
      mockApi.seedRetro = vi.fn().mockResolvedValue(
        makeRetroSeedResponse({ candidates: [makeRetroSeedCandidate({ wp_op_id: 11762, subject: "Do the thing" })] }),
      );
      mockApi.getRetroPreview = vi.fn().mockResolvedValue(
        makeRetroPreview({
          items: [
            makeRetroSeedCandidate({
              wp_op_id: 11762,
              subject: "Do the thing",
              estimate_at_start_date: 12,
              assignee_at_start_date: "Cameron Dalby",
              status_at_start_date: "In progress",
            }),
          ],
        }),
      );
      const onSprintsChanged = vi.fn();

      render(
        <SprintBoardScreen
          sprints={[makeSprint({ id: 1, name: "Sprint 1", status: "planning", is_retrospective: true })]}
          selectedSprintId={1}
          onSelectSprint={() => {}}
          onSprintsChanged={onSprintsChanged}
          refreshKey={0}
        />,
      );

      const projectSelect = await screen.findByLabelText("Project (for version list)");
      await user.selectOptions(projectSelect, "1:100");
      await waitFor(() => expect(mockApi.getVersions).toHaveBeenCalledWith(100, 1));

      const versionSelect = await screen.findByLabelText("Version");
      await user.selectOptions(versionSelect, "3.5.039");
      await user.click(screen.getByRole("button", { name: "Seed sprint from version" }));

      await waitFor(() => expect(mockApi.seedRetro).toHaveBeenCalledWith(1, { kind: "version", value: "3.5.039" }));
      await waitFor(() => expect(onSprintsChanged).toHaveBeenCalled());

      const table = await screen.findByTestId("retro-preview-table");
      expect(within(table).getByText(/Do the thing/)).toBeInTheDocument();
      expect(within(table).getByText("Cameron Dalby")).toBeInTheDocument();
    });

    it("seeds from a pasted ticket ID list as the fallback path", async () => {
      const user = userEvent.setup();
      mockApi.getBacklog = vi.fn().mockResolvedValue([]);
      mockApi.getProjects = vi.fn().mockResolvedValue([]);
      mockApi.seedRetro = vi.fn().mockResolvedValue(makeRetroSeedResponse());
      mockApi.getRetroPreview = vi.fn().mockResolvedValue(makeRetroPreview());

      render(
        <SprintBoardScreen
          sprints={[makeSprint({ id: 1, name: "Sprint 1", status: "planning", is_retrospective: true })]}
          selectedSprintId={1}
          onSelectSprint={() => {}}
          onSprintsChanged={() => {}}
          refreshKey={0}
        />,
      );

      const idsField = await screen.findByLabelText(/Or paste ticket IDs/);
      await user.type(idsField, "11762, 11763");
      await user.click(screen.getByRole("button", { name: "Seed sprint from IDs" }));

      await waitFor(() =>
        expect(mockApi.seedRetro).toHaveBeenCalledWith(1, { kind: "ids", value: "11762, 11763" }),
      );
    });

    it("flags a partially-reconstructed candidate in the preview table with its gaps", async () => {
      mockApi.getBacklog = vi.fn().mockResolvedValue([]);
      mockApi.getProjects = vi.fn().mockResolvedValue([]);
      mockApi.getRetroPreview = vi.fn().mockResolvedValue(
        makeRetroPreview({
          items: [
            makeRetroSeedCandidate({
              wp_op_id: 5,
              subject: "Gappy ticket",
              reconstructed: true,
              gaps: ["estimate_at_start_date"],
            }),
          ],
        }),
      );

      render(
        <SprintBoardScreen
          sprints={[makeSprint({ id: 1, name: "Sprint 1", status: "planning", is_retrospective: true })]}
          selectedSprintId={1}
          onSelectSprint={() => {}}
          onSprintsChanged={() => {}}
          refreshKey={0}
        />,
      );

      const table = await screen.findByTestId("retro-preview-table");
      const warning = within(table).getByText(/partially reconstructed/);
      expect(warning).toBeInTheDocument();
      expect(warning).toHaveAttribute("title", expect.stringContaining("estimate_at_start_date"));
    });

    // SPEC_13 §2 point 4: a ticket created AFTER the sprint's start_date reads
    // as a distinct "not baseline, will land as an addition" reason, never as
    // a generic "partially reconstructed" warning (even though the server
    // also marks it reconstructed=true — the created-after-start reason wins).
    it("shows a distinct 'created after start date' reason instead of a generic reconstructed warning", async () => {
      mockApi.getBacklog = vi.fn().mockResolvedValue([]);
      mockApi.getProjects = vi.fn().mockResolvedValue([]);
      mockApi.getRetroPreview = vi.fn().mockResolvedValue(
        makeRetroPreview({
          items: [
            makeRetroSeedCandidate({
              wp_op_id: 11762,
              subject: "New ticket",
              reconstructed: true,
              created_after_start_date: true,
              created_at_op: "2026-07-07T03:41:00Z",
            }),
          ],
        }),
      );

      render(
        <SprintBoardScreen
          sprints={[makeSprint({ id: 1, name: "Sprint 1", status: "planning", is_retrospective: true, start_date: "2026-07-06" })]}
          selectedSprintId={1}
          onSelectSprint={() => {}}
          onSprintsChanged={() => {}}
          refreshKey={0}
        />,
      );

      const table = await screen.findByTestId("retro-preview-table");
      // Increment 16 (SPEC_16 §4): DD/MM/YYYY, not the raw ISO date.
      expect(within(table).getByText(/Created 07\/07\/2026/)).toBeInTheDocument();
      expect(within(table).queryByText(/⚠ partially reconstructed/)).not.toBeInTheDocument();
    });

    // SPEC_13 §1/§1a (REVISED): identity IS the name — a journal name with no
    // linked OP account reads as a completely ordinary name in the preview
    // table, never as a flagged/blocking state. `assignee_resolution` is kept
    // only as a subtle, non-alarming indicator (SPEC_13 §1b).
    it("shows a journal name with no linked OP account as a plain name in the preview, not a blocking flag", async () => {
      mockApi.getBacklog = vi.fn().mockResolvedValue([]);
      mockApi.getProjects = vi.fn().mockResolvedValue([]);
      mockApi.getRetroPreview = vi.fn().mockResolvedValue(
        makeRetroPreview({
          items: [
            makeRetroSeedCandidate({
              wp_op_id: 11585,
              subject: "Do the thing",
              assignee_at_start_date: "Jan Belka",
              assignee_op_id_at_start_date: null,
              assignee_resolution: "unresolved",
            }),
          ],
        }),
      );

      render(
        <SprintBoardScreen
          sprints={[makeSprint({ id: 1, name: "Sprint 1", status: "planning", is_retrospective: true })]}
          selectedSprintId={1}
          onSelectSprint={() => {}}
          onSprintsChanged={() => {}}
          refreshKey={0}
        />,
      );

      const table = await screen.findByTestId("retro-preview-table");
      // The name itself, unflagged — never rendered as "unresolved (Jan Belka)".
      expect(within(table).getByText("Jan Belka")).toBeInTheDocument();
      expect(within(table).queryByText(/unresolved \(/)).not.toBeInTheDocument();
    });

    // SPEC_13 §1a/§3 (REVISED, core regression): a retro-reconstructed name
    // with NO linked OP account renders through the EXACT SAME normal
    // capacity row as a resolved person — no pairing required first. This is
    // the explicit anti-regression for the old "unresolved, blocked" bucket:
    // the availability input must be immediately editable, and real bar
    // segments must render, exactly like a resolved line.
    it("renders a name-only capacity line (op_user_id null) as a normal, immediately-editable line", async () => {
      mockApi.getBacklog = vi.fn().mockResolvedValue([]);
      mockApi.getProjects = vi.fn().mockResolvedValue([]);
      mockApi.getRetroPreview = vi.fn().mockResolvedValue(makeRetroPreview({ items: [] }));
      mockApi.getCapacity = vi.fn().mockResolvedValue(
        capacity([
          {
            op_user_id: null,
            member_id: 101,
            name: "Jan Belka",
            planned_hours: 19,
            baseline_hours: 19,
            available_hours: 0,
            has_sprint_work: true,
          },
          // A resolved line, for a side-by-side functional comparison.
          {
            op_user_id: 7,
            member_id: 55,
            name: "Cameron Dalby",
            planned_hours: 36,
            baseline_hours: 36,
            available_hours: 0,
            has_sprint_work: true,
          },
        ]),
      );

      renderBoard([
        makeSprint({ id: 1, name: "Sprint 1", status: "planning", is_retrospective: true }),
      ]);

      // Not flagged/blocked — just the plain name.
      expect(await screen.findByText("Jan Belka")).toBeInTheDocument();
      expect(screen.queryByText(/unresolved \(/)).not.toBeInTheDocument();

      // Availability input is present and EDITABLE (not disabled/readOnly),
      // matching a resolved line's own input exactly.
      const janInput = screen.getByLabelText("available hours for Jan Belka") as HTMLInputElement;
      const daweInput = screen.getByLabelText("available hours for Cameron Dalby") as HTMLInputElement;
      expect(janInput).not.toBeDisabled();
      expect(daweInput).not.toBeDisabled();
      expect(janInput.readOnly).toBe(daweInput.readOnly);

      // Real, non-zero-width bar segments render for the name-only line too
      // (not collapsed just because op_user_id/available_hours are absent).
      const janBar = screen.getByLabelText("load for Jan Belka");
      const janGreen = janBar.querySelector(".bar-green") as HTMLElement;
      expect(janGreen.style.width).toBe("100%");

      // Setting availability behaves identically to a resolved line: typing
      // updates the controlled input immediately.
      const user = userEvent.setup();
      await user.clear(janInput);
      await user.type(janInput, "20");
      expect(janInput).toHaveValue(20);
    });

    // SPEC_13 §1b: pairing is an OPTIONAL enrichment action offered directly
    // on the capacity line — never a precondition. Uses GET /people to find
    // the connection_id a name belongs to (a CapacityLine itself carries
    // none), POSTs /user-aliases, then refreshes via the same onSprintsChanged
    // path other planning actions already use.
    it("optionally links a name-only capacity line to an OP account via the Link control", async () => {
      const user = userEvent.setup();
      const onSprintsChanged = vi.fn();
      mockApi.getBacklog = vi.fn().mockResolvedValue([
        makeBacklogItem({ op_id: 1, assignee_op_id: 42, assignee_name: "Arend Kuiper" }),
      ]);
      mockApi.getProjects = vi.fn().mockResolvedValue([]);
      mockApi.getRetroPreview = vi.fn().mockResolvedValue(makeRetroPreview({ items: [] }));
      mockApi.getCapacity = vi.fn().mockResolvedValue(
        capacity([
          {
            op_user_id: null,
            member_id: 101,
            name: "Jan Belka",
            planned_hours: 19,
            baseline_hours: 19,
            available_hours: 0,
            has_sprint_work: true,
          },
        ]),
      );
      mockApi.getSprintPeople = vi.fn().mockResolvedValue(
        makeSprintPeopleResponse([{ connection_id: 1, name: "Jan Belka", op_user_id: null, hours: 19, ticket_count: 3 }]),
      );
      mockApi.createUserAlias = vi.fn().mockResolvedValue(
        makeUserAlias({ id: 5, connection_id: 1, journal_name: "Jan Belka", op_user_id: 42 }),
      );

      render(
        <SprintBoardScreen
          sprints={[makeSprint({ id: 1, name: "Sprint 1", status: "planning", is_retrospective: true })]}
          selectedSprintId={1}
          onSelectSprint={() => {}}
          onSprintsChanged={onSprintsChanged}
          refreshKey={0}
        />,
      );

      // The line is already fully usable BEFORE any linking — availability
      // is editable right away.
      const janInput = await screen.findByLabelText("available hours for Jan Belka");
      expect(janInput).not.toBeDisabled();

      const linkButton = screen.getByRole("button", { name: "Link OP account" });
      expect(linkButton).not.toBeDisabled();
      await user.click(linkButton);

      const picker = screen.getByLabelText("Link Jan Belka to");
      await user.selectOptions(picker, "42");

      await waitFor(() =>
        expect(mockApi.createUserAlias).toHaveBeenCalledWith({
          connection_id: 1,
          journal_name: "Jan Belka",
          op_user_id: 42,
        }),
      );
      await waitFor(() => expect(onSprintsChanged).toHaveBeenCalled());
    });

    // SPEC_13 §1a/§3 (REVISED): the "People in this sprint" summary is a
    // neutral, informational convenience view (never a "problems to fix"
    // queue) — shows every person GET /people knows about, with their linked
    // account when known, and is visible regardless of planning/active/locked
    // status (the endpoint itself is not planning-gated).
    it("shows a low-key 'People in this sprint' summary for a retrospective sprint, in any status", async () => {
      mockApi.getBacklog = vi.fn().mockResolvedValue([]);
      mockApi.getRetroPreview = vi.fn().mockResolvedValue(makeRetroPreview({ items: [] }));
      mockApi.getSprintPeople = vi.fn().mockResolvedValue(
        makeSprintPeopleResponse([
          { connection_id: 1, name: "Jan Belka", op_user_id: null, hours: 19, ticket_count: 3 },
          { connection_id: 1, name: "Cameron Dalby", op_user_id: 3, hours: 36, ticket_count: 4 },
        ]),
      );

      renderBoard([
        makeSprint({ id: 1, name: "Sprint 1", status: "active", activated_at: "2026-06-01T00:00:00Z", is_retrospective: true }),
      ]);

      const panel = await screen.findByTestId("sprint-people-panel");
      expect(within(panel).getByText("Jan Belka")).toBeInTheDocument();
      expect(within(panel).getByText(/No linked OP account/)).toBeInTheDocument();
      expect(within(panel).getByText("Cameron Dalby")).toBeInTheDocument();
      expect(within(panel).getByText(/Linked to OP user #3/)).toBeInTheDocument();
      // Never framed as a "problems to fix" list.
      expect(within(panel).queryByText(/unresolved/i)).not.toBeInTheDocument();
    });
  });

  // ── Increment 17 (SPEC_17 §1): developer capacity bar segments (v2) ──
  describe("Increment 17 — developer capacity segments (v2)", () => {
    /** One segment per SPEC_17 §1 row (a–g), each on its own wp_op_id, so
     * each kind's rendering can be asserted independently. Row a doubles as
     * the overshoot example (est 30 / logged 46.5), mirroring SPEC_15's
     * original Zbynek Trnka worked example. */
    const allKindSegments = [
      makeDeveloperTicketSegment({
        wp_op_id: 201,
        subject: "Baseline worked",
        kind: "baseline_worked",
        estimate_hours: 30,
        logged_hours: 46.5,
        show_logged_marker: true,
      }),
      makeDeveloperTicketSegment({ wp_op_id: 208, subject: "Baseline unlogged", kind: "baseline_worked", estimate_hours: 12, logged_hours: 0 }),
      makeDeveloperTicketSegment({ wp_op_id: 203, subject: "Handoff", kind: "handoff", estimate_hours: 5, logged_hours: 0 }),
      makeDeveloperTicketSegment({ wp_op_id: 204, subject: "Removed", kind: "removed", estimate_hours: 4, logged_hours: 0 }),
      makeDeveloperTicketSegment({
        wp_op_id: 205,
        subject: "Acquired",
        kind: "acquired",
        estimate_hours: 19,
        logged_hours: 17.5,
        show_logged_marker: true,
        in_baseline: false,
      }),
      makeDeveloperTicketSegment({ wp_op_id: 206, subject: "Idle", kind: "idle", estimate_hours: 6, logged_hours: 0, in_baseline: false }),
      makeDeveloperTicketSegment({ wp_op_id: 207, subject: "Churned", kind: "churned", estimate_hours: 3, logged_hours: 0, in_baseline: false }),
    ];

    function renderWithSegments(segments = allKindSegments) {
      mockApi.getBacklog = vi.fn().mockResolvedValue([]);
      mockApi.getCapacity = vi.fn().mockResolvedValue(
        capacity([{ op_user_id: 9, name: "Jan Belka", available_hours: 40, planned_hours: 19, has_sprint_work: true }]),
      );
      mockApi.getClosureStats = vi.fn().mockResolvedValue(
        makeClosureStats({ per_developer: [makeDeveloperCapacityBreakdown({ op_user_id: 9, name: "Jan Belka", segments })] }),
      );
      return renderBoard([makeSprint({ id: 1, name: "Sprint 1", status: "active", activated_at: "2026-06-01T00:00:00Z" })]);
    }

    it("renders each of the 6 segment kinds with its own distinct style class", async () => {
      renderWithSegments();
      const bar = await screen.findByTestId("dev-segment-bar-9");

      expect(within(bar).getByTestId("9-seg-201-baseline_worked")).toHaveClass("bar-green");
      // Increment 26 (CAPACITY_BAR_RULES.md §2/§6 invariant #1): a baseline
      // ticket still held but with ZERO logged hours is now `baseline_worked`
      // too — and must render plain green, never hatched.
      expect(within(bar).getByTestId("9-seg-208-baseline_worked")).toHaveClass("bar-green");
      expect(within(bar).getByTestId("9-seg-203-handoff")).toHaveClass("bar-handoff");
      expect(within(bar).getByTestId("9-seg-204-removed")).toHaveClass("bar-blue");
      expect(within(bar).getByTestId("9-seg-205-acquired")).toHaveClass("bar-red");
      expect(within(bar).getByTestId("9-seg-206-idle")).toHaveClass("bar-idle");
      expect(within(bar).getByTestId("9-seg-207-churned")).toHaveClass("bar-blue");
    });

    // Increment 26 (CAPACITY_BAR_RULES.md §2/§6 invariant #1) ABOLISHED the
    // old grey-hatched `baseline_idle` state: a baseline ticket a developer
    // still holds is always `baseline_worked` — plain green — whether or not
    // they've logged time on it. Only TWO hatch treatments remain: handoff
    // (c, blue, replaces Increment 15's plain grey `redistributed`) and idle
    // (f, amber, purely informative). Assert they're visually distinct from
    // each other AND that a zero-logged baseline segment renders plain green
    // with no hatch at all (the direct regression check for invariant #1).
    it("renders handoff and idle as two visually distinct hatch styles, and a zero-logged baseline segment as plain green with no hatch", async () => {
      renderWithSegments();
      const bar = await screen.findByTestId("dev-segment-bar-9");
      const baselineUnlogged = within(bar).getByTestId("9-seg-208-baseline_worked");
      const handoff = within(bar).getByTestId("9-seg-203-handoff");
      const idle = within(bar).getByTestId("9-seg-206-idle");

      // CAPACITY_BAR_RULES.md §6 invariant #1: a zero-logged baseline segment
      // must never get a hatched class — plain green only.
      expect(baselineUnlogged).toHaveClass("bar-green");
      expect(baselineUnlogged).not.toHaveClass("bar-handoff");
      expect(baselineUnlogged).not.toHaveClass("bar-idle");

      expect(handoff).toHaveClass("bar-handoff");
      expect(idle).toHaveClass("bar-idle");
      expect(handoff).not.toHaveClass("bar-idle");
      expect(idle).not.toHaveClass("bar-handoff");
      expect(handoff.className).not.toBe(idle.className);
      expect(baselineUnlogged.className).not.toBe(handoff.className);
      expect(baselineUnlogged.className).not.toBe(idle.className);
    });

    // SPEC_17 §1 row e: mid-sprint acquisition this developer logged on ->
    // red + logged marker, bar not empty. Modelled as one `acquired` segment
    // (19h estimate, 17.5h logged) to keep the assertion focused.
    it("shows the logged marker INSIDE the segment when logged_hours < estimate_hours (no overshoot)", async () => {
      renderWithSegments();
      const bar = await screen.findByTestId("dev-segment-bar-9");
      const acquired = within(bar).getByTestId("9-seg-205-acquired");
      expect(acquired).toHaveClass("bar-red");
      expect(Number(acquired.style.width.replace("%", ""))).toBeGreaterThan(0);

      // Inner marker present (logged 17.5 <= estimate 19), no overshoot span.
      expect(within(bar).getByTestId("9-seg-205-logged-marker")).toBeInTheDocument();
      expect(within(bar).queryByTestId("9-seg-205-overshoot")).not.toBeInTheDocument();
    });

    // SPEC_17 §1 row a: baseline, logged 46.5h against a 30h estimate ->
    // overshoot must be VISIBLE as an extension past the segment, distinct
    // from the pre-existing `.bar-marker` (available-hours reference line).
    it("renders a visible overshoot extension when logged_hours > estimate_hours, distinct from .bar-marker", async () => {
      renderWithSegments();
      const bar = await screen.findByTestId("dev-segment-bar-9");

      const overshoot = within(bar).getByTestId("9-seg-201-overshoot");
      expect(overshoot).toHaveClass("bar-overshoot");
      expect(Number(overshoot.style.width.replace("%", ""))).toBeGreaterThan(0);
      // No inner marker for the overshoot case — the extension IS the marker.
      expect(within(bar).queryByTestId("9-seg-201-logged-marker")).not.toBeInTheDocument();

      // .bar-logged-marker / .bar-overshoot are a DIFFERENT concept from the
      // person's available-hours `.bar-marker` reference line — both can
      // coexist on the same row without colliding.
      expect(bar.querySelector(".bar-overshoot")).not.toBeNull();
      const availableMarker = bar.querySelector(".bar-marker");
      expect(availableMarker).not.toBeNull();
      expect(availableMarker).not.toHaveClass("bar-overshoot");
    });

    // Increment 34 follow-up (the Jan Belka #11166 confusion): a segment whose
    // ticket has NO estimate paints its whole logged time as the trailing
    // span — that is "never estimated", not a genuine estimate overrun, so it
    // must be visually AND verbally distinct from the real overshoot case.
    it("renders a NO-ESTIMATE logged span with its own muted style and 'No estimate' tooltip, distinct from a genuine overshoot", async () => {
      renderWithSegments([
        ...allKindSegments,
        makeDeveloperTicketSegment({
          wp_op_id: 209,
          subject: "Never estimated",
          kind: "acquired",
          estimate_hours: null,
          logged_hours: 14.5,
          show_logged_marker: true,
          in_baseline: false,
        }),
      ]);
      const bar = await screen.findByTestId("dev-segment-bar-9");

      const noEstimate = within(bar).getByTestId("9-seg-209-overshoot");
      expect(noEstimate).toHaveClass("bar-overshoot");
      expect(noEstimate).toHaveClass("bar-overshoot-noestimate");
      expect(noEstimate).toHaveAttribute("title", "No estimate — 14.5h logged");

      // The genuine overshoot (est 30 / logged 46.5) keeps its own wording
      // and never picks up the no-estimate style.
      const genuine = within(bar).getByTestId("9-seg-201-overshoot");
      expect(genuine).not.toHaveClass("bar-overshoot-noestimate");
      expect(genuine).toHaveAttribute(
        "title",
        expect.stringContaining("Overshoot: logged 46.5h vs. estimate 30h"),
      );
    });

    // SPEC_17 §1/§2, updated for Increment 30 (`CAPACITY_BAR_RULES.md` §5):
    // the bar's four trailing numbers — Jan Belka's worked example: nothing
    // RETAINED from activation (0h baseline), +19h net scope acquired and
    // logged, so CURRENT SCOPE (Planned) is now 19h (Baseline 0 + Change
    // +19 — invariant 9's balancing composition), 30h capacity →
    // "0h / 19h / +19h / 30h".
    it("shows the four trailing numbers (Baseline / Planned / ±Change / Capacity) for a developer with segment data", async () => {
      mockApi.getBacklog = vi.fn().mockResolvedValue([]);
      mockApi.getCapacity = vi.fn().mockResolvedValue(
        capacity([{ op_user_id: 9, name: "Jan Belka", available_hours: 30, planned_hours: 19, has_sprint_work: true }]),
      );
      mockApi.getClosureStats = vi.fn().mockResolvedValue(
        makeClosureStats({
          per_developer: [
            makeDeveloperCapacityBreakdown({
              op_user_id: 9,
              name: "Jan Belka",
              baseline_hours: 0,
              planned_hours: 19,
              scope_change_hours: 19,
              segments: [
                makeDeveloperTicketSegment({ wp_op_id: 205, kind: "acquired", estimate_hours: 19, logged_hours: 17.5, show_logged_marker: true, in_baseline: false }),
              ],
            }),
          ],
        }),
      );

      renderBoard([makeSprint({ id: 1, name: "Sprint 1", status: "active", activated_at: "2026-06-01T00:00:00Z" })]);

      const bar = await screen.findByTestId("dev-segment-bar-9");
      const numbers = bar.closest(".capacity-line")!.querySelector('[title*="Planned"]') as HTMLElement;
      expect(numbers).toHaveTextContent("0h / 19h / +19h / 30h");
      expect(numbers).toHaveAttribute(
        "title",
        capacityNumbersTitle({ baseline: "0h", planned: "19h", change: "+19h", capacity: "30h" }),
      );
      expect(numbers.getAttribute("title")).toContain("Baseline: 0h — What they were signed up for at the last Activate");
    });

    // A developer who lost baseline scope with no work done, netting
    // negative Change (SPEC_17 §1 row d) — baseline 26h, 6h removed, so
    // current-scope Planned (Increment 30) is 20h: "26h / 20h / −6h / 40h".
    it("shows a negative (proper minus sign) scope change when net scope was lost", async () => {
      mockApi.getBacklog = vi.fn().mockResolvedValue([]);
      mockApi.getCapacity = vi.fn().mockResolvedValue(
        capacity([{ op_user_id: 9, name: "Zbynek", available_hours: 40, planned_hours: 20, has_sprint_work: true }]),
      );
      mockApi.getClosureStats = vi.fn().mockResolvedValue(
        makeClosureStats({
          per_developer: [
            makeDeveloperCapacityBreakdown({
              op_user_id: 9,
              name: "Zbynek",
              baseline_hours: 26,
              planned_hours: 20,
              scope_change_hours: -6,
              segments: [makeDeveloperTicketSegment({ wp_op_id: 204, kind: "removed", estimate_hours: 6, logged_hours: 0 })],
            }),
          ],
        }),
      );

      renderBoard([makeSprint({ id: 1, name: "Sprint 1", status: "active", activated_at: "2026-06-01T00:00:00Z" })]);

      const bar = await screen.findByTestId("dev-segment-bar-9");
      const numbers = bar.closest(".capacity-line")!.querySelector('[title*="Planned"]') as HTMLElement;
      expect(numbers).toHaveTextContent("26h / 20h / −6h / 40h");
    });

    // SPEC_17 §1/§4 BUG 2 regression, UI layer, updated for Increment 30's
    // extra leading Baseline number: even when a developer carries BOTH a
    // `removed` and a `handoff` segment dragging Change deep negative,
    // neither Baseline nor Planned (the bar's first two numbers) may ever
    // show a minus sign — both render exactly whatever the server sent
    // (which is structurally >= 0), never a client-derived subtraction.
    // Baseline 40h (20 removed + 12 handed off + 8 retained), Planned now
    // the current-scope 8h retained.
    it("never renders a negative Baseline or Planned, even with removed/handoff segments present", async () => {
      mockApi.getBacklog = vi.fn().mockResolvedValue([]);
      mockApi.getCapacity = vi.fn().mockResolvedValue(
        capacity([{ op_user_id: 9, name: "Jan Bílý", available_hours: 40, planned_hours: 8, has_sprint_work: true }]),
      );
      mockApi.getClosureStats = vi.fn().mockResolvedValue(
        makeClosureStats({
          per_developer: [
            makeDeveloperCapacityBreakdown({
              op_user_id: 9,
              name: "Jan Bílý",
              baseline_hours: 40,
              planned_hours: 8,
              scope_change_hours: -20,
              segments: [
                makeDeveloperTicketSegment({ wp_op_id: 204, kind: "removed", estimate_hours: 20, logged_hours: 0 }),
                makeDeveloperTicketSegment({ wp_op_id: 203, kind: "handoff", estimate_hours: 12, logged_hours: 0 }),
              ],
            }),
          ],
        }),
      );

      renderBoard([makeSprint({ id: 1, name: "Sprint 1", status: "active", activated_at: "2026-06-01T00:00:00Z" })]);

      const bar = await screen.findByTestId("dev-segment-bar-9");
      const numbers = bar.closest(".capacity-line")!.querySelector('[title*="Planned"]') as HTMLElement;
      expect(numbers).toHaveTextContent("40h / 8h / −20h / 40h");
      const [baselineText, plannedText] = numbers.textContent!.split("/");
      expect(baselineText).not.toMatch(/[-−]/);
      expect(plannedText).not.toMatch(/[-−]/);
    });

    it("does not render segment bars for a non-developer, even when closure-stats has data for them", async () => {
      mockApi.getBacklog = vi.fn().mockResolvedValue([]);
      mockApi.getCapacity = vi.fn().mockResolvedValue(
        capacity([
          { op_user_id: 11, name: "Arend Tester", available_hours: 0, planned_hours: 5, role: "tester", is_developer: false, has_sprint_work: true },
        ]),
      );
      // Even if a (buggy/unexpected) closure-stats response carried segment
      // data keyed to this person, role-gating on the FRONTEND must still
      // keep them on the plain grey non-dev line, never the segment bar.
      mockApi.getClosureStats = vi.fn().mockResolvedValue(
        makeClosureStats({
          per_developer: [
            makeDeveloperCapacityBreakdown({
              op_user_id: 11,
              name: "Arend Tester",
              segments: [makeDeveloperTicketSegment({ wp_op_id: 301, kind: "baseline_worked" })],
            }),
          ],
        }),
      );

      renderBoard([makeSprint({ id: 1, name: "Sprint 1", status: "active", activated_at: "2026-06-01T00:00:00Z" })]);

      const nonDevRow = await screen.findByTestId("capacity-line-nondev-11");
      expect(within(nonDevRow).queryByTestId("dev-segment-bar-11")).not.toBeInTheDocument();
      const bar = within(nonDevRow).getByLabelText("load for Arend Tester");
      expect(bar.querySelector(".bar-green")).toBeInTheDocument();
    });

    it("does not render a segment bar while closure-stats hasn't loaded/has no data for this developer", async () => {
      mockApi.getBacklog = vi.fn().mockResolvedValue([]);
      mockApi.getCapacity = vi.fn().mockResolvedValue(
        capacity([{ op_user_id: 9, name: "Jan Belka", available_hours: 40, planned_hours: 19, has_sprint_work: true }]),
      );
      // beforeEach's default: getClosureStats resolves with per_developer: [].
      renderBoard([makeSprint({ id: 1, name: "Sprint 1", status: "active", activated_at: "2026-06-01T00:00:00Z" })]);

      const bar = await screen.findByLabelText("load for Jan Belka");
      expect(bar.querySelector(".bar-green")).toBeInTheDocument();
      expect(screen.queryByTestId("dev-segment-bar-9")).not.toBeInTheDocument();
    });
  });

  // ── Increment 30 (`docs/CAPACITY_BAR_RULES.md` §5, invariants 7–9) ──
  describe("Increment 30 — canonical Planned / Baseline", () => {
    // Invariant 8: the header's "Planned (developers)" total must equal the
    // sum of the developer rows rendered beneath it — Alice (12h) + Bob (8h)
    // = 20h — and must NOT include Dan, a non-developer, even though his row
    // is visible too (40h would make the header unreproducible by summing
    // what's on screen).
    it("the header equals the sum of the displayed developer rows, excluding the visible non-developer row", async () => {
      mockApi.getBacklog = vi.fn().mockResolvedValue([]);
      mockApi.getCapacity = vi.fn().mockResolvedValue(
        capacity([
          { op_user_id: 7, name: "Alice", planned_hours: 12, available_hours: 20, role: "developer", is_developer: true, has_sprint_work: true },
          { op_user_id: 8, name: "Bob", planned_hours: 8, available_hours: 15, role: "developer", is_developer: true, has_sprint_work: true },
          { op_user_id: 11, name: "Dan", planned_hours: 40, available_hours: 66, role: "tester", is_developer: false, has_sprint_work: true },
        ]),
      );
      mockApi.getClosureStats = vi.fn().mockResolvedValue(
        makeClosureStats({
          per_developer: [
            makeDeveloperCapacityBreakdown({
              op_user_id: 7,
              name: "Alice",
              baseline_hours: 12,
              planned_hours: 12,
              scope_change_hours: 0,
              segments: [makeDeveloperTicketSegment({ wp_op_id: 401, kind: "baseline_worked", estimate_hours: 12 })],
            }),
            makeDeveloperCapacityBreakdown({
              op_user_id: 8,
              name: "Bob",
              baseline_hours: 8,
              planned_hours: 8,
              scope_change_hours: 0,
              segments: [makeDeveloperTicketSegment({ wp_op_id: 402, kind: "baseline_worked", estimate_hours: 8 })],
            }),
          ],
        }),
      );

      renderBoard([makeSprint({ id: 1, name: "Sprint 1", status: "active", activated_at: "2026-06-01T00:00:00Z" })]);

      const plannedStat = await screen.findByText("Planned (developers)").then((el) => el.closest(".stat") as HTMLElement);
      expect(within(plannedStat).getByText("20h")).toBeInTheDocument();

      const aliceRow = (await screen.findByTestId("dev-segment-bar-7")).closest(".capacity-line")!;
      const bobRow = screen.getByTestId("dev-segment-bar-8").closest(".capacity-line")!;
      const aliceNumbers = within(aliceRow as HTMLElement).getByText(/12h \/ 12h/);
      const bobNumbers = within(bobRow as HTMLElement).getByText(/8h \/ 8h/);
      expect(aliceNumbers).toBeInTheDocument();
      expect(bobNumbers).toBeInTheDocument();

      // Dan is visible (grey, non-developer) but marked as excluded from the total above.
      const nonDevRow = screen.getByTestId("capacity-line-nondev-11");
      expect(within(nonDevRow).getByText("40h / 66h")).toHaveAttribute(
        "title",
        expect.stringContaining("Not counted in the header's"),
      );
    });

    // Invariant 9: Baseline is its own labelled figure, never composed with
    // Planned or with ±Change — Planned (32h, current scope) already
    // contains the +22h gained since activation, so "Planned + Change"
    // (54h) must never appear; "Baseline + Change" (10 + 22 = 32) is the
    // composition that balances, matching Planned by construction here.
    it("shows Baseline and Planned as distinct labelled figures, never composed with ±Change", async () => {
      mockApi.getBacklog = vi.fn().mockResolvedValue([]);
      mockApi.getCapacity = vi.fn().mockResolvedValue(
        capacity([{ op_user_id: 9, name: "Carla", available_hours: 60, planned_hours: 32, has_sprint_work: true }]),
      );
      mockApi.getClosureStats = vi.fn().mockResolvedValue(
        makeClosureStats({
          per_developer: [
            makeDeveloperCapacityBreakdown({
              op_user_id: 9,
              name: "Carla",
              baseline_hours: 10,
              planned_hours: 32,
              scope_change_hours: 22,
              segments: [
                makeDeveloperTicketSegment({ wp_op_id: 501, kind: "baseline_worked", estimate_hours: 10 }),
                makeDeveloperTicketSegment({ wp_op_id: 502, kind: "acquired", estimate_hours: 22, logged_hours: 5, in_baseline: false }),
              ],
            }),
          ],
        }),
      );

      renderBoard([makeSprint({ id: 1, name: "Sprint 1", status: "active", activated_at: "2026-06-01T00:00:00Z" })]);

      const bar = await screen.findByTestId("dev-segment-bar-9");
      const numbers = bar.closest(".capacity-line")!.querySelector('[title*="Planned"]') as HTMLElement;
      expect(numbers).toHaveAttribute(
        "title",
        capacityNumbersTitle({ baseline: "10h", planned: "32h", change: "+22h", capacity: "60h" }),
      );
      expect(numbers).toHaveTextContent("10h / 32h / +22h / 60h");

      // The forbidden composition (Planned 32 + Change 22 = 54) must never
      // appear anywhere on the page.
      expect(document.body.textContent).not.toMatch(/54h/);
    });

    // Invariant 7: Planned = CURRENT SCOPE. A ticket acquired and held after
    // activation (kind "idle" — held, not yet logged) moves Planned even
    // though it contributes NOTHING to ±Change (idle's change sign is 0) —
    // the direct regression check that Planned is no longer "Σ baseline_worked
    // only" (the pre-Increment-30 definition, now `baseline_hours`).
    it("Planned reflects current scope — a held mid-sprint addition moves it even with zero ±Change", async () => {
      mockApi.getBacklog = vi.fn().mockResolvedValue([]);
      mockApi.getCapacity = vi.fn().mockResolvedValue(
        capacity([{ op_user_id: 9, name: "Marek", available_hours: 40, planned_hours: 18, has_sprint_work: true }]),
      );
      mockApi.getClosureStats = vi.fn().mockResolvedValue(
        makeClosureStats({
          per_developer: [
            makeDeveloperCapacityBreakdown({
              op_user_id: 9,
              name: "Marek",
              baseline_hours: 10,
              planned_hours: 18, // 10 retained + 8 idle — current scope, not just baseline
              scope_change_hours: 0, // "idle" doesn't move ±Change (only acquired/removed do)
              segments: [
                makeDeveloperTicketSegment({ wp_op_id: 601, kind: "baseline_worked", estimate_hours: 10 }),
                makeDeveloperTicketSegment({ wp_op_id: 602, kind: "idle", estimate_hours: 8, logged_hours: 0, in_baseline: false }),
              ],
            }),
          ],
        }),
      );

      renderBoard([makeSprint({ id: 1, name: "Sprint 1", status: "active", activated_at: "2026-06-01T00:00:00Z" })]);

      const bar = await screen.findByTestId("dev-segment-bar-9");
      const numbers = bar.closest(".capacity-line")!.querySelector('[title*="Planned"]') as HTMLElement;
      // Planned (18h) has already moved off Baseline (10h) purely because of
      // the held idle addition — NOT because ±Change (0h) reflects it.
      expect(numbers).toHaveTextContent("10h / 18h / 0h / 40h");
    });
  });

  // ── Increment 28 (docs/INCREMENT_28_CONTRACTS.md §2): double counting ──────
  describe("double counting (Increment 28)", () => {
    /** One parent (#11165) with two children (#11810, #11811) — all three
     * ALREADY in the sprint, backend-flagged (the ONE source, §2a). */
    function doubleCountItems() {
      return [
        makeSprintItemDetail({
          op_id: 11165,
          subject: "Parent ticket",
          effective_hours: 8,
          double_count_children: [11810, 11811],
        }),
        makeSprintItemDetail({
          op_id: 11810,
          subject: "Child ticket A",
          effective_hours: 3,
          double_count_parent_of: 11165,
        }),
        makeSprintItemDetail({
          op_id: 11811,
          subject: "Child ticket B",
          effective_hours: 4,
          double_count_parent_of: 11165,
        }),
      ];
    }

    it("badges both sides of the relationship with the shared tooltip", async () => {
      mockApi.getBacklog = vi.fn().mockResolvedValue([]);
      mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue(doubleCountItems());

      renderBoard();

      const tooltip =
        "A parent and its child are both in the sprint — hours may be counted twice. Plan at leaf level.";

      const parentCard = await screen.findByTestId("wp-card-11165");
      const parentBadge = within(parentCard).getByText("Parent of #11810, #11811");
      expect(parentBadge).toHaveAttribute("title", tooltip);

      const childCard = screen.getByTestId("wp-card-11810");
      const childBadge = within(childCard).getByText("Child of #11165");
      expect(childBadge).toHaveAttribute("title", tooltip);
      // A ticket with neither relationship gets no badge at all.
      expect(within(screen.getByTestId("wp-card-11811")).getByText("Child of #11165")).toBeInTheDocument();
    });

    it("renders the concrete warning groups and jumps to/highlights the ticket on click", async () => {
      mockApi.getBacklog = vi.fn().mockResolvedValue([]);
      mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue(doubleCountItems());

      renderBoard();

      const warning = await screen.findByTestId("double-count-warning");
      const group = within(warning).getByTestId("double-count-group-11165");
      expect(group).toHaveTextContent("#11165");
      expect(group).toHaveTextContent("(parent)");
      expect(group).toHaveTextContent("#11810");
      expect(group).toHaveTextContent("#11811");
      // Old count-only message is gone.
      expect(screen.queryByText(/Double counting: \d+ item/)).not.toBeInTheDocument();

      const user = userEvent.setup();
      const jumpLink = within(group).getByRole("button", { name: "Jump to ticket #11810" });
      await user.click(jumpLink);

      const childCard = screen.getByTestId("wp-card-11810");
      expect(childCard).toHaveClass("card-highlight");
      expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    });

    it("offers no fix actions on a locked sprint but still shows badges and the warning", async () => {
      mockApi.getBacklog = vi.fn().mockResolvedValue([]);
      mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue(doubleCountItems());

      renderBoard([
        makeSprint({ id: 1, name: "Sprint 1", status: "closed", is_locked: true, lock_reason: "finished" }),
      ]);

      expect(await screen.findByTestId("double-count-warning")).toBeInTheDocument();
      expect(screen.getByTestId("wp-card-11165")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Remove parent(s) from sprint" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Remove children from sprint" })).not.toBeInTheDocument();
    });

    it("removes flagged parents via the PRIMARY action after naming them in a confirm modal, then refreshes", async () => {
      const user = userEvent.setup();
      mockApi.getBacklog = vi.fn().mockResolvedValue([]);
      mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue(doubleCountItems());
      mockApi.removeDoubleCountParents = vi.fn().mockResolvedValue({});
      const onSprintsChanged = vi.fn();

      render(
        <SprintBoardScreen
          sprints={[makeSprint({ id: 1, name: "Sprint 1", status: "planning" })]}
          selectedSprintId={1}
          onSelectSprint={() => {}}
          onSprintsChanged={onSprintsChanged}
          refreshKey={0}
        />,
      );

      await screen.findByTestId("double-count-warning");
      const closureCallsBefore = mockApi.getClosureStats!.mock.calls.length;

      await user.click(screen.getByRole("button", { name: "Remove parent(s) from sprint" }));
      const modal = screen.getByRole("dialog");
      expect(modal).toHaveTextContent("#11165");
      expect(mockApi.removeDoubleCountParents).not.toHaveBeenCalled();

      await user.click(within(modal).getByRole("button", { name: "Yes, remove" }));

      await waitFor(() => expect(mockApi.removeDoubleCountParents).toHaveBeenCalledWith(1));
      // Same full invalidation as every other membership-changing mutation
      // (task §1's refresh()) — local states reload AND the App-level key bumps.
      await waitFor(() =>
        expect(mockApi.getClosureStats!.mock.calls.length).toBeGreaterThan(closureCallsBefore),
      );
      expect(onSprintsChanged).toHaveBeenCalled();
    });

    it("removes flagged children via the secondary action after confirming", async () => {
      const user = userEvent.setup();
      mockApi.getBacklog = vi.fn().mockResolvedValue([]);
      mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue(doubleCountItems());
      mockApi.removeDoubleCountChildren = vi.fn().mockResolvedValue({});

      renderBoard();
      await screen.findByTestId("double-count-warning");

      await user.click(screen.getByRole("button", { name: "Remove children from sprint" }));
      const modal = screen.getByRole("dialog");
      expect(modal).toHaveTextContent("#11810");
      expect(modal).toHaveTextContent("#11811");

      await user.click(within(modal).getByRole("button", { name: "Yes, remove" }));
      await waitFor(() => expect(mockApi.removeDoubleCountChildren).toHaveBeenCalledWith(1));
    });

    it("shows nothing when the backend flags no double counting", async () => {
      mockApi.getBacklog = vi.fn().mockResolvedValue([]);
      mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue([
        makeSprintItemDetail({ op_id: 1, subject: "Solo ticket", effective_hours: 4 }),
      ]);

      renderBoard();
      await waitFor(() => expect(screen.getByText(/Solo ticket/)).toBeInTheDocument());
      expect(screen.queryByTestId("double-count-warning")).not.toBeInTheDocument();
    });
  });
});

/**
 * Increment 31 (docs/INCREMENT_31_CONTRACTS.md §4 point 3) — the freeze/grace
 * badge next to the sprint status badge: "frozen" once `frozen_at` is set,
 * "grace until <date>" (locked_at + freeze_grace_days, computed client-side)
 * for a closed-but-unfrozen sprint, and no badge at all when the sprint isn't
 * closed, or the config/locked_at needed to compute the date aren't there.
 */
describe("SprintBoardScreen — freeze/grace badge", () => {
  it("shows 'frozen' once frozen_at is set, with the SPRINT_FROZEN explanation as its tooltip", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    renderBoard([
      makeSprint({
        id: 1,
        name: "Sprint 1",
        status: "closed",
        is_locked: true,
        lock_reason: "finished",
        locked_at: "2026-06-14T18:00:00Z",
        frozen_at: "2026-06-18T00:00:00Z",
      }),
    ]);

    const badge = await screen.findByTestId("freeze-badge");
    expect(badge).toHaveTextContent("frozen");
    expect(badge).toHaveAttribute(
      "title",
      "Numbers are frozen; the sprint no longer updates from OpenProject. Reactivate to unfreeze.",
    );
  });

  it("shows 'grace until <date>' for a closed, unfrozen sprint, computed from locked_at + freeze_grace_days", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getConfig = vi.fn().mockResolvedValue(makeAppConfig({ freeze_grace_days: 3 }));
    renderBoard([
      makeSprint({
        id: 1,
        name: "Sprint 1",
        status: "closed",
        is_locked: true,
        lock_reason: "finished",
        locked_at: "2026-06-14T18:00:00Z",
        frozen_at: null,
      }),
    ]);

    // locked_at 2026-06-14 + 3 days = 2026-06-17, British DD/MM/YYYY.
    const badge = await screen.findByTestId("freeze-badge");
    expect(badge).toHaveTextContent("grace until 17/06/2026");
  });

  it("shows no badge for a planning/active sprint (never closed, so never frozen or in grace)", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    renderBoard([makeSprint({ id: 1, name: "Sprint 1", status: "active", frozen_at: null })]);

    await waitFor(() => expect(screen.getByTestId("sprint-status")).toBeInTheDocument());
    expect(screen.queryByTestId("freeze-badge")).not.toBeInTheDocument();
  });

  it("omits the badge rather than guessing when locked_at is missing", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    renderBoard([
      makeSprint({ id: 1, name: "Sprint 1", status: "closed", is_locked: true, locked_at: null, frozen_at: null }),
    ]);

    await waitFor(() => expect(screen.getByTestId("sprint-status")).toBeInTheDocument());
    expect(screen.queryByTestId("freeze-badge")).not.toBeInTheDocument();
  });

  it("omits the badge rather than guessing while config hasn't loaded yet", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    // Never resolves — config stays "loading" for the life of this test.
    mockApi.getConfig = vi.fn().mockReturnValue(new Promise(() => {}));
    renderBoard([
      makeSprint({
        id: 1,
        name: "Sprint 1",
        status: "closed",
        is_locked: true,
        locked_at: "2026-06-14T18:00:00Z",
        frozen_at: null,
      }),
    ]);

    await waitFor(() => expect(screen.getByTestId("sprint-status")).toBeInTheDocument());
    expect(screen.queryByTestId("freeze-badge")).not.toBeInTheDocument();
  });
});

/**
 * Increment 32 (docs/INCREMENT_32_CONTRACTS.md §4/§5) — the Capacity panel's
 * "Outside the sprint" section: developers' logged time on tickets that
 * never made it into this sprint, for EVERY developer (not just those with a
 * capacity line above). Collapsed by default. Two distinct empty states —
 * see the doc comment on `OffSprintTimeSection` in SprintBoardScreen.tsx for
 * how the contract's ambiguous wording ("nothing renders... and the section
 * shows a one-line empty state") was resolved: "never fetched" (fetched_at
 * null) gets the one-line note, a genuine "fetched and found nothing" stays
 * fully silent.
 */
describe("SprintBoardScreen — Outside the sprint (off-sprint time)", () => {
  it("shows a one-line empty note when the sprint has never fetched an off-sprint report", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getOffSprintTime = vi.fn().mockResolvedValue(
      makeOffSprintTimeResponse({ fetched_at: null, per_person: [] }),
    );
    renderBoard();

    expect(await screen.findByTestId("off-sprint-time-empty")).toHaveTextContent(
      "No off-sprint work recorded yet — it refreshes with each sprint update.",
    );
    expect(screen.queryByTestId("off-sprint-time-section")).not.toBeInTheDocument();
  });

  it("renders nothing when a real fetch found genuinely no off-sprint work", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getOffSprintTime = vi.fn().mockResolvedValue(
      makeOffSprintTimeResponse({ fetched_at: "2026-06-10T12:00:00Z", per_person: [] }),
    );
    renderBoard();

    await waitFor(() => expect(screen.getByTestId("sprint-status")).toBeInTheDocument());
    expect(screen.queryByTestId("off-sprint-time-section")).not.toBeInTheDocument();
    expect(screen.queryByTestId("off-sprint-time-empty")).not.toBeInTheDocument();
  });

  it("shows the collapsed header with total hours, window dates, and an 'as of' note", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getOffSprintTime = vi.fn().mockResolvedValue(
      makeOffSprintTimeResponse({
        window: { from: "2026-06-01", to: "2026-06-14" },
        fetched_at: "2026-06-10T12:00:00Z",
        total_hours: 7.5,
        per_person: [makeOffSprintTimePerson()],
      }),
    );
    renderBoard();

    const toggle = await screen.findByTestId("off-sprint-time-toggle");
    expect(toggle).toHaveTextContent("Outside the sprint — 7.5h");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText(/01\/06\/2026–14\/06\/2026/)).toBeInTheDocument();
    expect(screen.getByText(/as of/)).toBeInTheDocument();
    // Collapsed by default: no person rows rendered yet.
    expect(screen.queryByTestId("off-sprint-time-people")).not.toBeInTheDocument();
  });

  it("expands to show per-person rows, and a person row expands to its ticket list", async () => {
    const user = userEvent.setup();
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getOffSprintTime = vi.fn().mockResolvedValue(
      makeOffSprintTimeResponse({
        total_hours: 4,
        per_person: [
          makeOffSprintTimePerson({
            op_user_id: 9,
            name: "Carol",
            total_hours: 4,
            tickets: [{ wp_op_id: 555, subject: "Unplanned hotfix", hours: 4, connection_id: 1 }],
          }),
        ],
      }),
    );
    renderBoard();

    await user.click(await screen.findByTestId("off-sprint-time-toggle"));
    const personRow = await screen.findByTestId("off-sprint-time-person-9");
    expect(personRow).toHaveTextContent("Carol — 4h");
    expect(screen.queryByTestId("off-sprint-time-tickets-9")).not.toBeInTheDocument();

    await user.click(personRow);
    const tickets = await screen.findByTestId("off-sprint-time-tickets-9");
    expect(within(tickets).getByText("#555 Unplanned hotfix — 4h")).toBeInTheDocument();
  });

  it("shows a ticket id alone (no jump link) when subject is null — these tickets are typically not local", async () => {
    const user = userEvent.setup();
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getOffSprintTime = vi.fn().mockResolvedValue(
      makeOffSprintTimeResponse({
        total_hours: 2,
        per_person: [
          makeOffSprintTimePerson({
            op_user_id: 9,
            name: "Carol",
            total_hours: 2,
            tickets: [{ wp_op_id: 777, subject: null, hours: 2, connection_id: null }],
          }),
        ],
      }),
    );
    renderBoard();

    await user.click(await screen.findByTestId("off-sprint-time-toggle"));
    await user.click(await screen.findByTestId("off-sprint-time-person-9"));
    const tickets = await screen.findByTestId("off-sprint-time-tickets-9");
    expect(within(tickets).getByText("#777 — 2h")).toBeInTheDocument();
    expect(within(tickets).queryByRole("link")).not.toBeInTheDocument();
  });

  it("shows a person who has no capacity line above — the roster here is EVERY developer, not just those with sprint work", async () => {
    const user = userEvent.setup();
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    // Capacity has only Alice (op_user_id 7); off-sprint-time reports Dave
    // (op_user_id 42), who has no capacity line at all.
    mockApi.getCapacity = vi.fn().mockResolvedValue(
      capacity([{ op_user_id: 7, name: "Alice", planned_hours: 5 }]),
    );
    mockApi.getOffSprintTime = vi.fn().mockResolvedValue(
      makeOffSprintTimeResponse({
        total_hours: 3,
        per_person: [makeOffSprintTimePerson({ op_user_id: 42, name: "Dave", total_hours: 3, tickets: [] })],
      }),
    );
    renderBoard();

    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    expect(screen.queryByText("Dave")).not.toBeInTheDocument(); // collapsed

    await user.click(await screen.findByTestId("off-sprint-time-toggle"));
    expect(await screen.findByTestId("off-sprint-time-person-42")).toHaveTextContent("Dave — 3h");
  });
});

// Increment 33 (docs/INCREMENT_33_CONTRACTS.md §5) — the sprint board's own
// "Filter sprint tickets by assignee" select. User decisions 2a/2b: it
// narrows ONLY the sprint-member ticket cards; the backlog-candidate column,
// capacity lines, and every header total/count stay complete regardless.
describe("person filter on the sprint board (Increment 33 §5)", () => {
  it("derives options from the sprint roster: distinct, name asc, with Unassigned appended last", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue([
      makeSprintItemDetail({ op_id: 1, subject: "Bob ticket 1", assignee_op_id: 9, assignee_name: "Bob" }),
      // Same assignee on a second ticket — must not produce a duplicate option.
      makeSprintItemDetail({ op_id: 2, subject: "Bob ticket 2", assignee_op_id: 9, assignee_name: "Bob" }),
      makeSprintItemDetail({ op_id: 3, subject: "Alice ticket", assignee_op_id: 7, assignee_name: "Alice" }),
      makeSprintItemDetail({ op_id: 4, subject: "Nobody's ticket", assignee_op_id: null, assignee_name: null }),
    ]);

    renderBoard();
    const select = (await screen.findByLabelText("Filter sprint tickets by assignee")) as HTMLSelectElement;
    const optionLabels = within(select)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(optionLabels).toEqual(["All people", "Alice", "Bob", "Unassigned"]);
  });

  it("omits the 'Unassigned' option when every sprint member has an assignee", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue([
      makeSprintItemDetail({ op_id: 1, subject: "Bob ticket", assignee_op_id: 9, assignee_name: "Bob" }),
    ]);

    renderBoard();
    const select = (await screen.findByLabelText("Filter sprint tickets by assignee")) as HTMLSelectElement;
    const optionLabels = within(select)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(optionLabels).toEqual(["All people", "Bob"]);
  });

  it("narrows only the sprint-member cards — backlog candidates and the header count stay untouched", async () => {
    const user = userEvent.setup();
    mockApi.getBacklog = vi.fn().mockResolvedValue([
      makeBacklogItem({
        op_id: 10,
        subject: "Backlog candidate for Bob",
        assignee_op_id: 9,
        assignee_name: "Bob",
        effective_hours: 3,
        in_sprint: false,
      }),
    ]);
    mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue([
      makeSprintItemDetail({ op_id: 1, subject: "Alice sprint ticket", assignee_op_id: 7, assignee_name: "Alice" }),
      makeSprintItemDetail({ op_id: 2, subject: "Bob sprint ticket", assignee_op_id: 9, assignee_name: "Bob" }),
    ]);

    renderBoard();
    await waitFor(() => expect(screen.getByText(/Alice sprint ticket/)).toBeInTheDocument());

    const sprintZone = screen.getByTestId("drop-sprint");
    const backlogZone = screen.getByTestId("drop-backlog");
    expect(within(sprintZone).getByText(/Bob sprint ticket/)).toBeInTheDocument();
    // The header count reflects the full roster before any filtering.
    expect(screen.getByText("Sprint 1 (2)")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Filter sprint tickets by assignee"), "Alice");

    await waitFor(() =>
      expect(within(sprintZone).queryByText(/Bob sprint ticket/)).not.toBeInTheDocument(),
    );
    expect(within(sprintZone).getByText(/Alice sprint ticket/)).toBeInTheDocument();
    // Backlog candidate column is entirely unaffected by the sprint-member filter (2a).
    expect(within(backlogZone).getByText(/Backlog candidate for Bob/)).toBeInTheDocument();
    // The header count STAYS at the full roster size, never the filtered count (2b).
    expect(screen.getByText("Sprint 1 (2)")).toBeInTheDocument();
  });

  it("'Unassigned' matches sprint-member items with no assignee", async () => {
    const user = userEvent.setup();
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue([
      makeSprintItemDetail({ op_id: 1, subject: "Alice sprint ticket", assignee_op_id: 7, assignee_name: "Alice" }),
      makeSprintItemDetail({ op_id: 2, subject: "Nobody's ticket", assignee_op_id: null, assignee_name: null }),
    ]);

    renderBoard();
    const sprintZone = await screen.findByTestId("drop-sprint");
    await waitFor(() => expect(within(sprintZone).getByText(/Nobody's ticket/)).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText("Filter sprint tickets by assignee"), "Unassigned");

    await waitFor(() =>
      expect(within(sprintZone).queryByText(/Alice sprint ticket/)).not.toBeInTheDocument(),
    );
    expect(within(sprintZone).getByText(/Nobody's ticket/)).toBeInTheDocument();
  });

  it("keeps capacity lines complete while the person filter narrows the sprint list", async () => {
    const user = userEvent.setup();
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue([
      makeSprintItemDetail({ op_id: 1, subject: "Alice sprint ticket", assignee_op_id: 7, assignee_name: "Alice" }),
      makeSprintItemDetail({ op_id: 2, subject: "Bob sprint ticket", assignee_op_id: 9, assignee_name: "Bob" }),
    ]);
    mockApi.getCapacity = vi.fn().mockResolvedValue(
      capacity([
        { op_user_id: 7, name: "Alice", planned_hours: 4, available_hours: 8 },
        { op_user_id: 9, name: "Bob", planned_hours: 4, available_hours: 8 },
      ]),
    );

    renderBoard();
    await waitFor(() => expect(screen.getByLabelText("available hours for Alice")).toBeInTheDocument());
    expect(screen.getByLabelText("available hours for Bob")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Filter sprint tickets by assignee"), "Alice");

    await waitFor(() =>
      expect(within(screen.getByTestId("drop-sprint")).queryByText(/Bob sprint ticket/)).not.toBeInTheDocument(),
    );
    // Both capacity lines still render — filtering the ticket list never
    // touches the capacity panel (2b).
    expect(screen.getByLabelText("available hours for Alice")).toBeInTheDocument();
    expect(screen.getByLabelText("available hours for Bob")).toBeInTheDocument();
  });

  it("resets the person filter when the selected sprint changes", async () => {
    const user = userEvent.setup();
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getSprintItemsDetailed = vi.fn().mockImplementation((sprintId: number) =>
      Promise.resolve(
        sprintId === 1
          ? [
              makeSprintItemDetail({ op_id: 1, subject: "Alice sprint ticket", assignee_op_id: 7, assignee_name: "Alice" }),
              makeSprintItemDetail({ op_id: 2, subject: "Bob sprint ticket", assignee_op_id: 9, assignee_name: "Bob" }),
            ]
          : [
              makeSprintItemDetail({ op_id: 3, subject: "Carol sprint 2 ticket", assignee_op_id: 11, assignee_name: "Carol" }),
            ],
      ),
    );

    const sprint1 = makeSprint({ id: 1, name: "Sprint 1", status: "planning" });
    const sprint2 = makeSprint({ id: 2, name: "Sprint 2", status: "planning" });
    const { rerender } = render(
      <SprintBoardScreen
        sprints={[sprint1, sprint2]}
        selectedSprintId={1}
        onSelectSprint={() => {}}
        onSprintsChanged={() => {}}
        refreshKey={0}
      />,
    );

    await waitFor(() => expect(screen.getByText(/Bob sprint ticket/)).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText("Filter sprint tickets by assignee"), "Alice");
    await waitFor(() => expect(screen.queryByText(/Bob sprint ticket/)).not.toBeInTheDocument());

    // Switch to sprint 2 on the SAME mounted component (matching how App.tsx
    // re-renders SprintBoardScreen with a new selectedSprintId, no remount —
    // same pattern as the 'Add person' reset test above, SPEC_10 §c).
    rerender(
      <SprintBoardScreen
        sprints={[sprint1, sprint2]}
        selectedSprintId={2}
        onSelectSprint={() => {}}
        onSprintsChanged={() => {}}
        refreshKey={0}
      />,
    );

    await waitFor(() => expect(mockApi.getSprintItemsDetailed).toHaveBeenCalledWith(2));
    await waitFor(() => expect(screen.getByText(/Carol sprint 2 ticket/)).toBeInTheDocument());
    expect((screen.getByLabelText("Filter sprint tickets by assignee") as HTMLSelectElement).value).toBe("");
  });
});

// Increment 34 (docs/INCREMENT_34_CONTRACTS.md §3/§5) — the multi-sprint
// badge on a sprint-member card, and the "Carry over" button + modal offered
// once the current sprint is closed/locked for a not-done ticket.
describe("Increment 34 — multi-sprint badge + carry-over", () => {
  it("shows the multi-sprint badge with sequence/total for a sprint-member ticket", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue([
      makeSprintItemDetail({ op_id: 1, subject: "Long runner", multi_sprint: { sequence: 2, total: 3 } }),
    ]);

    renderBoard();
    await waitFor(() => expect(screen.getByText(/Long runner/)).toBeInTheDocument());

    const badge = screen.getByText("sprint 2/3");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute("title", "This ticket spans 3 sprints — this is sprint 2.");
  });

  it("shows no multi-sprint badge for a single-sprint ticket (multi_sprint null, the default)", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue([
      makeSprintItemDetail({ op_id: 1, subject: "Ordinary ticket" }),
    ]);

    renderBoard();
    await waitFor(() => expect(screen.getByText(/Ordinary ticket/)).toBeInTheDocument());

    expect(screen.queryByText(/^sprint \d+\/\d+$/)).not.toBeInTheDocument();
  });

  it("offers Carry over for a not-done item once the sprint is closed/locked", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue([
      makeSprintItemDetail({ op_id: 1, subject: "Unfinished", is_done: false }),
    ]);

    renderBoard([
      makeSprint({
        id: 1,
        name: "Sprint 1",
        status: "active",
        activated_at: "2026-06-01T00:00:00Z",
        is_locked: true,
        locked_at: "2026-06-14T18:00:00Z",
        lock_reason: "finished",
      }),
    ]);

    await waitFor(() => expect(screen.getByText(/Unfinished/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Carry over" })).toBeInTheDocument();
  });

  it("hides Carry over for a done item, even on a locked sprint", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue([
      makeSprintItemDetail({ op_id: 1, subject: "Finished ticket", is_done: true }),
    ]);

    renderBoard([
      makeSprint({
        id: 1,
        name: "Sprint 1",
        status: "active",
        activated_at: "2026-06-01T00:00:00Z",
        is_locked: true,
        locked_at: "2026-06-14T18:00:00Z",
        lock_reason: "finished",
      }),
    ]);

    await waitFor(() => expect(screen.getByText(/Finished ticket/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Carry over" })).not.toBeInTheDocument();
  });

  it("hides Carry over on an open (not closed/locked) sprint", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue([
      makeSprintItemDetail({ op_id: 1, subject: "Still planning", is_done: false }),
    ]);

    renderBoard([makeSprint({ id: 1, name: "Sprint 1", status: "planning" })]);

    await waitFor(() => expect(screen.getByText(/Still planning/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Carry over" })).not.toBeInTheDocument();
  });

  it("filters the target-sprint select to eligible sprints only, carries via the API, and refreshes", async () => {
    const user = userEvent.setup();
    const onSprintsChanged = vi.fn();
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue([
      makeSprintItemDetail({ op_id: 42, subject: "Carry me", is_done: false }),
    ]);
    mockApi.carrySprintItem = vi.fn().mockResolvedValue({ carried: true, target_sprint_id: 3, wp_op_id: 42 });

    const source = makeSprint({
      id: 1,
      name: "Source sprint",
      status: "active",
      is_locked: true,
      locked_at: "2026-06-14T18:00:00Z",
      lock_reason: "finished",
    });
    const eligiblePlanning = makeSprint({ id: 2, name: "Next sprint (planning)", status: "planning" });
    const eligibleActive = makeSprint({ id: 3, name: "Current sprint (active)", status: "active" });
    const otherLocked = makeSprint({ id: 4, name: "Another closed sprint", status: "active", is_locked: true });
    const frozen = makeSprint({ id: 5, name: "Frozen sprint", status: "active", frozen_at: "2026-06-20T00:00:00Z" });

    render(
      <SprintBoardScreen
        sprints={[source, eligiblePlanning, eligibleActive, otherLocked, frozen]}
        selectedSprintId={1}
        onSelectSprint={() => {}}
        onSprintsChanged={onSprintsChanged}
        refreshKey={0}
      />,
    );

    await waitFor(() => expect(screen.getByText(/Carry me/)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Carry over" }));

    const select = await screen.findByLabelText("Target sprint");
    const options = within(select)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).toEqual(["Select a sprint…", "Next sprint (planning)", "Current sprint (active)"]);
    expect(options).not.toContain("Source sprint");
    expect(options).not.toContain("Another closed sprint");
    expect(options).not.toContain("Frozen sprint");

    await user.selectOptions(select, "3");
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Carry over" }));

    await waitFor(() =>
      expect(mockApi.carrySprintItem).toHaveBeenCalledWith(1, 42, { target_sprint_id: 3 }),
    );
    await waitFor(() => expect(onSprintsChanged).toHaveBeenCalled());
    expect(await screen.findByText(/Carried to "Current sprint \(active\)"/)).toBeInTheDocument();
  });
});

/**
 * Increment 36 (docs/INCREMENT_36_CONTRACTS.md §3): "Export status PDF" — must render for
 * EVERY sprint state (the whole point is "generate at any moment", never status-gated), and
 * must NOT be edited into any of the existing pre-Increment-36 tests above.
 */
describe("SprintBoardScreen — Export status PDF", () => {
  it("is present for a planning sprint", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    renderBoard([makeSprint({ id: 1, name: "Sprint 1", status: "planning" })]);

    expect(await screen.findByTestId("export-status-pdf")).toHaveTextContent("Export status PDF");
  });

  it("is present for an active sprint", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    renderBoard([makeSprint({ id: 1, name: "Sprint 1", status: "active", activated_at: "2026-06-01T00:00:00Z" })]);

    expect(await screen.findByTestId("export-status-pdf")).toHaveTextContent("Export status PDF");
  });

  it("is present for a locked/finished (and frozen) sprint", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    renderBoard([
      makeSprint({
        id: 1,
        name: "Sprint 1",
        status: "closed",
        is_locked: true,
        lock_reason: "finished",
        locked_at: "2026-06-14T18:00:00Z",
        frozen_at: "2026-06-18T00:00:00Z",
      }),
    ]);

    expect(await screen.findByTestId("export-status-pdf")).toHaveTextContent("Export status PDF");
  });

  it("calls the download helper with the sprint id on click", async () => {
    const user = userEvent.setup();
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.downloadSprintStatusPdf = vi.fn().mockResolvedValue(undefined);
    renderBoard([makeSprint({ id: 1, name: "Sprint 1", status: "planning" })]);

    await user.click(await screen.findByTestId("export-status-pdf"));

    await waitFor(() => expect(mockApi.downloadSprintStatusPdf).toHaveBeenCalledWith(1));
  });

  it("shows a busy label and disables the button while the download is in flight", async () => {
    const user = userEvent.setup();
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    let resolveDownload: (() => void) | undefined;
    mockApi.downloadSprintStatusPdf = vi.fn().mockReturnValue(
      new Promise<void>((resolve) => {
        resolveDownload = resolve;
      }),
    );
    renderBoard([makeSprint({ id: 1, name: "Sprint 1", status: "active", activated_at: "2026-06-01T00:00:00Z" })]);

    const button = await screen.findByTestId("export-status-pdf");
    await user.click(button);

    expect(await screen.findByTestId("export-status-pdf")).toHaveTextContent("Exporting…");
    expect(screen.getByTestId("export-status-pdf")).toBeDisabled();

    resolveDownload?.();
    await waitFor(() => expect(screen.getByTestId("export-status-pdf")).not.toBeDisabled());
    expect(screen.getByTestId("export-status-pdf")).toHaveTextContent("Export status PDF");
  });

  it("surfaces a failed download as an error next to the button", async () => {
    const user = userEvent.setup();
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.downloadSprintStatusPdf = vi.fn().mockRejectedValue(new Error("Sprint not found"));
    renderBoard([makeSprint({ id: 1, name: "Sprint 1", status: "planning" })]);

    await user.click(await screen.findByTestId("export-status-pdf"));

    expect(await screen.findByTestId("export-status-pdf-error")).toHaveTextContent("Sprint not found");
    expect(screen.getByTestId("export-status-pdf")).not.toBeDisabled();
  });
});

// Increment 40 (S1): the neutral project badge on a board card — identifier
// (short), tooltip = name; identifier null → name; both null → no badge.
describe("SprintBoardScreen — Increment 40 project badge", () => {
  it("renders the project identifier badge (tooltip = name) before the status badge", async () => {
    mockApi.getBacklog = vi.fn().mockResolvedValue([]);
    mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue([
      makeSprintItemDetail({ op_id: 7, subject: "Northwind fix", project_name: "Northwind Payments", project_identifier: "northwind", status_name: "New" }),
      makeSprintItemDetail({ op_id: 8, subject: "Name-only fix", project_name: "Harbor Ops", project_identifier: null }),
      makeSprintItemDetail({ op_id: 9, subject: "Projectless fix", project_op_id: 0, project_name: null, project_identifier: null }),
    ]);

    renderBoard([makeSprint({ id: 1, name: "Sprint 1", status: "active", activated_at: "2026-06-01T00:00:00Z" })]);

    const sprintZone = await screen.findByTestId("drop-sprint");
    const nwBadge = within(sprintZone).getByText("northwind");
    expect(nwBadge).toHaveClass("badge", "project");
    expect(nwBadge).toHaveAttribute("title", "Northwind Payments");
    // Placed BEFORE the status badge in card-meta.
    const meta = nwBadge.closest(".card-meta")!;
    const badges = [...meta.querySelectorAll(".badge")];
    expect(badges[0]).toBe(nwBadge);
    expect(badges[1]).toHaveTextContent("New");

    // Identifier null → name.
    expect(within(sprintZone).getByText("Harbor Ops")).toHaveClass("project");

    // Both null → nothing rendered for that card.
    const projectless = within(sprintZone).getByTestId("wp-card-9");
    expect(projectless.querySelector(".card-meta")).not.toBeNull();
    expect(projectless.querySelector(".badge.project")).toBeNull();
  });
});
