import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import {
  makeAppConfig,
  makeBacklogItem,
  makeClosureStats,
  makeConnection,
  makeOffSprintTimeResponse,
  makePersonSummary,
  makeSprint,
  makeSprintItemDetail,
} from "../test/fixtures";
import { RoleProvider } from "../lib/role";

const { mockApi } = vi.hoisted(() => ({ mockApi: {} as Record<string, ReturnType<typeof vi.fn>> }));
vi.mock("../api-client", async (orig) => {
  const actual = await orig<typeof import("../api-client")>();
  return { ...actual, api: mockApi };
});

import { SprintBoardScreen } from "./SprintBoardScreen";
import { BacklogScreen } from "./BacklogScreen";
import { PeopleScreen } from "./PeopleScreen";
import { SettingsScreen } from "./SettingsScreen";
import { ClosureScreen } from "./ClosureScreen";
import { ReportsScreen } from "./ReportsScreen";

const capacity = {
  sprint_id: 1,
  lines: [
    {
      member_id: null,
      op_user_id: 7,
      name: "Alice",
      available_hours: 20,
      planned_hours: 0,
      overloaded: false,
      baseline_hours: 0,
      added_hours: 0,
      removed_hours: 0,
      redistributed_out_hours: 0,
      redistributed_in_hours: 0,
      role: "developer",
      is_developer: true,
      has_sprint_work: false,
    },
  ],
  total_available_hours: 20,
  total_planned_hours: 0,
  overloaded: false,
  baseline_total_hours: null,
  scope_planned_hours: 0,
  scope_delivered_hours: 0,
};

beforeEach(() => {
  for (const k of Object.keys(mockApi)) delete mockApi[k];
  mockApi.getBacklog = vi.fn().mockResolvedValue([makeBacklogItem({ op_id: 1, subject: "Backlog thing" })]);
  mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue([
    makeSprintItemDetail({ op_id: 2, subject: "Sprint thing", is_done: false }),
  ]);
  mockApi.getCapacity = vi.fn().mockResolvedValue(capacity);
  mockApi.getClosureStats = vi.fn().mockResolvedValue(makeClosureStats({ per_developer: [] }));
  mockApi.getSprintUpdates = vi.fn().mockResolvedValue([]);
  mockApi.getSprintPeople = vi.fn().mockResolvedValue([]);
  mockApi.getConnections = vi.fn().mockResolvedValue([makeConnection()]);
  mockApi.getConfig = vi.fn().mockResolvedValue(makeAppConfig());
  mockApi.getOffSprintTime = vi.fn().mockResolvedValue(makeOffSprintTimeResponse());
});

function board(role: "Viewer" | "Planner", sprint = makeSprint({ id: 1, name: "Sprint 1", status: "planning" })) {
  return render(
    <RoleProvider value={{ role, mode: "entra" }}>
      <SprintBoardScreen
        sprints={[sprint, makeSprint({ id: 2, name: "Sprint 2", status: "planning" })]}
        selectedSprintId={1}
        onSelectSprint={() => {}}
        onSprintsChanged={() => {}}
        refreshKey={0}
      />
    </RoleProvider>,
  );
}

const MUTATING = [
  /Create sprint/,
  /^Activate$/,
  /Update Sprint/,
  /Finish sprint/,
  /Back to planning/,
  /Delete sprint/,
  /Reactivate/i,
  /Add →/,
  /← Return/,
  /Save capacity/,
  /Carry over/,
  /Remove .* from sprint/i,
  /Add ticket/i,
];

function expectNoMutatingButtons() {
  for (const re of MUTATING) {
    expect(screen.queryByRole("button", { name: re })).not.toBeInTheDocument();
  }
}

