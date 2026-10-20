import type {
  ClosureItem,
  ClosureReportResponse,
  DoneStatusRule,
  LockReason,
} from "@osp/contracts";
import type { Repositories } from "@osp/db";
import { classifyStatus } from "./done";

/**
 * Closure report + version deep-link (SPEC §6). At sprint close:
 *  - split tickets into done / not-done,
 *  - not-done are offered to carry back to the backlog (outcome=carried),
 *  - build a READ-ONLY deep-link into the OP work-package table filtered on the
 *    carried ids so the user can bulk-edit the version in OP. Nothing is written.
 */
export interface ClosureInputItem {
  wp_op_id: number;
  subject: string;
  status_name: string;
  status_is_closed: boolean;
  assignee_name: string | null;
  planned_hours: number | null;
  remaining_hours: number | null;
  version_name: string | null;
  /**
   * Increment 34 (docs/INCREMENT_34_CONTRACTS.md §1) — burned-remaining
   * velocity inputs. `remaining_start_hours` = ticket_baseline.remaining at
   * activation; `remaining_end_hours` = the CURRENT live remaining (ignored
   * for a done item — see `burnedRemainingHours` below, which always forces
   * remEnd = 0 there). BOTH optional: omitted ⇒ `completed_hours` keeps its
   * pre-Increment-34 meaning EXACTLY (Σ `planned_hours` over done items only —
   * a not-done item's default remEnd = remStart burns 0), so every existing
   * caller/test is unaffected without editing.
   */
  remaining_start_hours?: number | null;
  remaining_end_hours?: number | null;
}

export interface ClosureSplit {
  done: ClosureItem[];
  not_done: ClosureItem[];
  /** Candidates to move to a new version in OP (== not_done). */
  version_change: ClosureItem[];
  /** Sum of planned_hours for done items (velocity input). */
  completed_hours: number;
}

function toClosureItem(i: ClosureInputItem): ClosureItem {
  return {
    wp_op_id: i.wp_op_id,
    subject: i.subject,
    status_name: i.status_name,
    assignee_name: i.assignee_name,
    planned_hours: i.planned_hours,
    remaining_hours: i.remaining_hours,
    version_name: i.version_name,
  };
}

/**
 * Increment 34 (docs/INCREMENT_34_CONTRACTS.md §1; CAPACITY_BAR_RULES §5
 * "Velocity") — `max(0, remStart − remEnd)`, the SAME rule
 * `developerSegments.ts`'s `burnedRemaining` applies, expressed over
 * `ClosureInputItem` (whose "estimate of record" field is `planned_hours`,
 * not `estimate_hours` — a different name for the same concept in this
 * module). `remEnd` is FORCED to 0 for a done item regardless of what (if
 * anything) the caller passed — "done" always means "nothing left to burn".
 */
export function burnedRemainingHours(it: ClosureInputItem, isDone: boolean): number {
  const estHours = it.planned_hours ?? 0;
  const remStart = it.remaining_start_hours ?? estHours;
  const remEnd = isDone ? 0 : (it.remaining_end_hours ?? remStart);
  return Math.max(0, remStart - remEnd);
}

/**
 * Increment 34 (CAPACITY_BAR_RULES §5 "Delivered", integration fix) — the ONE
 * gap-aware read of a `ticket_baseline`'s remaining. A RETROSPECTIVE sprint's
 * baseline is journal-reconstructed, and OP journals that never touched
 * "Remaining work" before start_date make `stateAtDate` fall back to the
 * ticket's CURRENT live remaining (packages/op-client/src/reconstruct.ts) —
 * which, for a finished timeline, is typically 0. That value is honestly
 * flagged in `reconstruction_gaps_json` ("remaining_hours"), and treating it
 * as a real at-start figure would zero every burned-remaining Delivered/
 * velocity credit on retro sprints (the th-/tr- e2e regressions). A gapped
 * remaining is therefore UNKNOWN (null ⇒ callers fall back to the estimate of
 * record), never a number. Malformed gap JSON reads as gapped — admit, don't
 * infer.
 *
 * The same "not an at-start fact" reasoning applies to an `added_retroactively`
 * baseline (SPEC_25): it is captured live at ADD-CLICK time — by definition
 * AFTER the work it retro-credits happened — so its remaining (typically an
 * explicit 0 on an already-done ticket) reflects the post-work state, and
 * using it as remStart would erase exactly the burn the retro add exists to
 * credit (the tr- e2e regression). Unknown ⇒ estimate fallback ⇒ a done
 * retro-added ticket delivers its estimate, exactly as before Increment 34.
 */
export function baselineRemaining(
  b:
    | {
        remaining_hours: number | null;
        reconstruction_gaps_json: string | null;
        origin?: string;
      }
    | null
    | undefined,
): number | null {
  if (!b || b.remaining_hours == null) return null;
  if (b.origin === "added_retroactively") return null;
  if (b.reconstruction_gaps_json != null) {
    try {
      const gaps = JSON.parse(b.reconstruction_gaps_json) as unknown;
      if (!Array.isArray(gaps) || gaps.includes("remaining_hours")) return null;
    } catch {
      return null;
    }
  }
  return b.remaining_hours;
}

