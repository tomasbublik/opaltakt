import type { Sprint } from "@osp/contracts";

/** Shared sprint picker used by the board, burndown, velocity and closure screens. */
export function SprintSelect({
  sprints,
  value,
  onChange,
  id = "sprint-select",
}: {
  sprints: Sprint[];
  value: number | undefined;
  onChange: (id: number) => void;
  id?: string;
}) {
  if (sprints.length === 0) {
    return <span className="muted">No sprints yet.</span>;
  }
  return (
    <div className="field" style={{ marginBottom: 0 }}>
      <label htmlFor={id}>Sprint</label>
      <select id={id} value={value ?? ""} onChange={(e) => onChange(Number(e.target.value))}>
        {sprints.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name} · {s.status === "closed" ? "Finished" : s.status}
          </option>
        ))}
      </select>
    </div>
  );
}