describe("Viewer is read-only on the sprint board", () => {
  it("planning sprint: no mutating controls, no backlog column, capacity input disabled, PDF stays", async () => {
    board("Viewer");
    await waitFor(() => expect(screen.getByText(/Sprint thing/)).toBeInTheDocument());
    expectNoMutatingButtons();
    expect(screen.queryByTestId("drop-backlog")).not.toBeInTheDocument();
    expect(screen.queryByText(/Backlog thing/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("available hours for Alice")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Remove Alice" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Add person")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Export status PDF/i })).toBeInTheDocument();
  });

  it("active sprint: no Update/Finish/Back to planning", async () => {
    board("Viewer", makeSprint({ id: 1, name: "Sprint 1", status: "active", activated_at: "2026-06-01T00:00:00Z" }));
    await waitFor(() => expect(screen.getByText(/Sprint thing/)).toBeInTheDocument());
    expectNoMutatingButtons();
  });

  it("locked/closed sprint: no Carry over, no Reactivate", async () => {
    mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue([
      makeSprintItemDetail({ op_id: 2, subject: "Sprint thing", is_done: false }),
    ]);
    board("Viewer", makeSprint({ id: 1, name: "Sprint 1", status: "closed", is_locked: true, lock_reason: "finished" }));
    await waitFor(() => expect(screen.getByText(/Sprint thing/)).toBeInTheDocument());
    expectNoMutatingButtons();
  });

  it("Planner sanity: same board still offers the controls", async () => {
    board("Planner");
    await waitFor(() => expect(screen.getByText(/Sprint thing/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Create sprint" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Activate" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete sprint" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add →" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save capacity" })).toBeInTheDocument();
  });
});

describe("Viewer on other screens", () => {
  it("Backlog: no Remove / selection / Override controls", async () => {
    mockApi.getBacklogFilterOptions = vi.fn().mockResolvedValue({
      projects: [], statuses: [], assignees: [], versions: [], priorities: [], servers: [],
    });
    render(
      <RoleProvider value={{ role: "Viewer", mode: "entra" }}>
        <BacklogScreen refreshKey={0} baseUrl="https://op.example.com" />
      </RoleProvider>,
    );
    await waitFor(() => expect(screen.getByText("Backlog thing")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Remove from backlog" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Select all")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Select #1")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("edit override for 1")).not.toBeInTheDocument();
  });

  it("People: role selects are disabled", async () => {
    mockApi.getPeople = vi.fn().mockResolvedValue([makePersonSummary({ id: 1, name: "Alice" })]);
    render(
      <RoleProvider value={{ role: "Viewer", mode: "entra" }}>
        <PeopleScreen refreshKey={0} />
      </RoleProvider>,
    );
    await waitFor(() => expect(screen.getByLabelText("Role for Alice")).toBeInTheDocument());
    expect(screen.getByLabelText("Role for Alice")).toBeDisabled();
  });

  it("Settings: fields disabled and no Save button", async () => {
    render(
      <RoleProvider value={{ role: "Viewer", mode: "entra" }}>
        <SettingsScreen />
      </RoleProvider>,
    );
    await waitFor(() => expect(screen.getByLabelText(/grace period/i)).toBeInTheDocument());
    expect(screen.getByLabelText(/grace period/i)).toBeDisabled();
    expect(screen.getByLabelText(/Overshoot threshold/i)).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save settings" })).not.toBeInTheDocument();
  });

  it("Closure: no close/generate button for a Viewer, present for a Planner", async () => {
    mockApi.getClosureStats = vi.fn().mockResolvedValue(makeClosureStats());
    const props = {
      sprints: [makeSprint({ id: 1, status: "active" })],
      selectedSprintId: 1,
      onSelectSprint: () => {},
      onSprintsChanged: () => {},
    };
    const { unmount } = render(
      <RoleProvider value={{ role: "Viewer", mode: "entra" }}>
        <ClosureScreen {...props} />
      </RoleProvider>,
    );
    await waitFor(() => expect(mockApi.getClosureStats).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /Close sprint/ })).not.toBeInTheDocument();
    unmount();
    render(
      <RoleProvider value={{ role: "Planner", mode: "entra" }}>
        <ClosureScreen {...props} />
      </RoleProvider>,
    );
    expect(screen.getByRole("button", { name: /Close sprint/ })).toBeInTheDocument();
  });

  it("Reports: renders for a Viewer (read-only screen, no gating needed)", async () => {
    mockApi.getReports = vi.fn().mockResolvedValue([]);
    render(
      <RoleProvider value={{ role: "Viewer", mode: "entra" }}>
        <ReportsScreen refreshKey={0} />
      </RoleProvider>,
    );
    await waitFor(() => expect(mockApi.getReports).toHaveBeenCalled());
  });
});
