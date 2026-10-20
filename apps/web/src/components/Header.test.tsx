import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConnectionSyncOutcome } from "@osp/contracts";
import { makeConnection, makeSyncStatus } from "../test/fixtures";

const { mockApi } = vi.hoisted(() => ({ mockApi: {} as Record<string, ReturnType<typeof vi.fn>> }));
vi.mock("../api-client", async (orig) => {
  const actual = await orig<typeof import("../api-client")>();
  return { ...actual, api: mockApi };
});

import {
  formatConnectionSyncOutcome,
  formatCoverageWarning,
  formatOrphanNote,
  Header,
} from "./Header";

/**
 * Increment 29 (docs/INCREMENT_29_CONTRACTS.md §4, contract §4.3) — the
 * mandatory "not everything was actually refreshed" warning, the
 * refreshed/total_cached coverage summary, the data-age note, orphan
 * reporting, and the new "Full refresh" button.
 */

function makeOutcome(over: Partial<ConnectionSyncOutcome> = {}): ConnectionSyncOutcome {
  return {
    connection_id: 1,
    connection_label: "Acme",
    status: "synced",
    run: {
      id: 8,
      started_at: "2026-08-10T11:59:00Z",
      finished_at: "2026-08-10T12:00:00Z",
      kind: "full",
      wp_count: 3,
      total_count: 3,
      status: "success",
      error: null,
      cancel_requested: false,
      last_progress_at: "2026-08-10T11:59:30Z",
    } as ConnectionSyncOutcome["run"],
    message: "updated 3 tickets",
    coverage: null,
    ...over,
  };
}

function renderHeader(over: Partial<Parameters<typeof Header>[0]> = {}) {
  const onSyncNow = vi.fn();
  const onFullRefresh = vi.fn();
  render(
    <Header
      tab="board"
      onTab={vi.fn()}
      connected
      syncStatus={makeSyncStatus({ last_synced_at: "2026-08-10T12:00:00Z" })}
      syncing={false}
      onSyncNow={onSyncNow}
      onFullRefresh={onFullRefresh}
      onCancelConflictingSync={vi.fn()}
      aggregate="green"
      connections={[makeConnection()]}
      onTestConnection={vi.fn()}
      onLockVault={vi.fn()}
      now={new Date("2026-08-10T12:05:00Z")}
      {...over}
    />,
  );
  return { onSyncNow, onFullRefresh };
}

describe("formatConnectionSyncOutcome (Increment 29 coverage text)", () => {
  it("appends refreshed/total_cached for a synced connection with coverage", () => {
    const text = formatConnectionSyncOutcome(
      makeOutcome({ coverage: { total_cached: 50, refreshed: 45, not_refreshed: 5, orphan_op_ids: [], oldest_cached_at: null } }),
    );
    expect(text).toBe("Acme: updated 3 tickets (45/50 cached tickets refreshed)");
  });

  it("falls back to the plain wording when coverage is null", () => {
    const text = formatConnectionSyncOutcome(makeOutcome({ coverage: null }));
    expect(text).toBe("Acme: updated 3 tickets");
  });
});

describe("formatCoverageWarning / formatOrphanNote", () => {
  it("names the not-refreshed count and the oldest cached record", () => {
    const msg = formatCoverageWarning({
      total_cached: 50,
      refreshed: 45,
      not_refreshed: 5,
      orphan_op_ids: [],
      oldest_cached_at: "2026-08-01T00:00:00Z",
    });
    expect(msg).toContain("5 cached tickets not refreshed this run");
    expect(msg).toContain("01/08/2026");
  });

  it("pluralizes the orphan note correctly", () => {
    expect(
      formatOrphanNote({ total_cached: 1, refreshed: 1, not_refreshed: 0, orphan_op_ids: [42], oldest_cached_at: null }),
    ).toBe("1 ticket no longer exist in OpenProject");
  });
});

describe("Header — sync coverage feedback (Increment 29)", () => {
  it("shows the not-refreshed warning when coverage.not_refreshed > 0", () => {
    renderHeader({
      syncSummary: [
        makeOutcome({
          coverage: { total_cached: 50, refreshed: 45, not_refreshed: 5, orphan_op_ids: [], oldest_cached_at: "2026-08-01T00:00:00Z" },
        }),
      ],
    });
    const warning = screen.getByTestId("coverage-warning-1");
    expect(warning).toBeInTheDocument();
    expect(warning).toHaveTextContent("5 cached tickets not refreshed this run");
    expect(warning).toHaveTextContent("01/08/2026");
  });

  it("does NOT show the warning when coverage.not_refreshed is 0", () => {
    renderHeader({
      syncSummary: [
        makeOutcome({
          coverage: { total_cached: 50, refreshed: 50, not_refreshed: 0, orphan_op_ids: [], oldest_cached_at: "2026-08-09T00:00:00Z" },
        }),
      ],
    });
    expect(screen.queryByTestId("coverage-warning-1")).not.toBeInTheDocument();
    // Data age is still surfaced per contract §4.3, just without warning styling.
    expect(screen.getByText(/oldest cached record: 09\/08\/2026/)).toBeInTheDocument();
  });

  it("renders nothing extra when coverage is null (skipped/error outcome)", () => {
    renderHeader({
      syncSummary: [makeOutcome({ status: "skipped", run: null, message: "disconnected", coverage: null })],
    });
    expect(screen.queryByTestId("coverage-warning-1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("coverage-orphans-1")).not.toBeInTheDocument();
    expect(screen.queryByText(/oldest cached record/)).not.toBeInTheDocument();
  });

  it("reports orphan_op_ids as informational text, never auto-deleting anything", () => {
    renderHeader({
      syncSummary: [
        makeOutcome({
          coverage: { total_cached: 10, refreshed: 10, not_refreshed: 0, orphan_op_ids: [11, 12, 13], oldest_cached_at: null },
        }),
      ],
    });
    const orphans = screen.getByTestId("coverage-orphans-1");
    expect(orphans).toHaveTextContent("3 tickets no longer exist in OpenProject");
  });

  it("labels the result panel when the run was a full refresh", () => {
    renderHeader({
      syncSummary: [makeOutcome({ coverage: null })],
      syncFullRefresh: true,
    });
    expect(screen.getByTestId("full-refresh-label")).toHaveTextContent("Full refresh");
  });

  it("does not label the result panel for an ordinary Sync now", () => {
    renderHeader({ syncSummary: [makeOutcome({ coverage: null })], syncFullRefresh: false });
    expect(screen.queryByTestId("full-refresh-label")).not.toBeInTheDocument();
  });
});

describe("Header — Full refresh button", () => {
  it("calls onFullRefresh when clicked", async () => {
    const user = userEvent.setup();
    const { onFullRefresh } = renderHeader();
    await user.click(screen.getByRole("button", { name: "Full refresh" }));
    expect(onFullRefresh).toHaveBeenCalledTimes(1);
  });

  it("is disabled while a sync is running, same as Sync now", () => {
    renderHeader({ syncing: true });
    // Both "Sync now" and "Full refresh" read "Syncing…" and are disabled
    // while ANY sync is running — they share one running state.
    const syncingButtons = screen.getAllByRole("button", { name: "Syncing…" });
    expect(syncingButtons).toHaveLength(2);
    for (const b of syncingButtons) expect(b).toBeDisabled();
  });
});
