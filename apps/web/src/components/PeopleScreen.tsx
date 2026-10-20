import { useState } from "react";
import type { PersonRole, PersonSummary } from "@osp/contracts";
import { api } from "../api-client";
import { useAsync } from "../lib/useAsync";
import { useCan } from "../lib/role";
import { Async, EmptyState, Panel } from "./ui";

const ROLE_OPTIONS: { value: PersonRole; label: string }[] = [
  { value: "developer", label: "Developer" },
  { value: "tester", label: "Tester" },
  { value: "customer", label: "Customer" },
  { value: "other", label: "Other" },
  { value: "unset", label: "unset" },
];

/**
 * SPEC_14 §2 "Nastavení → Lidé": every person seen in tickets/journals
 * (GET /api/people), each with a role dropdown wired to
 * PUT /api/people/:id/role. `unset` is NEVER guessed — the done-matrix's
 * role-dependent branch and the "capacity = Developers only" rule both
 * depend on this being visible, not silently defaulted, so an unset role
 * gets a highlighted row/badge here and a running "X people without a role
 * affect Y tickets" counter (Y summed straight off `ticket_count`, no extra
 * endpoint needed — SPEC_14 §2).
 */
export function PeopleScreen({ refreshKey }: { refreshKey: number }) {
  const state = useAsync(() => api.getPeople(), [refreshKey]);

  return (
    <Panel title="People">
      <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
        Every person seen in tickets or journals for this vault's connections. Their role decides how the
        done-matrix (§2) and sprint capacity (Developers only) treat their tickets — a role is never guessed.
      </p>
      <Async
        state={state}
        loadingLabel="Loading people…"
        isEmpty={(d) => d.length === 0}
        empty={<EmptyState>No people seen yet — sync a project first.</EmptyState>}
      >
        {(people) => <PeopleList people={people} onChanged={() => state.reload()} />}
      </Async>
    </Panel>
  );
}

function PeopleList({ people, onChanged }: { people: PersonSummary[]; onChanged: () => void }) {
  const unset = people.filter((p) => p.role === "unset");
  const affectedTickets = unset.reduce((s, p) => s + p.ticket_count, 0);

  // Unset-role people surface first — the whole point is that they're never
  // silently buried at the bottom of an alphabetical list.
  const sorted = [...people].sort((a, b) => {
    const au = a.role === "unset";
    const bu = b.role === "unset";
    if (au !== bu) return au ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div>
      {unset.length > 0 ? (
        <div className="msg warn" role="alert" data-testid="unset-role-counter" style={{ marginBottom: 12 }}>
          {unset.length} {unset.length === 1 ? "person" : "people"} without a role affect {affectedTickets}{" "}
          ticket{affectedTickets === 1 ? "" : "s"}.
        </div>
      ) : null}
      <div className="table-scroll">
<table className="grid" data-testid="people-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>OP account</th>
            <th>Tickets</th>
            <th>Role</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((p) => (
            <PersonRow key={p.id} person={p} onChanged={onChanged} />
          ))}
        </tbody>
      </table>
</div>
    </div>
  );
}

function PersonRow({ person, onChanged }: { person: PersonSummary; onChanged: () => void }) {
  const canPlan = useCan("plan");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  const isUnset = person.role === "unset";

  async function changeRole(role: PersonRole) {
    setBusy(true);
    setError(undefined);
    try {
      await api.setPersonRole(person.id, { role });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr className={isUnset ? "row-unset-role" : undefined} data-testid={`person-row-${person.id}`}>
      <td>{person.name}</td>
      <td className="muted">{person.op_user_id != null ? `#${person.op_user_id}` : "—"}</td>
      <td>{person.ticket_count}</td>
      <td>
        <div className="row" style={{ alignItems: "center", gap: 6, marginBottom: 0 }}>
          <select
            aria-label={`Role for ${person.name}`}
            value={person.role}
            disabled={busy || !canPlan}
            className={isUnset ? "role-unset" : undefined}
            onChange={(e) => void changeRole(e.target.value as PersonRole)}
          >
            {ROLE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {isUnset ? (
            <span
              className="badge role-unset"
              title={`Role not set for ${person.name} — their tickets go to the "ambiguous" bucket, never guessed.`}
            >
              unset
            </span>
          ) : null}
        </div>
        {error ? (
          <div className="muted" style={{ fontSize: 11, color: "var(--danger)" }}>
            {error.message}
          </div>
        ) : null}
      </td>
    </tr>
  );
}
