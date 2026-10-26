import { useEffect, useMemo, useState } from "react";
import type { BacklogFilterOptionsResponse, BacklogItem } from "@osp/contracts";
import { api } from "../api-client";
import { useAsync } from "../lib/useAsync";
import { formatHours, isDimmedStatus } from "../lib/format";
import { Async, Panel } from "./ui";
import { useCan } from "../lib/role";

type HasEstimate = "" | "yes" | "no";

/** One dropdown option for the Assignee/Version facets (SPEC_23 §2). */
type FilterOptionEntry = BacklogFilterOptionsResponse["assignees"][number];

interface Filters {
  /**
   * Increment 40 (§2 Agent C / B1): the connection-safe composite project
   * key (`FilterOptionEntry.key`, `${connection_id}:${project_op_id}` or
   * `none:${project_op_id}`) — NEVER the project name, which can collide
   * across servers (pillar 2: op_id is identity, name is display-only).
   * "" means "All".
   */
  projectKey: string;
  status: string;
  /**
   * Increment 23 (SPEC_23 §2): the connection-safe composite key
   * (`FilterOptionEntry.key`, i.e. `${connection_id}:${op_user_id}` or
   * `none:${op_user_id}`) — NEVER a bare op_user_id, which collides across
   * servers (the Alan Turing@mock / Cameron Dalby@Acme incident, both
   * OP user id 3 on their own server). "" means "All".
   */
  assigneeKey: string;
  /** Same rationale/format as `assigneeKey`, for the Version facet. */
  versionKey: string;
  priority: string;
  hasEstimate: HasEstimate;
  /** connection_id as string, or "" (SPEC_07 §4) — drives a server-side re-fetch. */
  connectionId: string;
}

const EMPTY: Filters = {
  projectKey: "",
  status: "",
  assigneeKey: "",
  versionKey: "",
  priority: "",
  hasEstimate: "",
  connectionId: "",
};

/** Disambiguated dropdown label (SPEC_23 §2) — matches the existing
 * connection-label convention already used for backlog rows (BacklogRow
 * below shows `item.connection_label`): append " (label)" whenever a
 * connection is known, so two people who share a name (or a bare id, pre-fix)
 * across two servers are never visually indistinguishable, e.g. "Cameron
 * Dalby (Acme)" vs. "Alan Turing (mock)". Legacy connection-less rows
 * (`connection_label: null`) show the bare name, same as before this fix. */
function formatFilterOptionLabel(o: FilterOptionEntry): string {
  return o.connection_label ? `${o.name} (${o.connection_label})` : o.name;
}

