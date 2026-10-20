import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  makeClosedSprintSummary,
  makeClosureOffSprint,
  makeClosureOffSprintPerson,
  makeClosureStats,
  makeReportDetail,
  makeReportsListResponse,
  makeScopeOrigin,
} from "../test/fixtures";

const { mockApi } = vi.hoisted(() => ({ mockApi: {} as Record<string, ReturnType<typeof vi.fn>> }));
vi.mock("../api-client", async (orig) => {
  const actual = await orig<typeof import("../api-client")>();
  return { ...actual, api: mockApi };
});

import { ReportsScreen } from "./ReportsScreen";

beforeEach(() => {
  for (const k of Object.keys(mockApi)) delete mockApi[k];
});

describe("ReportsScreen", () => {
  it("lists closed sprints and shows Detail + Generate PDF actions per row", async () => {
    mockApi.getReports = vi.fn().mockResolvedValue(
      makeReportsListResponse([
        { sprint_id: 1, name: "Sprint 1" },
        { sprint_id: 2, name: "Sprint 2", closed_at: null },
      ]),
    );

    render(<ReportsScreen refreshKey={0} />);

    await waitFor(() => expect(screen.getByTestId("reports-table")).toBeInTheDocument());
    expect(screen.getByTestId("report-row-1")).toHaveTextContent("Sprint 1");
    expect(screen.getByTestId("report-row-2")).toHaveTextContent("Sprint 2");
    // A never-closed_at row still renders (defensive — shouldn't crash).
    expect(screen.getByTestId("report-row-2")).toHaveTextContent("—");
    expect(screen.getByTestId("generate-pdf-1")).toBeInTheDocument();
    expect(screen.getByTestId("generate-pdf-2")).toBeInTheDocument();
  });

  it("opens the Detail view with statistics and charts, and calls Generate PDF", async () => {
    const user = userEvent.setup();
    mockApi.getReports = vi.fn().mockResolvedValue(makeReportsListResponse([{ sprint_id: 1, name: "Sprint 1" }]));
    mockApi.getReportDetail = vi.fn().mockResolvedValue(makeReportDetail({ sprint: makeClosedSprintSummary({ sprint_id: 1, name: "Sprint 1" }) }));
    mockApi.generateReportPdf = vi.fn().mockResolvedValue(undefined);

    render(<ReportsScreen refreshKey={0} />);
    await waitFor(() => expect(screen.getByTestId("reports-table")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Detail" }));
    await waitFor(() => expect(mockApi.getReportDetail).toHaveBeenCalledWith(1));

    const detail = await screen.findByTestId("report-detail");
    expect(detail).toHaveTextContent("Sprint 1");
    expect(screen.getByTestId("closure-stats")).toBeInTheDocument();
    expect(screen.getByTestId("report-burndown-chart")).toBeInTheDocument();
    expect(screen.getByTestId("report-developer-chart")).toBeInTheDocument();
    expect(screen.getByTestId("report-estimate-chart")).toBeInTheDocument();
    expect(screen.getByTestId("report-status-chart")).toBeInTheDocument();

    // Generate PDF is available both on the list row and inside Detail —
    // both share the same sprint-scoped testid, so there are two now.
    const pdfButtons = screen.getAllByTestId("generate-pdf-1");
    expect(pdfButtons).toHaveLength(2);
    await user.click(pdfButtons[0]!);
    await waitFor(() => expect(mockApi.generateReportPdf).toHaveBeenCalledWith(1));
  });

  it("surfaces an error from Generate PDF without crashing the row", async () => {
    const user = userEvent.setup();
    mockApi.getReports = vi.fn().mockResolvedValue(makeReportsListResponse([{ sprint_id: 1, name: "Sprint 1" }]));
    mockApi.generateReportPdf = vi.fn().mockRejectedValue(new Error("boom"));

    render(<ReportsScreen refreshKey={0} />);
    await waitFor(() => expect(screen.getByTestId("reports-table")).toBeInTheDocument());

    await user.click(screen.getByTestId("generate-pdf-1"));
    await waitFor(() => expect(screen.getByText("boom")).toBeInTheDocument());
  });

  it("shows an empty state when there are no closed sprints yet", async () => {
    mockApi.getReports = vi.fn().mockResolvedValue([]);
    render(<ReportsScreen refreshKey={0} />);
    await waitFor(() => expect(screen.getByText(/No closed sprints yet/)).toBeInTheDocument());
  });

  // Increment 33 (docs/INCREMENT_33_CONTRACTS.md §4) — the read-only "Outside
  // the sprint" variant in a closed-sprint's report detail, sourced from
  // `ReportDetailResponse.stats.off_sprint` (same shape ClosureScreen reads
  // live, same shared OffSprintClosureSection component).
  it("shows the off-sprint section in the report detail, expandable to per-person tickets", async () => {
    const user = userEvent.setup();
    mockApi.getReports = vi.fn().mockResolvedValue(makeReportsListResponse([{ sprint_id: 1, name: "Sprint 1" }]));
    mockApi.getReportDetail = vi.fn().mockResolvedValue(
      makeReportDetail({
        sprint: makeClosedSprintSummary({ sprint_id: 1, name: "Sprint 1" }),
        stats: makeClosureStats({
          off_sprint: makeClosureOffSprint({
            total_hours: 6,
            sprint_logged_hours: 9,
            share_pct: 40,
            per_person: [
              makeClosureOffSprintPerson({
                op_user_id: 9,
                name: "Carol",
                total_hours: 6,
                share_pct: 40,
                tickets: [{ wp_op_id: 555, subject: "Unplanned hotfix", hours: 6, connection_id: 1 }],
              }),
            ],
          }),
        }),
      }),
    );

    render(<ReportsScreen refreshKey={0} />);
    await waitFor(() => expect(screen.getByTestId("reports-table")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Detail" }));

    const section = await screen.findByTestId("closure-off-sprint-section");
    expect(within(section).getByTestId("closure-off-sprint-headline")).toHaveTextContent(
      "40% of developer time outside the sprint — 6h of 15h total",
    );

    await user.click(within(section).getByTestId("closure-off-sprint-toggle"));
    await user.click(screen.getByTestId("closure-off-sprint-person-id:9"));
    expect(screen.getByTestId("closure-off-sprint-tickets-id:9")).toHaveTextContent("#555 Unplanned hotfix — 6h");
  });

  it("hides the off-sprint section in the report detail when there is no off-sprint time", async () => {
    const user = userEvent.setup();
    mockApi.getReports = vi.fn().mockResolvedValue(makeReportsListResponse([{ sprint_id: 1, name: "Sprint 1" }]));
    mockApi.getReportDetail = vi.fn().mockResolvedValue(
      makeReportDetail({ sprint: makeClosedSprintSummary({ sprint_id: 1, name: "Sprint 1" }) }),
    );

    render(<ReportsScreen refreshKey={0} />);
    await waitFor(() => expect(screen.getByTestId("reports-table")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Detail" }));

    await screen.findByTestId("report-detail");
    expect(screen.queryByTestId("closure-off-sprint-section")).not.toBeInTheDocument();
  });

  // Increment 35 (docs/INCREMENT_35_CONTRACTS.md §4; CAPACITY_BAR_RULES §5c) —
  // smoke test that the "Scope origin" section (ClosureStats.tsx, shared with
  // ClosureScreen) also shows up in a closed sprint's report detail, sourced
  // from `ReportDetailResponse.stats.scope_origin`. Full behavioural coverage
  // (donut fallback, badges, null-share) lives in ClosureScreen.test.tsx —
  // both screens render the exact same ClosureStatsView.
  it("shows the scope-origin section in the report detail", async () => {
    mockApi.getReports = vi.fn().mockResolvedValue(makeReportsListResponse([{ sprint_id: 1, name: "Sprint 1" }]));
    mockApi.getReportDetail = vi.fn().mockResolvedValue(
      makeReportDetail({
        sprint: makeClosedSprintSummary({ sprint_id: 1, name: "Sprint 1" }),
        stats: makeClosureStats({
          scope_origin: makeScopeOrigin({
            baseline: { ticket_count: 2, estimate_hours: 30, dev_logged_hours: 20 },
            added: { ticket_count: 3, estimate_hours: 12, dev_logged_hours: 17 },
            added_logged_share_pct: (17 / 37) * 100,
            added_estimate_share_pct: (12 / 42) * 100,
          }),
        }),
      }),
    );

    render(<ReportsScreen refreshKey={0} />);
    await waitFor(() => expect(screen.getByTestId("reports-table")).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Detail" }));

    const section = await screen.findByTestId("closure-scope-origin-section");
    expect(within(section).getByTestId("closure-scope-origin-headline")).toHaveTextContent(
      "46% of developer time went to work added during the sprint",
    );
    expect(within(section).getByTestId("closure-scope-origin-donut")).toBeInTheDocument();
  });
});
