import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConnectionsHealthResponse } from "@osp/contracts";
import {
  makeAppConfig,
  makeBacklogItem,
  makeBurndown,
  makeClosureStats,
  makeConnection,
  makeConnectionHealth,
  makeHealth,
  makeMe,
  makeOffSprintTimeResponse,
  makeProject,
  makeSprint,
  makeSyncStatus,
  makeVaultStatus,
  makeVelocity,
} from "./test/fixtures";

const { mockApi, healthSubscribers } = vi.hoisted(() => ({
  mockApi: {} as Record<string, ReturnType<typeof vi.fn>>,
  healthSubscribers: [] as Array<(h: ConnectionsHealthResponse) => void>,
}));
vi.mock("./api-client", async (orig) => {
  const actual = await orig<typeof import("./api-client")>();
  return {
    ...actual,
    api: mockApi,
    // App subscribes once; tests push live updates through healthSubscribers.
    subscribeConnectionsHealth: (cb: (h: ConnectionsHealthResponse) => void) => {
      healthSubscribers.push(cb);
      return () => {
        const i = healthSubscribers.indexOf(cb);
        if (i >= 0) healthSubscribers.splice(i, 1);
      };
    },
  };
});

import { ApiError } from "./api-client";
import { App } from "./App";

beforeEach(() => {
  for (const k of Object.keys(mockApi)) delete mockApi[k];
  healthSubscribers.length = 0;
  // Vault unlocked + one stored connection → the app is immediately connected
  // (SPEC_02: no token re-entry after unlock).
  // Increment 39: none-mode synthetic local Planner — behaviour unchanged.
  mockApi.getMe = vi.fn().mockResolvedValue(makeMe());
  mockApi.getVaultStatus = vi.fn().mockResolvedValue(makeVaultStatus());
  mockApi.getConnections = vi.fn().mockResolvedValue([makeConnection()]);
  mockApi.getConnectionsHealth = vi.fn().mockResolvedValue(makeHealth());
  mockApi.testConnection = vi.fn().mockResolvedValue(makeConnection());
  mockApi.lockVault = vi.fn().mockResolvedValue(undefined);
  mockApi.getSyncStatus = vi.fn().mockResolvedValue(makeSyncStatus({ last_synced_at: "2026-07-01T11:30:00Z" }));
  mockApi.getSprints = vi.fn().mockResolvedValue([makeSprint({ id: 1, status: "active" })]);
  mockApi.getBacklog = vi.fn().mockResolvedValue([makeBacklogItem({ op_id: 1, subject: "Alpha", effective_hours: 5 })]);
  // Increment 19 (SPEC_19 §1/§3): BacklogScreen now fetches dropdown options
  // from this endpoint too — no App-level test here drives the filters
  // themselves, so an empty facet set is enough to keep it from throwing.
  mockApi.getBacklogFilterOptions = vi.fn().mockResolvedValue({
    projects: [],
    statuses: [],
    assignees: [],
    versions: [],
    priorities: [],
    servers: [],
  });
  mockApi.cancelSync = vi.fn().mockResolvedValue({});
  mockApi.getBurndown = vi.fn().mockResolvedValue(makeBurndown());
  mockApi.getVelocity = vi.fn().mockResolvedValue(makeVelocity());
  mockApi.triggerSync = vi.fn().mockResolvedValue({});
  mockApi.getProjects = vi.fn().mockResolvedValue([makeProject({ op_id: 100 })]);
  // Something already imported → App lands on Backlog after unlock.
  mockApi.getImports = vi.fn().mockResolvedValue([
    { id: 1, project_op_id: 100, project_name: "Demo Project", version_op_id: null, version_name: null, created_at: "2026-06-01T00:00:00Z" },
  ]);
  // Increment 29 (contract §6) — the Import screen's out-of-selection cleanup
  // panel fetches this on mount; empty by default so it never interferes
  // with tests that don't care about it.
  mockApi.getOutOfSelection = vi.fn().mockResolvedValue({ entries: [], total: 0, protected_count: 0 });
  // Increment 31 (docs/INCREMENT_31_CONTRACTS.md §3/§4): the Sprint board's
  // freeze/grace badge and the new Settings tab both fetch this — default so
  // no pre-existing test needs to know about it.
  mockApi.getConfig = vi.fn().mockResolvedValue(makeAppConfig());
  // Increment 32 (docs/INCREMENT_32_CONTRACTS.md §4/§5): the Capacity panel's
  // "Outside the sprint" section — default to "never fetched, no rows" so the
  // one App-level test that reaches the Sprint board tab is unaffected.
  mockApi.getOffSprintTime = vi.fn().mockResolvedValue(makeOffSprintTimeResponse());
});