export function buildClosureSplit(
  items: ClosureInputItem[],
  rules: DoneStatusRule[],
): ClosureSplit {
  const done: ClosureItem[] = [];
  const not_done: ClosureItem[] = [];
  let completed_hours = 0;
  for (const it of items) {
    const cls = classifyStatus(it, rules);
    const isDone = cls === "done";
    if (isDone) {
      done.push(toClosureItem(it));
    } else {
      // rejected + open are both "not done" for carry purposes.
      not_done.push(toClosureItem(it));
    }
    // Increment 34 — velocity (`completed_hours`) now sums burned remaining
    // over EVERY item, uniformly, not just done items' flat planned_hours:
    // a ticket spanning sprints delivers the slice it actually burned in
    // THIS sprint, done or not. Omitted remaining_start/end_hours (every
    // pre-Increment-34 caller) reduces to exactly the old sum (see the type's
    // doc comment) — a not-done item contributes 0 by construction.
    completed_hours += burnedRemainingHours(it, isDone);
  }
  return { done, not_done, version_change: not_done, completed_hours };
}

/** Build the done/not-done split for a sprint's LIVE items (pure — no writes). */
async function buildClosureData(
  repos: Repositories,
  sprintId: number,
): Promise<{ items: Awaited<ReturnType<Repositories["sprintItems"]["listBySprint"]>>; split: ClosureSplit }> {
  // Increment 5 (SPEC_05 §1): a ticket descoped mid-sprint is no longer a
  // commitment — it must NOT appear as "not done"/carried at closure, same
  // treatment as the classic pre-activation "removed" (packages/sync's
  // computeSnapshot already excludes both from the burndown for this reason).
  const items = (await repos.sprintItems.listBySprint(sprintId)).filter(
    (i) => i.outcome !== "removed" && i.outcome !== "removed_mid_sprint",
  );
  const [wps, baselines] = await Promise.all([
    repos.workPackages.getManyByOpIds(items.map((i) => i.wp_op_id)),
    repos.ticketBaselines.listBySprint(sprintId),
  ]);
  const wpById = new Map(wps.map((w) => [w.op_id, w]));
  const baselineByWp = new Map(baselines.map((b) => [b.wp_op_id, b]));
  const rules = await repos.doneStatusRules.listBySprint(sprintId);

  const closureInput: ClosureInputItem[] = items.map((it) => {
    const wp = wpById.get(it.wp_op_id);
    const baseline = baselineByWp.get(it.wp_op_id);
    return {
      wp_op_id: it.wp_op_id,
      subject: wp?.subject ?? `WP ${it.wp_op_id}`,
      status_name: wp?.status_name ?? "",
      status_is_closed: wp?.status_is_closed ?? false,
      assignee_name: wp?.assignee_name ?? null,
      planned_hours: it.planned_hours,
      remaining_hours: wp?.remaining_hours ?? null,
      version_name: wp?.version_name ?? null,
      // Increment 34 (§1) — remStart = the activation-time baseline snapshot
      // (falls back to planned_hours inside burnedRemainingHours when null);
      // remEnd = the CURRENT live remaining (ignored for a done item). A
      // journal-gapped reconstructed remaining is UNKNOWN, not a number — see
      // baselineRemaining above.
      remaining_start_hours: baselineRemaining(baseline),
      remaining_end_hours: wp?.remaining_hours ?? null,
    };
  });
  return { items, split: buildClosureSplit(closureInput, rules) };
}

/**
 * SPEC_11 §8a — compute + persist the closure report WITHOUT any side effect on
 * the sprint's status/lock. This is what POST /sprints/:id/close does now:
 * "View / regenerate closure report" is a READ-ish operation and MUST be safely
 * repeatable on a still-ACTIVE sprint (the old bug locked it via performClosure).
 * It writes a fresh sprint_closure_report row (idempotent upsert) but does NOT
 * setOutcome on items (those stay "planned" while running) and does NOT lock.
 */
export async function computeAndStoreClosureReport(
  repos: Repositories,
  sprintId: number,
): Promise<ClosureReportResponse> {
  const { split } = await buildClosureData(repos, sprintId);
  const saved = await repos.closureReports.upsert({
    sprint_id: sprintId,
    done_json: JSON.stringify(split.done),
    not_done_json: JSON.stringify(split.not_done),
    version_change_json: JSON.stringify(split.version_change),
  });
  return {
    sprint_id: sprintId,
    generated_at: saved.generated_at,
    done: split.done,
    not_done: split.not_done,
    version_change: split.version_change,
  };
}

