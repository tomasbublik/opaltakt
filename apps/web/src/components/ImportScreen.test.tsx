import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProjectWithConnection } from "@osp/contracts";

const { mockApi } = vi.hoisted(() => ({ mockApi: {} as Record<string, ReturnType<typeof vi.fn>> }));
vi.mock("../api-client", async (orig) => {
  const actual = await orig<typeof import("../api-client")>();
  return { ...actual, api: mockApi };
});

import { ImportScreen } from "./ImportScreen";

const versions = [
  { op_id: 10, name: "Release 1" },
  { op_id: 11, name: "Release 2" },
  { op_id: 12, name: "Backlog" },
];

function makeProject(over: Partial<ProjectWithConnection> = {}): ProjectWithConnection {
  return {
    id: 1,
    connection_id: 1,
    connection_base_url: "https://op-a.example.com",
    connection_label: null,
    op_id: 100,
    identifier: "demo",
    name: "Demo Project",
    last_synced_at: null,
    ...over,
  };
}

function makeImport(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    connection_id: 1,
    connection_base_url: "https://op-a.example.com",
    connection_label: null,
    project_op_id: 100,
    project_name: "Platform",
    version_op_id: null,
    version_name: null,
    created_at: "2026-06-01T00:00:00Z",
    ...over,
  };
}

beforeEach(() => {
  for (const k of Object.keys(mockApi)) delete mockApi[k];
  mockApi.getProjects = vi.fn().mockResolvedValue([
    makeProject({ op_id: 100, name: "Platform" }),
    makeProject({ op_id: 200, name: "Demo Project" }),
  ]);
  mockApi.getVersions = vi.fn().mockResolvedValue(versions);
  mockApi.getImports = vi.fn().mockResolvedValue([]);
  mockApi.removeImport = vi.fn().mockResolvedValue({
    deleted: true,
    removed_ticket_count: 0,
    protected_ticket_count: 0,
  });
  // Increment 29 (contract §6) — out-of-selection cleanup panel, empty by
  // default; individual tests below override it.
  mockApi.getOutOfSelection = vi.fn().mockResolvedValue({ entries: [], total: 0, protected_count: 0 });
});

function makeSyncRun(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    started_at: "2026-06-01T00:00:00Z",
    finished_at: "2026-06-01T00:01:00Z",
    kind: "manual",
    wp_count: 5,
    total_count: 5,
    status: "success",
    error: null,
    ...over,
  };
}

function renderScreen(onImport = vi.fn().mockResolvedValue(makeSyncRun())) {
  const onViewBacklog = vi.fn();
  const onAdded = vi.fn();
  const onRemoved = vi.fn();
  render(
    <ImportScreen
      refreshKey={0}
      onImport={onImport}
      onAdded={onAdded}
      onRemoved={onRemoved}
      onViewBacklog={onViewBacklog}
    />,
  );
  return { onImport, onViewBacklog, onAdded, onRemoved };
}

