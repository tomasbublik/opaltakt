import {
  AUTO_WP_ID_START,
  CANONICAL_STATUSES,
  DEFAULT_PROJECTS,
  type AdvanceDayResult,
  type MockEvent,
  type MockStateSummary,
  type RenameProjectRequest,
  type RenameProjectResult,
  type Scenario,
  type ScenarioProject,
  type ScenarioStatus,
  type ScenarioSummary,
  type WorkPackageSeed,
  type WorkPackageStateSummary,
} from "../scenario-types";

/**
 * SPEC_03 §4 — the stateful scenario engine behind the mock OP server.
 *
 * One engine per server instance (module singleton, every recording server,
 * every startMockOpServer) — NO shared mutable module state, so parallel test
 * suites stay isolated. With no scenario loaded the engine is in "fixtures"
 * mode and the HTTP layer serves the legacy static JSON files untouched.
 *
 * Clock semantics (frozen in ../scenario-types.ts):
 *  - load: state := deep-copied seed; day := 0; date := startDate; day-0
 *    timeline events applied immediately.
 *  - advance-day: day += 1, date += 1 calendar day, apply that day's events.
 *  - goto-day n: forward fast-forward; n < day ⇒ reload from scratch first.
 *  - Seeded WPs get `${startDate}T08:00:00Z`; every mutation stamps the
 *    touched WP `${currentDate}T09:00:00Z` + 1 minute per successive mutation
 *    that day. Untouched WPs keep their timestamp.
 *  - logTime creates a time entry (spentOn = current date) and does NOT change
 *    remainingTime.
 */

