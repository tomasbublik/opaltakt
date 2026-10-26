import { useState } from "react";
import type { BurndownResponse, ClosedSprintSummary, ClosureStatsResponse } from "@osp/contracts";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../api-client";
import { useAsync } from "../lib/useAsync";
import { formatDate, formatHours } from "../lib/format";
import { Async, EmptyState, ErrorBox, Panel } from "./ui";
import { ClosureStatsView } from "./ClosureStats";
// Increment 33 (docs/INCREMENT_33_CONTRACTS.md §4) — the "Outside the sprint"
// section is shared as-is with ClosureScreen (same ClosureStatsResponse.off_sprint
// shape, read-only here too); not re-implemented per the ownership boundary.
import { OffSprintClosureSection } from "./ClosureScreen";

const BUCKET_COLORS: Record<string, string> = {
  Done: "#16a34a",
  "Not done": "#dc2626",
  Rejected: "#64748b",
  Ambiguous: "#d97706",
};

/**
 * SPEC_14 §4 "Reporty + PDF pro management": closed sprints only
 * (GET /api/reports), each with a Detail view and a Generate PDF download.
 * Works entirely from stored data (baseline, changelog, snapshots, closure)
 * — no live OP call — and generating a report/PDF is READ-ONLY: it never
 * changes sprint.status/is_locked, even for an already-locked sprint
 * (SPEC_11 §8a's "view ≠ lock" principle, restated for §4).
 */
export function ReportsScreen({ refreshKey, baseUrl }: { refreshKey: number; baseUrl?: string }) {
  const [selected, setSelected] = useState<number | undefined>();
  const state = useAsync(() => api.getReports(), [refreshKey]);

  return (
    <>
      <Panel title="Reports">
        <Async
          state={state}
          loadingLabel="Loading reports…"
          isEmpty={(d) => d.length === 0}
          empty={<EmptyState>No closed sprints yet.</EmptyState>}
        >
          {(reports) => (
            <div style={{ overflowX: "auto" }}>
              <div className="table-scroll">
<table className="grid" data-testid="reports-table">
                <thead>
                  <tr>
                    <th>Sprint</th>
                    <th>Window</th>
                    <th>Closed</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {reports.map((r) => (
                    <ReportRow
                      key={r.sprint_id}
                      report={r}
                      selected={selected === r.sprint_id}
                      onDetail={() => setSelected(r.sprint_id === selected ? undefined : r.sprint_id)}
                    />
                  ))}
                </tbody>
              </table>
</div>
            </div>
          )}
        </Async>
      </Panel>

      {selected != null ? (
        <ReportDetail sprintId={selected} baseUrl={baseUrl} onClose={() => setSelected(undefined)} />
      ) : null}
    </>
  );
}

function ReportRow({
  report,
  selected,
  onDetail,
}: {
  report: ClosedSprintSummary;
  selected: boolean;
  onDetail: () => void;
}) {
  return (
    <tr className={selected ? "row-selected" : undefined} data-testid={`report-row-${report.sprint_id}`}>
      <td>{report.name}</td>
      <td>
        {formatDate(report.start_date)} – {formatDate(report.end_date)}
      </td>
      {/* Increment 16 (SPEC_16 §4): pinned to DD/MM/YYYY via the shared
          formatDate, replacing the previous ad-hoc, implicit-locale
          `new Date(...).toLocaleString()` call. */}
      <td>{report.closed_at ? formatDate(report.closed_at) : "—"}</td>
      <td>
        <div className="row" style={{ gap: 8, marginBottom: 0 }}>
          <button type="button" className="btn small secondary" onClick={onDetail}>
            {selected ? "Hide detail" : "Detail"}
          </button>
          <GeneratePdfButton sprintId={report.sprint_id} />
        </div>
      </td>
    </tr>
  );
}

/**
 * SPEC_14 §4: POST /api/reports/:id/pdf streams a PDF download — never a
 * JSON envelope. `api.generateReportPdf` triggers a normal browser download
 * as its side effect; this button just tracks busy/error around that call.
 */
