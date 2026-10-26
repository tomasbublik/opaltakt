import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  makeClosureOffSprint,
  makeClosureOffSprintPerson,
  makeClosureReport,
  makeClosureStats,
  makeScopeOrigin,
  makeSprint,
  makeTicketEstimateLine,
} from "../test/fixtures";

const { mockApi } = vi.hoisted(() => ({ mockApi: {} as Record<string, ReturnType<typeof vi.fn>> }));
vi.mock("../api-client", async (orig) => {
  const actual = await orig<typeof import("../api-client")>();
  return { ...actual, api: mockApi };
});

import { ClosureScreen } from "./ClosureScreen";

beforeEach(() => {
  for (const k of Object.keys(mockApi)) delete mockApi[k];
  // Increment 14 (SPEC_14 §2/§3): the new role-aware statistics panel fetches
  // this unconditionally whenever a sprint is selected — every test needs a
  // default so it doesn't crash on an unmocked call.
  mockApi.getClosureStats = vi.fn().mockResolvedValue(makeClosureStats());
});

const sprints = [makeSprint({ id: 1, status: "active" })];

function renderClosure() {
  return render(
    <ClosureScreen
      sprints={sprints}
      selectedSprintId={1}
      onSelectSprint={() => {}}
      onSprintsChanged={() => {}}
    />,
  );
}