/** Client-side page sizes (SPEC §8 backlog can exceed 600 items). */
const PAGE_SIZES = [5, 10, 20, 30, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 20;

/** Case-insensitive/trimmed equality (SPEC_19 §1.2) — an extra safety net on
 * top of correct, cascading options; ids (assignee/version) stay exact. */
function sameText(a: string | null | undefined, b: string): boolean {
  return (a ?? "").trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Increment 23 (SPEC_23 §2): `assigneeKey`/`versionKey` are NOT re-checked
 * here — unlike `connectionId` (also forwarded, also never re-checked
 * client-side), they're sent straight through to `GET /api/backlog` so the
 * backend's connection-aware (`connection_id`, id) matching is the ONE place
 * that decides membership. Re-deriving a bare-id comparison here would
 * reintroduce the exact cross-server collision this increment fixes.
 */
/** Increment 40: the same composite key the backend emits for the project
 * facet — `${connection_id ?? "none"}:${project_op_id}`. */
export function projectKeyOf(it: Pick<BacklogItem, "connection_id" | "project_op_id">): string {
  return `${it.connection_id ?? "none"}:${it.project_op_id}`;
}

/** Increment 40 §1.2 (web tables): the displayed project — name, falling back
 * to the identifier; null when neither is known (rendered as "—"). */
export function projectDisplayName(
  it: Pick<BacklogItem, "project_name" | "project_identifier">,
): string | null {
  return it.project_name ?? it.project_identifier ?? null;
}

function applyFilters(items: BacklogItem[], f: Filters): BacklogItem[] {
  return items.filter((it) => {
    // Increment 40: `projectKey` is ALSO sent to the API (server-side match);
    // this exact-key re-check is consistent with it (same composite key, never
    // the name) and keeps the table correct even before a re-fetch lands.
    if (f.projectKey && projectKeyOf(it) !== f.projectKey) return false;
    if (f.status && !sameText(it.status_name, f.status)) return false;
    if (f.priority && !sameText(it.priority, f.priority)) return false;
    if (f.hasEstimate === "yes" && it.effective_hours == null) return false;
    if (f.hasEstimate === "no" && it.effective_hours != null) return false;
    return true;
  });
}

// ── Sorting (SPEC §8 backlog) ────────────────────────────────────────────────
export type SortKey = "id" | "project" | "status" | "version" | "priority" | "server";
export type SortDir = "asc" | "desc";
export interface Sort {
  key: SortKey;
  dir: SortDir;
}

/** OpenProject default priority ordering (higher = more urgent). */
const PRIORITY_RANK: Record<string, number> = { immediate: 4, high: 3, normal: 2, low: 1 };

/** Same label ?? base_url fallback used elsewhere (e.g. ConnectionStatus.tsx). */
function serverLabel(it: Pick<BacklogItem, "connection_label" | "connection_base_url">): string | null {
  return it.connection_label ?? it.connection_base_url ?? null;
}

function sortValue(it: BacklogItem, key: SortKey): number | string | null {
  switch (key) {
    case "id":
      return it.op_id;
    case "project": {
      // Increment 40: by the DISPLAYED name, case-insensitively; nulls last.
      const name = projectDisplayName(it);
      return name ? name.toLowerCase() : null;
    }
    case "status":
      return it.status_name ?? null;
    case "version":
      return it.version_name ?? null;
    case "priority":
      return it.priority ? (PRIORITY_RANK[it.priority.toLowerCase()] ?? 0) : null;
    case "server":
      return serverLabel(it);
  }
}

/** Comparator: nulls always sort last; ties break by ascending id (stable). */
export function compareBacklog(a: BacklogItem, b: BacklogItem, sort: Sort): number {
  const dir = sort.dir === "asc" ? 1 : -1;
  const va = sortValue(a, sort.key);
  const vb = sortValue(b, sort.key);
  if (va == null && vb == null) return a.op_id - b.op_id;
  if (va == null) return 1;
  if (vb == null) return -1;
  const cmp =
    typeof va === "number" && typeof vb === "number"
      ? va - vb
      : String(va).localeCompare(String(vb));
  return cmp !== 0 ? dir * cmp : a.op_id - b.op_id;
}

function ariaSort(sort: Sort, key: SortKey): "ascending" | "descending" | "none" {
  if (sort.key !== key) return "none";
  return sort.dir === "asc" ? "ascending" : "descending";
}

/** A clickable, sortable column header. */
function SortTh({
  label,
  sortKey,
  sort,
  onToggle,
}: {
  label: string;
  sortKey: SortKey;
  sort: Sort;
  onToggle: (k: SortKey) => void;
}) {
  const active = sort.key === sortKey;
  const arrow = active ? (sort.dir === "asc" ? " ▲" : " ▼") : "";
  return (
    <th aria-sort={ariaSort(sort, sortKey)}>
      <button
        type="button"
        className="th-sort"
        aria-label={`Sort by ${label}`}
        onClick={() => onToggle(sortKey)}
      >
        {label}
        <span aria-hidden="true">{arrow}</span>
      </button>
    </th>
  );
}

/**
 * SPEC §8 Backlog: filterable table of cached work packages. Shows the OP
 * estimate and the local planning override side by side, plus the effective
 * estimate-of-record. Overrides are editable inline (POST /api/estimate-override).
 */
/** Deep-link to a work package in the configured OpenProject instance. */
export function opWorkPackageUrl(baseUrl: string, opId: number): string {
  return `${baseUrl.replace(/\/+$/, "")}/work_packages/${opId}`;
}

export function BacklogScreen({
  refreshKey,
  baseUrl,
  onDataChanged,
}: {
  refreshKey: number;
  baseUrl: string;
  /**
   * Increment 28 (docs/INCREMENT_28_CONTRACTS.md §1) — the App-level
   * refreshKey-bump callback (`App.tsx`'s `refreshData`). An estimate
   * override saved here changes `effectiveEstimate`, which the Sprint board
   * tab's capacity bar / per-developer segments also depend on — a screen
   * this one never touches directly. Calling ONLY this screen's own local
   * `state.reload()` (the pre-Increment-28 behaviour, kept below for this
   * screen's own immediate refresh) left that other screen stale; this
   * callback is what actually propagates the change app-wide. Optional/
   * no-op default keeps every existing standalone-render test (none of which
   * exercise a save) working unchanged.
   */
  onDataChanged?: () => void;
}) {
  const canPlan = useCan("plan");
  const [filters, setFilters] = useState<Filters>(EMPTY);
  // Union of ALL imported projects/versions (no projectId → additive backlog).
  // SPEC_07 §4: the server filter is forwarded to the API as `connectionId`
  // (re-fetches scoped server-side); Increment 23 (SPEC_23 §2) adds
  // `assigneeKey`/`versionKey` to that same server-side group — the
  // connection-aware composite key, NEVER the legacy bare op_id, so the
  // backend's (connection_id, id) matching is what actually decides
  // membership (no client-side re-derivation of that match — see
  // applyFilters()'s doc comment). The remaining filters below all narrow the
  // already-fetched `items` client-side.
  const state = useAsync(
    () =>
      api.getBacklog({
        connectionId: filters.connectionId ? Number(filters.connectionId) : undefined,
        assigneeKey: filters.assigneeKey || undefined,
        versionKey: filters.versionKey || undefined,
        projectKey: filters.projectKey || undefined,
      }),
    [refreshKey, filters.connectionId, filters.assigneeKey, filters.versionKey, filters.projectKey],
  );
  const [sort, setSort] = useState<Sort>({ key: "id", dir: "asc" });
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [removing, setRemoving] = useState(false);

  const items = state.data ?? [];

  // Increment 19 (SPEC_19 §1/§3): options for every dropdown come from the
  // backend, CASCADINGLY — each facet respects every OTHER currently active
  // filter, so re-fetch on every filter change (excluding `hasEstimate`,
  // which isn't a facet, and excluding itself). This is what actually
  // prevents "Version X + Status Y → 0 results": a status that can't occur
  // for the selected version simply never appears as an option.
  const filterOptionsState = useAsync(
    () =>
      api.getBacklogFilterOptions({
        // Increment 40 (B1): the connection-safe composite project key.
        projectKey: filters.projectKey || undefined,
        status: filters.status || undefined,
        // Increment 23 (SPEC_23 §2): the connection-safe composite key, NEVER
        // the legacy bare op_id (`assignee`/`version` — still accepted by the
        // contract for back-compat, but ignored server-side once a Key is
        // present, and never sent from here).
        assigneeKey: filters.assigneeKey || undefined,
        versionKey: filters.versionKey || undefined,
        priority: filters.priority || undefined,
        connectionId: filters.connectionId ? Number(filters.connectionId) : undefined,
      }),
    [filters.projectKey, filters.status, filters.assigneeKey, filters.versionKey, filters.priority, filters.connectionId],
  );

  // Server filter options accumulate across fetches on top of whatever the
  // endpoint returns (rather than trusting the CURRENT, possibly narrowed-by-
  // other-filters response alone) so the dropdown keeps offering every server
  // seen so far in this session — otherwise picking, say, a Version could
  // legitimately make a server disappear from the list, which is the exact
  // "silently narrows" UX this increment's other half is fixing. This
  // preserves the deliberate "servers never disappear" behavior already
  // established for this dropdown (Increment 7/9).
  const [knownConnections, setKnownConnections] = useState<Map<number, string>>(new Map());
  useEffect(() => {
    const servers = filterOptionsState.data?.servers;
    if (!servers || servers.length === 0) return;
    setKnownConnections((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const s of servers) {
        if (next.get(s.id) !== s.name) {
          next.set(s.id, s.name);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [filterOptionsState.data]);

  const options = useMemo(() => {
    const fo = filterOptionsState.data;
    return {
      projects: fo?.projects ?? [],
      statuses: fo?.statuses ?? [],
      assignees: fo?.assignees ?? [],
      versions: fo?.versions ?? [],
      priorities: fo?.priorities ?? [],
      servers: [...knownConnections.entries()]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }, [filterOptionsState.data, knownConnections]);

  // Increment 40: label = name; when two options share a name (e.g. the same
  // project op_id on two servers), append the connection label like the
  // assignee/version facets do.
  const projectOptionLabels = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of options.projects) {
      const k = p.name.trim().toLowerCase();
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const m = new Map<string, string>();
    for (const p of options.projects) {
      const dup = (counts.get(p.name.trim().toLowerCase()) ?? 0) > 1;
      m.set(p.key, dup ? formatFilterOptionLabel(p) : p.name);
    }
    return m;
  }, [options.projects]);

  const filtered = useMemo(() => applyFilters(items, filters), [items, filters]);
  const sorted = useMemo(
    () => [...filtered].sort((a, b) => compareBacklog(a, b, sort)),
    [filtered, sort],
  );

  // Reset to the first page whenever the underlying set, ordering, or page size
  // changes, so we never sit on an out-of-range page.
  useEffect(() => {
    setPage(1);
  }, [filters, sort, pageSize, state.data]);

  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages);
  const startIndex = (currentPage - 1) * pageSize;
  const pageItems = sorted.slice(startIndex, startIndex + pageSize);
  const showingFrom = total === 0 ? 0 : startIndex + 1;
  const showingTo = Math.min(startIndex + pageSize, total);

  // Selection covers the whole FILTERED set (all pages); the header checkbox
  // selects/clears everything the current filters show.
  const filteredIds = useMemo(() => filtered.map((i) => i.op_id), [filtered]);
  const allSelected = filteredIds.length > 0 && filteredIds.every((id) => selected.has(id));
  const someSelected = filteredIds.some((id) => selected.has(id));

  // Keep the selection within the current filter, so "remove" only ever affects
  // what the filters show.
  useEffect(() => {
    setSelected((prev) => {
      const f = new Set(filteredIds);
      const kept = [...prev].filter((id) => f.has(id));
      return kept.length === prev.size ? prev : new Set(kept);
    });
  }, [filteredIds]);

  function toggleAll() {
    setSelected((prev) => {
      if (allSelected) {
        const next = new Set(prev);
        for (const id of filteredIds) next.delete(id);
        return next;
      }
      return new Set([...prev, ...filteredIds]);
    });
  }

  function toggleOne(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function removeSelected() {
    if (selected.size === 0 || removing) return;
    setRemoving(true);
    try {
      await api.removeFromBacklog([...selected]);
      setSelected(new Set());
      state.reload();
    } finally {
      setRemoving(false);
    }
  }

  function set<K extends keyof Filters>(key: K, value: Filters[K]) {
    setFilters((f) => ({ ...f, [key]: value }));
  }

  function toggleSort(key: SortKey) {
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" },
    );
  }

  return (
    <Panel
      title="Backlog"
      actions={
        <div className="row" style={{ alignItems: "center", gap: 12 }}>
          <span className="muted" aria-label="backlog count">
            {filtered.length} / {items.length} work packages
          </span>
          {canPlan ? (
          <button
            type="button"
            className="btn small"
            aria-label="Remove from backlog"
            disabled={selected.size === 0 || removing}
            onClick={() => void removeSelected()}
          >
            {removing
              ? "Removing…"
              : `Remove from backlog${selected.size > 0 ? ` (${selected.size})` : ""}`}
          </button>
          ) : null}
        </div>
      }
    >
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="f-project">Project</label>
          <select id="f-project" value={filters.projectKey} onChange={(e) => set("projectKey", e.target.value)}>
            <option value="">All</option>
            {options.projects.map((p) => (
              <option key={p.key} value={p.key}>{projectOptionLabels.get(p.key) ?? p.name}</option>
            ))}
          </select>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="f-status">Status</label>
          <select id="f-status" value={filters.status} onChange={(e) => set("status", e.target.value)}>
            <option value="">All</option>
            {options.statuses.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="f-assignee">Assignee</label>
          {/* Increment 23 (SPEC_23 §2): keyed/valued by the connection-safe
              composite `key`, NOT the bare op_id — two different people on
              two servers can share a numeric op_id (the confirmed Alan
              Turing@mock / Cameron Dalby@Acme incident). */}
          <select id="f-assignee" value={filters.assigneeKey} onChange={(e) => set("assigneeKey", e.target.value)}>
            <option value="">All</option>
            {options.assignees.map((a) => (
              <option key={a.key} value={a.key}>{formatFilterOptionLabel(a)}</option>
            ))}
          </select>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="f-version">Version</label>
          <select id="f-version" value={filters.versionKey} onChange={(e) => set("versionKey", e.target.value)}>
            <option value="">All</option>
            {options.versions.map((v) => (
              <option key={v.key} value={v.key}>{formatFilterOptionLabel(v)}</option>
            ))}
          </select>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="f-priority">Priority</label>
          <select id="f-priority" value={filters.priority} onChange={(e) => set("priority", e.target.value)}>
            <option value="">All</option>
            {options.priorities.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="f-estimate">Estimate</label>
          <select id="f-estimate" value={filters.hasEstimate} onChange={(e) => set("hasEstimate", e.target.value as HasEstimate)}>
            <option value="">All</option>
            <option value="yes">Has estimate</option>
            <option value="no">No estimate</option>
          </select>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="f-server">Server</label>
          <select id="f-server" value={filters.connectionId} onChange={(e) => set("connectionId", e.target.value)}>
            <option value="">All</option>
            {options.servers.map((s) => (
              <option key={s.id} value={String(s.id)}>{s.name}</option>
            ))}
          </select>
        </div>
        <button type="button" className="btn small secondary" onClick={() => setFilters(EMPTY)}>
          Clear
        </button>
        <div className="field" style={{ marginBottom: 0, marginLeft: "auto" }}>
          <label htmlFor="f-page-size">Page size</label>
          <select
            id="f-page-size"
            value={String(pageSize)}
            onChange={(e) => setPageSize(Number(e.target.value))}
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={String(n)}>{n}</option>
            ))}
          </select>
        </div>
      </div>

      <Async
        state={state}
        isEmpty={() => filtered.length === 0}
        empty={<div className="msg" role="note">No work packages match the current filters.</div>}
      >
        {() => (
          <div className="table-scroll">
<table className="grid">
            <thead>
              <tr>
                <th>
                  {canPlan ? (
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    ref={(el) => {
                      if (el) el.indeterminate = someSelected && !allSelected;
                    }}
                    checked={allSelected}
                    onChange={toggleAll}
                  />
                  ) : null}
                </th>
                <SortTh label="ID" sortKey="id" sort={sort} onToggle={toggleSort} />
                <th>Subject</th>
                <SortTh label="Project" sortKey="project" sort={sort} onToggle={toggleSort} />
                <SortTh label="Server" sortKey="server" sort={sort} onToggle={toggleSort} />
                <th>Type</th>
                <SortTh label="Status" sortKey="status" sort={sort} onToggle={toggleSort} />
                <th>Assignee</th>
                <SortTh label="Version" sortKey="version" sort={sort} onToggle={toggleSort} />
                <SortTh label="Priority" sortKey="priority" sort={sort} onToggle={toggleSort} />
                <th>OP est.</th>
                <th>Override</th>
                <th>Effective</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pageItems.map((it) => (
                <BacklogRow
                  key={it.op_id}
                  item={it}
                  baseUrl={baseUrl}
                  selected={selected.has(it.op_id)}
                  onToggleSelect={() => toggleOne(it.op_id)}
                  onSaved={() => {
                    // Local immediate refresh (unchanged) PLUS the shared
                    // App-level bump (Increment 28 §1) — see onDataChanged's
                    // doc comment above for why both are needed.
                    state.reload();
                    onDataChanged?.();
                  }}
                />
              ))}
            </tbody>
          </table>
</div>
        )}
      </Async>

      {total > 0 ? (
        <div className="row" style={{ marginTop: 12, alignItems: "center" }}>
          <span className="muted" aria-label="showing range">
            Showing {showingFrom}–{showingTo} of {total}
          </span>
          <div className="row" style={{ marginLeft: "auto", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              className="btn small secondary"
              aria-label="Previous page"
              disabled={currentPage <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Prev
            </button>
            <span className="muted" aria-label="page indicator">
              Page {currentPage} of {totalPages}
            </span>
            <button
              type="button"
              className="btn small secondary"
              aria-label="Next page"
              disabled={currentPage >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next
            </button>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}

function BacklogRow({
  item,
  baseUrl,
  selected,
  onToggleSelect,
  onSaved,
}: {
  item: BacklogItem;
  baseUrl: string;
  selected: boolean;
  onToggleSelect: () => void;
  onSaved: () => void;
}) {
  // SPEC_09 §4: link to the ticket's OWN source server, not the "current"
  // connection — `baseUrl` is only a fallback for legacy rows with no
  // recorded connection.
  const href = opWorkPackageUrl(item.connection_base_url ?? baseUrl, item.op_id);
  const canPlan = useCan("plan");
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(item.override_hours != null ? String(item.override_hours) : "");
  const [saving, setSaving] = useState(false);

  async function save() {
    const parsed = Number(value);
    if (value === "" || Number.isNaN(parsed)) return;
    setSaving(true);
    try {
      await api.createEstimateOverride({ wp_op_id: item.op_id, planning_hours: parsed });
      setEditing(false);
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  // SPEC_07 §1: stale (disconnected/unreachable source) rows stay fully
  // usable — only the visual treatment changes (dimmed row + tooltip/badge).
  // SPEC_11 §3/#6: Developed/Tested/Resolved rows recede the same way, so
  // New/Confirmed/In progress stand out as what still needs attention.
  const rowClass = [
    selected ? "row-selected" : "",
    item.stale ? "row-stale" : "",
    isDimmedStatus(item.status_name) ? "status-dimmed" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const staleTitle = "Data from a disconnected/unreachable server — may not be current";

  return (
    <tr className={rowClass || undefined} title={item.stale ? staleTitle : undefined}>
      <td>
        {canPlan ? (
          <input
            type="checkbox"
            aria-label={`Select #${item.op_id}`}
            checked={selected}
            onChange={onToggleSelect}
          />
        ) : null}
      </td>
      <td>
        <a href={href} target="_blank" rel="noopener noreferrer" title={`Open #${item.op_id} in OpenProject`}>
          {item.op_id}
        </a>
      </td>
      <td>
        <a href={href} target="_blank" rel="noopener noreferrer" title={`Open "${item.subject}" in OpenProject`}>
          {item.subject}
        </a>
      </td>
      <td title={item.project_identifier ?? undefined}>
        {projectDisplayName(item) ?? <span className="muted">—</span>}
      </td>
      <td>
        {item.connection_label ?? item.connection_base_url ?? <span className="muted">—</span>}
        {item.stale ? (
          <span className="badge" style={{ marginLeft: 6 }} title={staleTitle}>
            stale
          </span>
        ) : null}
      </td>
      <td>{item.type_name}</td>
      <td>
        <span className={`badge ${item.status_is_closed ? "closed" : "open"}`}>{item.status_name}</span>
      </td>
      <td>{item.assignee_name ?? <span className="muted">—</span>}</td>
      <td>{item.version_name ?? <span className="muted">—</span>}</td>
      <td>{item.priority ?? <span className="muted">—</span>}</td>
      <td>{formatHours(item.estimated_hours)}</td>
      <td>
        {editing ? (
          <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
            <input
              aria-label={`override hours for ${item.op_id}`}
              type="number"
              step="0.5"
              style={{ width: 64 }}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <button type="button" className="btn small" disabled={saving} onClick={save}>
              Save
            </button>
            <button type="button" className="btn small secondary" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <span>{formatHours(item.override_hours)}</span>
        )}
      </td>
      <td>
        <strong>{formatHours(item.effective_hours)}</strong>
      </td>
      <td>
        {canPlan && !editing ? (
          <button
            type="button"
            className="btn small secondary"
            aria-label={`edit override for ${item.op_id}`}
            onClick={() => {
              setValue(item.override_hours != null ? String(item.override_hours) : "");
              setEditing(true);
            }}
          >
            Override
          </button>
        ) : null}
      </td>
    </tr>
  );
}