describe("App vault gate", () => {
  it("shows the create-passphrase screen when the vault is uninitialized", async () => {
    mockApi.getVaultStatus = vi.fn().mockResolvedValue(makeVaultStatus({ initialized: false, locked: true }));
    render(<App />);
    await waitFor(() => expect(screen.getByText("Create passphrase")).toBeInTheDocument());
    expect(screen.getByLabelText("Passphrase (min 8 characters)")).toBeInTheDocument();
    expect(screen.getByText(/cannot be recovered/)).toBeInTheDocument();
    // No app chrome yet.
    expect(screen.queryByRole("button", { name: "Backlog" })).not.toBeInTheDocument();
  });

  it("shows the unlock screen when the vault is locked and surfaces a wrong passphrase", async () => {
    const user = userEvent.setup();
    mockApi.getVaultStatus = vi.fn().mockResolvedValue(makeVaultStatus({ locked: true }));
    mockApi.unlockVault = vi.fn().mockRejectedValue(
      new ApiError(401, { error: { code: "VAULT_INVALID_PASSPHRASE", message: "Invalid passphrase" } }),
    );
    render(<App />);
    await waitFor(() => expect(screen.getByText("Unlock vault")).toBeInTheDocument());

    await user.type(screen.getByLabelText("Passphrase"), "wrong-pass");
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Invalid passphrase"));
    // Still locked.
    expect(screen.getByLabelText("Passphrase")).toBeInTheDocument();
  });

  it("unlocks and proceeds into the app with connections auto-loaded (no token re-entry)", async () => {
    const user = userEvent.setup();
    mockApi.getVaultStatus = vi.fn().mockResolvedValue(makeVaultStatus({ locked: true }));
    mockApi.unlockVault = vi.fn().mockResolvedValue(undefined);
    render(<App />);
    await waitFor(() => expect(screen.getByText("Unlock vault")).toBeInTheDocument());

    await user.type(screen.getByLabelText("Passphrase"), "correct horse");
    await user.click(screen.getByRole("button", { name: "Unlock" }));

    // Lands on Backlog (imports exist) with the stored connection — no setup form.
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());
    expect(mockApi.unlockVault).toHaveBeenCalledWith({ passphrase: "correct horse" });
    expect(mockApi.getConnections).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Backlog" })).not.toBeDisabled();
  });

  it("initializes the vault on first run and continues", async () => {
    const user = userEvent.setup();
    mockApi.getVaultStatus = vi.fn().mockResolvedValue(makeVaultStatus({ initialized: false, locked: true }));
    mockApi.initVault = vi.fn().mockResolvedValue(undefined);
    render(<App />);
    await waitFor(() => expect(screen.getByText("Create passphrase")).toBeInTheDocument());

    await user.type(screen.getByLabelText("Passphrase (min 8 characters)"), "longenough");
    await user.type(screen.getByLabelText("Confirm passphrase"), "longenough");
    await user.click(screen.getByRole("button", { name: "Create vault" }));

    await waitFor(() => expect(mockApi.initVault).toHaveBeenCalledWith({ passphrase: "longenough" }));
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());
  });
});