function GeneratePdfButton({ sprintId }: { sprintId: number }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | undefined>();

  async function generate() {
    setBusy(true);
    setError(undefined);
    try {
      await api.generateReportPdf(sprintId);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span>
      <button
        type="button"
        className="btn small secondary"
        disabled={busy}
        onClick={() => void generate()}
        data-testid={`generate-pdf-${sprintId}`}
      >
        {busy ? "Generating…" : "Generate PDF"}
      </button>
      {error ? (
        <span className="muted" style={{ fontSize: 11, marginLeft: 6, color: "var(--danger)" }}>
          {error.message}
        </span>
      ) : null}
    </span>
  );
}

function ReportDetail({
  sprintId,
  baseUrl,
  onClose,
}: {
  sprintId: number;
  baseUrl?: string;
  onClose: () => void;
}) {
  const state = useAsync(() => api.getReportDetail(sprintId), [sprintId]);

  return (
    <Panel
      title="Report detail"
      actions={
        <button type="button" className="btn small secondary" onClick={onClose}>
          Close
        </button>
      }
    >
      <Async state={state} loadingLabel="Loading report…">
        {(data) => (
          <div data-testid="report-detail">
            <div className="row" style={{ alignItems: "center", marginBottom: 16 }}>
              <div>
                <h3 style={{ margin: 0 }}>{data.sprint.name}</h3>
                <span className="muted">
                  {formatDate(data.sprint.start_date)} – {formatDate(data.sprint.end_date)}
                </span>
              </div>
              <div className="spacer" />
              <GeneratePdfButton sprintId={sprintId} />
            </div>
            <ClosureStatsView stats={data.stats} baseUrl={baseUrl} />
            <OffSprintClosureSection offSprint={data.stats.off_sprint} />
            <ReportCharts stats={data.stats} burndown={data.burndown} />
          </div>
        )}
      </Async>
      {state.error ? <ErrorBox error={state.error} onRetry={state.reload} /> : null}
    </Panel>
  );
}

/**
 * SPEC_14 §4 charts: burndown/burnup (reusing the same recharts LineChart
 * shape BurndownScreen already renders for a live sprint), a per-developer
 * bar chart, an estimate-vs-actual bar chart (done tickets only — SPEC_14
 * §3's "accuracy only makes sense for done work"), and a done/not-done/
 * rejected/ambiguous pie. recharts is already a dependency (BurndownScreen) —
 * no new charting library added.
 */
/** Increment 40 (R1): "Estimate vs. actual" tooltip label — `#<id> · <identifier>`
 * when the project identifier is known, else `#<id>`. */
export function estimateTooltipLabel(opId: number, identifier: string | null | undefined): string {
  return identifier ? `#${opId} · ${identifier}` : `#${opId}`;
}

function ReportCharts({ stats, burndown }: { stats: ClosureStatsResponse; burndown: BurndownResponse }) {
  const bucketData = [
    { name: "Done", value: stats.done.count },
    { name: "Not done", value: stats.not_done.count },
    { name: "Rejected", value: stats.rejected.count },
    { name: "Ambiguous", value: stats.ambiguous.count },
  ].filter((d) => d.value > 0);
  const doneTickets = stats.per_ticket.filter((t) => t.bucket === "done");
  // Increment 40 (R1): tooltip label `#<id> · <identifier>` when known.
  const identifierById = new Map(doneTickets.map((t) => [t.wp_op_id, t.project_identifier]));
  const estimateChartLabel = (v: number): string => estimateTooltipLabel(v, identifierById.get(v));

  return (
    <div style={{ marginTop: 24 }}>
      <h3 style={{ fontSize: 13, margin: "0 0 8px", color: "var(--muted)" }}>Burndown / burnup</h3>
      <div style={{ width: "100%", height: 280 }} data-testid="report-burndown-chart">
        <ResponsiveContainer>
          <LineChart data={burndown.points} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis dataKey="date" fontSize={11} />
            <YAxis fontSize={11} tickFormatter={(v: number) => formatHours(v)} />
            <Tooltip formatter={(value: number) => formatHours(value)} />
            <Legend />
            <Line type="monotone" dataKey="ideal_hours" name="Ideal" stroke="#94a3b8" strokeDasharray="5 5" dot={false} />
            <Line type="monotone" dataKey="remaining_hours" name="Remaining" stroke="#2563eb" connectNulls dot={false} />
            <Line type="monotone" dataKey="logged_hours" name="Logged" stroke="#16a34a" connectNulls dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="row" style={{ marginTop: 24, alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 320 }}>
          <h3 style={{ fontSize: 13, margin: "0 0 8px", color: "var(--muted)" }}>Per developer</h3>
          <div style={{ width: "100%", height: 260 }} data-testid="report-developer-chart">
            <ResponsiveContainer>
              <BarChart data={stats.per_developer} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="name" fontSize={11} />
                <YAxis fontSize={11} tickFormatter={(v: number) => formatHours(v)} />
                <Tooltip formatter={(value: number) => formatHours(value)} />
                <Legend />
                <Bar dataKey="planned_hours" name="Planned" fill="#94a3b8" />
                <Bar dataKey="logged_hours" name="Logged" fill="#2563eb" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 320 }}>
          <h3 style={{ fontSize: 13, margin: "0 0 8px", color: "var(--muted)" }}>Estimate vs. actual (done tickets)</h3>
          <div style={{ width: "100%", height: 260 }} data-testid="report-estimate-chart">
            <ResponsiveContainer>
              <BarChart data={doneTickets} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="wp_op_id" fontSize={11} tickFormatter={(v: number) => `#${v}`} />
                <YAxis fontSize={11} tickFormatter={(v: number) => formatHours(v)} />
                <Tooltip formatter={(value: number) => formatHours(value)} labelFormatter={(v: number) => estimateChartLabel(v)} />
                <Legend />
                <Bar dataKey="estimate_hours" name="Estimate" fill="#94a3b8" />
                <Bar dataKey="dev_logged_hours" name="Dev logged" fill="#2563eb" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 260 }}>
          <h3 style={{ fontSize: 13, margin: "0 0 8px", color: "var(--muted)" }}>Done / not-done / rejected</h3>
          <div style={{ width: "100%", height: 260 }} data-testid="report-status-chart">
            <ResponsiveContainer>
              <PieChart>
                <Pie data={bucketData} dataKey="value" nameKey="name" outerRadius={90} label>
                  {bucketData.map((d) => (
                    <Cell key={d.name} fill={BUCKET_COLORS[d.name] ?? "#94a3b8"} />
                  ))}
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}
