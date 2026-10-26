/**
 * SPEC_03 Phase 0 — the FROZEN contract between the stateful mock OP engine
 * (fixtures/mock-op-server/, Agent M1), the declarative scenarios + control
 * panel/CLI (fixtures/scenarios/ + fixtures/mock-ui/, Agent M2) and the
 * verification suites (tests/, Agent V). Data only — no runtime code here.
 *
 * ── Clock semantics (SPEC_03 §4) ────────────────────────────────────────────
 * The engine holds a logical CURRENT DATE.
 *  - load(scenario): state := seed; day := 0; date := startDate; timeline
 *    entries with day === 0 are applied immediately.
 *  - advance-day: day += 1; date += 1 calendar day; apply that day's events.
 *  - goto-day n: forward-only fast-forward; n < current day ⇒ reload the
 *    scenario from scratch, then advance to n.
 *  - Every event that touches a work package bumps its `updatedAt` to the
 *    current date (time component increments per mutation within a day, e.g.
 *    09:00:00Z, 09:01:00Z…, so `updatedAt >=d` filters and ordering are
 *    deterministic). Untouched WPs keep their old `updatedAt`.
 *  - logTime creates a time entry with spentOn = current date. It does NOT
 *    implicitly decrease remainingTime — pair it with an explicit
 *    setRemaining event (scenarios stay predictable; real OP behaves the same).
 *  - Scenario-mode work packages report `spentTime: null` — the app must
 *    aggregate time entries itself (the realistic no-permission OP path).
 *  - Each scenario-mode time entry also gets a `createdAt` timestamp (the
 *    engine's next mutation stamp, same clock as `updatedAt`) — Increment 4's
 *    changelog needs a precise moment to order `time_logged` entries by.
 *
 * ── Journals / activities (SPEC_04 §3, Increment 4) ─────────────────────────
 * GET /api/v3/work_packages/:id/activities serves one journal entry per
 * MUTATING event applied to that WP (setStatus/reassign/setRemaining/
 * setEstimate/setVersion — NOT logTime, which is a time entry, not a journal).
 * Each entry has exactly one `details` item naming the OLD and NEW value of
 * the field that event touched, plus an attributed actor (see MockEvent's
 * `actor` doc below for the default-resolution rule). This is a documented
 * SIMPLIFICATION of real OpenProject (whose Activity.details are formatted
 * prose, not structured) made deliberately so the changelog engine has exact,
 * testable data instead of a text-parsing problem — see
 * packages/op-client/src/types.ts's OpActivity for the wire shape.
 *
 * ── Fixture mode vs scenario mode ───────────────────────────────────────────
 * With NO scenario loaded the server behaves exactly like the legacy static
 * mock (re-reads fixtures/data/*.json per request; sim.ts keeps working).
 * POST /__mock/load/:name switches the instance to in-memory scenario state;
 * POST /__mock/reset returns it to fixture mode. Each server instance owns its
 * OWN engine state (parallel tests stay isolated).
 *
 * ── Admin API (SPEC_03 §5; NOT OpenProject — never called by op-client) ────
 *  GET  /__mock/scenarios          → ScenarioSummary[]
 *  POST /__mock/load/:name         → MockStateSummary
 *  POST /__mock/advance-day        → AdvanceDayResult   (body: AdvanceDayRequest)
 *  POST /__mock/goto-day/:n        → MockStateSummary
 *  POST /__mock/inject-urgent      → { work_package: WorkPackageStateSummary }
 *  GET  /__mock/state              → MockStateSummary
 *  POST /__mock/reset              → { mode: "fixtures" }
 *  POST /__mock/rename-project/:id → RenameProjectResult (body: RenameProjectRequest)
 *  GET  /__mock/ui (+ /__mock/ui/*) → static control panel from fixtures/mock-ui/
 */

// ── Scenario seed shapes ─────────────────────────────────────────────────────

export interface ScenarioUser {
  /** Scenario-local reference key, e.g. "dev", "tester", "customer". */
  key: string;
  id: number;
  name: string;
  login?: string;
  /** Exactly one seeded user should be the /users/me identity. */
  me?: boolean;
}

export interface ScenarioStatus {
  id: number;
  name: string;
  isClosed: boolean;
}

export interface ScenarioProject {
  id: number;
  identifier: string;
  name: string;
  /**
   * Increment 40 — a project the token cannot see as a PROJECT although its
   * work packages are visible (real OP: WP shared across projects, archived
   * project, or a role without "view project" on it). The mock keeps serving
   * its WPs (with `_links.project.title` = `name`, exactly like real OP's
   * embedded link) but omits it from `GET /api/v3/projects` and answers
   * `GET /api/v3/projects/{id}` with a 404 HAL error. Default false.
   */
  hidden?: boolean;
}