/** Engine-side error carrying the HTTP status the admin API should emit. */
export class MockEngineError extends Error {
  override readonly name = "MockEngineError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ── Internal (resolved) state shapes ─────────────────────────────────────────

export interface EngineUser {
  key: string;
  id: number;
  name: string;
  login: string | null;
  me: boolean;
}

export interface EngineVersion {
  key: string;
  id: number;
  name: string;
  projectId: number;
}

export interface EngineWorkPackage {
  key: string;
  id: number;
  subject: string;
  typeName: string;
  projectId: number;
  statusId: number;
  assigneeId: number | null;
  accountableId: number | null;
  estimatedHours: number | null;
  remainingHours: number | null;
  storyPoints: number | null;
  versionId: number | null;
  priority: string;
  parentId: number | null;
  percentageDone: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface EngineTimeEntry {
  id: number;
  wpId: number;
  userId: number;
  hours: number;
  spentOn: string;
  /** Mutation-clock timestamp (Increment 4: orders `time_logged` changelog entries). */
  createdAt: string;
}

/** One field's old/new value for a journal detail (SPEC_04 §3). */
export interface EngineJournalDetail {
  property: "status" | "assignee" | "accountable" | "estimatedTime" | "remainingTime" | "version";
  /** null = the field was empty; a reference field carries {id, name}. */
  oldValue: { id: number; name: string } | number | null;
  newValue: { id: number; name: string } | number | null;
}

/**
 * One journal (activity) entry — one per mutating event, SPEC_04 §3.
 * A journal is EITHER a field change (`detail` set, `comment` null) OR a plain
 * comment (`detail` null, `comment` set) — SPEC_10 §d's content-free
 * `comment_added`. The two are never both set.
 */
export interface EngineJournal {
  id: number;
  wpId: number;
  actorId: number | null;
  createdAt: string;
  /** The field change this journal records; null for a pure-comment journal. */
  detail: EngineJournalDetail | null;
  /** Comment text; null for a field-change journal. */
  comment: string | null;
}

/** Read-only view of the loaded scenario state (the HTTP layer serializes it). */
export interface ScenarioView {
  statuses: ScenarioStatus[];
  projects: ScenarioProject[];
  users: EngineUser[];
  versions: EngineVersion[];
  workPackages: EngineWorkPackage[];
  timeEntries: EngineTimeEntry[];
  /** All journal entries across every WP (SPEC_04 §3); filter by wpId to serve one ticket's activities. */
  journals: EngineJournal[];
}

/** Scenarios may be injected directly (unit tests) or provided lazily (registry). */
export type ScenarioRegistry = Scenario[] | (() => Promise<Scenario[]>);

/** First time-entry id handed out in scenario mode (clear of fixture ids). */
const FIRST_TIME_ENTRY_ID = 9001;

/** Add `days` calendar days to a YYYY-MM-DD date. */
function addDays(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Highest timeline day of a scenario (0 when it has no timed events). */
function maxTimelineDay(scenario: Scenario): number {
  let max = 0;
  for (const entry of scenario.timeline) max = Math.max(max, entry.day);
  return max;
}

// ── Lazy scenario registry (Agent M2 delivers ../scenarios/index.ts) ─────────

let registryCache: Promise<Scenario[]> | null = null;

/**
 * Load `scenarios` from ../scenarios/index (built by Agent M2 in parallel).
 * Tolerant: when the registry is missing or broken the server still boots in
 * fixture mode with an empty scenario list. Cached after the first attempt.
 */
export function loadScenarioRegistry(): Promise<Scenario[]> {
  registryCache ??= (async () => {
    for (const rel of ["../scenarios/index.ts", "../scenarios/index.js"]) {
      try {
        // Computed specifier keeps tsc/vite from statically resolving a module
        // that may not exist yet (M2 builds it in parallel).
        const spec = new URL(rel, import.meta.url).href;
        const mod = (await import(spec)) as { scenarios?: unknown };
        if (Array.isArray(mod.scenarios)) return mod.scenarios as Scenario[];
      } catch {
        // Registry absent → keep trying / fall through to empty.
      }
    }
    return [];
  })();
  return registryCache;
}

// ── The engine ───────────────────────────────────────────────────────────────

export class ScenarioEngine {
  private readonly registry: ScenarioRegistry;

  private scenario: Scenario | null = null;
  private day = 0;
  private date: string | null = null;
  /** Mutations applied on the current logical day (drives the 09:0N stamps). */
  private mutationsToday = 0;
  /**
   * Increment 19 (SPEC_19 §2 test harness): artificial per-page delay (ms) the
   * HTTP layer applies BEFORE every `work_packages` collection response, so an
   * e2e test can reliably click "Abort" while a paged sync is still in flight
   * (a real mock answers in <1ms, making the race unwinnable). 0 = disabled.
   * Set via `POST /__mock/set-latency-ms`; RESET to 0 by any `load`/`reset`
   * (a fresh scenario starts fast unless a test opts back in). Instance-scoped
   * like every other engine field, so parallel suites never interfere.
   */
  private workPackagesLatencyMs = 0;
  private urgentCount = 0;
  private nextWpId = AUTO_WP_ID_START;
  private nextTimeEntryId = FIRST_TIME_ENTRY_ID;
  private nextJournalId = 1;

  private statuses: ScenarioStatus[] = [];
  private projects: ScenarioProject[] = [];
  private users: EngineUser[] = [];
  private versions: EngineVersion[] = [];
  private workPackages: EngineWorkPackage[] = [];
  private timeEntries: EngineTimeEntry[] = [];
  private journals: EngineJournal[] = [];
  /**
   * Increment 40 — FIXTURE-mode project renames (`POST /__mock/rename-project`
   * with no scenario loaded). The static `data/projects.json` is never
   * written; the HTTP layer overlays these on every project-bearing response.
   * Cleared by `load`/`reset`. (Scenario mode mutates `this.projects`.)
   */
  private fixtureProjectOverrides = new Map<number, { name?: string; identifier?: string }>();
  /** Supplies the static fixture-mode project list (for rename validation). */
  private readonly fixtureProjects: () => ScenarioProject[];

  constructor(
    registry: ScenarioRegistry = loadScenarioRegistry,
    fixtureProjects: () => ScenarioProject[] = () => [],
  ) {
    this.registry = registry;
    this.fixtureProjects = fixtureProjects;
  }

  /**
   * Increment 40 — fixture-mode overlay for one project id (empty object when
   * not renamed). Read by the HTTP layer; never mutates the JSON files.
   */
  fixtureProjectOverride(id: number): { name?: string; identifier?: string } {
    return this.fixtureProjectOverrides.get(id) ?? {};
  }

  /**
   * POST /__mock/rename-project/:id (Increment 40) — rename a project's
   * `name` and/or `identifier`. The `op_id` never changes (it is the identity;
   * name/identifier are display-only — exactly the real OP rename semantics).
   * Scenario mode: mutates the loaded state, so every later project endpoint
   * and every WP/time-entry/membership/version `_links.project.title` carries
   * the new values. Fixture mode: recorded as an overlay on data/projects.json.
   * Unknown id → 404; empty patch / non-string fields → 400.
   */
  renameProject(id: number, patch: RenameProjectRequest): RenameProjectResult {
    if (!Number.isInteger(id) || id <= 0) {
      throw new MockEngineError(400, `rename-project expects a positive integer id, got "${id}"`);
    }
    const name = patch.name;
    const identifier = patch.identifier;
    if (name === undefined && identifier === undefined) {
      throw new MockEngineError(400, "rename-project needs at least one of { name, identifier }");
    }
    for (const [field, v] of [["name", name], ["identifier", identifier]] as const) {
      if (v !== undefined && (typeof v !== "string" || v.trim() === "")) {
        throw new MockEngineError(400, `rename-project: "${field}" must be a non-empty string`);
      }
    }
    if (this.scenario !== null) {
      const project = this.projects.find((p) => p.id === id);
      if (project === undefined) {
        throw new MockEngineError(404, `Scenario has no project with id ${id}`);
      }
      if (name !== undefined) project.name = name;
      if (identifier !== undefined) project.identifier = identifier;
      return {
        project: {
          id: project.id,
          identifier: project.identifier,
          name: project.name,
          hidden: project.hidden === true,
        },
      };
    }
    const base = this.fixtureProjects().find((p) => p.id === id);
    if (base === undefined) {
      throw new MockEngineError(404, `Fixture data has no project with id ${id}`);
    }
    const next = { ...this.fixtureProjectOverride(id) };
    if (name !== undefined) next.name = name;
    if (identifier !== undefined) next.identifier = identifier;
    this.fixtureProjectOverrides.set(id, next);
    return {
      project: {
        id,
        identifier: next.identifier ?? base.identifier,
        name: next.name ?? base.name,
        hidden: false,
      },
    };
  }

  get mode(): "fixtures" | "scenario" {
    return this.scenario === null ? "fixtures" : "scenario";
  }

  /** Current artificial per-page work_packages latency (ms); 0 = disabled. */
  get workPackagesLatency(): number {
    return this.workPackagesLatencyMs;
  }

  /**
   * POST /__mock/set-latency-ms — inject an artificial delay (ms) before each
   * `work_packages` collection response (SPEC_19 §2 abort-test harness).
   * Clamped to a non-negative integer; a non-finite/negative value 400s so a
   * typo never silently disables the delay the test is relying on.
   */
  setWorkPackagesLatency(ms: number): number {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new MockEngineError(400, `set-latency-ms expects a non-negative number, got "${ms}"`);
    }
    this.workPackagesLatencyMs = Math.floor(ms);
    return this.workPackagesLatencyMs;
  }

  /** Live (read-only) view of the loaded state; null in fixture mode. */
  view(): ScenarioView | null {
    if (this.scenario === null) return null;
    return {
      statuses: this.statuses,
      projects: this.projects,
      users: this.users,
      versions: this.versions,
      workPackages: this.workPackages,
      timeEntries: this.timeEntries,
      journals: this.journals,
    };
  }

  private async scenarios(): Promise<Scenario[]> {
    return Array.isArray(this.registry) ? this.registry : this.registry();
  }

  async listScenarios(): Promise<ScenarioSummary[]> {
    const all = await this.scenarios();
    return all.map((s) => ({
      name: s.name,
      description: s.description,
      start_date: s.startDate,
      total_days: maxTimelineDay(s),
    }));
  }

  /** POST /__mock/load/:name — reset to day 0 of the named scenario. */
  async load(name: string): Promise<MockStateSummary> {
    const all = await this.scenarios();
    const scenario = all.find((s) => s.name === name);
    if (scenario === undefined) {
      throw new MockEngineError(404, `Unknown scenario "${name}"`);
    }
    return this.loadScenario(scenario);
  }

  /** Load a scenario object directly (unit tests / goto-day rewind). */
  loadScenario(scenario: Scenario): MockStateSummary {
    // Deep copy so the registry's scenario objects are never mutated.
    const sc = structuredClone(scenario);
    if (!Number.isFinite(Date.parse(`${sc.startDate}T00:00:00Z`))) {
      throw new MockEngineError(
        400,
        `Scenario "${sc.name}" has an invalid startDate "${sc.startDate}"`,
      );
    }

    this.scenario = sc;
    this.day = 0;
    this.date = sc.startDate;
    this.mutationsToday = 0;
    // A fresh scenario load starts fast — a test that needs the abort window
    // re-arms the delay explicitly (SPEC_19 §2 harness contract).
    this.workPackagesLatencyMs = 0;
    this.fixtureProjectOverrides.clear();
    this.urgentCount = 0;
    this.nextWpId = AUTO_WP_ID_START;
    this.nextTimeEntryId = FIRST_TIME_ENTRY_ID;
    this.nextJournalId = 1;

    this.statuses = (sc.seed.statuses ?? [...CANONICAL_STATUSES]).map((s) => ({ ...s }));
    this.projects = (sc.seed.projects ?? [...DEFAULT_PROJECTS]).map((p) => ({ ...p }));
    this.users = sc.seed.users.map((u) => ({
      key: u.key,
      id: u.id,
      name: u.name,
      login: u.login ?? null,
      me: u.me ?? false,
    }));
    this.versions = [];
    for (const v of sc.seed.versions) {
      if (this.projects.every((p) => p.id !== v.projectId)) {
        throw new MockEngineError(
          400,
          `Version "${v.key}" references unknown project id ${v.projectId}`,
        );
      }
      this.versions.push({ key: v.key, id: v.id, name: v.name, projectId: v.projectId });
    }
    this.workPackages = [];
    this.timeEntries = [];
    this.journals = [];

    // Seeded WPs carry the frozen `${startDate}T08:00:00Z` timestamp.
    const seededAt = `${sc.startDate}T08:00:00Z`;
    for (const seed of sc.seed.workPackages) this.addWorkPackage(seed, seededAt);
    for (const te of sc.seed.timeEntries ?? []) {
      // Seed entries do NOT bump updatedAt (they predate the clock).
      this.createTimeEntry(te.wp, te.user, te.hours, te.spentOn, seededAt);
    }

    // Day-0 timeline events apply immediately on load.
    this.applyDayEvents(0);
    return this.stateSummary();
  }

  /** POST /__mock/advance-day (the app-helper part lives in the admin layer). */
  advanceDay(): AdvanceDayResult {
    const sc = this.requireScenario();
    this.day += 1;
    this.date = addDays(sc.startDate, this.day);
    this.mutationsToday = 0;
    const applied = this.applyDayEvents(this.day);
    return { day: this.day, date: this.date, applied_events: applied };
  }

  /** POST /__mock/goto-day/:n — forward fast-forward; backward ⇒ reload first. */
  gotoDay(n: number): MockStateSummary {
    const sc = this.requireScenario();
    if (!Number.isInteger(n) || n < 0) {
      throw new MockEngineError(400, `goto-day expects a non-negative integer, got "${n}"`);
    }
    if (n < this.day) this.loadScenario(sc); // rewind = reload + fast-forward
    while (this.day < n) this.advanceDay();
    return this.stateSummary();
  }

  /** POST /__mock/inject-urgent — add the urgent template (or a generic bug) "now". */
  injectUrgent(): WorkPackageStateSummary {
    const sc = this.requireScenario();
    const template = sc.urgentTemplate ?? this.genericUrgentTemplate();
    this.urgentCount += 1;
    let key = `urgent-${this.urgentCount}`;
    while (this.workPackages.some((wp) => wp.key === key)) {
      this.urgentCount += 1;
      key = `urgent-${this.urgentCount}`;
    }
    const wp = this.addWorkPackage({ ...template, key }, this.nextTimestamp());
    return this.workPackageSummary(wp);
  }

  /** POST /__mock/reset — back to the legacy static fixture behavior. */
  reset(): void {
    this.scenario = null;
    this.day = 0;
    this.date = null;
    this.mutationsToday = 0;
    this.workPackagesLatencyMs = 0;
    this.fixtureProjectOverrides.clear();
    this.urgentCount = 0;
    this.statuses = [];
    this.projects = [];
    this.users = [];
    this.versions = [];
    this.workPackages = [];
    this.timeEntries = [];
    this.journals = [];
  }

  /**
   * GET /api/v3/work_packages/:id/activities (SPEC_04 §3) — this WP's journal,
   * chronological. Empty in fixture mode (no scenario loaded) or for an
   * unknown wpId (a 404 on the collection wouldn't be useful; real OP-style
   * "no activity yet" is an empty list, and the HTTP layer 404s separately
   * when the WP itself doesn't resolve).
   */
  getActivities(wpId: number): EngineJournal[] {
    return this.journals.filter((j) => j.wpId === wpId);
  }

  /** GET /__mock/state. */
  stateSummary(): MockStateSummary {
    const sc = this.scenario;
    const pendingDays =
      sc === null
        ? 0
        : new Set(sc.timeline.filter((t) => t.day > this.day).map((t) => t.day)).size;
    return {
      scenario: sc?.name ?? null,
      day: this.day,
      date: sc === null ? null : this.date,
      total_days: sc === null ? 0 : maxTimelineDay(sc),
      pending_days: pendingDays,
      work_packages: [...this.workPackages]
        .sort((a, b) => a.id - b.id)
        .map((wp) => this.workPackageSummary(wp)),
    };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private requireScenario(): Scenario {
    if (this.scenario === null) {
      throw new MockEngineError(400, "No scenario loaded (mock is in fixture mode)");
    }
    return this.scenario;
  }

  /**
   * Next mutation timestamp: `${currentDate}T09:00:00Z` + 1 minute per
   * successive mutation that day — deterministic `updatedAt >=d` ordering.
   */
  private nextTimestamp(): string {
    const date = this.date ?? this.scenario?.startDate ?? "1970-01-01";
    const base = Date.parse(`${date}T09:00:00Z`);
    const iso = new Date(base + this.mutationsToday * 60_000).toISOString();
    this.mutationsToday += 1;
    return iso.replace(".000Z", "Z");
  }

  private touch(wp: EngineWorkPackage): void {
    wp.updatedAt = this.nextTimestamp();
  }

  /** Apply every timeline entry for `day` (in declaration order). */
  private applyDayEvents(day: number): number {
    const sc = this.requireScenario();
    let applied = 0;
    for (const entry of sc.timeline) {
      if (entry.day !== day) continue;
      for (const event of entry.events) {
        this.applyEvent(event);
        applied += 1;
      }
    }
    return applied;
  }

  private applyEvent(event: MockEvent): void {
    switch (event.t) {
      case "setStatus": {
        const wp = this.resolveWp(event.wp);
        const actorId = this.resolveActorId(wp, event.actor);
        const oldStatusId = wp.statusId;
        wp.statusId = this.resolveStatus(event.status).id;
        this.touch(wp);
        // Increment 21 (SPEC_21): an optional `statusDisplayText` overrides ONLY
        // this journal's displayed `to` casing (the WP's own status link keeps
        // the resolved canonical name — see workPackageSummary/HAL). Models OP
        // preserving historically-submitted casing in activity prose.
        const newValue = this.statusRef(wp.statusId);
        const displayedNewValue =
          event.statusDisplayText !== undefined && newValue !== null
            ? { id: newValue.id, name: event.statusDisplayText }
            : newValue;
        this.recordJournal(wp, actorId, {
          property: "status",
          oldValue: this.statusRef(oldStatusId),
          newValue: displayedNewValue,
        });
        return;
      }
      case "reassign": {
        const wp = this.resolveWp(event.wp);
        // Resolved from the assignee BEFORE this event (the outgoing person
        // performs the handoff) — captured before either field is touched.
        const actorId = this.resolveActorId(wp, event.actor);
        const oldAssigneeId = wp.assigneeId;
        const oldAccountableId = wp.accountableId;
        // assignee and accountable are INDEPENDENT (SPEC_03 §2a):
        // null clears the link, omitted leaves it unchanged.
        if (event.assignee !== undefined) {
          wp.assigneeId = event.assignee === null ? null : this.resolveUser(event.assignee).id;
        }
        if (event.accountable !== undefined) {
          wp.accountableId =
            event.accountable === null ? null : this.resolveUser(event.accountable).id;
        }
        this.touch(wp);
        // One journal detail per field that actually changed value (SPEC_04 §3:
        // each activity carries exactly one detail) — a redundant reassign to
        // the same person emits nothing.
        if (wp.assigneeId !== oldAssigneeId) {
          this.recordJournal(wp, actorId, {
            property: "assignee",
            oldValue: this.userRef(oldAssigneeId),
            newValue: this.userRef(wp.assigneeId),
          });
        }
        if (wp.accountableId !== oldAccountableId) {
          this.recordJournal(wp, actorId, {
            property: "accountable",
            oldValue: this.userRef(oldAccountableId),
            newValue: this.userRef(wp.accountableId),
          });
        }
        return;
      }
      case "comment": {
        const wp = this.resolveWp(event.wp);
        // The comment's author IS the actor (like logTime's `user`).
        const actorId = this.resolveUser(event.user).id;
        // Stamp the WP so the journal reuses the same mutation tick — one
        // applied event, one clock tick, exactly like every other event.
        this.touch(wp);
        this.recordComment(wp, actorId, event.text);
        return;
      }
      case "logTime": {
        const wp = this.resolveWp(event.wp);
        const date = this.date ?? this.requireScenario().startDate;
        // Does NOT change remainingTime (pair with an explicit setRemaining).
        // Stamp the WP first so the time entry's createdAt reuses the SAME
        // mutation tick (one applied event = one clock tick, as elsewhere).
        this.touch(wp);
        this.createTimeEntry(event.wp, event.user, event.hours, date, wp.updatedAt);
        return;
      }
      case "setRemaining": {
        const wp = this.resolveWp(event.wp);
        const actorId = this.resolveActorId(wp, event.actor);
        const oldHours = wp.remainingHours;
        wp.remainingHours = event.hours;
        this.touch(wp);
        this.recordJournal(wp, actorId, {
          property: "remainingTime",
          oldValue: oldHours,
          newValue: wp.remainingHours,
        });
        return;
      }
      case "setEstimate": {
        const wp = this.resolveWp(event.wp);
        const actorId = this.resolveActorId(wp, event.actor);
        const oldHours = wp.estimatedHours;
        wp.estimatedHours = event.hours;
        this.touch(wp);
        this.recordJournal(wp, actorId, {
          property: "estimatedTime",
          oldValue: oldHours,
          newValue: wp.estimatedHours,
        });
        return;
      }
      case "setVersion": {
        const wp = this.resolveWp(event.wp);
        const actorId = this.resolveActorId(wp, event.actor);
        const oldVersionId = wp.versionId;
        wp.versionId = event.version === null ? null : this.resolveVersion(event.version).id;
        this.touch(wp);
        this.recordJournal(wp, actorId, {
          property: "version",
          oldValue: this.versionRef(oldVersionId),
          newValue: this.versionRef(wp.versionId),
        });
        return;
      }
      case "addWorkPackage": {
        // The creation stamp counts as this day's next mutation. Creations
        // have no journal entry — journals model CHANGES, not birth.
        this.addWorkPackage(event.wp, this.nextTimestamp());
        return;
      }
    }
  }

  /** Default actor = the WP's CURRENT assignee (read BEFORE this event's own
   * mutation); an explicit `actor` override always wins. See scenario-types.ts. */
  private resolveActorId(wp: EngineWorkPackage, override?: string): number | null {
    if (override !== undefined) return this.resolveUser(override).id;
    return wp.assigneeId;
  }

  private userRef(id: number | null): { id: number; name: string } | null {
    if (id === null) return null;
    const u = this.users.find((x) => x.id === id);
    return { id, name: u?.name ?? `User ${id}` };
  }

  private statusRef(id: number | null): { id: number; name: string } | null {
    if (id === null) return null;
    const s = this.statuses.find((x) => x.id === id);
    return { id, name: s?.name ?? String(id) };
  }

  private versionRef(id: number | null): { id: number; name: string } | null {
    if (id === null) return null;
    const v = this.versions.find((x) => x.id === id);
    return { id, name: v?.name ?? `Version ${id}` };
  }

  private recordJournal(
    wp: EngineWorkPackage,
    actorId: number | null,
    detail: EngineJournalDetail,
  ): void {
    this.journals.push({
      id: this.nextJournalId,
      wpId: wp.id,
      actorId,
      // Reuses the timestamp `touch(wp)` just stamped — one event, one tick.
      createdAt: wp.updatedAt,
      detail,
      comment: null,
    });
    this.nextJournalId += 1;
  }

  /**
   * Record a pure-comment journal (SPEC_10 §d): empty `details`, the text in
   * `comment`. Mirrors recordJournal's timestamp reuse — the caller must
   * `touch(wp)` first so createdAt matches this event's mutation tick.
   */
  private recordComment(wp: EngineWorkPackage, actorId: number | null, text: string): void {
    this.journals.push({
      id: this.nextJournalId,
      wpId: wp.id,
      actorId,
      createdAt: wp.updatedAt,
      detail: null,
      comment: text,
    });
    this.nextJournalId += 1;
  }

  /** Materialize a WP seed into state; `timestamp` becomes createdAt+updatedAt. */
  private addWorkPackage(seed: WorkPackageSeed, timestamp: string): EngineWorkPackage {
    if (this.workPackages.some((wp) => wp.key === seed.key)) {
      throw new MockEngineError(400, `Duplicate work package key "${seed.key}"`);
    }
    let id = seed.id;
    if (id === undefined) {
      while (this.workPackages.some((wp) => wp.id === this.nextWpId)) this.nextWpId += 1;
      id = this.nextWpId;
      this.nextWpId += 1;
    } else if (this.workPackages.some((wp) => wp.id === id)) {
      throw new MockEngineError(400, `Duplicate work package id ${id} (key "${seed.key}")`);
    }
    if (this.projects.every((p) => p.id !== seed.project)) {
      throw new MockEngineError(
        400,
        `Work package "${seed.key}" references unknown project id ${seed.project}`,
      );
    }
    const wp: EngineWorkPackage = {
      key: seed.key,
      id,
      subject: seed.subject,
      typeName: seed.type ?? "Task",
      projectId: seed.project,
      statusId: this.resolveStatus(seed.status).id,
      assigneeId: seed.assignee == null ? null : this.resolveUser(seed.assignee).id,
      accountableId: seed.accountable == null ? null : this.resolveUser(seed.accountable).id,
      estimatedHours: seed.estimatedHours ?? null,
      remainingHours: seed.remainingHours ?? null,
      storyPoints: seed.storyPoints ?? null,
      versionId: seed.version == null ? null : this.resolveVersion(seed.version).id,
      priority: seed.priority ?? "Normal",
      // Parent must already exist (declare parents before children in seeds).
      parentId: seed.parent == null ? null : this.resolveWp(seed.parent).id,
      percentageDone: seed.percentageDone ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.workPackages.push(wp);
    return wp;
  }

  private createTimeEntry(
    wpKey: string,
    userKey: string,
    hours: number,
    spentOn: string,
    createdAt: string,
  ): EngineTimeEntry {
    const wp = this.resolveWp(wpKey);
    const user = this.resolveUser(userKey);
    const entry: EngineTimeEntry = {
      id: this.nextTimeEntryId,
      wpId: wp.id,
      userId: user.id,
      hours,
      spentOn,
      createdAt,
    };
    this.nextTimeEntryId += 1;
    this.timeEntries.push(entry);
    return entry;
  }

  /** Fallback for inject-urgent when the scenario has no urgentTemplate. */
  private genericUrgentTemplate(): Omit<WorkPackageSeed, "key" | "id"> {
    const project = this.projects[0];
    if (project === undefined) {
      throw new MockEngineError(400, "Scenario has no projects to inject an urgent bug into");
    }
    const status = this.statuses.find((s) => !s.isClosed) ?? this.statuses[0];
    if (status === undefined) {
      throw new MockEngineError(400, "Scenario has no statuses to inject an urgent bug with");
    }
    return {
      subject: "URGENT: production incident",
      type: "Bug",
      project: project.id,
      status: status.name,
      priority: "High",
      estimatedHours: 4,
      remainingHours: 4,
    };
  }

  // Dangling scenario keys are HARD 400s with a clear message (frozen contract).

  private resolveWp(key: string): EngineWorkPackage {
    const wp = this.workPackages.find((w) => w.key === key);
    if (wp === undefined) throw new MockEngineError(400, `Unknown work package key "${key}"`);
    return wp;
  }

  private resolveUser(key: string): EngineUser {
    const user = this.users.find((u) => u.key === key);
    if (user === undefined) throw new MockEngineError(400, `Unknown user key "${key}"`);
    return user;
  }

  private resolveVersion(key: string): EngineVersion {
    const version = this.versions.find((v) => v.key === key);
    if (version === undefined) throw new MockEngineError(400, `Unknown version key "${key}"`);
    return version;
  }

  private resolveStatus(name: string): ScenarioStatus {
    const lower = name.toLowerCase();
    const status = this.statuses.find((s) => s.name.toLowerCase() === lower);
    if (status === undefined) throw new MockEngineError(400, `Unknown status "${name}"`);
    return status;
  }

  private workPackageSummary(wp: EngineWorkPackage): WorkPackageStateSummary {
    const status = this.statuses.find((s) => s.id === wp.statusId);
    const assignee = this.users.find((u) => u.id === wp.assigneeId);
    const accountable = this.users.find((u) => u.id === wp.accountableId);
    const version = this.versions.find((v) => v.id === wp.versionId);
    const spent = this.timeEntries
      .filter((te) => te.wpId === wp.id)
      .reduce((sum, te) => sum + te.hours, 0);
    return {
      id: wp.id,
      key: wp.key,
      subject: wp.subject,
      status: status?.name ?? String(wp.statusId),
      assignee: assignee?.key ?? null,
      accountable: accountable?.key ?? null,
      estimated_hours: wp.estimatedHours,
      remaining_hours: wp.remainingHours,
      spent_hours: spent,
      version: version?.key ?? null,
      updated_at: wp.updatedAt,
    };
  }
}
