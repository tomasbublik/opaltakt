import { useEffect, useMemo, useState } from "react";
import type { Sprint } from "@osp/contracts";
import { api } from "../api-client";
import { EmptyState, ErrorBox, Modal } from "./ui";
import { useCan } from "../lib/role";

/**
 * Increment 34 (docs/INCREMENT_34_CONTRACTS.md §3) — "sprint 2/3" badge:
 * this sprint's 1-based position among ALL sprints containing the wp; null
 * for a single-sprint ticket, which renders nothing (byte-identical to a
 * pre-Increment-34 row — no badge, no extra markup). Shared by the sprint
 * board's WpCard and the Closure/Reports per-ticket table (ClosureStats.tsx)
 * so the wording never drifts between the two.
 */
export function MultiSprintBadge({
  badge,
}: {
  badge: { sequence: number; total: number } | null | undefined;
}) {
  if (badge == null) return null;
  return (
    <span
      className="badge"
      title={`This ticket spans ${badge.total} sprints — this is sprint ${badge.sequence}.`}
    >
      sprint {badge.sequence}/{badge.total}
    </span>
  );
}

/**
 * Increment 34 (§5): eligible carry-over targets — `planning` or `active`,
 * unlocked, unfrozen, and never the source sprint itself. Mirrors the
 * server's own gate (SPRINT_LOCKED / SPRINT_FROZEN / source-is-target 409s)
 * so the select never even offers a choice the backend would reject.
 */
export function eligibleCarryTargets(sprints: Sprint[], sourceSprintId: number): Sprint[] {
  return sprints.filter(
    (s) =>
      s.id !== sourceSprintId &&
      (s.status === "planning" || s.status === "active") &&
      !s.is_locked &&
      s.frozen_at == null,
  );
}

/**
 * Increment 34 (§5) — "Carry over" button + confirm modal: carries an
 * unfinished ticket from a (typically closed/locked) source sprint into a
 * chosen open one. The source sprint/item is never mutated server-side; the
 * caller decides WHEN to render this (closed/locked source + not-done item,
 * per the contract) — this component only handles the target picker and the
 * API call. Shared by SprintBoardScreen's sprint-member cards and
 * ClosureScreen's "Not done" list rows.
 */
export function CarryOverButton({
  sprints,
  sourceSprintId,
  wpOpId,
  onCarried,
  label = "Carry over",
}: {
  /** The full sprint list (any status) — eligible targets are filtered from it. */
  sprints: Sprint[];
  sourceSprintId: number;
  wpOpId: number;
  /** Called once the carry succeeds — the caller re-fetches/refreshes. */
  onCarried: () => void;
  label?: string;
}) {
  const canPlan = useCan("plan");
  const [open, setOpen] = useState(false);
  const [targetId, setTargetId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  const [justCarried, setJustCarried] = useState<string | undefined>();

  const targets = useMemo(() => eligibleCarryTargets(sprints, sourceSprintId), [sprints, sourceSprintId]);

  useEffect(() => {
    if (!justCarried) return;
    const t = window.setTimeout(() => setJustCarried(undefined), 4000);
    return () => window.clearTimeout(t);
  }, [justCarried]);

  function openModal() {
    setOpen(true);
    setTargetId("");
    setError(undefined);
  }

  function close() {
    if (busy) return;
    setOpen(false);
  }

  async function confirm() {
    if (!targetId) return;
    setBusy(true);
    setError(undefined);
    try {
      const target = targets.find((s) => String(s.id) === targetId);
      await api.carrySprintItem(sourceSprintId, wpOpId, { target_sprint_id: Number(targetId) });
      setOpen(false);
      setJustCarried(target ? `Carried to "${target.name}".` : "Carried.");
      onCarried();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  }

  // Increment 39: a Viewer cannot carry tickets (hooks above all ran).
  if (!canPlan) return null;

  return (
    <>
      <button type="button" className="btn small secondary" onClick={openModal}>
        {label}
      </button>
      {justCarried ? (
        <div className="msg ok" role="status" style={{ marginTop: 4, fontSize: 12 }}>
          {justCarried}
        </div>
      ) : null}
      {open ? (
        <Modal title="Carry over to another sprint" onClose={close}>
          <p className="muted" style={{ fontSize: 12 }}>
            Move this unfinished ticket into a sprint that's still open, entering at its current estimate of record.
          </p>
          {targets.length === 0 ? (
            <EmptyState>No eligible open sprint to carry this into.</EmptyState>
          ) : (
            <>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor={`carry-target-${wpOpId}`}>Target sprint</label>
                <select
                  id={`carry-target-${wpOpId}`}
                  aria-label="Target sprint"
                  value={targetId}
                  disabled={busy}
                  onChange={(e) => setTargetId(e.target.value)}
                >
                  <option value="">Select a sprint…</option>
                  {targets.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
              {error ? (
                <div style={{ marginTop: 8 }}>
                  <ErrorBox error={error} />
                </div>
              ) : null}
              <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
                <button type="button" className="btn small secondary" disabled={busy} onClick={close}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn small"
                  disabled={busy || !targetId}
                  onClick={() => void confirm()}
                >
                  {busy ? "Carrying…" : "Carry over"}
                </button>
              </div>
            </>
          )}
        </Modal>
      ) : null}
    </>
  );
}
