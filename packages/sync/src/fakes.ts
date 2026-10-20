import type {
  BurndownSnapshot,
  Project,
  RemainingStatusRule,
  Sprint,
  SprintItem,
  SprintItemOutcome,
  SyncKind,
  SyncRun,
  SyncStatus,
  WorkPackageCache,
} from "@osp/contracts";
import type {
  BurndownRepository,
  NewBurndownSnapshot,
  NewRemainingStatusRule,
  NewWorkPackageCache,
  ProjectRepository,
  RemainingStatusRuleRepository,
  SprintItemRepository,
  SprintRepository,
  SyncRunRepository,
  SyncWatermarkRepository,
  WorkPackageCacheFilter,
  WorkPackageCacheRepository,
} from "@osp/db";

/**
 * Minimal in-memory fakes of the repository interfaces for unit tests.
 * Only the methods the sync engine / snapshot writer call are exercised;
 * the rest throw so accidental use surfaces loudly.
 */

const notUsed = (name: string) => (): never => {
  throw new Error(`fake repo: ${name} not implemented for tests`);
};

export class FakeWorkPackageCacheRepo implements WorkPackageCacheRepository {
  rows = new Map<number, WorkPackageCache>();
  upserts: NewWorkPackageCache[] = [];
  /** Number of upsertMany() INVOCATIONS (not rows) — lets a test assert the
   * buffered sync writes exactly once, or an aborted one never writes.
   * commitStaging() funnels through upsertMany(), so this stays the proxy for
   * "the live cache was written." */
  upsertManyCalls = 0;
  // ── Increment 20 staging (SPEC_20 §2) — in-memory, keyed by syncRunId. ──
  staging = new Map<number, NewWorkPackageCache[]>();
  stageBatchCalls = 0;
  commitStagingCalls = 0;
  dropStagingCalls = 0;
  clearAllStagingCalls = 0;
  private seq = 1;

  seed(rows: WorkPackageCache[]): void {
    for (const r of rows) this.rows.set(r.op_id, r);
  }

  async getByOpId(opId: number): Promise<WorkPackageCache | null> {
    return this.rows.get(opId) ?? null;
  }
  async getManyByOpIds(opIds: number[]): Promise<WorkPackageCache[]> {
    return opIds
      .map((id) => this.rows.get(id))
      .filter((x): x is WorkPackageCache => x !== undefined);
  }
  async upsertMany(rows: NewWorkPackageCache[]): Promise<void> {
    this.upsertManyCalls += 1;
    for (const r of rows) {
      this.upserts.push(r);
      this.rows.set(r.op_id, {
        ...r,
        connection_id: r.connection_id ?? null,
        id: this.seq++,
        cached_at: new Date().toISOString(),
      });
    }
  }
  async maxUpdatedAtOp(projectOpId: number): Promise<string | null> {
    let max: string | null = null;
    for (const r of this.rows.values()) {
      if (r.project_op_id !== projectOpId) continue;
      if (max === null || r.updated_at_op > max) max = r.updated_at_op;
    }
    return max;
  }
  find(_f: WorkPackageCacheFilter): Promise<WorkPackageCache[]> {
    return notUsed("find")();
  }
  async deleteMany(opIds: number[]): Promise<void> {
    for (const id of opIds) this.rows.delete(id);
  }
  async setConnectionIdForProject(projectOpId: number, connectionId: number): Promise<void> {
    for (const row of this.rows.values()) {
      if (row.project_op_id === projectOpId) row.connection_id = connectionId;
    }
  }
  async setConnectionIdForOpIds(opIds: number[], connectionId: number): Promise<void> {
    for (const id of opIds) {
      const row = this.rows.get(id);
      if (row) row.connection_id = connectionId;
    }
  }

  async stageBatch(syncRunId: number, rows: NewWorkPackageCache[]): Promise<void> {
    this.stageBatchCalls += 1;
    const cur = this.staging.get(syncRunId) ?? [];
    cur.push(...rows);
    this.staging.set(syncRunId, cur);
  }
  async commitStaging(syncRunId: number): Promise<number> {
    this.commitStagingCalls += 1;
    const rows = this.staging.get(syncRunId) ?? [];
    // Merge through the same store upsertMany writes to (bumps upsertManyCalls,
    // the "cache was written" proxy the existing tests assert on), then clear.
    await this.upsertMany(rows);
    this.staging.delete(syncRunId);
    return rows.length;
  }
  async dropStaging(syncRunId: number): Promise<void> {
    this.dropStagingCalls += 1;
    this.staging.delete(syncRunId);
  }
  async clearAllStaging(): Promise<void> {
    this.clearAllStagingCalls += 1;
    this.staging.clear();
  }
}

