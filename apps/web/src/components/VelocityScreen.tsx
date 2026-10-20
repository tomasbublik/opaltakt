import type { Sprint } from "@osp/contracts";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../api-client";
import { useAsync } from "../lib/useAsync";
import { formatHours } from "../lib/format";
import { Async, EmptyState, Panel } from "./ui";
import { SprintSelect } from "./SprintSelect";

/**
 * SPEC §8 Velocity: bar chart of delivered vs. planned hours over the last N
 * closed sprints, plus the recommended capacity for the next sprint (SPEC §6),
 * from GET /api/sprints/:id/velocity. Increment 37: the delivered figure (still
 * `completed_hours` on the wire) equals Closure's Delivered — same vocabulary,
 * same numbers.
 */
export function VelocityScreen({
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
    () => (selectedSprintId != null ? api.getVelocity(selectedSprintId) : Promise.resolve(null)),
    [selectedSprintId, refreshKey],
  );

  // SPEC_12 §4/§9/§12.3: retrospective sprints count toward velocity but must
  // be visibly distinguished (badge) — VelocityHistoryEntry itself carries no
  // is_retrospective flag (frozen contract), so cross-reference the already-
  // loaded `sprints` list by id, the same one every other screen gets as a prop.
  const retrospectiveSprintIds = new Set(sprints.filter((s) => s.is_retrospective).map((s) => s.id));

  return (
    <Panel
      title="Velocity"
      actions={<SprintSelect sprints={sprints} value={selectedSprintId} onChange={onSelectSprint} />}
    >
      {selectedSprintId == null ? (
        <EmptyState>Select a sprint to see velocity.</EmptyState>
      ) : (
        <Async state={state} loadingLabel="Loading velocity…" isEmpty={(d) => d == null || d.history.length === 0} empty={<EmptyState>No closed sprints yet — velocity appears once sprints are closed.</EmptyState>}>
          {(data) =>
            data == null ? null : (
              <>
                <div className="row" style={{ marginBottom: 12 }}>
                  <div className="stat">
                    <span className="stat-value" title="Matches this sprint's Closure Delivered figure">
                      {formatHours(data.average_completed_hours)}
                    </span>
                    <span className="stat-label">Avg delivered ({data.window} sprints)</span>
                  </div>
                  <div className="stat">
                    <span className="stat-value">{formatHours(data.recommended_capacity_hours)}</span>
                    <span className="stat-label">Recommended capacity</span>
                  </div>
                </div>
                {/* Oldest → newest reads naturally left-to-right. */}
                <div style={{ width: "100%", height: 340 }} data-testid="velocity-chart">
                  <ResponsiveContainer>
                    <BarChart data={[...data.history].reverse()} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                      <XAxis dataKey="name" fontSize={11} />
                      {/* SPEC_11 §7: round every displayed hour value to 1 decimal (formatHours). */}
                      <YAxis fontSize={11} tickFormatter={(v: number) => formatHours(v)} />
                      <Tooltip formatter={(value: number) => formatHours(value)} />
                      <Legend />
                      <Bar dataKey="planned_hours" name="Planned" fill="#94a3b8" />
                      <Bar dataKey="completed_hours" name="Delivered" fill="#2563eb" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                {/* SPEC_11 §9: per-server split of each closed sprint's delivered hours
                    (by_connection, still `completed_hours` on the wire), attributed by
                    the DONE items' source connection — reuses the capacity panel's row
                    layout for a consistent look. */}
                <div style={{ marginTop: 16 }}>
                  <h3 style={{ fontSize: 12, margin: "0 0 8px", color: "var(--muted)" }}>
                    Delivered hours by server
                  </h3>
                  {data.history.map((h) => (
                    <div className="capacity-line" key={h.sprint_id}>
                      <span style={{ width: 160 }}>
                        {h.name}
                        {retrospectiveSprintIds.has(h.sprint_id) ? (
                          <span
                            className="badge"
                            data-testid={`retro-badge-velocity-${h.sprint_id}`}
                            title="Reconstructed retrospectively from OP history, not planned live"
                            style={{ marginLeft: 6 }}
                          >
                            Retrospective
                          </span>
                        ) : null}
                      </span>
                      <span className="muted" style={{ flex: 1 }}>
                        {h.by_connection.length === 0
                          ? "—"
                          : h.by_connection
                              .map((c) => `${c.label ?? c.base_url}: ${formatHours(c.completed_hours)}`)
                              .join(" · ")}
                      </span>
                      <span style={{ width: 90, textAlign: "right" }}>{formatHours(h.completed_hours)}</span>
                    </div>
                  ))}
                </div>
              </>
            )
          }
        </Async>
      )}
    </Panel>
  );
}
