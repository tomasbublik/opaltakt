import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeBacklogItem } from "../test/fixtures";

const { mockApi } = vi.hoisted(() => ({ mockApi: {} as Record<string, ReturnType<typeof vi.fn>> }));
vi.mock("../api-client", async (orig) => {
  const actual = await orig<typeof import("../api-client")>();
  return { ...actual, api: mockApi };
});

import { BacklogScreen } from "./BacklogScreen";

/** Mirrors the OLD client-side derivation this endpoint replaced (Increment
 * 19) — good enough to keep every filter-dropdown-driven test below passing
 * without a per-test fixture rewrite; tests that care about the endpoint's
 * CASCADING behavior itself set `mockApi.getBacklogFilterOptions` directly.
 * Increment 23 (SPEC_23 §2): assignees/versions now dedup by the
 * connection-safe composite `key` (`${connection_id}:${id}`/`none:${id}`),
 * NOT bare `id` — mirrors the real fix (two different people on two
 * connections sharing a numeric op_id must stay distinct entries). */
function optionsFromItems(rows: ReturnType<typeof makeBacklogItem>[]) {
  const uniq = (vals: (string | null | undefined)[]) =>
    [...new Set(vals.filter((v): v is string => !!v))].sort();
  const uniqByKey = (
    pairs: ({ id: number; name: string; connection_id: number | null; connection_label: string | null } | null)[],
  ) => {
    const m = new Map<string, { id: number; name: string; key: string; connection_id: number | null; connection_label: string | null }>();
    for (const p of pairs) {
      if (!p) continue;
      const key = `${p.connection_id ?? "none"}:${p.id}`;
      if (!m.has(key)) m.set(key, { ...p, key });
    }
    return [...m.values()];
  };
  return {
    // Increment 40 (§3): keyed like assignees/versions —
    // `${connection_id ?? "none"}:${project_op_id}`, name = resolved name.
    projects: uniqByKey(
      rows.map((i) =>
        i.project_name != null || i.project_identifier != null
          ? { id: i.project_op_id, name: i.project_name ?? i.project_identifier ?? `#${i.project_op_id}`, connection_id: i.connection_id, connection_label: i.connection_label }
          : null,
      ),
    ).sort((a, b) => a.name.localeCompare(b.name)),
    statuses: uniq(rows.map((i) => i.status_name)),
    assignees: uniqByKey(
      rows.map((i) =>
        i.assignee_op_id != null
          ? { id: i.assignee_op_id, name: i.assignee_name ?? String(i.assignee_op_id), connection_id: i.connection_id, connection_label: i.connection_label }
          : null,
      ),
    ),
    versions: uniqByKey(
      rows.map((i) =>
        i.version_op_id != null
          ? { id: i.version_op_id, name: i.version_name ?? String(i.version_op_id), connection_id: i.connection_id, connection_label: i.connection_label }
          : null,
      ),
    ),
    priorities: uniq(rows.map((i) => i.priority)),
    servers: uniqServers(rows),
  };
}

function uniqServers(rows: ReturnType<typeof makeBacklogItem>[]) {
  const m = new Map<number, { id: number; name: string }>();
  for (const i of rows) {
    if (i.connection_id == null || m.has(i.connection_id)) continue;
    m.set(i.connection_id, {
      id: i.connection_id,
      name: i.connection_label ?? i.connection_base_url ?? `Connection #${i.connection_id}`,
    });
  }
  return [...m.values()];
}

/** Mocks BOTH `getBacklog` and `getBacklogFilterOptions` from the same rows —
 * a plain resolved-value mock for each (NOT one calling the other), so tests
 * asserting `getBacklog`'s call count aren't thrown off by the options fetch. */
function setBacklog(rows: ReturnType<typeof makeBacklogItem>[]) {
  mockApi.getBacklog = vi.fn().mockResolvedValue(rows);
  mockApi.getBacklogFilterOptions = vi.fn().mockResolvedValue(optionsFromItems(rows));
}

beforeEach(() => {
  for (const k of Object.keys(mockApi)) delete mockApi[k];
});