describe("App", () => {
  it("auto-connects from stored connections and lands on the backlog", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());
    expect(screen.getByLabelText("last synced")).toHaveTextContent("Last synced");
    expect(screen.getByRole("button", { name: "Backlog" })).not.toBeDisabled();
  });

  it("lands on the Import screen when nothing has been imported yet", async () => {
    mockApi.getImports = vi.fn().mockResolvedValue([]);
    render(<App />);
    await waitFor(() => expect(screen.getByText("Import from OpenProject")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("Projects")).toBeInTheDocument());
  });

  it("lands on Setup with tabs gated when no connection is stored", async () => {
    mockApi.getConnections = vi.fn().mockResolvedValue([]);
    mockApi.getConnectionsHealth = vi.fn().mockResolvedValue(makeHealth({ aggregate: "neutral", connections: [] }));
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Add server" })).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Backlog" })).toBeDisabled();
  });

  it("navigates to burndown and velocity charts", async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Burndown" }));
    await waitFor(() => expect(mockApi.getBurndown).toHaveBeenCalledWith(1));
    expect(screen.getByTestId("burndown-chart")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Velocity" }));
    await waitFor(() => expect(mockApi.getVelocity).toHaveBeenCalledWith(1));
    expect(screen.getByText("Recommended capacity")).toBeInTheDocument();
    // Increment 37: Velocity adopts Closure's vocabulary — "Completed" → "Delivered".
    expect(screen.getByText("Avg delivered (2 sprints)")).toBeInTheDocument();
    expect(screen.getByText("Delivered hours by server")).toBeInTheDocument();
  });

  // SPEC_12 §5/§9: "Rebuild burndown from OP history" — a safe, repeatable
  // recompute offered for ANY sprint, no confirmation needed (never touches
  // lock state server-side).
  it("rebuilds the burndown from OP history and refreshes the chart", async () => {
    const user = userEvent.setup();
    mockApi.rebuildBurndown = vi.fn().mockResolvedValue(makeBurndown());
    render(<App />);
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Burndown" }));
    await waitFor(() => expect(mockApi.getBurndown).toHaveBeenCalledWith(1));

    await user.click(screen.getByRole("button", { name: "Rebuild burndown from OP history" }));
    await waitFor(() => expect(mockApi.rebuildBurndown).toHaveBeenCalledWith(1));
    // Reloads via the existing GET burndown (once on mount, once after rebuild).
    await waitFor(() => expect(mockApi.getBurndown).toHaveBeenCalledTimes(2));
  });

  // SPEC_12 §4/§9/§12.3: retrospective sprints count in velocity but must be
  // visibly badged, not silently blended in with live-planned sprints.
  it("badges a retrospective sprint's row in the Velocity history", async () => {
    const user = userEvent.setup();
    mockApi.getSprints = vi.fn().mockResolvedValue([makeSprint({ id: 1, status: "active", is_retrospective: true })]);
    render(<App />);
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Velocity" }));
    await waitFor(() => expect(mockApi.getVelocity).toHaveBeenCalledWith(1));
    // makeVelocity's default history includes sprint_id 1 ("Sprint 1"), which
    // now matches the retrospective sprint from getSprints.
    expect(screen.getByTestId("retro-badge-velocity-1")).toBeInTheDocument();
  });

  it("triggers a sync from the header", async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Sync now" }));
    // "Sync now" refreshes every recorded import (empty body).
    await waitFor(() => expect(mockApi.triggerSync).toHaveBeenCalledWith({}));
  });

  // Increment 23 (SPEC_23 §1): the root bug — one disconnected connection
  // used to 409 the ENTIRE refresh-all "Sync now", even when every OTHER
  // connection was healthy. The backend now returns a per-connection
  // breakdown instead of a bare SyncRun for a refresh-all call; the frontend
  // must discriminate the shape and surface every connection's own outcome,
  // never collapse it back into a single pass/fail.
  it("shows a per-connection summary after a refresh-all 'Sync now' that skipped one disconnected connection", async () => {
    const user = userEvent.setup();
    mockApi.triggerSync = vi.fn().mockResolvedValue({
      connections: [
        {
          connection_id: 1,
          connection_label: "Acme",
          status: "synced",
          run: {
            id: 8,
            started_at: "2026-07-01T11:59:00Z",
            finished_at: "2026-07-01T12:00:00Z",
            kind: "full",
            wp_count: 3,
            total_count: 3,
            status: "success",
            error: null,
            cancel_requested: false,
            last_progress_at: "2026-07-01T11:59:30Z",
          },
          message: "updated 3 tickets",
        },
        {
          connection_id: 2,
          connection_label: "mock",
          status: "skipped",
          run: null,
          message: "disconnected",
        },
      ],
      last: null,
    });
    render(<App />);
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(screen.getByLabelText("sync summary")).toBeInTheDocument());
    const summary = screen.getByLabelText("sync summary");
    expect(summary).toHaveTextContent("Acme: updated 3 ticket");
    expect(summary).toHaveTextContent("mock: skipped (disconnected)");
    // Never a bare, unexplained whole-sync failure — no error surfaced for
    // the healthy connection just because the other was down.
    expect(screen.queryByLabelText("sync error")).not.toBeInTheDocument();

    // Affected data actually refetches — not just a toast over stale numbers.
    await waitFor(() => expect(mockApi.getBacklog!.mock.calls.length).toBeGreaterThan(1));
  });

  // A bare SyncRun (single-project sync shape, or any triggerSync mock that
  // doesn't include `connections`) must never render the per-connection
  // summary panel — every existing "Sync now" test above uses `{}`/plain
  // SyncRun-ish mocks and already implicitly covers this, asserted here
  // explicitly for the new discriminator.
  it("never shows the per-connection summary for a bare SyncRun response", async () => {
    const user = userEvent.setup();
    render(<App />); // beforeEach's default mockApi.triggerSync resolves `{}`.
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(mockApi.triggerSync).toHaveBeenCalled());
    expect(screen.queryByLabelText("sync summary")).not.toBeInTheDocument();
  });

  // Increment 22: a 409 SYNC_IN_PROGRESS never creates a sync_run row for
  // THIS attempt, so unlike every other outcome there is nothing for the
  // next status poll to surface — App.tsx has to capture it from the
  // rejected promise itself and the header must offer a real Cancel action.
  it("shows a running-since message and a Cancel action for a 409 SYNC_IN_PROGRESS conflict, and cancels via the API", async () => {
    const user = userEvent.setup();
    mockApi.triggerSync = vi.fn().mockRejectedValue(
      new ApiError(409, {
        error: {
          code: "SYNC_IN_PROGRESS",
          message: "A sync is already running (started 2026-07-01T12:00:00Z)",
          details: {
            runId: 9,
            started_at: "2026-07-01T12:00:00Z",
            last_progress_at: "2026-07-01T12:00:30Z",
          },
        },
      }),
    );
    render(<App />);
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(screen.getByLabelText("sync conflict")).toBeInTheDocument());
    expect(screen.getByLabelText("sync conflict")).toHaveTextContent(
      "A sync is already running",
    );
    // Not swallowed silently — the old empty catch handler left no trace here.
    expect(screen.queryByLabelText("last synced")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel it" }));
    await waitFor(() => expect(mockApi.cancelSync).toHaveBeenCalledWith(9));
    await waitFor(() =>
      expect(screen.queryByLabelText("sync conflict")).not.toBeInTheDocument(),
    );
  });

  // SPEC_22 §4: every "Sync now" outcome must be visibly reported — a
  // successful sync that touched 0 work packages must not look identical to
  // one that changed nothing having happened at all.
  it("shows 'no changes' after a successful sync that processed 0 work packages", async () => {
    const user = userEvent.setup();
    mockApi.getSyncStatus = vi
      .fn()
      .mockResolvedValueOnce(makeSyncStatus({ last_synced_at: null }))
      .mockResolvedValue(
        makeSyncStatus({
          last_synced_at: "2026-07-01T12:00:00Z",
          last: {
            id: 8,
            started_at: "2026-07-01T11:59:00Z",
            finished_at: "2026-07-01T12:00:00Z",
            kind: "full",
            wp_count: 0,
            total_count: 0,
            status: "success",
            error: null,
            cancel_requested: false,
            last_progress_at: "2026-07-01T11:59:30Z",
          },
        }),
      );
    render(<App />);
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(mockApi.triggerSync).toHaveBeenCalled());

    await waitFor(() =>
      expect(screen.getByLabelText("last synced")).toHaveTextContent("no changes"),
    );
  });

  it("shows 'updated N' after a successful sync that processed N work packages", async () => {
    const user = userEvent.setup();
    mockApi.getSyncStatus = vi
      .fn()
      .mockResolvedValueOnce(makeSyncStatus({ last_synced_at: null }))
      .mockResolvedValue(
        makeSyncStatus({
          last_synced_at: "2026-07-01T12:00:00Z",
          last: {
            id: 8,
            started_at: "2026-07-01T11:59:00Z",
            finished_at: "2026-07-01T12:00:00Z",
            kind: "full",
            wp_count: 3,
            total_count: 3,
            status: "success",
            error: null,
            cancel_requested: false,
            last_progress_at: "2026-07-01T11:59:30Z",
          },
        }),
      );
    render(<App />);
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(mockApi.triggerSync).toHaveBeenCalled());

    await waitFor(() =>
      expect(screen.getByLabelText("last synced")).toHaveTextContent("updated 3"),
    );
  });

  it("refreshes the header last-synced label after a sync (never → real time)", async () => {
    const user = userEvent.setup();
    // First status has never synced; after a sync it returns a fresh timestamp.
    mockApi.getSyncStatus = vi
      .fn()
      .mockResolvedValueOnce(makeSyncStatus({ last_synced_at: null }))
      .mockResolvedValue(makeSyncStatus({ last_synced_at: new Date().toISOString() }));
    render(<App />);

    // Header initially shows "never".
    await waitFor(() =>
      expect(screen.getByLabelText("last synced")).toHaveTextContent("Last synced never"),
    );

    await user.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(mockApi.triggerSync).toHaveBeenCalled());

    // After the sync completes the status is refetched and a real label shown.
    await waitFor(() =>
      expect(screen.getByLabelText("last synced")).toHaveTextContent("Last synced just now"),
    );
    expect(screen.getByLabelText("last synced")).not.toHaveTextContent("never");
    // Status was read again after the sync (initial load + post-sync refetch).
    expect(mockApi.getSyncStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("refreshes connection health after a user-triggered sync", async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());
    const before = mockApi.getConnectionsHealth!.mock.calls.length;

    await user.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(mockApi.triggerSync).toHaveBeenCalled());
    await waitFor(() =>
      expect(mockApi.getConnectionsHealth!.mock.calls.length).toBeGreaterThan(before),
    );
  });

  // Increment 29 §7 (orchestrator correction to the frozen contract) — a
  // refresh-all is N+1 SEPARATE sync_run commits (one per import selection,
  // plus the coverage pass), each with its own atomic staging commit, not one
  // atomic operation. The 1s progress poll must therefore refresh ONLY the
  // sync-status/progress-bar display; capacity and closure (like every other
  // refreshKey consumer) must keep showing the pre-sync, fully-settled
  // numbers throughout the run and refetch exactly once, after it finishes —
  // otherwise a genuinely half-updated intermediate cache state gets
  // rendered mid-sync (SPEC_28 §1.2's "44h at Starting → 4h at Importing
  // 9/14", which was never a caching bug).
  it("does not refetch capacity/closure while a sync is in flight, and refetches exactly once after it settles", async () => {
    const user = userEvent.setup();
    mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue([]);
    mockApi.getCapacity = vi.fn().mockResolvedValue({
      capacity_mode: "per_person",
      members: [],
      lines: [],
      total_available_hours: 0,
      total_planned_hours: 0,
      baseline_total_hours: null,
      scope_planned_hours: 0,
      scope_delivered_hours: 0,
    });
    mockApi.getClosureStats = vi.fn().mockResolvedValue(makeClosureStats());

    let resolveSync: (v: unknown) => void = () => {};
    mockApi.triggerSync = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSync = resolve;
        }),
    );

    render(<App />);
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Sprint board" }));
    await waitFor(() => expect(mockApi.getCapacity).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockApi.getClosureStats).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(mockApi.triggerSync).toHaveBeenCalled());

    // Let several real 1s poll ticks elapse while the sync is still pending —
    // proven alive via the sync-status poll advancing.
    const statusCallsAtStart = mockApi.getSyncStatus!.mock.calls.length;
    await waitFor(() => expect(mockApi.getSyncStatus!.mock.calls.length).toBeGreaterThan(statusCallsAtStart), {
      timeout: 2500,
    });

    // Capacity/closure must NOT have refetched — they depend on refreshKey,
    // not the sync poll.
    expect(mockApi.getCapacity).toHaveBeenCalledTimes(1);
    expect(mockApi.getClosureStats).toHaveBeenCalledTimes(1);

    // Settle the sync — refreshKey bumps exactly once, in `finally`.
    await act(async () => {
      resolveSync({});
    });

    await waitFor(() => expect(mockApi.getCapacity).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mockApi.getClosureStats).toHaveBeenCalledTimes(2));
  });

  it("shows a sync progress bar while a sync is running", async () => {
    // A running sync with a known total drives the header progress bar.
    mockApi.getSyncStatus = vi.fn().mockResolvedValue(
      makeSyncStatus({
        current: {
          id: 5,
          started_at: "2026-07-01T12:00:00Z",
          finished_at: null,
          kind: "full",
          wp_count: 120,
          total_count: 600,
          status: "running",
          error: null,
          cancel_requested: false,
          last_progress_at: null,
        },
        last_synced_at: null,
        current_elapsed_ms: 7_000,
      }),
    );
    render(<App />);

    await waitFor(() => expect(screen.getByLabelText("sync progress")).toBeInTheDocument());
    expect(screen.getByLabelText("sync progress").textContent).toContain("120/600");
  });

  it("shows elapsed mm:ss and an Abort button while a sync is running, and cancels via the API (SPEC_19 §2b/§2c)", async () => {
    const user = userEvent.setup();
    mockApi.getSyncStatus = vi.fn().mockResolvedValue(
      makeSyncStatus({
        current: {
          id: 5,
          started_at: "2026-07-01T12:00:00Z",
          finished_at: null,
          kind: "full",
          wp_count: 120,
          total_count: 600,
          status: "running",
          error: null,
          cancel_requested: false,
          last_progress_at: null,
        },
        last_synced_at: null,
        current_elapsed_ms: 67_000, // 1 min 7 s
      }),
    );
    render(<App />);

    await waitFor(() => expect(screen.getByLabelText("sync progress")).toBeInTheDocument());
    expect(screen.getByLabelText("sync progress").textContent).toContain("01:07");

    const abortBtn = screen.getByRole("button", { name: "Abort sync" });
    expect(abortBtn).toBeEnabled();
    expect(abortBtn).toHaveTextContent("Abort");

    await user.click(abortBtn);
    await waitFor(() => expect(mockApi.cancelSync).toHaveBeenCalledWith(5));
    // Disabled + "Cancelling…" immediately on click, before the next poll
    // could possibly confirm the server has observed the cancellation.
    expect(screen.getByRole("button", { name: "Abort sync" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Abort sync" })).toHaveTextContent("Cancelling…");
  });

  it("shows Cancelling… (and disables Abort) once a poll reports cancel_requested, even without a local click — another tab could have triggered it", async () => {
    mockApi.getSyncStatus = vi.fn().mockResolvedValue(
      makeSyncStatus({
        current: {
          id: 5,
          started_at: "2026-07-01T12:00:00Z",
          finished_at: null,
          kind: "full",
          wp_count: 10,
          total_count: 100,
          status: "running",
          error: null,
          cancel_requested: true,
          last_progress_at: null,
        },
        last_synced_at: null,
        current_elapsed_ms: 1_000,
      }),
    );
    render(<App />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Abort sync" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Abort sync" })).toHaveTextContent("Cancelling…");
  });

  it("shows a distinct 'sync cancelled' message after an aborted run, instead of the normal last-synced label", async () => {
    mockApi.getSyncStatus = vi.fn().mockResolvedValue(
      makeSyncStatus({
        current: null,
        last: {
          id: 5,
          started_at: "2026-07-01T12:00:00Z",
          finished_at: "2026-07-01T12:01:00Z",
          kind: "full",
          wp_count: 42,
          total_count: 600,
          status: "aborted",
          error: null,
          cancel_requested: true,
          last_progress_at: null,
        },
        last_synced_at: null,
        current_elapsed_ms: null,
      }),
    );
    render(<App />);

    await waitFor(() => expect(screen.getByLabelText("sync cancelled")).toBeInTheDocument());
    expect(screen.getByLabelText("sync cancelled")).toHaveTextContent(
      "Sync cancelled — backlog unchanged",
    );
    expect(screen.queryByLabelText("last synced")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Abort sync" })).not.toBeInTheDocument();
  });

  // Increment 20 (SPEC_20 §3): a mid-sync watchdog "no progress" stop ends
  // the run as status "error" (not "aborted"), distinct from an immediate
  // connection-failure error a user would already have seen pre-Increment 20.
  // Models a real poll sequence: the header shows live progress while
  // `triggerSync`'s request is in flight (polled every 1s by `runSync`'s own
  // interval, per App.tsx), then — once the backend request itself settles
  // with the watchdog's error — the final post-sync refetch reflects the
  // terminal "error" state with its descriptive message.
  it("shows the watchdog's no-progress error message after a mid-sync stall stop", async () => {
    const user = userEvent.setup();
    let resolveTrigger!: (run: unknown) => void;
    mockApi.triggerSync = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveTrigger = resolve;
      }),
    );
    mockApi.getSyncStatus = vi
      .fn()
      .mockResolvedValueOnce(makeSyncStatus({ last_synced_at: null }))
      .mockResolvedValue(
        makeSyncStatus({
          current: {
            id: 6,
            started_at: "2026-07-01T12:00:00Z",
            finished_at: null,
            kind: "full",
            wp_count: 80,
            total_count: 600,
            status: "running",
            error: null,
            cancel_requested: false,
            last_progress_at: "2026-07-01T12:00:30Z",
          },
          last_synced_at: null,
          current_elapsed_ms: 30_000,
        }),
      );
    render(<App />);
    await waitFor(() =>
      expect(screen.getByLabelText("last synced")).toHaveTextContent("Last synced never"),
    );

    await user.click(screen.getByRole("button", { name: "Sync now" }));

    // The 1s poll (started by runSync while triggerSync is still in flight)
    // picks up the running state.
    await waitFor(
      () => expect(screen.getByLabelText("sync progress")).toBeInTheDocument(),
      { timeout: 3000 },
    );

    // The backend request itself now settles (watchdog fired mid-sync) — the
    // next status fetch, triggered by runSync's own post-completion refetch,
    // reports the terminal "error" state with the watchdog's message.
    mockApi.getSyncStatus.mockResolvedValue(
      makeSyncStatus({
        current: null,
        last: {
          id: 6,
          started_at: "2026-07-01T12:00:00Z",
          finished_at: "2026-07-01T12:01:30Z",
          kind: "full",
          wp_count: 80,
          total_count: 600,
          status: "error",
          error: "Sync watchdog: no progress for 60s, aborting",
          cancel_requested: false,
          last_progress_at: "2026-07-01T12:00:30Z",
        },
        last_synced_at: null,
        current_elapsed_ms: null,
      }),
    );
    resolveTrigger({});

    await waitFor(() => expect(screen.getByLabelText("sync error")).toBeInTheDocument());
    expect(screen.getByLabelText("sync error")).toHaveTextContent(
      "Sync failed — Sync watchdog: no progress for 60s, aborting",
    );
    expect(screen.queryByLabelText("sync progress")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Abort sync" })).not.toBeInTheDocument();
  });

  // Increment 20 (SPEC_20 §3): the watchdog's max-duration (15 min) cutoff
  // also ends a run as "aborted" — same status value as a user's own Cancel
  // click — but nobody clicked anything, so cancel_requested stays false.
  // The UI must still resolve cleanly out of "running"/"cancelling" and use
  // the distinct auto-stop copy rather than "Sync cancelled".
  it("resolves cleanly after a watchdog max-duration auto-abort (cancel_requested: false)", async () => {
    const user = userEvent.setup();
    let resolveTrigger!: (run: unknown) => void;
    mockApi.triggerSync = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveTrigger = resolve;
      }),
    );
    mockApi.getSyncStatus = vi
      .fn()
      .mockResolvedValueOnce(makeSyncStatus({ last_synced_at: null }))
      .mockResolvedValue(
        makeSyncStatus({
          current: {
            id: 7,
            started_at: "2026-07-01T12:00:00Z",
            finished_at: null,
            kind: "full",
            wp_count: 500,
            total_count: 600,
            status: "running",
            error: null,
            cancel_requested: false,
            last_progress_at: "2026-07-01T12:14:59Z",
          },
          last_synced_at: null,
          current_elapsed_ms: 900_000,
        }),
      );
    render(<App />);
    await waitFor(() =>
      expect(screen.getByLabelText("last synced")).toHaveTextContent("Last synced never"),
    );

    await user.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(
      () => expect(screen.getByLabelText("sync progress")).toBeInTheDocument(),
      { timeout: 3000 },
    );

    mockApi.getSyncStatus.mockResolvedValue(
      makeSyncStatus({
        current: null,
        last: {
          id: 7,
          started_at: "2026-07-01T12:00:00Z",
          finished_at: "2026-07-01T12:15:00Z",
          kind: "full",
          wp_count: 500,
          total_count: 600,
          status: "aborted",
          error: null,
          cancel_requested: false,
          last_progress_at: "2026-07-01T12:14:59Z",
        },
        last_synced_at: null,
        current_elapsed_ms: null,
      }),
    );
    resolveTrigger({});

    await waitFor(() => expect(screen.getByLabelText("sync stopped")).toBeInTheDocument());
    expect(screen.getByLabelText("sync stopped")).toHaveTextContent(
      "Sync stopped automatically (ran too long) — backlog unchanged",
    );
    expect(screen.queryByLabelText("sync progress")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Abort sync" })).not.toBeInTheDocument();
  });
});