export interface ScenarioVersion {
  /** Scenario-local reference key. */
  key: string;
  id: number;
  name: string;
  /** Owning project id (drives /projects/:id/versions). */
  projectId: number;
}

export interface WorkPackageSeed {
  /** Scenario-local reference key used by timeline events. */
  key: string;
  /** Explicit OP id; auto-assigned (5001, 5002, …) when omitted. */
  id?: number;
  subject: string;
  /** Type display name; default "Task". */
  type?: string;
  /** Owning project id. */
  project: number;
  /** Status NAME (must exist in seed.statuses). */
  status: string;
  /** User key; null/omitted = unassigned. */
  assignee?: string | null;
  /** User key; the accountable link is SEPARATE from assignee (SPEC_03 §2a). */
  accountable?: string | null;
  estimatedHours?: number | null;
  remainingHours?: number | null;
  storyPoints?: number | null;
  /** Version key; null/omitted = no version. */
  version?: string | null;
  /** Priority display name; default "Normal". */
  priority?: string;
  /** Parent WP key; null/omitted = no parent. */
  parent?: string | null;
  percentageDone?: number | null;
}

export interface TimeEntrySeed {
  /** WP key. */
  wp: string;
  /** User key. */
  user: string;
  hours: number;
  /** YYYY-MM-DD (seeds may predate startDate). */
  spentOn: string;
}

// ── Timeline events (SPEC_03 §4; `actor` added in SPEC_04 §3 for journals) ──

/**
 * Actor attribution for a mutating event (who OP would show as the journal's
 * author). All variants below except `logTime` (whose `user` field already IS
 * the actor) accept an OPTIONAL `actor` override; when omitted the engine
 * defaults to the ticket's CURRENT assignee (its value immediately BEFORE this
 * event is applied) — "whoever has the ticket makes the change", including a
 * `reassign` itself being attributed to the OUTGOING assignee (the handoff).
 * A ticket with no assignee at that moment gets an unattributed (actor: null)
 * journal entry. This default needs NO changes to existing scenario data —
 * see s1-accountable-handoff.ts for why it already tells the right story.
 */
export type MockEvent =
  | {
      t: "setStatus";
      wp: string;
      status: string;
      actor?: string;
      /**
       * Increment 21 (SPEC_21) — OPTIONAL override for the DISPLAYED text in
       * this transition's journal/activity prose ONLY. When set, the activity
       * renders "Status changed … to <i>{statusDisplayText}</i>" using this raw
       * string, while the WP's own `_links.status.title` still reflects the
       * resolved status object's CANONICAL name. This models the real-world
       * divergence the status-normalization fix targets: OP's activity history
       * preserves whatever casing was submitted at the time (e.g. "in progress"),
       * whereas the current status link always shows the status's canonical
       * spelling ("In progress"). `status` still selects the actual status;
       * `statusDisplayText` only changes how THIS journal entry reads. Narrowly
       * scoped to the Status field on purpose — not a general per-field mechanism.
       */
      statusDisplayText?: string;
    }
  | {
      t: "reassign";
      wp: string;
      /** User key; null clears the link; omitted = leave unchanged. */
      assignee?: string | null;
      accountable?: string | null;
      actor?: string;
    }
  | { t: "logTime"; wp: string; user: string; hours: number }
  | {
      /**
       * A plain comment on the WP (SPEC_10 §d). Produces a journal/activity
       * with EMPTY `details` and a populated `comment` — the parser must map
       * it to a content-free `comment_added` changelog row. `user` IS the
       * author (like logTime's `user`), so no separate `actor` override.
       */
      t: "comment";
      wp: string;
      user: string;
      text: string;
    }
  | { t: "setRemaining"; wp: string; hours: number; actor?: string }
  | { t: "setEstimate"; wp: string; hours: number | null; actor?: string }
  | { t: "setVersion"; wp: string; version: string | null; actor?: string }
  | { t: "addWorkPackage"; wp: WorkPackageSeed };

export interface TimelineDay {
  /** Logical day number (0 = applied on load; 1 = first advance-day…). */
  day: number;
  events: MockEvent[];
}

// ── Scenario ─────────────────────────────────────────────────────────────────