/**
 * Increment 31 (docs/INCREMENT_31_CONTRACTS.md §2b step 2) — the
 * outcome-baking + closure-report half of a closure pass, extracted VERBATIM
 * out of `performClosure` so the freeze sweep can re-run it WITHOUT also
 * re-running `repos.sprints.close` (which would stomp `closed_at`/`locked_at`/
 * `lock_reason` on a sprint that is already closed and locked). `performClosure`
 * below is now just "refresh + close" — behaviour for its EXISTING callers
 * (POST /sprints/:id/finish) is byte-identical to before this split.
 *
 * Split into done/not-done from the sprint's LIVE items (still read from
 * `work_package_cache`/baselines — this runs BEFORE the freeze snapshot is
 * written, see freeze.ts step ordering), persists each item's outcome (done →
 * done, else carried — never delete), and persists sprint_closure_report.
 */
export async function refreshClosureArtifacts(
  repos: Repositories,
  sprintId: number,
  generatedAt: string,
): Promise<{ report: ClosureReportResponse; completed_hours: number }> {
  const { items, split } = await buildClosureData(repos, sprintId);
  const doneWpIds = new Set(split.done.map((d) => d.wp_op_id));

  // Persist outcomes: done → done; not-done → carried (never delete).
  for (const it of items) {
    await repos.sprintItems.setOutcome(
      it.id,
      doneWpIds.has(it.wp_op_id) ? "done" : "carried",
    );
  }

  // The repository stamps its OWN generated_at (it is omitted from the insert
  // type). Read that stored value back and use it for BOTH the atomic close
  // (performClosure) and the response, so an idempotent re-close/re-finish
  // (which returns the stored report) matches this response EXACTLY — the
  // `generatedAt` arg is only a fallback contract for callers that need one.
  const saved = await repos.closureReports.upsert({
    sprint_id: sprintId,
    done_json: JSON.stringify(split.done),
    not_done_json: JSON.stringify(split.not_done),
    version_change_json: JSON.stringify(split.version_change),
  });

  return {
    report: {
      sprint_id: sprintId,
      generated_at: saved.generated_at,
      done: split.done,
      not_done: split.not_done,
      version_change: split.version_change,
    },
    completed_hours: split.completed_hours,
  };
}

/**
 * Perform a sprint closure (SPEC §6 / SPEC_04 §5): split live items into
 * done/not-done, persist each item's outcome (done → done, else carried),
 * persist the sprint_closure_report, and ATOMICALLY close+lock the sprint.
 *
 * EXCLUSIVE to POST /sprints/:id/finish (SPEC_11 §8a): the lock is the finish
 * event, never a side effect of viewing/regenerating the report. Callers own
 * the idempotency check (an already-closed sprint returns the stored report via
 * readStoredClosureReport instead of re-running this).
 *
 * Increment 31: now literally "refreshClosureArtifacts + close" — the refresh
 * half is shared with the freeze sweep (freeze.ts), which needs the SAME
 * outcome-baking/report-regeneration but must NOT re-close an already-closed
 * sprint.
 */
export async function performClosure(
  repos: Repositories,
  sprintId: number,
  generatedAt: string,
  lockReason: LockReason = "finished",
): Promise<ClosureReportResponse> {
  const { report, completed_hours } = await refreshClosureArtifacts(repos, sprintId, generatedAt);
  // Closing IS the lock event (SPEC_04): status="closed" + is_locked atomically.
  await repos.sprints.close(sprintId, completed_hours, report.generated_at, lockReason);
  return report;
}

/**
 * The idempotent read of an already-generated closure report (a re-`close` /
 * re-`finish` returns the stored report unchanged). Mirrors the shape
 * performClosure returns.
 */
export async function readStoredClosureReport(
  repos: Repositories,
  sprintId: number,
  fallbackGeneratedAt: string,
): Promise<ClosureReportResponse> {
  const stored = await repos.closureReports.getBySprint(sprintId);
  return {
    sprint_id: sprintId,
    generated_at: stored?.generated_at ?? fallbackGeneratedAt,
    done: stored ? (JSON.parse(stored.done_json) as ClosureReportResponse["done"]) : [],
    not_done: stored
      ? (JSON.parse(stored.not_done_json) as ClosureReportResponse["not_done"])
      : [],
    version_change: stored
      ? (JSON.parse(stored.version_change_json) as ClosureReportResponse["version_change"])
      : [],
  };
}

/**
 * OP deep-link to the work-package table filtered to the given ids (SPEC §6).
 * URL-encodes the query_props value. READ-ONLY — user performs the bulk edit.
 */
export function buildVersionDeepLink(
  baseUrl: string,
  projectIdentifier: string,
  wpOpIds: number[],
): string {
  const queryProps = JSON.stringify({
    c: ["id", "subject", "version"],
    t: "id:asc",
    f: [{ n: "id", o: "=", v: wpOpIds.map((id) => String(id)) }],
  });
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/projects/${projectIdentifier}/work_packages?query_props=${encodeURIComponent(queryProps)}`;
}
