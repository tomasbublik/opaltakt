import { useState } from "react";
import type { BurndownPoint, Sprint } from "@osp/contracts";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../api-client";
import { useAsync } from "../lib/useAsync";
import { formatDate, formatHours } from "../lib/format";
import { Async, EmptyState, ErrorBox, Panel } from "./ui";
import { useCan } from "../lib/role";
import { SprintSelect } from "./SprintSelect";
import { isIsolatedSnapshotPoint } from "../lib/burndownDots";

/**
 * Recharts custom-dot factory for the Remaining/Logged lines: draw a dot ONLY
 * for an isolated snapshot value (see isIsolatedSnapshotPoint — a lone
 * first-day point was otherwise invisible: no segment to draw, dots off).
 * Recharts calls this per point and expects an element back — an empty <g/>
 * is the "no dot" case.
 */
function isolatedSnapshotDot(
  points: readonly BurndownPoint[],
  key: "remaining_hours" | "logged_hours",
  fill: string,
) {
  return function IsolatedDot(props: { cx?: number; cy?: number; index?: number }) {
    const i = props.index ?? -1;
    if (props.cx == null || props.cy == null || !isIsolatedSnapshotPoint(points, i, key)) {
      return <g key={`${key}-dot-${i}`} />;
    }
    return (
      <circle
        key={`${key}-dot-${i}`}
        cx={props.cx}
        cy={props.cy}
        r={3.5}
        fill={fill}
        data-testid={`burndown-dot-${key}`}
      />
    );
  };
}

/**
 * SPEC §8 Burndown/burnup: ideal vs. remaining (burndown) vs. logged (burnup),
 * driven by GET /api/sprints/:id/burndown (daily snapshots, SPEC §6).
 *
 * SPEC_12 §5/§9: "Rebuild burndown from OP history" — since burndown is
 * recomputable straight from OP journals + time entries (not just the
 * nightly job), offer it for ANY sprint, including a locked one. It's a
 * pure read/recompute that NEVER touches sprint.status/is_locked (same
 * "view ≠ lock" principle as ClosureScreen's regenerate button), so no
 * confirmation modal is needed — safe and repeatable.
 */
export function BurndownScreen({
  sprints,
  selectedSprintId,
  onSelectSprint,
  refreshKey,
}: {
  sprints: Sprint[];
  selectedSprintId: number | undefined;
  onSelectSprint: (id: number) => void;
  refreshKey: number;
}) {
  const state = useAsync(
    () => (selectedSprintId != null ? api.getBurndown(selectedSprintId) : Promise.resolve(null)),
    [selectedSprintId, refreshKey],
  );
  const canPlan = useCan("plan");
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildError, setRebuildError] = useState<Error | undefined>();

  async function rebuild() {
    if (selectedSprintId == null) return;
    setRebuilding(true);
    setRebuildError(undefined);
    try {
      await api.rebuildBurndown(selectedSprintId);
      state.reload();
    } catch (err) {
      setRebuildError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setRebuilding(false);
    }
  }

  return (
    <Panel
      title="Burndown / burnup"
      actions={<SprintSelect sprints={sprints} value={selectedSprintId} onChange={onSelectSprint} />}
    >
      {selectedSprintId == null ? (
        <EmptyState>Select a sprint to see its burndown.</EmptyState>
      ) : (
        <Async state={state} loadingLabel="Loading burndown…" isEmpty={(d) => d == null || d.points.length === 0} empty={<EmptyState>No snapshots yet — the nightly job records them daily.</EmptyState>}>
          {(data) =>
            data == null ? null : (
              <>
                <div className="row" style={{ marginBottom: 12, alignItems: "center" }}>
                  <div className="stat">
                    <span className="stat-value">{formatHours(data.total_planned_hours)}</span>
                    <span className="stat-label">Planned</span>
                  </div>
                  <div className="stat">
                    <span className="stat-value">{formatDate(data.start_date)}</span>
                    <span className="stat-label">Start</span>
                  </div>
                  <div className="stat">
                    <span className="stat-value">{formatDate(data.end_date)}</span>
                    <span className="stat-label">End</span>
                  </div>
                  {canPlan ? (
                    <button type="button" className="btn small secondary" disabled={rebuilding} onClick={() => void rebuild()}>
                      {rebuilding ? "Rebuilding…" : "Rebuild burndown from OP history"}
                    </button>
                  ) : null}
                </div>
                {rebuildError ? <div style={{ marginBottom: 12 }}><ErrorBox error={rebuildError} /></div> : null}
                <div style={{ width: "100%", height: 360 }} data-testid="burndown-chart">
                  <ResponsiveContainer>
                    <LineChart data={data.points} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                      <XAxis dataKey="date" fontSize={11} />
                      {/* SPEC_11 §7: never show a raw un-rounded value like 54.333333333333336 —
                          same formatHours helper used everywhere else (e.g. "54.3h"). */}
                      <YAxis fontSize={11} tickFormatter={(v: number) => formatHours(v)} />
                      <Tooltip formatter={(value: number) => formatHours(value)} />
                      <Legend />
                      <Line type="monotone" dataKey="ideal_hours" name="Ideal" stroke="#94a3b8" strokeDasharray="5 5" dot={false} />
                      <Line
                        type="monotone"
                        dataKey="remaining_hours"
                        name="Remaining"
                        stroke="#2563eb"
                        connectNulls
                        dot={isolatedSnapshotDot(data.points, "remaining_hours", "#2563eb")}
                      />
                      <Line
                        type="monotone"
                        dataKey="logged_hours"
                        name="Logged"
                        stroke="#16a34a"
                        connectNulls
                        dot={isolatedSnapshotDot(data.points, "logged_hours", "#16a34a")}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </>
            )
          }
        </Async>
      )}
    </Panel>
  );
}