describe("ClosureScreen", () => {
  it("generates a report, returns an item to backlog, and opens the version deep link", async () => {
    const user = userEvent.setup();
    mockApi.closeSprint = vi.fn().mockResolvedValue(makeClosureReport());
    mockApi.removeSprintItem = vi.fn().mockResolvedValue({});
    mockApi.getVersionExport = vi.fn().mockResolvedValue({
      sprint_id: 1,
      wp_op_ids: [2],
      deep_link: "https://op.example.com/work_packages?query_props=%7B%7D",
    });
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);

    renderClosure();

    await user.click(screen.getByRole("button", { name: /Close sprint & generate report/ }));
    await waitFor(() => expect(screen.getByText(/Done thing/)).toBeInTheDocument());
    // Appears in both the not-done column and the version-change candidates list.
    expect(screen.getAllByText(/Unfinished thing/).length).toBeGreaterThanOrEqual(1);

    await user.click(screen.getByRole("button", { name: "Return to backlog" }));
    await waitFor(() => expect(mockApi.removeSprintItem).toHaveBeenCalledWith(1, 2));
    expect(screen.getByText("Returned")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Open in OP to change version/ }));
    await waitFor(() => expect(mockApi.getVersionExport).toHaveBeenCalledWith(1));
    expect(openSpy).toHaveBeenCalledWith(
      "https://op.example.com/work_packages?query_props=%7B%7D",
      "_blank",
      "noopener",
    );
  });

  // SPEC_04 §6 task 4: once a sprint is locked (via the new /finish endpoint,
  // called from SprintBoardScreen), this screen's action must not imply it
  // "closes" anything — it just (re)builds the already-generated report by
  // calling the pre-existing, unchanged, idempotent POST /close.
  it("presents itself as a view/regenerate action (not a closing action) once the sprint is locked", async () => {
    mockApi.closeSprint = vi.fn().mockResolvedValue(makeClosureReport());
    const lockedSprints = [
      makeSprint({ id: 1, status: "active", is_locked: true, locked_at: "2026-06-14T18:00:00Z", lock_reason: "finished" }),
    ];

    render(
      <ClosureScreen
        sprints={lockedSprints}
        selectedSprintId={1}
        onSelectSprint={() => {}}
        onSprintsChanged={() => {}}
      />,
    );

    // Let the additive closure-statistics panel's own fetch settle (SPEC_14
    // §2/§3) so its state update doesn't land outside act() after this test
    // has already moved on.
    await waitFor(() => expect(screen.getByTestId("closure-stats")).toBeInTheDocument());

    expect(screen.getByRole("button", { name: "View / regenerate closure report" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Close sprint & generate report/ })).not.toBeInTheDocument();
    expect(screen.getByText(/already locked/)).toBeInTheDocument();
  });

  // SPEC_09 §4: closure items link out to OP when a base URL is available
  // (ClosureItem itself carries no per-item connection_base_url, unlike
  // Backlog/Sprint board, so this is a "current connection" best-effort link).
  it("links ticket references to OpenProject when a base URL is provided", async () => {
    const user = userEvent.setup();
    mockApi.closeSprint = vi.fn().mockResolvedValue(makeClosureReport());

    render(
      <ClosureScreen
        sprints={sprints}
        selectedSprintId={1}
        onSelectSprint={() => {}}
        onSprintsChanged={() => {}}
        baseUrl="https://op.example.com"
      />,
    );

    await user.click(screen.getByRole("button", { name: /Close sprint & generate report/ }));
    await waitFor(() => expect(screen.getByText(/Done thing/)).toBeInTheDocument());

    const link = screen.getByText(/Done thing/).closest("a");
    expect(link).toHaveAttribute("href", "https://op.example.com/work_packages/1");
    expect(link).toHaveAttribute("target", "_blank");
  });

  // SPEC_14 §2/§3: the new role-aware statistics panel is additive — it's
  // fetched and shown regardless of whether the OLD report has been
  // generated, and surfaces anomalies distinctly plus an expandable
  // ambiguous bucket with its per-ticket reason.
  it("shows role-aware closure statistics, including anomalies and the ambiguous bucket's reason", async () => {
    const user = userEvent.setup();
    mockApi.closeSprint = vi.fn().mockResolvedValue(makeClosureReport());
    mockApi.getClosureStats = vi.fn().mockResolvedValue(
      makeClosureStats({
        done: { count: 9, items: [] },
        not_done: {
          count: 1,
          items: [
            {
              wp_op_id: 11592,
              subject: "In progress dev ticket",
              status_name: "in progress",
              holder_name: "Zbynek Trnka",
              holder_op_user_id: 3,
              holder_role: "developer",
              bucket: "not_done",
              ambiguous_reason: null,
              anomaly: null,
            },
          ],
        },
        ambiguous: {
          count: 1,
          items: [
            {
              wp_op_id: 11726,
              subject: "Needs a role",
              status_name: "on hold",
              holder_name: "Jindrich Benda",
              holder_op_user_id: 4,
              holder_role: "unset",
              bucket: "ambiguous",
              ambiguous_reason: "role není nastavena pro Jindrich Benda",
              anomaly: null,
            },
          ],
        },
        anomalies: [
          {
            wp_op_id: 11700,
            subject: "Nobody's holding this",
            status_name: "in progress",
            holder_name: null,
            holder_op_user_id: null,
            holder_role: null,
            bucket: "not_done",
            ambiguous_reason: null,
            anomaly: "unassigned_in_progress",
          },
        ],
      }),
    );

    renderClosure();

    await waitFor(() => expect(mockApi.getClosureStats).toHaveBeenCalledWith(1));
    expect(screen.getByTestId("closure-stats")).toBeInTheDocument();

    // Anomaly callout is visible without expanding anything.
    const anomalies = screen.getByTestId("closure-anomalies");
    expect(anomalies).toHaveTextContent("Nobody's holding this");
    expect(anomalies).toHaveTextContent(/should never happen/);

    // Ambiguous bucket starts collapsed; expanding shows the reason.
    expect(screen.queryByText(/role není nastavena/)).not.toBeInTheDocument();
    await user.click(screen.getByTestId("bucket-toggle-Ambiguous (role not set)"));
    expect(screen.getByText(/role není nastavena pro Jindrich Benda/)).toBeInTheDocument();
  });

  // Increment 15 (SPEC_15 §3): the per-developer table's Delivered column
  // reads the corrected `delivered_hours` (not the deprecated
  // `delivered_estimate_hours` alias), and Effectivity is NEVER "—" once
  // delivered_hours > 0 — the exact "Zbynek Trnka" bug this increment
  // fixes (developed + delivered to a tester, DELIVERED used to land on the
  // tester and show effectivity "—"). The default fixture models exactly
  // that worked example: baseline 30h, logged 46.5h, delivered 30h, ~155%.
  // Increment 16 (SPEC_16 §1): the column itself is renamed Accuracy →
  // Effectivity (label only, `accuracy_pct` field/calculation unchanged) —
  // this per-developer table already had its own Delivered column BEFORE
  // Increment 16 (the new SPEC_16 §3 "Delivered" stat lives in the summary
  // row above this table, not here), so the column INDICES below are
  // unaffected by this increment, only the header text is.
  it("shows a non-dash effectivity and the corrected delivered_hours whenever a developer delivered something", async () => {
    mockApi.closeSprint = vi.fn().mockResolvedValue(makeClosureReport());
    // beforeEach's default makeClosureStats() already models the Zbynek
    // Trnka case (delivered_hours 30, accuracy_pct 155) — used as-is here.
    renderClosure();

    await waitFor(() => expect(mockApi.getClosureStats).toHaveBeenCalledWith(1));
    const table = screen.getByTestId("per-developer-table");
    const row = within(table).getByText("Zbynek Trnka").closest("tr")!;
    // Columns in order: Developer, Planned, Logged, Delivered, Effectivity, Overshoot.
    const cells = row.querySelectorAll("td");
    expect(cells[3]).toHaveTextContent("30h"); // Delivered — delivered_hours, not the deprecated alias
    expect(cells[4]).toHaveTextContent("155%"); // Effectivity — never "—" once delivered_hours > 0
    expect(cells[4]).not.toHaveTextContent("—");
  });

  // Increment 34 follow-up (the Jan Belka #11166 confusion): the bar can show
  // a per-segment "overshoot" span for OPEN tickets, but Closure's OVERSHOOT
  // figures count completed tickets only — both the summary stat and the
  // per-developer column say so via a tooltip so the two surfaces never read
  // as contradicting each other.
  it("labels the OVERSHOOT stat and column as completed-tickets-only via tooltips", async () => {
    renderClosure();

    await waitFor(() => expect(screen.getByTestId("closure-stats")).toBeInTheDocument());
    const stat = screen.getByText(/^Overshoot \(flag/).closest(".stat")!;
    expect(stat).toHaveAttribute("title", expect.stringContaining("Completed tickets only"));

    const table = screen.getByTestId("per-developer-table");
    const th = within(table).getByText("Overshoot", { selector: "th" });
    expect(th).toHaveAttribute("title", "Completed tickets only");
  });

  // Increment 33 (docs/INCREMENT_33_CONTRACTS.md §4) — the "Outside the
  // sprint" section renders nothing at all (§0.1 posture — this block never
  // feeds any other number) when there's no off-sprint time. beforeEach's
  // default makeClosureStats() already carries the empty off_sprint.
  it("hides the off-sprint section when there is no off-sprint time", async () => {
    renderClosure();

    await waitFor(() => expect(screen.getByTestId("closure-stats")).toBeInTheDocument());
    expect(screen.queryByTestId("closure-off-sprint-section")).not.toBeInTheDocument();
  });

  it("shows the headline share with 0 decimals once it's ≥10%", async () => {
    mockApi.getClosureStats = vi.fn().mockResolvedValue(
      makeClosureStats({
        off_sprint: makeClosureOffSprint({
          total_hours: 6,
          sprint_logged_hours: 9,
          share_pct: 40,
          per_person: [makeClosureOffSprintPerson()],
        }),
      }),
    );

    renderClosure();

    const section = await screen.findByTestId("closure-off-sprint-section");
    expect(within(section).getByTestId("closure-off-sprint-toggle")).toHaveTextContent("Outside the sprint — 6h");
    expect(within(section).getByTestId("closure-off-sprint-headline")).toHaveTextContent(
      "40% of developer time outside the sprint — 6h of 15h total",
    );
  });

  it("shows the headline share with 1 decimal below 10%", async () => {
    mockApi.getClosureStats = vi.fn().mockResolvedValue(
      makeClosureStats({
        off_sprint: makeClosureOffSprint({
          total_hours: 1,
          sprint_logged_hours: 29,
          share_pct: 3.4,
          per_person: [makeClosureOffSprintPerson()],
        }),
      }),
    );

    renderClosure();

    const section = await screen.findByTestId("closure-off-sprint-section");
    expect(within(section).getByTestId("closure-off-sprint-headline")).toHaveTextContent(
      "3.4% of developer time outside the sprint — 1h of 30h total",
    );
  });

  it("expands to show per-person rows with each person's own share", async () => {
    const user = userEvent.setup();
    mockApi.getClosureStats = vi.fn().mockResolvedValue(
      makeClosureStats({
        off_sprint: makeClosureOffSprint({
          total_hours: 4,
          sprint_logged_hours: 6,
          share_pct: 40,
          per_person: [makeClosureOffSprintPerson({ op_user_id: 9, name: "Carol", total_hours: 4, share_pct: 40 })],
        }),
      }),
    );

    renderClosure();

    await screen.findByTestId("closure-off-sprint-section");
    expect(screen.queryByTestId("closure-off-sprint-people")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("closure-off-sprint-toggle"));
    const personRow = screen.getByTestId("closure-off-sprint-person-id:9");
    expect(personRow).toHaveTextContent("Carol — 4h (40%)");
  });

  it("expands a person to show their off-sprint tickets, including one with a null subject", async () => {
    const user = userEvent.setup();
    mockApi.getClosureStats = vi.fn().mockResolvedValue(
      makeClosureStats({
        off_sprint: makeClosureOffSprint({
          total_hours: 6,
          sprint_logged_hours: 4,
          share_pct: 60,
          per_person: [
            makeClosureOffSprintPerson({
              op_user_id: 9,
              name: "Carol",
              total_hours: 6,
              share_pct: 60,
              tickets: [
                { wp_op_id: 555, subject: "Unplanned hotfix", hours: 4, connection_id: 1 },
                { wp_op_id: 777, subject: null, hours: 2, connection_id: null },
              ],
            }),
          ],
        }),
      }),
    );

    renderClosure();

    await user.click(await screen.findByTestId("closure-off-sprint-toggle"));
    await user.click(screen.getByTestId("closure-off-sprint-person-id:9"));

    const tickets = screen.getByTestId("closure-off-sprint-tickets-id:9");
    expect(tickets).toHaveTextContent("#555 Unplanned hotfix — 4h");
    expect(tickets).toHaveTextContent("#777");
    expect(tickets).toHaveTextContent("2h");
  });
});

