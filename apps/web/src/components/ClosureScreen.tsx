import { useState } from "react";
import type { ClosureItem, ClosureReportResponse, ClosureStatsResponse, Sprint } from "@osp/contracts";
import { api } from "../api-client";
import { useAsync } from "../lib/useAsync";
import { formatHours } from "../lib/format";
import { Async, EmptyState, ErrorBox, Panel } from "./ui";
import { SprintSelect } from "./SprintSelect";
import { opWorkPackageUrl } from "./BacklogScreen";
import { ClosureStatsView } from "./ClosureStats";
import { CarryOverButton } from "./CarryOverControl";
import { useCan } from "../lib/role";

/**
 * SPEC §8 Closure: generate a closure report (POST /api/sprints/:id/close),
 * list done / not-done, return not-done items to the backlog, and open the
 * read-only OP deep link to bulk-change versions (GET .../version-export).
 * Nothing is ever written to OP (SPEC §2, §6).
 *
 * SPEC_04 §6 task-4 split decision: SprintBoardScreen's "Finish sprint" button
 * is the PRIMARY lifecycle action — it calls the new POST /finish, which does
 * a final scoped update pass and IRREVERSIBLY LOCKS the sprint before writing
 * the report. This screen deliberately keeps calling the pre-existing POST
 * /close instead of switching to /finish: /close is unchanged, still
 * idempotent, and (per Agent B) now shares the exact same closure algorithm
 * as /finish — so the two always agree, and viewing/regenerating the report
 * here never has side effects on the sprint's lock state. Once a sprint is
 * already locked, `generate` is effectively a "view/regenerate the report"
 * action rather than something that "closes" anything — the copy below
 * reflects that.
 */