describe("Header connection status", () => {
  it("shows the aggregate dot color and the current server URL", async () => {
    mockApi.getConnectionsHealth = vi.fn().mockResolvedValue(makeHealth({ aggregate: "green" }));
    render(<App />);
    await waitFor(() =>
      expect(screen.getByLabelText("connection status: green")).toBeInTheDocument(),
    );
    expect(screen.getByLabelText("connection status: green")).toHaveTextContent(
      "https://op.example.com",
    );
  });

  it("reflects a degraded aggregate (orange) and live updates from the feed", async () => {
    mockApi.getConnectionsHealth = vi.fn().mockResolvedValue(makeHealth({ aggregate: "orange" }));
    render(<App />);
    await waitFor(() =>
      expect(screen.getByLabelText("connection status: orange")).toBeInTheDocument(),
    );

    // A live push from the subscription recolors the dot without any refetch.
    act(() => {
      for (const cb of healthSubscribers) cb(makeHealth({ aggregate: "red" }));
    });
    await waitFor(() =>
      expect(screen.getByLabelText("connection status: red")).toBeInTheDocument(),
    );
  });

  it("opens the popover with per-server health, errors and a Test now action", async () => {
    const user = userEvent.setup();
    const okConn = makeConnection({ id: 1, base_url: "https://op.example.com", label: "Prod" });
    const failConn = makeConnection({
      id: 2,
      base_url: "https://down.example.com",
      is_current: false,
      health: makeConnectionHealth({ last_status: "fail", last_latency_ms: null, last_error: "connect ECONNREFUSED" }),
    });
    mockApi.getConnections = vi.fn().mockResolvedValue([okConn, failConn]);
    mockApi.getConnectionsHealth = vi
      .fn()
      .mockResolvedValue(makeHealth({ aggregate: "orange", connections: [okConn, failConn] }));

    render(<App />);
    await waitFor(() =>
      expect(screen.getByLabelText("connection status: orange")).toBeInTheDocument(),
    );

    await user.click(screen.getByLabelText("connection status: orange"));
    const popover = screen.getByRole("dialog", { name: "Connections" });
    expect(popover).toHaveTextContent("https://op.example.com");
    expect(popover).toHaveTextContent("Prod");
    expect(popover).toHaveTextContent("https://down.example.com");
    expect(popover).toHaveTextContent("42 ms");
    expect(popover).toHaveTextContent("connect ECONNREFUSED");
    expect(screen.getByLabelText("server status: ok")).toBeInTheDocument();
    expect(screen.getByLabelText("server status: fail")).toBeInTheDocument();

    // "Test now" hits the per-connection test endpoint and refreshes health.
    const before = mockApi.getConnectionsHealth!.mock.calls.length;
    await user.click(screen.getAllByRole("button", { name: "Test now" })[1]!);
    await waitFor(() => expect(mockApi.testConnection).toHaveBeenCalledWith(2));
    await waitFor(() =>
      expect(mockApi.getConnectionsHealth!.mock.calls.length).toBeGreaterThan(before),
    );
  });

  it("closes the popover on outside-click (SPEC_10 §b)", async () => {
    const user = userEvent.setup();
    mockApi.getConnectionsHealth = vi.fn().mockResolvedValue(makeHealth({ aggregate: "green" }));

    render(<App />);
    await waitFor(() =>
      expect(screen.getByLabelText("connection status: green")).toBeInTheDocument(),
    );

    await user.click(screen.getByLabelText("connection status: green"));
    expect(screen.getByRole("dialog", { name: "Connections" })).toBeInTheDocument();

    // Click anywhere outside the popover's DOM subtree — not just anywhere.
    await user.click(document.body);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Connections" })).not.toBeInTheDocument(),
    );
  });

  it("closes the popover on Escape and returns focus to the trigger (SPEC_10 §b)", async () => {
    const user = userEvent.setup();
    mockApi.getConnectionsHealth = vi.fn().mockResolvedValue(makeHealth({ aggregate: "green" }));

    render(<App />);
    await waitFor(() =>
      expect(screen.getByLabelText("connection status: green")).toBeInTheDocument(),
    );

    const trigger = screen.getByLabelText("connection status: green");
    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "Connections" })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Connections" })).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
  });

  it("locks the vault from the popover and returns to the unlock screen", async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() =>
      expect(screen.getByLabelText("connection status: green")).toBeInTheDocument(),
    );

    await user.click(screen.getByLabelText("connection status: green"));
    await user.click(screen.getByRole("button", { name: "Lock vault" }));

    await waitFor(() => expect(mockApi.lockVault).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText("Unlock vault")).toBeInTheDocument());
  });
});