export class FakeSprintItemRepo implements SprintItemRepository {
  items: SprintItem[] = [];

  seed(items: SprintItem[]): void {
    this.items = items;
  }
  async listBySprint(sprintId: number): Promise<SprintItem[]> {
    return this.items.filter((i) => i.sprint_id === sprintId);
  }
  async setOutcome(
    id: number,
    outcome: SprintItemOutcome,
    removedAt?: string | null,
  ): Promise<SprintItem> {
    const item = this.items.find((i) => i.id === id);
    if (item === undefined) throw new Error(`no item ${id}`);
    item.outcome = outcome;
    item.removed_at = removedAt ?? null;
    return item;
  }
  getBySprintAndWp = notUsed("getBySprintAndWp");
  findByWpOpIds = notUsed("findByWpOpIds");
  add = notUsed("add");
  async deleteMany(ids: number[]): Promise<void> {
    this.items = this.items.filter((i) => !ids.includes(i.id));
  }
  // Increment 31 (docs/INCREMENT_31_CONTRACTS.md §1) — the sync engine never
  // reads/writes the freeze snapshot (§0: freeze is not a sync concern).
  listFrozenSnapshot = notUsed("listFrozenSnapshot");
  writeFreezeSnapshot = notUsed("writeFreezeSnapshot");
}

export class FakeSprintRepo implements SprintRepository {
  sprints: Sprint[] = [];

  seed(sprints: Sprint[]): void {
    this.sprints = sprints;
  }
  async list(): Promise<Sprint[]> {
    return this.sprints;
  }
  async getById(id: number): Promise<Sprint | null> {
    return this.sprints.find((s) => s.id === id) ?? null;
  }
  async listByStatus(status: Sprint["status"]): Promise<Sprint[]> {
    return this.sprints.filter((s) => s.status === status);
  }
  create = notUsed("create");
  update = notUsed("update");
  activate = notUsed("activate");
  close = notUsed("close");
  reactivate = notUsed("reactivate");
  deleteWithCascade = notUsed("deleteWithCascade");
  // Increment 31 (docs/INCREMENT_31_CONTRACTS.md §1) — the sync engine never
  // freezes a sprint (§0: freeze is not a sync concern).
  setFrozen = notUsed("setFrozen");
}

export class FakeSyncRunRepo implements SyncRunRepository {
  runs: SyncRun[] = [];
  private seq = 1;

  async start(kind: SyncKind): Promise<SyncRun> {
    const run: SyncRun = {
      id: this.seq++,
      started_at: new Date().toISOString(),
      finished_at: null,
      kind,
      wp_count: null,
      total_count: null,
      status: "running",
      error: null,
      cancel_requested: false,
      last_progress_at: null,
    };
    this.runs.push(run);
    return run;
  }
  async progress(id: number, processed: number, total: number | null): Promise<void> {
    const run = this.runs.find((r) => r.id === id);
    if (run === undefined) return;
    run.wp_count = processed;
    if (total !== null) run.total_count = total;
    // SPEC_20 §3 — stamp progress so the watchdog measures no-progress, not age.
    run.last_progress_at = new Date().toISOString();
  }
  async finish(
    id: number,
    status: SyncStatus,
    wpCount: number | null,
    error: string | null,
    finishedAt: string,
  ): Promise<SyncRun> {
    const run = this.runs.find((r) => r.id === id);
    if (run === undefined) throw new Error(`no run ${id}`);
    run.status = status;
    run.wp_count = wpCount;
    run.error = error;
    run.finished_at = finishedAt;
    return run;
  }
  async latest(): Promise<SyncRun | null> {
    return this.runs.at(-1) ?? null;
  }
  async current(): Promise<SyncRun | null> {
    return this.runs.find((r) => r.status === "running") ?? null;
  }
  async getById(id: number): Promise<SyncRun | null> {
    return this.runs.find((r) => r.id === id) ?? null;
  }
  async requestCancel(id: number): Promise<SyncRun | null> {
    const run = this.runs.find((r) => r.id === id);
    if (run === undefined) return null;
    // Idempotent: only a still-running run can be marked; a no-op otherwise.
    if (run.status === "running") run.cancel_requested = true;
    return run;
  }
  async isCancelled(id: number): Promise<boolean> {
    return this.runs.find((r) => r.id === id)?.cancel_requested ?? false;
  }
  async recoverOrphaned(): Promise<number> {
    let n = 0;
    for (const r of this.runs) {
      if (r.status === "running") {
        r.status = "aborted";
        r.error = "Recovered at startup: no live process could own a running sync_run";
        r.finished_at = new Date().toISOString();
        n += 1;
      }
    }
    return n;
  }
}