export interface Scenario {
  /** URL-safe unique name, e.g. "s1-accountable-handoff". */
  name: string;
  description: string;
  /** Logical day 0 (YYYY-MM-DD). */
  startDate: string;
  seed: {
    users: ScenarioUser[];
    /** Defaults to CANONICAL_STATUSES when omitted. */
    statuses?: ScenarioStatus[];
    /** Defaults to DEFAULT_PROJECTS when omitted. */
    projects?: ScenarioProject[];
    versions: ScenarioVersion[];
    workPackages: WorkPackageSeed[];
    timeEntries?: TimeEntrySeed[];
  };
  timeline: TimelineDay[];
  /**
   * Template for POST /__mock/inject-urgent (key gets a unique suffix and the
   * id is auto-assigned per injection). Falls back to a generic urgent bug in
   * the first seeded project when omitted.
   */
  urgentTemplate?: Omit<WorkPackageSeed, "key" | "id">;
}

/** List entry for GET /__mock/scenarios. */
export interface ScenarioSummary {
  name: string;
  description: string;
  start_date: string;
  /** Highest timeline day (0 when the scenario has no timed events). */
  total_days: number;
}

// ── Canonical defaults (SPEC_03 §2b / §9.3 — ids match fixtures/data) ───────

/** The 10-status spectrum with the confirmed isClosed mapping. */
export const CANONICAL_STATUSES: readonly ScenarioStatus[] = [
  { id: 1, name: "New", isClosed: false },
  { id: 2, name: "Confirmed", isClosed: false },
  { id: 7, name: "In progress", isClosed: false },
  { id: 3, name: "Developed", isClosed: false },
  { id: 4, name: "Merge pending", isClosed: false },
  { id: 5, name: "Tested", isClosed: false },
  { id: 6, name: "On hold", isClosed: false },
  { id: 14, name: "Rejected", isClosed: true },
  { id: 15, name: "Resolved", isClosed: true },
  { id: 12, name: "Closed", isClosed: true },
] as const;

export const DEFAULT_PROJECTS: readonly ScenarioProject[] = [
  { id: 3, identifier: "demo-project", name: "Demo Project" },
] as const;

/** Auto-assigned WP ids start here when a seed omits `id`. */
export const AUTO_WP_ID_START = 5001;

// ── Admin API payloads ───────────────────────────────────────────────────────

export interface WorkPackageStateSummary {
  id: number;
  key: string | null;
  subject: string;
  status: string;
  assignee: string | null;
  accountable: string | null;
  estimated_hours: number | null;
  remaining_hours: number | null;
  /** Sum of this WP's time entries (the engine's own bookkeeping). */
  spent_hours: number;
  version: string | null;
  updated_at: string;
}

export interface MockStateSummary {
  /** null = fixture mode (legacy static behavior). */
  scenario: string | null;
  day: number;
  /** Current logical date; null in fixture mode. */
  date: string | null;
  total_days: number;
  /** Days remaining with unapplied timeline events. */
  pending_days: number;
  work_packages: WorkPackageStateSummary[];
}

/**
 * Body of POST /__mock/rename-project/:id (Increment 40). Either field may be
 * omitted (= unchanged); at least one must be present. The rename is live:
 * every later `/api/v3/projects*` response AND every WP `_links.project.title`
 * carries the new values (scenario mode also time entries / memberships /
 * versions; fixture mode overlays projects, WPs and memberships). It is
 * state like any other mutation — a fresh `load` (or a backwards `goto-day`,
 * which reloads) or `reset` discards it.
 */
export interface RenameProjectRequest {
  name?: string;
  identifier?: string;
}

/** Response of POST /__mock/rename-project/:id — the project AFTER the rename. */
export interface RenameProjectResult {
  project: { id: number; identifier: string; name: string; hidden: boolean };
}

export interface AdvanceDayRequest {
  /**
   * When set, after advancing the mock server-side calls the Sprint Planner:
   * POST {app_url}/api/sync {} and POST {app_url}/api/snapshot {date} — the
   * optional helper from SPEC_03 §6 (panel/CLI stay CORS-free). The app's
   * vault must be unlocked; failures are REPORTED, not thrown.
   */
  app_url?: string;
  /** Default true when app_url is set. */
  sync?: boolean;
  /** Default true when app_url is set. */
  snapshot?: boolean;
}

export interface AppHelperResult {
  ok: boolean;
  /** e.g. "HTTP 423 VAULT_LOCKED" or "fetch failed" when !ok. */
  detail: string | null;
}

export interface AdvanceDayResult {
  day: number;
  date: string;
  applied_events: number;
  app?: {
    sync?: AppHelperResult;
    snapshot?: AppHelperResult;
  };
}