describe("ImportScreen", () => {
  it("loads versions when a single project is picked and filters them by search", async () => {
    const user = userEvent.setup();
    renderScreen();
    await waitFor(() => expect(screen.getByText("Platform")).toBeInTheDocument());

    await user.click(screen.getByRole("checkbox", { name: "Platform" }));
    await waitFor(() => expect(mockApi.getVersions).toHaveBeenCalledWith(100, 1));

    expect(screen.getByLabelText("Release 1")).toBeInTheDocument();
    expect(screen.getByLabelText("Release 2")).toBeInTheDocument();
    expect(screen.getByLabelText("Backlog")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Search versions"), "release");
    await waitFor(() => expect(screen.queryByLabelText("Backlog")).not.toBeInTheDocument());
    expect(screen.getByLabelText("Release 1")).toBeInTheDocument();
    expect(screen.getByLabelText("Release 2")).toBeInTheDocument();
  });

  it("imports WITHOUT a version when 'All versions' is selected", async () => {
    const user = userEvent.setup();
    const { onImport } = renderScreen();
    await waitFor(() => expect(screen.getByText("Platform")).toBeInTheDocument());

    await user.click(screen.getByRole("checkbox", { name: "Platform" }));
    await waitFor(() => expect(screen.getByLabelText("Release 1")).toBeInTheDocument());

    // "All versions" is the default selection.
    await user.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() =>
      expect(onImport).toHaveBeenCalledWith({ project_op_id: 100, connection_id: 1 }),
    );
  });

  it("imports WITH version_op_id when a version is chosen", async () => {
    const user = userEvent.setup();
    const { onImport } = renderScreen();
    await waitFor(() => expect(screen.getByText("Platform")).toBeInTheDocument());

    await user.click(screen.getByRole("checkbox", { name: "Platform" }));
    await waitFor(() => expect(screen.getByLabelText("Release 2")).toBeInTheDocument());

    await user.click(screen.getByLabelText("Release 2"));
    await user.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() =>
      expect(onImport).toHaveBeenCalledWith({
        project_op_id: 100,
        version_op_id: 11,
        connection_id: 1,
      }),
    );
  });

  it("groups projects by server and imports every selected project as a whole when 2+ are picked", async () => {
    mockApi.getProjects = vi.fn().mockResolvedValue([
      makeProject({
        op_id: 100,
        name: "Platform",
        connection_id: 1,
        connection_base_url: "https://op-a.example.com",
      }),
      makeProject({
        op_id: 3,
        name: "Demo Project",
        connection_id: 2,
        connection_base_url: "http://127.0.0.1:8099",
        connection_label: "Mock",
      }),
    ]);
    const user = userEvent.setup();
    const { onImport } = renderScreen();
    await waitFor(() => expect(screen.getByText("Platform")).toBeInTheDocument());

    // Two distinct server groups are rendered.
    expect(screen.getByText("https://op-a.example.com")).toBeInTheDocument();
    expect(screen.getByText("Mock")).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Platform" }));
    await user.click(screen.getByRole("checkbox", { name: "Demo Project" }));

    // No version narrowing once 2+ projects are selected.
    expect(screen.queryByLabelText("Search versions")).not.toBeInTheDocument();
    expect(screen.getByText(/2 projects selected/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Import 2 projects" }));
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(2));
    expect(onImport).toHaveBeenCalledWith({ project_op_id: 100, connection_id: 1 });
    expect(onImport).toHaveBeenCalledWith({ project_op_id: 3, connection_id: 2 });
  });

  it("selects every project in a server group via the group checkbox", async () => {
    mockApi.getProjects = vi.fn().mockResolvedValue([
      makeProject({ op_id: 100, name: "Platform", connection_id: 1 }),
      makeProject({ op_id: 101, name: "Backend", connection_id: 1 }),
    ]);
    const user = userEvent.setup();
    const { onImport } = renderScreen();
    await waitFor(() => expect(screen.getByText("Platform")).toBeInTheDocument());

    await user.click(screen.getByLabelText("Select all projects from https://op-a.example.com"));
    await user.click(screen.getByRole("button", { name: "Import 2 projects" }));
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(2));
  });

  it("resets the picker after a successful import", async () => {
    const user = userEvent.setup();
    renderScreen();
    await waitFor(() => expect(screen.getByText("Platform")).toBeInTheDocument());

    await user.click(screen.getByRole("checkbox", { name: "Platform" }));
    await waitFor(() => expect(screen.getByLabelText("Release 1")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Import" }));

    // Version list disappears once the selection is cleared.
    await waitFor(() => expect(screen.queryByLabelText("Release 1")).not.toBeInTheDocument());
    expect(screen.getByRole("checkbox", { name: "Platform" })).not.toBeChecked();
  });

  it("lists the already-imported selections as chips with server info", async () => {
    mockApi.getImports = vi.fn().mockResolvedValue([
      makeImport({
        id: 1,
        project_name: "Platform",
        version_op_id: 10,
        version_name: "R1",
        connection_base_url: "https://op-a.example.com",
        connection_label: null,
      }),
      makeImport({
        id: 2,
        project_name: "Demo Project",
        version_op_id: null,
        version_name: null,
        connection_base_url: "http://127.0.0.1:8099",
        connection_label: "Mock",
      }),
    ]);
    renderScreen();

    await waitFor(() => expect(screen.getByText(/Platform · R1/)).toBeInTheDocument());
    expect(screen.getByText(/Demo Project · all versions/)).toBeInTheDocument();
    expect(screen.getByText(/\(Mock\)/)).toBeInTheDocument();
  });

  it("removes an import via the × button and notifies the app", async () => {
    mockApi.getImports = vi.fn().mockResolvedValue([makeImport({ id: 7, project_name: "Platform" })]);
    const user = userEvent.setup();
    const { onRemoved } = renderScreen();

    await waitFor(() => expect(screen.getByText(/Platform · all versions/)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Remove Platform import" }));

    await waitFor(() => expect(mockApi.removeImport).toHaveBeenCalledWith(7));
    await waitFor(() => expect(onRemoved).toHaveBeenCalled());
  });

  it("shows a per-project result after a single-project import", async () => {
    const user = userEvent.setup();
    const onImport = vi.fn().mockResolvedValue(makeSyncRun({ wp_count: 7 }));
    renderScreen(onImport);
    await waitFor(() => expect(screen.getByText("Platform")).toBeInTheDocument());

    await user.click(screen.getByRole("checkbox", { name: "Platform" }));
    await waitFor(() => expect(screen.getByLabelText("Release 1")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(screen.getByTestId("import-results")).toBeInTheDocument());
    expect(screen.getByTestId("import-result-100")).toHaveTextContent(
      "Platform: 7 ticket(s) imported",
    );
  });

  it("continues past a failing project in a multi-project import and reports each outcome", async () => {
    mockApi.getProjects = vi.fn().mockResolvedValue([
      makeProject({
        op_id: 100,
        name: "Platform",
        connection_id: 1,
        connection_base_url: "https://op-a.example.com",
      }),
      makeProject({
        op_id: 3,
        name: "Demo Project",
        connection_id: 2,
        connection_base_url: "http://127.0.0.1:8099",
        connection_label: "Mock",
      }),
    ]);
    const user = userEvent.setup();
    const onImport = vi
      .fn()
      .mockImplementationOnce(() => Promise.reject(new Error("boom")))
      .mockImplementationOnce(() => Promise.resolve(makeSyncRun({ wp_count: 3 })));
    renderScreen(onImport);
    await waitFor(() => expect(screen.getByText("Platform")).toBeInTheDocument());

    await user.click(screen.getByRole("checkbox", { name: "Platform" }));
    await user.click(screen.getByRole("checkbox", { name: "Demo Project" }));
    await user.click(screen.getByRole("button", { name: "Import 2 projects" }));

    // Both projects get an attempt even though the first one failed.
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("import-result-100")).toBeInTheDocument());
    expect(screen.getByTestId("import-result-100")).toHaveTextContent(
      "Platform: import failed — boom",
    );
    expect(screen.getByTestId("import-result-3")).toHaveTextContent(
      "Demo Project: 3 ticket(s) imported",
    );
  });

  it("shows an aborted project as incomplete, not a clean success (SPEC_19 §2c)", async () => {
    const user = userEvent.setup();
    // The blocking sync RESOLVES (doesn't throw) when cancelled mid-project —
    // it must not read as a plain success just because wp_count > 0.
    const onImport = vi.fn().mockResolvedValue(makeSyncRun({ status: "aborted", wp_count: 3 }));
    renderScreen(onImport);
    await waitFor(() => expect(screen.getByText("Platform")).toBeInTheDocument());

    await user.click(screen.getByRole("checkbox", { name: "Platform" }));
    await waitFor(() => expect(screen.getByLabelText("Release 1")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(screen.getByTestId("import-result-100")).toBeInTheDocument());
    const result = screen.getByTestId("import-result-100");
    expect(result).toHaveTextContent(/cancelled/i);
    expect(result).toHaveTextContent("3");
    // The "ok"/success styling never applies to an aborted project.
    expect(result.className).not.toMatch(/\bok\b/);
  });

  it("adds a single ticket by id and refreshes", async () => {
    const user = userEvent.setup();
    mockApi.importWorkPackage = vi.fn().mockResolvedValue({ op_id: 6705, subject: "Fix HSM timeout" });
    const { onAdded } = renderScreen();
    await waitFor(() => expect(screen.getByLabelText("Work package ID")).toBeInTheDocument());

    await user.type(screen.getByLabelText("Work package ID"), "6705");
    await user.click(screen.getByRole("button", { name: "Add ticket" }));

    await waitFor(() => expect(mockApi.importWorkPackage).toHaveBeenCalledWith(6705));
    expect(await screen.findByText(/Added #6705 — Fix HSM timeout/)).toBeInTheDocument();
    expect(onAdded).toHaveBeenCalled();
  });
});

/**
 * Increment 29 (docs/INCREMENT_29_CONTRACTS.md §6, contract §6) — the
 * out-of-selection cleanup panel: protected rows must be unselectable and
 * excluded from "select all", and the three-bucket delete response
 * (removed/protected/rejected) must be reported, not assumed.
 *
 * Increment 31 (docs/INCREMENT_31_CONTRACTS.md §3/§4) revised the rule:
 * `protected` (not `in_sprint`) drives deletability — a FROZEN sprint no
 * longer protects its tickets, shown instead via `frozen_sprint_names` as a
 * muted "removable" note. `in_sprint`/`sprint_names` stay on the entry
 * (informational — `sprint_names` now lists only the PROTECTING sprints).
 */
function makeEntry(over: Record<string, unknown> = {}) {
  return {
    op_id: 42,
    subject: "Old ticket",
    project_op_id: 100,
    project_name: "Platform",
    version_op_id: null,
    version_name: null,
    connection_id: 1,
    connection_label: "Acme",
    cached_at: "2026-08-01T00:00:00Z",
    updated_at_op: "2026-08-01T00:00:00Z",
    in_sprint: false,
    sprint_names: [],
    frozen_sprint_names: [],
    protected: false,
    ...over,
  };
}

describe("ImportScreen — out-of-selection cleanup (Increment 29/31)", () => {
  it("shows a protected row disabled and excluded from 'select all'", async () => {
    mockApi.getOutOfSelection = vi.fn().mockResolvedValue({
      entries: [
        makeEntry({ op_id: 1, subject: "Free ticket" }),
        makeEntry({
          op_id: 2,
          subject: "Held ticket",
          in_sprint: true,
          sprint_names: ["Sprint 7"],
          protected: true,
        }),
      ],
      total: 2,
      protected_count: 1,
    });
    const user = userEvent.setup();
    renderScreen();
    await waitFor(() => expect(screen.getByText("Free ticket")).toBeInTheDocument());

    const heldCheckbox = screen.getByRole("checkbox", { name: "Select #2" });
    expect(heldCheckbox).toBeDisabled();
    expect(screen.getByText(/in sprint Sprint 7 — cannot be removed/)).toBeInTheDocument();

    // "Select all" only ever picks up the removable row.
    await user.click(screen.getByRole("checkbox", { name: "Select all" }));
    expect(screen.getByRole("checkbox", { name: "Select #1" })).toBeChecked();
    expect(heldCheckbox).not.toBeChecked();
  });

  // Increment 31 (docs/INCREMENT_31_CONTRACTS.md §3/§4): a ticket whose
  // ONLY sprint membership is frozen is no longer protected — selectable,
  // shown with a muted "removable" note (not the blocking "cannot be
  // removed" copy, and not disabled).
  it("shows a frozen-only membership as removable, not protected", async () => {
    mockApi.getOutOfSelection = vi.fn().mockResolvedValue({
      entries: [
        makeEntry({
          op_id: 3,
          subject: "Frozen-sprint ticket",
          in_sprint: true,
          sprint_names: [],
          frozen_sprint_names: ["Sprint 3"],
          protected: false,
        }),
      ],
      total: 1,
      protected_count: 0,
    });
    const user = userEvent.setup();
    renderScreen();
    await waitFor(() => expect(screen.getByText("Frozen-sprint ticket")).toBeInTheDocument());

    const checkbox = screen.getByRole("checkbox", { name: "Select #3" });
    expect(checkbox).not.toBeDisabled();
    expect(screen.getByText(/in frozen sprint Sprint 3 — removable/)).toBeInTheDocument();
    expect(screen.queryByText(/cannot be removed/)).not.toBeInTheDocument();

    // "Select all" picks it up — it's not protected.
    await user.click(screen.getByRole("checkbox", { name: "Select all" }));
    expect(checkbox).toBeChecked();
  });

  // Increment 31: a ticket can be protected by one sprint AND separately
  // hold a frozen membership in another — both notes render, protecting
  // name first.
  it("shows both notes, protecting first, when a row is protected AND has a frozen membership", async () => {
    mockApi.getOutOfSelection = vi.fn().mockResolvedValue({
      entries: [
        makeEntry({
          op_id: 4,
          subject: "Dual-membership ticket",
          in_sprint: true,
          sprint_names: ["Sprint 9"],
          frozen_sprint_names: ["Sprint 3"],
          protected: true,
        }),
      ],
      total: 1,
      protected_count: 1,
    });
    renderScreen();
    await waitFor(() => expect(screen.getByText("Dual-membership ticket")).toBeInTheDocument());

    expect(screen.getByRole("checkbox", { name: "Select #4" })).toBeDisabled();
    const protectedNote = screen.getByText(/in sprint Sprint 9 — cannot be removed/);
    const frozenNote = screen.getByText(/in frozen sprint Sprint 3 — removable/);
    expect(protectedNote).toBeInTheDocument();
    expect(frozenNote).toBeInTheDocument();
    // DOM order: protecting note before the frozen note.
    expect(
      protectedNote.compareDocumentPosition(frozenNote) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("reports all three buckets (removed/protected/rejected) after a delete, never assuming full success", async () => {
    mockApi.getOutOfSelection = vi.fn().mockResolvedValue({
      entries: [makeEntry({ op_id: 1, subject: "Free ticket" })],
      total: 1,
      protected_count: 0,
    });
    mockApi.deleteOutOfSelection = vi.fn().mockResolvedValue({
      removed: [1],
      protected: [{ op_id: 2, sprint_names: ["Sprint 7"] }],
      rejected: [{ op_id: 3, reason: "not_cached" }],
    });
    const user = userEvent.setup();
    renderScreen();
    await waitFor(() => expect(screen.getByText("Free ticket")).toBeInTheDocument());

    await user.click(screen.getByRole("checkbox", { name: "Select #1" }));
    await user.click(screen.getByRole("button", { name: "Remove selected (1)" }));
    await user.click(screen.getByTestId("out-of-selection-confirm-button"));

    await waitFor(() => expect(mockApi.deleteOutOfSelection).toHaveBeenCalledWith([1]));
    const result = await screen.findByTestId("out-of-selection-result");
    expect(result).toHaveTextContent("1 removed");
    expect(result).toHaveTextContent("1 protected (in a planning/active sprint or within the grace period)");
    expect(result).toHaveTextContent("1 rejected");
  });

  it("shows an empty state when nothing is out of selection", async () => {
    mockApi.getOutOfSelection = vi.fn().mockResolvedValue({ entries: [], total: 0, protected_count: 0 });
    renderScreen();
    await waitFor(() =>
      expect(
        screen.getByText("No cached tickets are outside your current import selections."),
      ).toBeInTheDocument(),
    );
  });
});