/**
 * Increment 29 (contracts §3) — in-memory `sync_watermark`, keyed exactly as
 * the real repository is: per (connection, project). `sets` records every
 * write so a test can assert a failed run wrote NOTHING (not merely that the
 * final value happens to look unchanged).
 */
export class FakeSyncWatermarkRepo implements SyncWatermarkRepository {
  values = new Map<string, string>();
  sets: Array<{ connectionId: number | null; projectOpId: number; watermarkAt: string }> = [];

  private key(connectionId: number | null, projectOpId: number): string {
    return `${connectionId === null ? "none" : connectionId}:${projectOpId}`;
  }
  seed(connectionId: number | null, projectOpId: number, watermarkAt: string): void {
    this.values.set(this.key(connectionId, projectOpId), watermarkAt);
  }
  async get(connectionId: number | null, projectOpId: number): Promise<string | null> {
    return this.values.get(this.key(connectionId, projectOpId)) ?? null;
  }
  async set(
    connectionId: number | null,
    projectOpId: number,
    watermarkAt: string,
  ): Promise<void> {
    this.sets.push({ connectionId, projectOpId, watermarkAt });
    this.values.set(this.key(connectionId, projectOpId), watermarkAt);
  }
  async clearForConnection(connectionId: number | null): Promise<void> {
    const prefix = `${connectionId === null ? "none" : connectionId}:`;
    for (const k of [...this.values.keys()]) {
      if (k.startsWith(prefix)) this.values.delete(k);
    }
  }
}

export class FakeProjectRepo implements ProjectRepository {
  projects: Project[] = [];
  lastSynced = new Map<number, string>();

  seed(projects: Project[]): void {
    this.projects = projects;
  }
  async list(): Promise<Project[]> {
    return this.projects;
  }
  async getByOpId(opId: number): Promise<Project | null> {
    return this.projects.find((p) => p.op_id === opId) ?? null;
  }
  async getByConnectionAndOpId(connectionId: number, opId: number): Promise<Project | null> {
    return (
      this.projects.find((p) => p.connection_id === connectionId && p.op_id === opId) ?? null
    );
  }
  async setLastSyncedAt(opId: number, at: string): Promise<void> {
    this.lastSynced.set(opId, at);
  }
  upsertMany = notUsed("upsertMany");
}

export class FakeBurndownRepo implements BurndownRepository {
  snapshots: BurndownSnapshot[] = [];
  private seq = 1;

  async upsert(input: NewBurndownSnapshot): Promise<BurndownSnapshot> {
    const existing = this.snapshots.find(
      (s) => s.sprint_id === input.sprint_id && s.snapshot_date === input.snapshot_date,
    );
    if (existing !== undefined) {
      Object.assign(existing, input);
      return existing;
    }
    const row: BurndownSnapshot = { ...input, id: this.seq++ };
    this.snapshots.push(row);
    return row;
  }
  async listBySprint(sprintId: number): Promise<BurndownSnapshot[]> {
    return this.snapshots.filter((s) => s.sprint_id === sprintId);
  }
  async getBySprintAndDate(
    sprintId: number,
    date: string,
  ): Promise<BurndownSnapshot | null> {
    return (
      this.snapshots.find(
        (s) => s.sprint_id === sprintId && s.snapshot_date === date,
      ) ?? null
    );
  }
}

/** SPEC_11 §6 — empty by default (fall back to DEFAULT_REMAINING_STATUSES). */
export class FakeRemainingStatusRuleRepo implements RemainingStatusRuleRepository {
  rules: RemainingStatusRule[] = [];
  private seq = 1;

  seed(rules: RemainingStatusRule[]): void {
    this.rules = rules;
  }
  async listBySprint(sprintId: number): Promise<RemainingStatusRule[]> {
    return this.rules.filter((r) => r.sprint_id === sprintId);
  }
  async replaceForSprint(
    sprintId: number,
    rows: NewRemainingStatusRule[],
  ): Promise<RemainingStatusRule[]> {
    this.rules = this.rules.filter((r) => r.sprint_id !== sprintId);
    const created = rows.map((r) => ({ ...r, id: this.seq++ }));
    this.rules.push(...created);
    return created;
  }
}