// Increment 34 (docs/INCREMENT_34_CONTRACTS.md §3/§5) — the multi-sprint
// badge + cumulative dev-logged figure in the per-ticket table (shared with
// ReportsScreen via ClosureStatsView), and the "Carry over" action on the
// old report's "Not done" rows.
describe("ClosureScreen — Increment 34 multi-sprint + carry-over", () => {
  it("shows the multi-sprint badge and cumulative dev-logged hours for a DONE multi-sprint per-ticket row", async () => {
    mockApi.getClosureStats = vi.fn().mockResolvedValue(
      makeClosureStats({
        per_ticket: [
          makeTicketEstimateLine({
            wp_op_id: 99,
            subject: "Long runner",
            bucket: "done",
            dev_logged_hours: 60,
            cumulative_dev_logged_hours: 110,
            multi_sprint: { sequence: 2, total: 2 },
          }),
        ],
      }),
    );

    renderClosure();

    const table = await screen.findByTestId("per-ticket-table");
    const row = within(table).getByText(/Long runner/).closest("tr")!;
    expect(within(row).getByText("sprint 2/2")).toBeInTheDocument();
    // Window figure and cumulative figure both visible, distinctly labelled.
    expect(row).toHaveTextContent("60h (110h across sprints)");
  });

  it("omits the badge and the cumulative figure for an ordinary single-sprint row (byte-identical to before)", async () => {
    mockApi.getClosureStats = vi.fn().mockResolvedValue(
      makeClosureStats({
        per_ticket: [
          makeTicketEstimateLine({
            wp_op_id: 1,
            subject: "Do the thing",
            bucket: "done",
            dev_logged_hours: 9,
            cumulative_dev_logged_hours: 9,
            multi_sprint: null,
          }),
        ],
      }),
    );

    renderClosure();

    const table = await screen.findByTestId("per-ticket-table");
    const row = within(table).getByText(/Do the thing/).closest("tr")!;
    expect(within(row).queryByText(/^sprint \d+\/\d+$/)).not.toBeInTheDocument();
    expect(row).not.toHaveTextContent("across sprints");
    expect(row).toHaveTextContent("9h");
  });

  it("does not show the cumulative figure for a NOT-done multi-sprint row, only the badge", async () => {
    mockApi.getClosureStats = vi.fn().mockResolvedValue(
      makeClosureStats({
        per_ticket: [
          makeTicketEstimateLine({
            wp_op_id: 7,
            subject: "Still going",
            bucket: "not_done",
            dev_logged_hours: 20,
            cumulative_dev_logged_hours: 35,
            multi_sprint: { sequence: 1, total: 2 },
            delta_hours: null,
            overshoot_flag: null,
          }),
        ],
      }),
    );

    renderClosure();

    const table = await screen.findByTestId("per-ticket-table");
    const row = within(table).getByText(/Still going/).closest("tr")!;
    expect(within(row).getByText("sprint 1/2")).toBeInTheDocument();
    expect(row).not.toHaveTextContent("across sprints");
  });

  it("offers Carry over on a 'Not done' row once the sprint is closed/locked, carries via the API, and swaps to a 'Carried' badge", async () => {
    const user = userEvent.setup();
    const onSprintsChanged = vi.fn();
    mockApi.closeSprint = vi.fn().mockResolvedValue(makeClosureReport());
    mockApi.carrySprintItem = vi.fn().mockResolvedValue({ carried: true, target_sprint_id: 2, wp_op_id: 2 });

    const lockedSprint = makeSprint({
      id: 1,
      status: "active",
      is_locked: true,
      locked_at: "2026-06-14T18:00:00Z",
      lock_reason: "finished",
    });
    const target = makeSprint({ id: 2, name: "Next sprint", status: "planning" });

    render(
      <ClosureScreen
        sprints={[lockedSprint, target]}
        selectedSprintId={1}
        onSelectSprint={() => {}}
        onSprintsChanged={onSprintsChanged}
      />,
    );

    await user.click(screen.getByRole("button", { name: "View / regenerate closure report" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Return to backlog" })).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Carry over" }));
    const select = await screen.findByLabelText("Target sprint");
    await user.selectOptions(select, "2");
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Carry over" }));

    await waitFor(() =>
      expect(mockApi.carrySprintItem).toHaveBeenCalledWith(1, 2, { target_sprint_id: 2 }),
    );
    expect(await screen.findByText("Carried")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Carry over" })).not.toBeInTheDocument();
    expect(onSprintsChanged).toHaveBeenCalled();
  });

  it("hides Carry over on 'Not done' rows while the sprint is still open (not closed/locked)", async () => {
    const user = userEvent.setup();
    mockApi.closeSprint = vi.fn().mockResolvedValue(makeClosureReport());

    renderClosure(); // beforeEach sprint: id 1, status "active", NOT locked

    await user.click(screen.getByRole("button", { name: /Close sprint & generate report/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Return to backlog" })).toBeInTheDocument());

    expect(screen.queryByRole("button", { name: "Carry over" })).not.toBeInTheDocument();
  });
});

// Increment 35 (docs/INCREMENT_35_CONTRACTS.md §4; CAPACITY_BAR_RULES §5c) —
// the "Scope origin" section (headline share, donut, breakdown table) and the
// per-ticket "added" badge, both rendered from ClosureStatsView (shared with
// ReportsScreen via ClosureStats.tsx — one edit, two surfaces).
describe("ClosureScreen — Increment 35 scope origin", () => {
  // beforeEach's default makeClosureStats() already carries the zeroed
  // scope_origin block, same posture as the off-sprint section.
  it("hides the scope-origin section on the zeroed default", async () => {
    renderClosure();

    await waitFor(() => expect(screen.getByTestId("closure-stats")).toBeInTheDocument());
    expect(screen.queryByTestId("closure-scope-origin-section")).not.toBeInTheDocument();
  });

  it("shows the headline share, a donut, and the breakdown table for mixed data", async () => {
    mockApi.getClosureStats = vi.fn().mockResolvedValue(
      makeClosureStats({
        scope_origin: makeScopeOrigin({
          baseline: { ticket_count: 2, estimate_hours: 30, dev_logged_hours: 20 },
          added: { ticket_count: 3, estimate_hours: 12, dev_logged_hours: 17 },
          added_logged_share_pct: (17 / 37) * 100,
          added_estimate_share_pct: (12 / 42) * 100,
        }),
      }),
    );

    renderClosure();

    const section = await screen.findByTestId("closure-scope-origin-section");
    expect(within(section).getByTestId("closure-scope-origin-headline")).toHaveTextContent(
      "46% of developer time went to work added during the sprint",
    );
    expect(within(section).getByTestId("closure-scope-origin-donut")).toBeInTheDocument();

    const table = within(section).getByTestId("closure-scope-origin-table");
    const rows = within(table).getAllByRole("row");
    // rows[0] is the header row.
    expect(rows[1]).toHaveTextContent("Planned before activation");
    expect(rows[1]).toHaveTextContent("2");
    expect(rows[1]).toHaveTextContent("30h");
    expect(rows[1]).toHaveTextContent("20h");
    expect(rows[1]).toHaveTextContent("54%"); // 100 - 46
    expect(rows[2]).toHaveTextContent("Added during sprint");
    expect(rows[2]).toHaveTextContent("3");
    expect(rows[2]).toHaveTextContent("12h");
    expect(rows[2]).toHaveTextContent("17h");
    expect(rows[2]).toHaveTextContent("46%");
  });

  it("falls back to a quiet message (no logged time yet) when added_logged_share_pct is null, but still shows the estimate-based donut", async () => {
    mockApi.getClosureStats = vi.fn().mockResolvedValue(
      makeClosureStats({
        scope_origin: makeScopeOrigin({
          baseline: { ticket_count: 1, estimate_hours: 10, dev_logged_hours: 0 },
          added: { ticket_count: 1, estimate_hours: 5, dev_logged_hours: 0 },
          added_logged_share_pct: null,
          added_estimate_share_pct: (5 / 15) * 100,
        }),
      }),
    );

    renderClosure();

    const section = await screen.findByTestId("closure-scope-origin-section");
    const headline = within(section).getByTestId("closure-scope-origin-headline");
    expect(headline).not.toHaveTextContent("%");
    expect(headline).toHaveTextContent(/no developer time logged yet/i);
    // Both hours are 0, so the donut falls back to the estimate split (§5c) —
    // it still has something to show (10h vs 5h) and must not be omitted.
    expect(within(section).getByTestId("closure-scope-origin-donut")).toBeInTheDocument();
    // The table's own Share column falls back to the estimate share too.
    const table = within(section).getByTestId("closure-scope-origin-table");
    expect(table).toHaveTextContent("67%"); // baseline: 100 - 33.33, rounded (≥10%)
    expect(table).toHaveTextContent("33%"); // added: 5/15 × 100, rounded (≥10%)
  });

  it("badges rows added during the sprint or retroactively, leaves baseline rows unbadged and byte-identical", async () => {
    mockApi.getClosureStats = vi.fn().mockResolvedValue(
      makeClosureStats({
        per_ticket: [
          makeTicketEstimateLine({ wp_op_id: 1, subject: "Planned from the start", origin: "baseline" }),
          makeTicketEstimateLine({ wp_op_id: 2, subject: "Joined mid-sprint", origin: "added_mid_sprint" }),
          makeTicketEstimateLine({ wp_op_id: 3, subject: "Reconstructed add", origin: "added_retroactively" }),
        ],
      }),
    );

    renderClosure();

    const table = await screen.findByTestId("per-ticket-table");
    const baselineRow = within(table).getByText(/Planned from the start/).closest("tr")!;
    expect(within(baselineRow).queryByText("added")).not.toBeInTheDocument();
    expect(within(baselineRow).queryByText("added (retro)")).not.toBeInTheDocument();

    const midSprintRow = within(table).getByText(/Joined mid-sprint/).closest("tr")!;
    expect(within(midSprintRow).getByTestId("scope-origin-badge-2")).toHaveTextContent("added");

    const retroRow = within(table).getByText(/Reconstructed add/).closest("tr")!;
    expect(within(retroRow).getByTestId("scope-origin-badge-3")).toHaveTextContent("added (retro)");
  });
});

// Increment 40 (C1, §1.2): the per-ticket "Project" column (shared with
// ReportsScreen via ClosureStatsView) — name, tooltip = identifier;
// name null → identifier; both null → "—".
describe("ClosureScreen — Increment 40 project column", () => {
  it("adds a Project column after Ticket with name, identifier tooltip and fallbacks", async () => {
    mockApi.getClosureStats = vi.fn().mockResolvedValue(
      makeClosureStats({
        per_ticket: [
          makeTicketEstimateLine({ wp_op_id: 1, subject: "Northwind fix", project_op_id: 10, project_name: "Northwind Payments", project_identifier: "northwind" }),
          makeTicketEstimateLine({ wp_op_id: 2, subject: "Ident-only fix", project_op_id: 20, project_name: null, project_identifier: "harbor-ops" }),
          makeTicketEstimateLine({ wp_op_id: 3, subject: "Unknown fix", project_op_id: null, project_name: null, project_identifier: null }),
        ],
      }),
    );

    renderClosure();

    const table = await screen.findByTestId("per-ticket-table");
    const headers = within(table).getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers.slice(0, 3)).toEqual(["Ticket", "Project", "Bucket"]);

    const c1 = within(table).getByTestId("per-ticket-project-1");
    expect(c1).toHaveTextContent("Northwind Payments");
    expect(c1).toHaveAttribute("title", "northwind");
    expect(within(table).getByTestId("per-ticket-project-2")).toHaveTextContent("harbor-ops");
    const c3 = within(table).getByTestId("per-ticket-project-3");
    expect(c3).toHaveTextContent("—");
    expect(c3).not.toHaveAttribute("title");
  });

  it("spans the empty-state row across every column, Project included", async () => {
    mockApi.getClosureStats = vi.fn().mockResolvedValue(makeClosureStats({ per_ticket: [] }));
    renderClosure();
    const table = await screen.findByTestId("per-ticket-table");
    const cell = within(table).getByText("No tickets.").closest("td")!;
    expect(cell).toHaveAttribute("colspan", String(within(table).getAllByRole("columnheader").length));
  });
});