const items = [
  makeBacklogItem({ op_id: 1, subject: "Alpha", status_name: "New", assignee_op_id: 7, assignee_name: "Alice", estimated_hours: 8, effective_hours: 8, priority: "High" }),
  makeBacklogItem({ op_id: 2, subject: "Beta", status_name: "In progress", assignee_op_id: 9, assignee_name: "Bob", estimated_hours: null, effective_hours: null, priority: "Low" }),
  makeBacklogItem({ op_id: 3, subject: "Gamma", status_name: "New", assignee_op_id: 7, assignee_name: "Alice", estimated_hours: 4, override_hours: 6, effective_hours: 6, priority: "High" }),
];

describe("BacklogScreen", () => {
  it("falls back to the current-connection baseUrl when a row has no connection_base_url of its own", async () => {
    // Legacy rows with no recorded source connection (SPEC_07 §4) link via the
    // "current" connection prop — the fallback path.
    setBacklog(items.map((it) => ({ ...it, connection_base_url: null })));
    render(<BacklogScreen refreshKey={0} baseUrl="https://openproject.acme.example/" />);
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());
    // Fetches the UNION across all imports (no projectId).
    expect(mockApi.getBacklog).toHaveBeenCalledWith({});
    // Subject links to {base}/work_packages/{op_id} (trailing slash trimmed).
    const link = screen.getByText("Alpha").closest("a");
    expect(link).toHaveAttribute("href", "https://openproject.acme.example/work_packages/1");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("links each row to ITS OWN source server (SPEC_09 §4), not the current/default connection", async () => {
    // Two tickets from two different OP servers, rendered while the "current"
    // connection (the baseUrl prop) is a THIRD, unrelated server — every row
    // must still deep-link to where it actually came from.
    setBacklog([
      makeBacklogItem({ op_id: 1, subject: "Acme ticket", connection_base_url: "https://openproject.acme.example" }),
      makeBacklogItem({ op_id: 2, subject: "Mock ticket", connection_base_url: "http://127.0.0.1:8099" }),
    ]);
    render(<BacklogScreen refreshKey={0} baseUrl="https://current.example.com" />);
    await waitFor(() => expect(screen.getByText("Acme ticket")).toBeInTheDocument());

    const acmeLink = screen.getByText("Acme ticket").closest("a");
    expect(acmeLink).toHaveAttribute("href", "https://openproject.acme.example/work_packages/1");
    const mockLink = screen.getByText("Mock ticket").closest("a");
    expect(mockLink).toHaveAttribute("href", "http://127.0.0.1:8099/work_packages/2");
  });

  it("dims a row whose status is Developed/Tested/Resolved but not New/In progress ones (SPEC_11 §3/#6)", async () => {
    setBacklog([
      makeBacklogItem({ op_id: 1, subject: "Still working", status_name: "In progress" }),
      makeBacklogItem({ op_id: 2, subject: "Wrapped up", status_name: "Developed" }),
      // Case-insensitive: OP servers don't all agree on casing.
      makeBacklogItem({ op_id: 3, subject: "Also wrapped up", status_name: "resolved" }),
    ]);
    render(<BacklogScreen refreshKey={0} baseUrl="https://op.example.com" />);
    await waitFor(() => expect(screen.getByText("Still working")).toBeInTheDocument());

    const workingRow = screen.getByText("Still working").closest("tr");
    const developedRow = screen.getByText("Wrapped up").closest("tr");
    const resolvedRow = screen.getByText("Also wrapped up").closest("tr");
    expect(workingRow?.className ?? "").not.toMatch(/status-dimmed/);
    expect(developedRow?.className ?? "").toMatch(/status-dimmed/);
    expect(resolvedRow?.className ?? "").toMatch(/status-dimmed/);
  });

  it("shows items from multiple projects and filters by Project", async () => {
    const user = userEvent.setup();
    setBacklog([
      makeBacklogItem({ op_id: 1, subject: "Alpha", project_op_id: 100, project_name: "Platform" }),
      makeBacklogItem({ op_id: 2, subject: "Beta", project_op_id: 200, project_name: "Demo Project" }),
    ]);

    render(<BacklogScreen refreshKey={0} baseUrl="https://op.example.com" />);
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());
    // Both projects visible in the union.
    expect(screen.getByText("Beta")).toBeInTheDocument();
    const alpha = screen.getByText("Alpha").closest("tr")!;
    expect(within(alpha).getByText("Platform")).toBeInTheDocument();

    // Filter to one project.
    await user.selectOptions(screen.getByLabelText("Project"), "Platform");
    await waitFor(() => expect(screen.queryByText("Beta")).not.toBeInTheDocument());
    expect(screen.getByText("Alpha")).toBeInTheDocument();
  });

  it("sorts by the displayed project name case-insensitively, nulls last (Increment 40)", async () => {
    const user = userEvent.setup();
    setBacklog([
      makeBacklogItem({ op_id: 1, subject: "No project", project_op_id: 0, project_name: null, project_identifier: null }),
      makeBacklogItem({ op_id: 2, subject: "Northwind ticket", project_op_id: 10, project_name: "northwind Payments", project_identifier: "northwind" }),
      makeBacklogItem({ op_id: 3, subject: "Harbor ticket", project_op_id: 20, project_name: "Harbor Ops", project_identifier: "harbor-ops" }),
      // Name unknown → identifier is the displayed (and sorted-by) value.
      makeBacklogItem({ op_id: 4, subject: "Ident-only ticket", project_op_id: 30, project_name: null, project_identifier: "aurora" }),
    ]);
    render(<BacklogScreen refreshKey={0} baseUrl="https://op.example.com" />);
    await waitFor(() => expect(screen.getByText("Harbor ticket")).toBeInTheDocument());

    const subjects = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        .map((r) => within(r).getAllByRole("link")[1]?.textContent);

    await user.click(screen.getByRole("button", { name: "Sort by Project" }));
    expect(subjects()).toEqual(["Ident-only ticket", "Harbor ticket", "Northwind ticket", "No project"]);
    await user.click(screen.getByRole("button", { name: "Sort by Project" }));
    // Descending — nulls still last.
    expect(subjects()).toEqual(["Northwind ticket", "Harbor ticket", "Ident-only ticket", "No project"]);

    // Cell: name, tooltip = identifier; identifier fallback; "—" when both null.
    const nw = screen.getByText("Northwind ticket").closest("tr")!;
    expect(within(nw).getByText("northwind Payments")).toHaveAttribute("title", "northwind");
    const ident = screen.getByText("Ident-only ticket").closest("tr")!;
    expect(within(ident).getByText("aurora")).toBeInTheDocument();
    const none = screen.getByText("No project").closest("tr")!;
    expect(within(none).getAllByText("—").length).toBeGreaterThan(0);
  });

  it("filters by the connection-safe project KEY and sends it as projectKey (Increment 40)", async () => {
    const user = userEvent.setup();
    // SAME project op_id (10) on two servers with the SAME name — must stay two
    // distinct options (disambiguated by connection label) and never merge.
    const rows = [
      makeBacklogItem({ op_id: 1, subject: "Server A ticket", connection_id: 1, connection_label: "alpha", project_op_id: 10, project_name: "Northwind", project_identifier: "northwind" }),
      makeBacklogItem({ op_id: 2, subject: "Server B ticket", connection_id: 2, connection_label: "beta", project_op_id: 10, project_name: "Northwind", project_identifier: "nw" }),
      makeBacklogItem({ op_id: 3, subject: "Harbor ticket", connection_id: 1, connection_label: "alpha", project_op_id: 20, project_name: "Harbor Ops", project_identifier: "harbor-ops" }),
    ];
    setBacklog(rows);
    render(<BacklogScreen refreshKey={0} baseUrl="https://op.example.com" />);
    await waitFor(() => expect(screen.getByText("Server B ticket")).toBeInTheDocument());

    const select = screen.getByLabelText("Project") as HTMLSelectElement;
    const opts = [...select.options].map((o) => [o.value, o.textContent]);
    expect(opts).toEqual([
      ["", "All"],
      ["1:20", "Harbor Ops"],
      ["1:10", "Northwind (alpha)"],
      ["2:10", "Northwind (beta)"],
    ]);

    await user.selectOptions(select, "2:10");
    await waitFor(() => expect(screen.queryByText("Server A ticket")).not.toBeInTheDocument());
    expect(screen.getByText("Server B ticket")).toBeInTheDocument();
    expect(screen.queryByText("Harbor ticket")).not.toBeInTheDocument();
    expect(select.value).toBe("2:10");

    // Sent to BOTH endpoints as the key — never a name, never a bare projectId.
    await waitFor(() =>
      expect(mockApi.getBacklog).toHaveBeenLastCalledWith(expect.objectContaining({ projectKey: "2:10" })),
    );
    expect(mockApi.getBacklogFilterOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ projectKey: "2:10" }),
    );
    const lastOptsCall = mockApi.getBacklogFilterOptions!.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(lastOptsCall.projectId).toBeUndefined();
  });

  it("re-fetches filter options CASCADINGLY on every filter change, narrowing what other dropdowns offer (SPEC_19 §1/§3)", async () => {
    const user = userEvent.setup();
    mockApi.getBacklog = vi.fn().mockResolvedValue([
      makeBacklogItem({ op_id: 1, subject: "Alpha", status_name: "New", version_op_id: 10, version_name: "v1.0" }),
      makeBacklogItem({ op_id: 2, subject: "Beta", status_name: "In progress", version_op_id: 20, version_name: "v2.0" }),
    ]);
    // The backend computes `statuses` respecting every OTHER active filter —
    // simulate that here: once Version=v1.0 (key "1:10") is selected, "In
    // progress" (which only occurs under v2.0) must never be offered.
    // Increment 23 (SPEC_23 §2): the cascading query param is now
    // `versionKey`, matched by `FilterOptionEntry.key` — never the legacy
    // bare `version` id.
    mockApi.getBacklogFilterOptions = vi.fn().mockImplementation(async (q: { versionKey?: string }) => ({
      projects: [],
      statuses: q.versionKey === "1:10" ? ["New"] : ["New", "In progress"],
      assignees: [],
      versions: [
        { id: 10, name: "v1.0", key: "1:10", connection_id: 1, connection_label: null },
        { id: 20, name: "v2.0", key: "1:20", connection_id: 1, connection_label: null },
      ],
      priorities: [],
      servers: [],
    }));

    render(<BacklogScreen refreshKey={0} baseUrl="https://op.example.com" />);
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());
    expect(
      within(screen.getByLabelText("Status")).getAllByRole("option").map((o) => o.textContent),
    ).toEqual(["All", "New", "In progress"]);

    await user.selectOptions(screen.getByLabelText("Version"), "1:10");
    await waitFor(() =>
      expect(mockApi.getBacklogFilterOptions).toHaveBeenLastCalledWith(
        expect.objectContaining({ versionKey: "1:10" }),
      ),
    );
    await waitFor(() =>
      expect(
        within(screen.getByLabelText("Status")).getAllByRole("option").map((o) => o.textContent),
      ).toEqual(["All", "New"]),
    );
  });

  // Increment 23 (SPEC_23 §2) — the confirmed incident: Alan Turing (mock,
  // op_user_id 3) and Cameron Dalby (Acme, ALSO op_user_id 3) must
  // both appear as distinct options, each disambiguated by server label, and
  // selecting one must send ONLY that connection's composite key — never the
  // bare, cross-server-colliding op_id.
  it("shows both same-op_id people from different connections as distinct, disambiguated Assignee options and filters by connection-safe key", async () => {
    const user = userEvent.setup();
    mockApi.getBacklog = vi.fn().mockResolvedValue([
      makeBacklogItem({ op_id: 1, subject: "Mock ticket", assignee_op_id: 3, assignee_name: "Alan Turing", connection_id: 1, connection_label: "mock" }),
      makeBacklogItem({ op_id: 2, subject: "Acme ticket", assignee_op_id: 3, assignee_name: "Cameron Dalby", connection_id: 2, connection_label: "Acme" }),
    ]);
    mockApi.getBacklogFilterOptions = vi.fn().mockResolvedValue({
      projects: [],
      statuses: [],
      assignees: [
        { id: 3, name: "Alan Turing", key: "1:3", connection_id: 1, connection_label: "mock" },
        { id: 3, name: "Cameron Dalby", key: "2:3", connection_id: 2, connection_label: "Acme" },
      ],
      versions: [],
      priorities: [],
      servers: [],
    });

    render(<BacklogScreen refreshKey={0} baseUrl="https://op.example.com" />);
    await waitFor(() => expect(screen.getByText("Mock ticket")).toBeInTheDocument());

    // Both people present as distinct, server-disambiguated options — Alan
    // Turing is never merged with, and Cameron Dalby never missing next
    // to, the other id-3 holder on the other server.
    const assigneeOptions = within(screen.getByLabelText("Assignee"))
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(assigneeOptions).toEqual(["All", "Alan Turing (mock)", "Cameron Dalby (Acme)"]);

    await user.selectOptions(screen.getByLabelText("Assignee"), "1:3");
    await waitFor(() =>
      expect(mockApi.getBacklog).toHaveBeenLastCalledWith(
        expect.objectContaining({ assigneeKey: "1:3" }),
      ),
    );
    // Never the legacy bare op_id — that's exactly the collision this fixes.
    expect(mockApi.getBacklog.mock.calls.at(-1)![0]).not.toHaveProperty("assignee");
  });

  it("keeps every server seen this session in the Server dropdown even once a cascaded fetch narrows it (Increment 7/9 UX, preserved)", async () => {
    const user = userEvent.setup();
    mockApi.getBacklog = vi.fn().mockResolvedValue([
      makeBacklogItem({ op_id: 1, subject: "Alpha", status_name: "New", connection_id: 1, connection_label: "Alpha server" }),
      makeBacklogItem({ op_id: 2, subject: "Beta", status_name: "In progress", connection_id: 2, connection_label: "Beta server" }),
    ]);
    // Simulate `servers` ALSO cascading (narrowed by `status`) — Increment
    // 7/9's "servers never disappear" UX is BacklogScreen's own accumulator
    // on top of this, not something the endpoint itself guarantees.
    mockApi.getBacklogFilterOptions = vi.fn().mockImplementation(async (q: { status?: string }) => ({
      projects: [],
      statuses: ["New", "In progress"],
      assignees: [],
      versions: [],
      priorities: [],
      servers:
        q.status === "New"
          ? [{ id: 1, name: "Alpha server" }]
          : [{ id: 1, name: "Alpha server" }, { id: 2, name: "Beta server" }],
    }));

    render(<BacklogScreen refreshKey={0} baseUrl="https://op.example.com" />);
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());
    await waitFor(() =>
      expect(
        within(screen.getByLabelText("Server")).getAllByRole("option").map((o) => o.textContent),
      ).toEqual(["All", "Alpha server", "Beta server"]),
    );

    await user.selectOptions(screen.getByLabelText("Status"), "New");
    await waitFor(() =>
      expect(mockApi.getBacklogFilterOptions).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: "New" }),
      ),
    );
    // Even though THIS response only returned Alpha server, Beta server
    // (seen earlier this session) must still be offered.
    expect(
      within(screen.getByLabelText("Server")).getAllByRole("option").map((o) => o.textContent),
    ).toEqual(["All", "Alpha server", "Beta server"]);
  });

  it("removes checked tickets; the button is disabled until something is checked", async () => {
    const user = userEvent.setup();
    setBacklog(items);
    mockApi.removeFromBacklog = vi.fn().mockResolvedValue({ removed: 1 });

    render(<BacklogScreen refreshKey={0} baseUrl="https://op.example.com" />);
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());

    const removeBtn = screen.getByRole("button", { name: "Remove from backlog" });
    expect(removeBtn).toBeDisabled();

    await user.click(screen.getByLabelText("Select #1"));
    expect(removeBtn).toBeEnabled();

    await user.click(removeBtn);
    await waitFor(() => expect(mockApi.removeFromBacklog).toHaveBeenCalledWith([1]));
    expect(mockApi.getBacklog).toHaveBeenCalledTimes(2); // reloaded after removal
  });

  it("select-all removes only the filtered items", async () => {
    const user = userEvent.setup();
    setBacklog(items); // Alpha(1,New) Beta(2,In progress) Gamma(3,New)
    mockApi.removeFromBacklog = vi.fn().mockResolvedValue({ removed: 2 });

    render(<BacklogScreen refreshKey={0} baseUrl="https://op.example.com" />);
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());

    // Filter to "New" → Alpha (1) + Gamma (3); Beta (2) hidden.
    await user.selectOptions(screen.getByLabelText("Status"), "New");
    await waitFor(() => expect(screen.queryByText("Beta")).not.toBeInTheDocument());

    await user.click(screen.getByLabelText("Select all"));
    await user.click(screen.getByRole("button", { name: "Remove from backlog" }));

    await waitFor(() =>
      expect(mockApi.removeFromBacklog).toHaveBeenCalledWith(expect.arrayContaining([1, 3])),
    );
    expect(mockApi.removeFromBacklog.mock.calls[0]![0]).toHaveLength(2); // Beta excluded by filter
  });

  it("renders rows with OP estimate and override side by side, and filters", async () => {
    const user = userEvent.setup();
    setBacklog(items);

    render(<BacklogScreen refreshKey={0} baseUrl="https://op.example.com" />);

    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());
    expect(screen.getByText("Gamma")).toBeInTheDocument();
    // Gamma row shows OP est 4h once, plus override 6h and effective 6h.
    const gamma = screen.getByText("Gamma").closest("tr")!;
    expect(within(gamma).getByText("4h")).toBeInTheDocument();
    expect(within(gamma).getAllByText("6h")).toHaveLength(2);

    // Filter to "No estimate" → only Beta remains.
    await user.selectOptions(screen.getByLabelText("Estimate"), "no");
    await waitFor(() => expect(screen.queryByText("Alpha")).not.toBeInTheDocument());
    expect(screen.getByText("Beta")).toBeInTheDocument();

    // Filter by status New (clear estimate filter first).
    await user.selectOptions(screen.getByLabelText("Estimate"), "");
    await user.selectOptions(screen.getByLabelText("Status"), "In progress");
    await waitFor(() => expect(screen.queryByText("Alpha")).not.toBeInTheDocument());
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("sorts rows by clickable ID and Priority headers (asc/desc)", async () => {
    const user = userEvent.setup();
    setBacklog(items);

    render(<BacklogScreen refreshKey={0} baseUrl="https://op.example.com" />);
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());

    const subjects = () =>
      screen
        .getAllByRole("row")
        .slice(1) // drop the header row
        .map((r) => within(r).getAllByRole("cell")[2]!.textContent); // [0]=checkbox, [1]=id, [2]=subject

    // Default sort = id ascending.
    expect(subjects()).toEqual(["Alpha", "Beta", "Gamma"]);

    // Click ID → toggles to descending.
    await user.click(screen.getByRole("button", { name: "Sort by ID" }));
    expect(subjects()).toEqual(["Gamma", "Beta", "Alpha"]);

    // Priority ascending: Low (Beta) first, then the two High tie-broken by id.
    await user.click(screen.getByRole("button", { name: "Sort by Priority" }));
    expect(subjects()).toEqual(["Beta", "Alpha", "Gamma"]);

    // Priority descending: High first (Alpha, Gamma by id), Low (Beta) last.
    await user.click(screen.getByRole("button", { name: "Sort by Priority" }));
    expect(subjects()).toEqual(["Alpha", "Gamma", "Beta"]);
  });

  it("saves an estimate override via the API and reloads", async () => {
    const user = userEvent.setup();
    setBacklog(items);
    mockApi.createEstimateOverride = vi.fn().mockResolvedValue({});

    render(<BacklogScreen refreshKey={0} baseUrl="https://op.example.com" />);
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());

    await user.click(screen.getByLabelText("edit override for 1"));
    const input = screen.getByLabelText("override hours for 1");
    await user.clear(input);
    await user.type(input, "12");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mockApi.createEstimateOverride).toHaveBeenCalledWith({ wp_op_id: 1, planning_hours: 12 }),
    );
    // Reloaded (initial load + reload).
    expect(mockApi.getBacklog).toHaveBeenCalledTimes(2);
  });

  // Increment 28 (docs/INCREMENT_28_CONTRACTS.md §1): the measured gap —
  // saving an override used to reload ONLY this screen's own list
  // (`state.reload()` above), never reaching the Sprint board tab's capacity
  // bar/per-developer segments (a different mount entirely). `onDataChanged`
  // is the App-level refreshKey-bump callback (`App.tsx`'s `refreshData`) —
  // it must fire on every successful override save.
  it("calls onDataChanged (the App-level refreshKey bump) after saving an estimate override", async () => {
    const user = userEvent.setup();
    setBacklog(items);
    mockApi.createEstimateOverride = vi.fn().mockResolvedValue({});
    const onDataChanged = vi.fn();

    render(<BacklogScreen refreshKey={0} baseUrl="https://op.example.com" onDataChanged={onDataChanged} />);
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());

    await user.click(screen.getByLabelText("edit override for 1"));
    await user.clear(screen.getByLabelText("override hours for 1"));
    await user.type(screen.getByLabelText("override hours for 1"), "12");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockApi.createEstimateOverride).toHaveBeenCalled());
    expect(onDataChanged).toHaveBeenCalled();
  });

  // ── Pagination ──────────────────────────────────────────────────────────────
  const many = Array.from({ length: 25 }, (_, i) =>
    makeBacklogItem({ op_id: i + 1, subject: `Item ${i + 1}` }),
  );

  const dataRowCount = () => screen.getAllByRole("row").length - 1; // drop header

  it("paginates with a default page size of 20 and a showing X–Y of Z label", async () => {
    setBacklog(many);

    render(<BacklogScreen refreshKey={0} baseUrl="https://op.example.com" />);
    await waitFor(() => expect(screen.getByText("Item 1")).toBeInTheDocument());

    expect(dataRowCount()).toBe(20);
    expect(screen.getByLabelText("showing range").textContent).toContain("Showing 1–20 of 25");
    expect(screen.getByLabelText("page indicator").textContent).toContain("Page 1 of 2");
    // First page: Prev disabled, Next enabled.
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled();
  });

  it("changes the page size and resets to page 1", async () => {
    const user = userEvent.setup();
    setBacklog(many);

    render(<BacklogScreen refreshKey={0} baseUrl="https://op.example.com" />);
    await waitFor(() => expect(screen.getByText("Item 1")).toBeInTheDocument());

    // Move off page 1 first.
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByLabelText("page indicator").textContent).toContain("Page 2 of 2");

    await user.selectOptions(screen.getByLabelText("Page size"), "5");
    await waitFor(() => expect(dataRowCount()).toBe(5));
    // Reset back to page 1 with the new size.
    expect(screen.getByLabelText("showing range").textContent).toContain("Showing 1–5 of 25");
    expect(screen.getByLabelText("page indicator").textContent).toContain("Page 1 of 5");
    expect(screen.getByText("Item 1")).toBeInTheDocument();
    expect(screen.queryByText("Item 6")).not.toBeInTheDocument();
  });

  it("navigates with Next/Prev and disables at the boundaries", async () => {
    const user = userEvent.setup();
    setBacklog(many);

    render(<BacklogScreen refreshKey={0} baseUrl="https://op.example.com" />);
    await waitFor(() => expect(screen.getByText("Item 1")).toBeInTheDocument());

    // Page 1 → 2 (last page).
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(dataRowCount()).toBe(5);
    expect(screen.getByLabelText("showing range").textContent).toContain("Showing 21–25 of 25");
    expect(screen.getByText("Item 25")).toBeInTheDocument();
    expect(screen.queryByText("Item 1")).not.toBeInTheDocument();
    // Last page: Next disabled, Prev enabled.
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous page" })).toBeEnabled();

    // Back to page 1.
    await user.click(screen.getByRole("button", { name: "Previous page" }));
    expect(screen.getByLabelText("showing range").textContent).toContain("Showing 1–20 of 25");
    expect(screen.getByText("Item 1")).toBeInTheDocument();
  });
});
