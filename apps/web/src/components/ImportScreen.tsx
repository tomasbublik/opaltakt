import { useEffect, useMemo, useState } from "react";
import type { ProjectWithConnection, SyncRun, TriggerSyncBody } from "@osp/contracts";
import { api } from "../api-client";
import { useAsync } from "../lib/useAsync";
import { relativeTime } from "../lib/format";
import { Async, EmptyState, ErrorBox, Modal, Panel } from "./ui";

/** Sentinel radio value meaning "import the whole project, no version filter". */
const ALL_VERSIONS = "__all__";

/** Composite key: op_id is only unique WITHIN a server. */
function projectKey(p: Pick<ProjectWithConnection, "connection_id" | "op_id">): string {
  return `${p.connection_id ?? "unknown"}:${p.op_id}`;
}

/** Outcome of a single project's import attempt, shown in the results panel
 * after `doImport()` finishes — one project's failure never hides the others'. */
type ImportResult =
  | {
      projectOpId: number;
      projectName: string;
      connectionId: number | null;
      ok: true;
      count: number;
    }
  | {
      projectOpId: number;
      projectName: string;
      connectionId: number | null;
      ok: false;
      error: string;
    };

/**
 * The core import experience (additive, repeatable).
 *
 * Projects are grouped by the OpenProject server they came from (base_url +
 * port identifies a server) — with 2+ connected servers, each group has its
 * own checkbox list plus a "select all" toggle, and more than one project can
 * be picked at once (even spanning multiple servers). With exactly one
 * project selected, a version can still be picked to narrow the import;
 * picking several projects imports each as a whole project (all versions).
 * Each Import records an additive selection server-side and syncs it; the
 * backlog accumulates the union of every import.
 */