export function ClosureScreen({
  sprints,
  selectedSprintId,
  onSelectSprint,
  onSprintsChanged,
  baseUrl,
}: {
  sprints: Sprint[];
  selectedSprintId: number | undefined;
  onSelectSprint: (id: number) => void;
  onSprintsChanged: () => void;
  /**
   * SPEC_09 §4: OP base URL for ticket deep links. `ClosureItem` (frozen
   * contract) doesn't carry a per-item `connection_base_url` the way
   * `BacklogItem`/`SprintItemDetail` do, so — unlike Backlog/Sprint board —
   * this screen can only link every ticket to the "current" connection, not
   * necessarily its own source server for a multi-server sprint.
   */
  baseUrl?: string;
}) {
  const canPlan = useCan("plan");
  const [report, setReport] = useState<ClosureReportResponse | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  const [returned, setReturned] = useState<Set<number>>(new Set());
  // Increment 34 (docs/INCREMENT_34_CONTRACTS.md §5): tracks which "Not
  // done" rows were just carried into another sprint — mirrors `returned`
  // above (same "swap the action for a static badge" UX), independent of it
  // since a ticket can only ever be returned OR carried, never both.
  const [carried, setCarried] = useState<Set<number>>(new Set());

  const sprint = sprints.find((s) => s.id === selectedSprintId);

  // Increment 14 (SPEC_14 §2/§3): the NEW role-aware done/not-done/rejected/
  // ambiguous statistics — additive to (and independent of) the done/not_done
  // report above, which stays driven by the pre-Increment-14 algorithm and is
  // untouched. Fetched alongside the old report so both are visible without
  // requiring a "Generate" click of their own — it's a read-only GET, safe to
  // load any time a sprint is selected.
  const closureStatsState = useAsync(
    () => (selectedSprintId != null ? api.getClosureStats(selectedSprintId) : Promise.resolve(undefined)),
    [selectedSprintId],
  );

  async function generate() {
    if (selectedSprintId == null) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.closeSprint(selectedSprintId);
      setReport(r);
      setReturned(new Set());
      setCarried(new Set());
      onSprintsChanged();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  }

  async function returnToBacklog(wpId: number) {
    if (selectedSprintId == null) return;
    try {
      await api.removeSprintItem(selectedSprintId, wpId);
      setReturned((s) => new Set(s).add(wpId));
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  async function openVersionExport() {
    if (selectedSprintId == null) return;
    setError(undefined);
    try {
      const exp = await api.getVersionExport(selectedSprintId);
      window.open(exp.deep_link, "_blank", "noopener");
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  return (
    <Panel
      title="Sprint closure"
      actions={<SprintSelect sprints={sprints} value={selectedSprintId} onChange={onSelectSprint} />}
    >
      {selectedSprintId == null ? (
        <EmptyState>Select a sprint to generate its closure report.</EmptyState>
      ) : (
        <>
          <div className="row" style={{ marginBottom: 12, alignItems: "center" }}>
            {canPlan ? (
            <button className="btn" type="button" disabled={busy} onClick={generate}>
              {busy
                ? "Generating…"
                : sprint?.is_locked
                  ? "View / regenerate closure report"
                  : sprint?.status === "closed"
                    ? "Regenerate report"
                    : "Close sprint & generate report"}
            </button>
            ) : null}
            {canPlan && sprint?.is_locked ? (
              <span className="muted" style={{ fontSize: 12 }}>
                This sprint is already locked — this only (re)builds the report, it does not change anything.
              </span>
            ) : null}
            {report ? (
              <button className="btn secondary" type="button" onClick={openVersionExport}>
                Open in OP to change version →
              </button>
            ) : null}
          </div>

          {error ? <ErrorBox error={error} /> : null}

          {report ? (
            <div className="board">
              <ClosureList title={`Done (${report.done.length})`} items={report.done} baseUrl={baseUrl} />
              <ClosureColumn
                title={`Not done (${report.not_done.length})`}
                items={report.not_done}
                returned={returned}
                onReturn={returnToBacklog}
                baseUrl={baseUrl}
                // Increment 34 (§5): "Carry over" alongside "Return to
                // backlog" — only meaningful once this sprint is actually
                // closed/locked (matches the sprint-board card's own gate;
                // a "Not done" report can in principle be regenerated on an
                // as-yet-unlocked sprint, SPEC_04 §6's "view/regenerate"
                // wording above, so this isn't assumed unconditionally).
                sprints={sprints}
                sourceSprintId={selectedSprintId}
                sourceLocked={Boolean(sprint?.is_locked || sprint?.status === "closed")}
                carried={carried}
                onCarried={(wpId) => {
                  setCarried((s) => new Set(s).add(wpId));
                  closureStatsState.reload();
                  onSprintsChanged();
                }}
              />
            </div>
          ) : (
            <EmptyState>Generate the report to see done / not-done work packages.</EmptyState>
          )}

          {report && report.version_change.length > 0 ? (
            <Panel title={`Version change candidates (${report.version_change.length})`}>
              <p className="muted">
                Carried / not-done items to move to a new version in OpenProject. Use the deep link above to bulk-edit — this app never writes to OP.
              </p>
              <ul>
                {report.version_change.map((it) => (
                  <li key={it.wp_op_id}>
                    <TicketRef item={it} baseUrl={baseUrl} /> {it.version_name ? `(${it.version_name})` : ""}
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}

          {/* SPEC_14 §2/§3: the NEW role-aware buckets/statistics — additive,
              always available once a sprint is selected (doesn't require
              generating the report above). */}
          <Panel title="Closure statistics (role-aware)">
            <Async state={closureStatsState} loadingLabel="Loading closure statistics…">
              {(stats) => (stats ? <ClosureStatsView stats={stats} baseUrl={baseUrl} /> : null)}
            </Async>
          </Panel>

          {closureStatsState.data ? <OffSprintClosureSection offSprint={closureStatsState.data.off_sprint} /> : null}
        </>
      )}
    </Panel>
  );
}

/**
 * Increment 33 (docs/INCREMENT_33_CONTRACTS.md §4) — percentage formatting
 * shared by the Closure and Reports "Outside the sprint" sections: 0 decimals
 * once the share is meaningfully large (≥10 %), 1 decimal below that so a
 * small-but-real share (e.g. "3.4 %") doesn't collapse to "3%" vs "0%" noise.
 * `null` (both sides 0 — §1) renders as an em dash, never "0%".
 */
export function formatSharePct(pct: number | null): string {
  if (pct === null || Number.isNaN(pct)) return "—";
  return Math.abs(pct) >= 10 ? `${Math.round(pct)}%` : `${pct.toFixed(1)}%`;
}

type ClosureOffSprint = ClosureStatsResponse["off_sprint"];
type ClosureOffSprintPerson = ClosureOffSprint["per_person"][number];

function offSprintPersonKey(p: ClosureOffSprintPerson): string {
  return p.op_user_id != null ? `id:${p.op_user_id}` : `name:${p.name}`;
}

/**
 * Increment 33 (docs/INCREMENT_33_CONTRACTS.md §4) — "Outside the sprint":
 * the logged time `off_sprint_time_entry` rows attribute to developers on
 * THIS sprint, but on tickets that never made it in. Deliberately its own
 * component (not imported from SprintBoardScreen's Increment-32 section,
 * per the file-ownership boundary) even though it mirrors that section's
 * interaction pattern: collapsed by default, ▸/▾ per-person rows expanding
 * to plain-text ticket lists. Renders nothing when there's no off-sprint
 * time at all (§0.1 — this block never feeds any other number, so an all-
 * zero sprint should show nothing rather than a "0h" stub). Shared as-is by
 * ClosureScreen (live sprint) and ReportsScreen (closed-sprint report
 * detail) — both read the identical `ClosureStatsResponse.off_sprint` shape,
 * so one component avoids re-deriving the same rendering twice.
 */
export function OffSprintClosureSection({ offSprint }: { offSprint: ClosureOffSprint }) {
  const [expanded, setExpanded] = useState(false);
  const [expandedPeople, setExpandedPeople] = useState<Set<string>>(new Set());

  if (offSprint.total_hours === 0) return null;

  const totalWindowHours = offSprint.total_hours + offSprint.sprint_logged_hours;

  function togglePerson(key: string) {
    setExpandedPeople((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div style={{ marginTop: 12 }} data-testid="closure-off-sprint-section">
      <button
        type="button"
        className="btn small secondary"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        data-testid="closure-off-sprint-toggle"
      >
        Outside the sprint — {formatHours(offSprint.total_hours)} {expanded ? "▲" : "▼"}
      </button>
      <div className="muted" style={{ marginTop: 4, fontSize: 12 }} data-testid="closure-off-sprint-headline">
        {formatSharePct(offSprint.share_pct)} of developer time outside the sprint — {formatHours(offSprint.total_hours)} of{" "}
        {formatHours(totalWindowHours)} total
      </div>
      {expanded ? (
        <div style={{ marginTop: 8 }} data-testid="closure-off-sprint-people">
          {offSprint.per_person.map((p) => {
            const key = offSprintPersonKey(p);
            return (
              <div key={key} style={{ marginBottom: 4 }}>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => togglePerson(key)}
                  aria-expanded={expandedPeople.has(key)}
                  data-testid={`closure-off-sprint-person-${key}`}
                >
                  {expandedPeople.has(key) ? "▾" : "▸"} {p.name} — {formatHours(p.total_hours)} (
                  {formatSharePct(p.share_pct)})
                </button>
                {expandedPeople.has(key) ? (
                  <ul
                    className="muted"
                    style={{ margin: "4px 0 0 18px", padding: 0, fontSize: 12 }}
                    data-testid={`closure-off-sprint-tickets-${key}`}
                  >
                    {p.tickets.map((t) => (
                      <li key={t.wp_op_id}>
                        #{t.wp_op_id} {t.subject ?? ""} — {formatHours(t.hours)}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * SPEC_09 §4: ticket reference, deep-linked when a base URL is resolvable.
 * `ClosureItem` (frozen contract) has no per-item `connection_base_url`, so
 * this always links via the "current" connection — a best-effort deep link,
 * not necessarily the ticket's own source server for a multi-server sprint.
 */
function TicketRef({ item, baseUrl }: { item: Pick<ClosureItem, "wp_op_id" | "subject">; baseUrl?: string }) {
  const label = `#${item.wp_op_id} ${item.subject}`;
  if (!baseUrl) return <>{label}</>;
  return (
    <a href={opWorkPackageUrl(baseUrl, item.wp_op_id)} target="_blank" rel="noopener noreferrer">
      {label}
    </a>
  );
}

function ClosureList({ title, items, baseUrl }: { title: string; items: ClosureItem[]; baseUrl?: string }) {
  return (
    <div>
      <h3 style={{ fontSize: 13, margin: "0 0 8px", color: "var(--muted)" }}>{title}</h3>
      {items.length === 0 ? (
        <EmptyState>None.</EmptyState>
      ) : (
        items.map((it) => (
          <div className="card" key={it.wp_op_id}>
            <div className="card-title"><TicketRef item={it} baseUrl={baseUrl} /></div>
            <div className="card-meta">
              <span className="badge">{it.status_name}</span>
              <span>{it.assignee_name ?? "Unassigned"}</span>
              <span>{formatHours(it.remaining_hours)} left</span>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function ClosureColumn({
  title,
  items,
  returned,
  onReturn,
  baseUrl,
  sprints,
  sourceSprintId,
  sourceLocked = false,
  carried,
  onCarried,
}: {
  title: string;
  items: ClosureItem[];
  returned: Set<number>;
  onReturn: (wpId: number) => void;
  baseUrl?: string;
  /**
   * Increment 34 (docs/INCREMENT_34_CONTRACTS.md §5): "Carry over" alongside
   * "Return to backlog" on each not-done row — every "Not done" row is, by
   * construction, not done, so the only extra gate needed here is
   * `sourceLocked`. All four are optional together so `ClosureColumn` stays
   * usable for the "Done" list too (`ClosureList` above, unaffected) without
   * every caller having to pass carry-over plumbing it doesn't need.
   */
  sprints?: Sprint[];
  sourceSprintId?: number;
  sourceLocked?: boolean;
  carried?: Set<number>;
  onCarried?: (wpId: number) => void;
}) {
  const canPlan = useCan("plan");
  return (
    <div>
      <h3 style={{ fontSize: 13, margin: "0 0 8px", color: "var(--muted)" }}>{title}</h3>
      {items.length === 0 ? (
        <EmptyState>None.</EmptyState>
      ) : (
        items.map((it) => (
          <div className="card" key={it.wp_op_id}>
            <div style={{ display: "flex", gap: 8, alignItems: "start" }}>
              <div style={{ flex: 1 }}>
                <div className="card-title"><TicketRef item={it} baseUrl={baseUrl} /></div>
                <div className="card-meta">
                  <span className="badge">{it.status_name}</span>
                  <span>{it.assignee_name ?? "Unassigned"}</span>
                  <span>{formatHours(it.remaining_hours)} left</span>
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end" }}>
                {!canPlan ? null : returned.has(it.wp_op_id) ? (
                  <span className="badge">Returned</span>
                ) : (
                  <button type="button" className="btn small secondary" onClick={() => onReturn(it.wp_op_id)}>
                    Return to backlog
                  </button>
                )}
                {sourceLocked && sprints && sourceSprintId != null && onCarried ? (
                  carried?.has(it.wp_op_id) ? (
                    <span className="badge">Carried</span>
                  ) : (
                    <CarryOverButton
                      sprints={sprints}
                      sourceSprintId={sourceSprintId}
                      wpOpId={it.wp_op_id}
                      onCarried={() => onCarried(it.wp_op_id)}
                    />
                  )
                ) : null}
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