export function ImportScreen({
  refreshKey,
  onImport,
  onAdded,
  onRemoved,
  onViewBacklog,
}: {
  refreshKey: number;
  /** Runs the sync with header progress + app refresh; resolves with the run
   * (incl. `wp_count`), rejects on failure. */
  onImport: (body: TriggerSyncBody) => Promise<SyncRun>;
  /** Called after a single ticket is added, so the app refreshes the backlog. */
  onAdded: () => void;
  /** Called after an import is removed (cascade), so the app refreshes. */
  onRemoved: () => void;
  onViewBacklog: () => void;
}) {
  const projectsState = useAsync(() => api.getProjects(), []);
  const importsState = useAsync(() => api.getImports(), [refreshKey]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [versionValue, setVersionValue] = useState<string>(ALL_VERSIONS);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  // Per-project outcomes from the most recent doImport() run — one row each,
  // independent of whether other projects in the same batch failed.
  const [results, setResults] = useState<ImportResult[]>([]);

  // Single-ticket-by-id add.
  const [wpId, setWpId] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<Error | undefined>();
  const [addMsg, setAddMsg] = useState<string | undefined>();

  // Per-import removal.
  const [removingId, setRemovingId] = useState<number | undefined>();
  const [removeError, setRemoveError] = useState<Error | undefined>();

  async function addById() {
    const id = Number(wpId.trim());
    if (!Number.isInteger(id) || id <= 0 || addBusy) return;
    setAddBusy(true);
    setAddError(undefined);
    setAddMsg(undefined);
    try {
      const wp = await api.importWorkPackage(id);
      setAddMsg(`Added #${wp.op_id} — ${wp.subject}`);
      setWpId("");
      onAdded();
    } catch (err) {
      setAddError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setAddBusy(false);
    }
  }

  const projects = projectsState.data ?? [];

  // Group projects by server (connection_id): each group gets its own
  // checkbox list + "select all from this server" action.
  const groups = useMemo(() => {
    const byConn = new Map<
      string,
      { connectionId: number | null; baseUrl: string; label: string | null; projects: ProjectWithConnection[] }
    >();
    for (const p of projects) {
      const key = String(p.connection_id ?? "unknown");
      let g = byConn.get(key);
      if (!g) {
        g = {
          connectionId: p.connection_id,
          baseUrl: p.connection_base_url ?? "Unknown server",
          label: p.connection_label,
          projects: [],
        };
        byConn.set(key, g);
      }
      g.projects.push(p);
    }
    return [...byConn.values()];
  }, [projects]);

  const projectByKey = useMemo(() => {
    const m = new Map<string, ProjectWithConnection>();
    for (const p of projects) m.set(projectKey(p), p);
    return m;
  }, [projects]);

  // With exactly one project selected, the version picker still applies to it.
  const singleSelected =
    selected.size === 1 ? (projectByKey.get([...selected][0]!) ?? null) : null;

  const versionsState = useAsync(
    () =>
      singleSelected != null
        ? api.getVersions(singleSelected.op_id, singleSelected.connection_id ?? undefined)
        : Promise.resolve([]),
    [singleSelected?.connection_id, singleSelected?.op_id],
  );
  const versions = versionsState.data ?? [];

  const filteredVersions = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? versions.filter((v) => v.name.toLowerCase().includes(q)) : versions;
  }, [versions, search]);

  function toggleProject(p: ProjectWithConnection) {
    setSelected((prev) => {
      const next = new Set(prev);
      const key = projectKey(p);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setVersionValue(ALL_VERSIONS);
    setSearch("");
    setError(undefined);
  }

  function toggleGroup(g: (typeof groups)[number]) {
    const keys = g.projects.map(projectKey);
    const allSelected = keys.every((k) => selected.has(k));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const k of keys) {
        if (allSelected) next.delete(k);
        else next.add(k);
      }
      return next;
    });
    setVersionValue(ALL_VERSIONS);
    setSearch("");
    setError(undefined);
  }

  /** Runs one project's import, always resolving to a result (never throws) —
   * so a batch loop can keep going past a single project's failure. */
  async function importOne(p: ProjectWithConnection, body: TriggerSyncBody): Promise<ImportResult> {
    try {
      const run = await onImport(body);
      // Increment 19 (SPEC_19 §2c): an aborted run resolves (doesn't throw) —
      // don't let a project that got cut off mid-import look like a clean
      // success; whatever partial `wp_count` it reached before the cancel was
      // observed is real progress, but the project should read as incomplete.
      if (run.status === "aborted") {
        return {
          projectOpId: p.op_id,
          projectName: p.name,
          connectionId: p.connection_id,
          ok: false,
          error: `sync cancelled — ${run.wp_count ?? 0} ticket(s) imported before cancellation`,
        };
      }
      return {
        projectOpId: p.op_id,
        projectName: p.name,
        connectionId: p.connection_id,
        ok: true,
        count: run?.wp_count ?? 0,
      };
    } catch (err) {
      return {
        projectOpId: p.op_id,
        projectName: p.name,
        connectionId: p.connection_id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async function doImport() {
    if (selected.size === 0 || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const newResults: ImportResult[] = [];
      if (singleSelected != null) {
        const body: TriggerSyncBody =
          versionValue === ALL_VERSIONS
            ? { project_op_id: singleSelected.op_id, connection_id: singleSelected.connection_id ?? undefined }
            : {
                project_op_id: singleSelected.op_id,
                version_op_id: Number(versionValue),
                connection_id: singleSelected.connection_id ?? undefined,
              };
        newResults.push(await importOne(singleSelected, body));
      } else {
        // Multiple projects (possibly across several servers): import each as
        // a whole project — narrowing to one version doesn't make sense when
        // several projects are selected at once. Each project is independently
        // try/caught (via importOne) so one failure never skips the rest.
        for (const key of selected) {
          const p = projectByKey.get(key);
          if (!p) continue;
          newResults.push(
            await importOne(p, { project_op_id: p.op_id, connection_id: p.connection_id ?? undefined }),
          );
        }
      }
      setResults(newResults);
      setSelected(new Set());
      setVersionValue(ALL_VERSIONS);
      setSearch("");
      importsState.reload();
    } catch (err) {
      // Only genuine setup errors land here now — per-project failures are
      // caught in importOne() and surfaced via the results panel instead.
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  }

  async function removeImport(id: number) {
    if (removingId != null) return;
    setRemovingId(id);
    setRemoveError(undefined);
    try {
      await api.removeImport(id);
      importsState.reload();
      onRemoved();
    } catch (err) {
      setRemoveError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setRemovingId(undefined);
    }
  }

  return (
    <>
      <Panel
        title="Import from OpenProject"
        actions={
          <button type="button" className="btn secondary" onClick={onViewBacklog}>
            View backlog
          </button>
        }
      >
        <p className="muted" style={{ marginTop: 0 }}>
          Pick one or more projects — grouped by server when 2+ are connected — and Import.
          With a single project selected you can also narrow to one version. Repeat to add
          more — the backlog accumulates everything you import.
        </p>

        <div className="field">
          <label>Projects</label>
          <Async state={projectsState} loadingLabel="Loading projects…">
            {() =>
              groups.length === 0 ? (
                <EmptyState>No projects available from any connected, enabled server.</EmptyState>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {groups.map((g) => {
                    const keys = g.projects.map(projectKey);
                    const allSelected = keys.length > 0 && keys.every((k) => selected.has(k));
                    return (
                      <div
                        key={String(g.connectionId)}
                        style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 8 }}
                      >
                        <label
                          style={{
                            display: "flex",
                            gap: 8,
                            alignItems: "center",
                            fontWeight: 600,
                            marginBottom: 6,
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={allSelected}
                            onChange={() => toggleGroup(g)}
                            aria-label={`Select all projects from ${g.baseUrl}`}
                          />
                          <span>{g.label ?? g.baseUrl}</span>
                          {g.label ? <span className="muted">({g.baseUrl})</span> : null}
                        </label>
                        <div style={{ display: "flex", flexDirection: "column", gap: 2, paddingLeft: 8 }}>
                          {g.projects.map((p) => (
                            <label
                              key={projectKey(p)}
                              style={{ display: "flex", gap: 8, alignItems: "center", padding: "2px 0" }}
                            >
                              <input
                                type="checkbox"
                                checked={selected.has(projectKey(p))}
                                onChange={() => toggleProject(p)}
                              />
                              <span>{p.name}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )
            }
          </Async>
        </div>

        {singleSelected != null ? (
          <div className="field">
            <label htmlFor="import-version-search">Version</label>
            <input
              id="import-version-search"
              aria-label="Search versions"
              placeholder="Filter versions by name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ marginBottom: 8 }}
            />
            {versionsState.error ? (
              <ErrorBox error={versionsState.error} onRetry={() => versionsState.reload()} />
            ) : versionsState.loading && versionsState.data === undefined ? (
              <div className="msg" role="status">Loading versions…</div>
            ) : (
              <div
                role="radiogroup"
                aria-label="Version"
                style={{
                  maxHeight: 220,
                  overflowY: "auto",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  padding: 8,
                }}
              >
                <label style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0" }}>
                  <input
                    type="radio"
                    name="import-version"
                    checked={versionValue === ALL_VERSIONS}
                    onChange={() => setVersionValue(ALL_VERSIONS)}
                  />
                  <span>All versions (no filter)</span>
                </label>
                {filteredVersions.map((v) => (
                  <label
                    key={v.op_id}
                    style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0" }}
                  >
                    <input
                      type="radio"
                      name="import-version"
                      checked={versionValue === String(v.op_id)}
                      onChange={() => setVersionValue(String(v.op_id))}
                    />
                    <span>{v.name}</span>
                  </label>
                ))}
                {versions.length > 0 && filteredVersions.length === 0 ? (
                  <div className="muted" style={{ padding: "4px 0", fontSize: 12 }}>
                    No versions match "{search}".
                  </div>
                ) : null}
                {versions.length === 0 ? (
                  <div className="muted" style={{ padding: "4px 0", fontSize: 12 }}>
                    This project has no versions — import will cover the whole project.
                  </div>
                ) : null}
              </div>
            )}
          </div>
        ) : selected.size > 1 ? (
          <p className="muted">
            {selected.size} projects selected — each will be imported in full (version filter
            only applies when a single project is selected).
          </p>
        ) : null}

        {error ? <div style={{ marginBottom: 12 }}><ErrorBox error={error} /></div> : null}

        <button
          type="button"
          className="btn"
          disabled={selected.size === 0 || busy}
          onClick={() => void doImport()}
        >
          {busy
            ? "Importing…"
            : selected.size > 1
              ? `Import ${selected.size} projects`
              : "Import"}
        </button>

        {results.length > 0 ? (
          <div
            data-testid="import-results"
            style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 4 }}
          >
            {results.map((r) => (
              <div
                key={`${r.connectionId ?? "unknown"}:${r.projectOpId}`}
                data-testid={`import-result-${r.projectOpId}`}
                className={`msg ${r.ok ? "ok" : "warn"}`}
              >
                {r.ok
                  ? `${r.projectName}: ${r.count} ticket(s) imported`
                  : `${r.projectName}: import failed — ${r.error}`}
              </div>
            ))}
          </div>
        ) : null}
      </Panel>

      <Panel title="Add a single ticket by ID">
        <p className="muted" style={{ marginTop: 0 }}>
          Fetch one specific OpenProject work package by its id and add it to the backlog
          (independent of the project/version imports above).
        </p>
        <form
          className="row"
          style={{ alignItems: "flex-end" }}
          onSubmit={(e) => {
            e.preventDefault();
            void addById();
          }}
        >
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="add-wp-id">Work package ID</label>
            <input
              id="add-wp-id"
              inputMode="numeric"
              placeholder="e.g. 6705"
              value={wpId}
              onChange={(e) => setWpId(e.target.value)}
            />
          </div>
          <button type="submit" className="btn" disabled={addBusy || wpId.trim() === ""}>
            {addBusy ? "Adding…" : "Add ticket"}
          </button>
        </form>
        {addMsg ? (
          <div className="msg" role="status" style={{ marginTop: 8 }}>{addMsg}</div>
        ) : null}
        {addError ? (
          <div style={{ marginTop: 8 }}><ErrorBox error={addError} /></div>
        ) : null}
      </Panel>

      <Panel title="Imported so far">
        {removeError ? (
          <div style={{ marginBottom: 12 }}><ErrorBox error={removeError} /></div>
        ) : null}
        <Async
          state={importsState}
          loadingLabel="Loading imports…"
          isEmpty={(imports) => imports.length === 0}
          empty={<EmptyState>Nothing imported yet — pick a project above to start.</EmptyState>}
        >
          {(imports) => (
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              {imports.map((imp) => (
                <span
                  key={imp.id}
                  className="badge open"
                  aria-label="import selection"
                  style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                >
                  <span>
                    {imp.project_name} · {imp.version_name ?? "all versions"}
                    {imp.connection_base_url ? (
                      <span className="muted"> ({imp.connection_label ?? imp.connection_base_url})</span>
                    ) : null}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${imp.project_name} import`}
                    title="Remove this import and its backlog tickets (never touches OpenProject)"
                    disabled={removingId === imp.id}
                    onClick={() => void removeImport(imp.id)}
                    style={{
                      border: "none",
                      background: "transparent",
                      cursor: removingId === imp.id ? "default" : "pointer",
                      padding: 0,
                      lineHeight: 1,
                      fontSize: 14,
                      color: "inherit",
                      opacity: removingId === imp.id ? 0.5 : 1,
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </Async>
      </Panel>

      <OutOfSelectionPanel refreshKey={refreshKey} />
    </>
  );
}

/**
 * Increment 29 (docs/INCREMENT_29_CONTRACTS.md §6, contract §6) — cleanup for
 * cached tickets no longer covered by ANY import selection above (e.g. after
 * narrowing a project-wide selection to one version — SPEC_29 §0a's exact
 * gap). Placed on this screen rather than Settings → Data because "what's
 * covered by a selection" is this screen's own concept — the panel right
 * above already lists/removes SELECTIONS; this one lists/removes the CACHE
 * ROWS a selection no longer covers. These tickets keep being refreshed by
 * "Sync now" like any other cached row (the whole point of Increment 29's
 * coverage fix) — this is purely a tidy-up action, never required for
 * correctness.
 *
 * Increment 31 (docs/INCREMENT_31_CONTRACTS.md §3/§4) revised the rule: a
 * row is protected — checkbox disabled, excluded from "select all" — iff
 * `protected` is true (member of a planning/active/closed-within-grace
 * sprint), NOT merely `in_sprint` (member of ANY sprint, informational
 * only now). A FROZEN sprint reads from its own snapshot (docs §0), so its
 * cache rows are provably safe to delete — `frozen_sprint_names` lists
 * those memberships as a muted, non-blocking note instead.
 */
function OutOfSelectionPanel({ refreshKey }: { refreshKey: number }) {
  const state = useAsync(() => api.getOutOfSelection(), [refreshKey]);
  const entries = state.data?.entries ?? [];

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [showConfirm, setShowConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  const [result, setResult] = useState<
    { removed: number; protectedCount: number; rejected: number } | undefined
  >();

  // "Select all" only ever covers removable (non-protected) rows. Increment
  // 31: "protected" is the deletability rule now, not `in_sprint` — a row
  // whose only membership is a FROZEN sprint is selectable.
  const selectableIds = useMemo(
    () => entries.filter((e) => !e.protected).map((e) => e.op_id),
    [entries],
  );
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));
  const someSelected = selectableIds.some((id) => selected.has(id));

  // Keep the selection within the current removable set (a reload can drop
  // rows, or a row already deleted stays selected otherwise).
  useEffect(() => {
    setSelected((prev) => {
      const s = new Set(selectableIds);
      const kept = [...prev].filter((id) => s.has(id));
      return kept.length === prev.size ? prev : new Set(kept);
    });
  }, [selectableIds]);

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(selectableIds));
  }

  function toggleOne(opId: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(opId)) next.delete(opId);
      else next.add(opId);
      return next;
    });
  }

  async function confirmDelete() {
    if (selected.size === 0 || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const res = await api.deleteOutOfSelection([...selected]);
      // Increment 29 (contract §6): partial success is the normal 200
      // outcome, never an error — report every bucket, don't assume the
      // whole request landed the way it was asked.
      setResult({
        removed: res.removed.length,
        protectedCount: res.protected.length,
        rejected: res.rejected.length,
      });
      setSelected(new Set());
      setShowConfirm(false);
      state.reload();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Out-of-selection tickets"
      actions={
        entries.length > 0 ? (
          <button
            type="button"
            className="btn small"
            disabled={selected.size === 0}
            onClick={() => setShowConfirm(true)}
          >
            Remove selected{selected.size > 0 ? ` (${selected.size})` : ""}
          </button>
        ) : null
      }
    >
      <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
        Tickets that were fetched into the local cache but are no longer covered by any current
        import selection above — most often after narrowing a project-wide selection down to one
        version. They keep being refreshed by Sync now like any other cached ticket; this is
        purely a local tidy-up and <strong>never touches OpenProject</strong> — it only deletes
        the local backlog cache entry.
      </p>

      {error ? (
        <div style={{ marginBottom: 12 }}>
          <ErrorBox error={error} />
        </div>
      ) : null}

      {result ? (
        <div className="msg" role="status" data-testid="out-of-selection-result" style={{ marginBottom: 12 }}>
          {result.removed} removed
          {result.protectedCount > 0
            ? `, ${result.protectedCount} protected (in a planning/active sprint or within the grace period)`
            : ""}
          {result.rejected > 0 ? `, ${result.rejected} rejected` : ""}.
        </div>
      ) : null}

      <Async
        state={state}
        isEmpty={(d) => d.entries.length === 0}
        empty={<EmptyState>No cached tickets are outside your current import selections.</EmptyState>}
      >
        {(data) => (
          <div className="table-scroll">
<table className="grid">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    ref={(el) => {
                      if (el) el.indeterminate = someSelected && !allSelected;
                    }}
                    checked={allSelected}
                    disabled={selectableIds.length === 0}
                    onChange={toggleAll}
                  />
                </th>
                <th>ID</th>
                <th>Subject</th>
                <th>Project</th>
                <th>Version</th>
                <th>Server</th>
                <th>Cached</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((e) => (
                <tr key={e.op_id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select #${e.op_id}`}
                      checked={selected.has(e.op_id)}
                      disabled={e.protected}
                      onChange={() => toggleOne(e.op_id)}
                    />
                  </td>
                  <td>#{e.op_id}</td>
                  <td>
                    {e.subject}
                    {/* Increment 31: protecting names first, then the frozen
                        note — a ticket can be BOTH (a still-protecting sprint
                        and a separate, already-frozen one) and both lines
                        show together in that case. */}
                    {e.protected ? (
                      <div className="muted" style={{ fontSize: 11 }}>
                        in sprint {e.sprint_names.join(", ")} — cannot be removed
                      </div>
                    ) : null}
                    {e.frozen_sprint_names.length > 0 ? (
                      <div className="muted" style={{ fontSize: 11 }}>
                        in frozen sprint {e.frozen_sprint_names.join(", ")} — removable
                      </div>
                    ) : null}
                  </td>
                  <td>{e.project_name ?? "—"}</td>
                  <td>{e.version_name ?? "—"}</td>
                  <td>{e.connection_label ?? (e.connection_id != null ? `connection ${e.connection_id}` : "—")}</td>
                  <td>{relativeTime(e.cached_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
</div>
        )}
      </Async>

      {showConfirm ? (
        <Modal
          title="Remove selected tickets from the local cache?"
          onClose={() => {
            if (!busy) setShowConfirm(false);
          }}
        >
          <p>
            This removes {selected.size} ticket{selected.size === 1 ? "" : "s"} from the local
            backlog cache only. <strong>OpenProject itself is never touched.</strong> If any of
            them are later covered by an import selection again, or turn up on a sync, they come
            straight back.
          </p>
          {error ? (
            <div style={{ marginBottom: 12 }}>
              <ErrorBox error={error} />
            </div>
          ) : null}
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button
              type="button"
              className="btn small secondary"
              disabled={busy}
              onClick={() => setShowConfirm(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn small danger"
              disabled={busy}
              onClick={() => void confirmDelete()}
              data-testid="out-of-selection-confirm-button"
            >
              {busy ? "Removing…" : "Yes, remove"}
            </button>
          </div>
        </Modal>
      ) : null}
    </Panel>
  );
}
