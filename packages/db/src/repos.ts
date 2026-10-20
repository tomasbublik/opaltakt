import { and, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type {
  BurndownSnapshot,
  CapacityEditAuditEntry,
  DoneRule,
  DoneStatusRule,
  EstimateOverride,
  ImportSelection,
  LockReason,
  OpConnection,
  OpId,
  Project,
  RemainingStatusRule,
  ReportConfig,
  Sprint,
  SprintClosureReport,
  SprintItem,
  SprintItemOutcome,
  SprintMemberCapacity,
  SprintUpdateRun,
  SyncKind,
  SyncRun,
  SyncStatus,
  TeamMember,
  TicketBaseline,
  TicketChangelogEntry,
  UpdateRunKind,
  UpdateRunTriggeredBy,
  UserNameAlias,
  VaultMeta,
  WorkPackageCache,
} from "@osp/contracts";
import type {
  BurndownRepository,
  CapacityEditAuditRepository,
  CapacityRepository,
  ClosureReportRepository,
  ConnectionHealthPatch,
  ConnectionRepository,
  DoneRuleRepository,
  DoneStatusRuleRepository,
  ReportConfigRepository,
  BacklogDismissalRepository,
  EstimateOverrideRepository,
  FrozenSprintItemFields,
  FrozenSprintItemSnapshot,
  ImportSelectionRepository,
  NewBurndownSnapshot,
  NewCapacityEditAudit,
  NewChangelogEntry,
  NewClosureReport,
  NewConnection,
  NewDoneStatusRule,
  NewEstimateOverride,
  NewImportSelection,
  NewOffSprintTimeEntry,
  NewProject,
  NewRemainingStatusRule,
  NewSprint,
  NewSprintItem,
  NewSprintMemberCapacity,
  NewSprintUpdateRun,
  NewTeamMember,
  NewTicketBaseline,
  NewUserNameAlias,
  NewWorkPackageCache,
  OffSprintTimeEntry,
  OffSprintTimeRepository,
  ProjectRepository,
  RemainingStatusRuleRepository,
  SprintItemRepository,
  SprintRepository,
  SprintRetroPatch,
  SprintUpdateRunRepository,
  SyncRunRepository,
  SyncWatermarkRepository,
  TeamMemberRepository,
  TicketBaselineRepository,
  TicketChangelogRepository,
  TokenBlob,
  UserNameAliasRepository,
  VaultMetaRepository,
  WorkPackageCacheFilter,
  WorkPackageCacheRepository,
} from "./repositories";
import {
  mapBurndown,
  mapCapacity,
  mapCapacityEditAudit,
  mapChangelogEntry,
  mapClosureReport,
  mapConnection,
  mapDoneRule,
  mapDoneStatusRule,
  mapEstimateOverride,
  mapFrozenSprintItemSnapshot,
  mapReportConfig,
  mapImportSelection,
  mapOffSprintTimeEntry,
  mapProject,
  mapRemainingStatusRule,
  mapSprint,
  mapSprintItem,
  mapSprintUpdateRun,
  mapSyncRun,
  mapTeamMember,
  mapTicketBaseline,
  mapUserNameAlias,
  mapVaultMeta,
  mapWorkPackage,
} from "./mappers";
import { schema } from "./schema";

const {
  backlogDismissal,
  burndownSnapshot,
  capacityEditAudit,
  doneRule,
  doneStatusRule,
  estimateOverride,
  importSelection,
  offSprintTimeEntry,
  opConnection,
  project,
  remainingStatusRule,
  reportConfig,
  sprint,
  sprintClosureReport,
  sprintItem,
  sprintMemberCapacity,
  sprintUpdateRun,
  syncRun,
  syncWatermark,
  ticketBaseline,
  ticketChangelogEntry,
  userNameAlias,
  vaultMeta,
  teamMember,
  workPackageCache,
  workPackageCacheStaging,
} = schema;

/**
 * The concrete Drizzle handle these repositories run against.
 *
 * Increment 27: driver-agnostic on purpose. `NodePgDatabase<typeof schema>`
 * (the app, real Postgres) and `PgliteDatabase<typeof schema>` (vitest,
 * in-process PGlite) both extend this, so one repository implementation serves
 * both without a generic leaking into every call site.
 */
export type OspDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

const nowIso = (): string => new Date().toISOString();

/** The camelCase column values for a work_package_cache (or _staging) row,
 * built from a contract-shaped NewWorkPackageCache. `cachedAt` is computed
 * once by the caller and shared across a whole batch (matches the existing
 * upsertMany pattern). */
function wpCacheValues(r: NewWorkPackageCache, cachedAt: string) {
  return {
    connectionId: r.connection_id,
    opId: r.op_id,
    projectOpId: r.project_op_id,
    subject: r.subject,
    typeName: r.type_name,
    statusName: r.status_name,
    statusIsClosed: r.status_is_closed,
    assigneeOpId: r.assignee_op_id,
    assigneeName: r.assignee_name,
    estimatedHours: r.estimated_hours,
    remainingHours: r.remaining_hours,
    spentHours: r.spent_hours,
    storyPoints: r.story_points,
    versionOpId: r.version_op_id,
    versionName: r.version_name,
    priority: r.priority,
    parentOpId: r.parent_op_id,
    percentageDone: r.percentage_done,
    updatedAtOp: r.updated_at_op,
    rawJson: r.raw_json,
    cachedAt,
  };
}

/** Increment 20 (SPEC_20 §2): rows-per-transaction when merging staging into
 * the live cache. Small enough that one chunk's synchronous insert never
 * blocks the event loop long, large enough that a big merge is a handful of
 * statements, not thousands. */
const COMMIT_STAGING_CHUNK = 200;

// ── ConnectionRepository ─────────────────────────────────────────────────────
// Multi-server registry (SPEC_02). Exactly one row is is_current at a time —
// that's the server OP-facing operations target.
function connectionRepository(db: OspDatabase): ConnectionRepository {
  const healthValues = (patch: ConnectionHealthPatch) => ({
    ...(patch.last_activity_at !== undefined
      ? { lastActivityAt: patch.last_activity_at }
      : {}),
    ...(patch.last_check_at !== undefined ? { lastCheckAt: patch.last_check_at } : {}),
    ...(patch.last_status !== undefined ? { lastStatus: patch.last_status } : {}),
    ...(patch.last_latency_ms !== undefined
      ? { lastLatencyMs: patch.last_latency_ms }
      : {}),
    ...(patch.last_error !== undefined ? { lastError: patch.last_error } : {}),
  });

  return {
    async getCurrent(): Promise<OpConnection | null> {
      const [current] = await db
        .select()
        .from(opConnection)
        .where(eq(opConnection.isCurrent, true))
        .limit(1);
      if (current) return mapConnection(current);
      const [newest] = await db
        .select()
        .from(opConnection)
        .orderBy(desc(opConnection.id))
        .limit(1);
      return newest ? mapConnection(newest) : null;
    },
    async getById(id: number): Promise<OpConnection | null> {
      const [row] = await db
        .select()
        .from(opConnection)
        .where(eq(opConnection.id, id))
        .limit(1);
      return row ? mapConnection(row) : null;
    },
    async getByBaseUrl(baseUrl: string): Promise<OpConnection | null> {
      const [row] = await db
        .select()
        .from(opConnection)
        .where(eq(opConnection.baseUrl, baseUrl))
        .limit(1);
      return row ? mapConnection(row) : null;
    },
    async list(): Promise<OpConnection[]> {
      const rows = await db
        .select()
        .from(opConnection)
        .orderBy(opConnection.id);
      return rows.map(mapConnection);
    },
    async create(input: NewConnection): Promise<OpConnection> {
      const [first] = await db
        .select({ id: opConnection.id })
        .from(opConnection)
        .limit(1);
      const isFirst = first == null;
      const [row] = await db
        .insert(opConnection)
        .values({
          baseUrl: input.base_url,
          label: input.label,
          tokenCt: input.token_ct,
          tokenNonce: input.token_nonce,
          tokenTag: input.token_tag,
          defaultProjectOpId: input.default_project_op_id,
          isCurrent: isFirst,
          createdAt: nowIso(),
        })
        .returning();
      return mapConnection(row!);
    },
    async update(
      id: number,
      patch: Partial<Omit<NewConnection, "base_url">>,
    ): Promise<OpConnection> {
      const [row] = await db
        .update(opConnection)
        .set({
          ...(patch.label !== undefined ? { label: patch.label } : {}),
          ...(patch.token_ct !== undefined ? { tokenCt: patch.token_ct } : {}),
          ...(patch.token_nonce !== undefined
            ? { tokenNonce: patch.token_nonce }
            : {}),
          ...(patch.token_tag !== undefined ? { tokenTag: patch.token_tag } : {}),
          ...(patch.default_project_op_id !== undefined
            ? { defaultProjectOpId: patch.default_project_op_id }
            : {}),
        })
        .where(eq(opConnection.id, id))
        .returning();
      if (!row) throw new Error(`connection ${id} not found`);
      return mapConnection(row);
    },
    async delete(id: number): Promise<boolean> {
      const [row] = await db
        .delete(opConnection)
        .where(eq(opConnection.id, id))
        .returning();
      if (!row) return false;
      // Keep exactly one current row: re-point to the newest remaining one.
      if (row.isCurrent) {
        const [newest] = await db
          .select({ id: opConnection.id })
          .from(opConnection)
          .orderBy(desc(opConnection.id))
          .limit(1);
        if (newest) {
          await db
            .update(opConnection)
            .set({ isCurrent: true })
            .where(eq(opConnection.id, newest.id));
        }
      }
      return true;
    },
    async setCurrent(id: number): Promise<void> {
      const [exists] = await db
        .select({ id: opConnection.id })
        .from(opConnection)
        .where(eq(opConnection.id, id))
        .limit(1);
      if (!exists) throw new Error(`connection ${id} not found`);
      // Both writes in one transaction: with an async driver the window between
      // "clear every current flag" and "set the new one" is a real await point,
      // and a concurrent getCurrent() must never observe zero current rows.
      await db.transaction(async (tx) => {
        await tx.update(opConnection).set({ isCurrent: false });
        await tx
          .update(opConnection)
          .set({ isCurrent: true })
          .where(eq(opConnection.id, id));
      });
    },
    async setEnabled(id: number, enabled: boolean): Promise<void> {
      await db.update(opConnection).set({ enabled }).where(eq(opConnection.id, id));
    },
    async updateHealth(id: number, patch: ConnectionHealthPatch): Promise<void> {
      const values = healthValues(patch);
      if (Object.keys(values).length === 0) return;
      await db.update(opConnection).set(values).where(eq(opConnection.id, id));
    },
    async listLegacyPlaintext(): Promise<OpConnection[]> {
      const rows = await db
        .select()
        .from(opConnection)
        .where(isNotNull(opConnection.tokenEncrypted));
      return rows.map(mapConnection);
    },
    async setEncryptedToken(id: number, blob: TokenBlob): Promise<void> {
      await db
        .update(opConnection)
        .set({
          tokenCt: blob.ct,
          tokenNonce: blob.nonce,
          tokenTag: blob.tag,
          // The whole point of the vault: no plaintext token at rest.
          tokenEncrypted: null,
        })
        .where(eq(opConnection.id, id));
    },
    async clearAllTokens(): Promise<number> {
      const rows = await db
        .update(opConnection)
        .set({
          tokenCt: null,
          tokenNonce: null,
          tokenTag: null,
          tokenEncrypted: null,
        })
        .where(
          sql`${opConnection.tokenCt} IS NOT NULL OR ${opConnection.tokenEncrypted} IS NOT NULL`,
        )
        .returning({ id: opConnection.id });
      return rows.length;
    },
  };
}

// ── VaultMetaRepository ──────────────────────────────────────────────────────
function vaultMetaRepository(db: OspDatabase): VaultMetaRepository {
  return {
    async get(): Promise<VaultMeta | null> {
      const [row] = await db
        .select()
        .from(vaultMeta)
        .where(eq(vaultMeta.id, 1))
        .limit(1);
      return row ? mapVaultMeta(row) : null;
    },
    async save(meta: Omit<VaultMeta, "id" | "created_at">): Promise<VaultMeta> {
      const values = {
        kdfAlgo: meta.kdf_algo,
        kdfSalt: meta.kdf_salt,
        kdfParamsJson: meta.kdf_params_json,
        verifierCt: meta.verifier_ct,
        verifierNonce: meta.verifier_nonce,
      };
      const [row] = await db
        .insert(vaultMeta)
        .values({ id: 1, ...values, createdAt: nowIso() })
        .onConflictDoUpdate({ target: vaultMeta.id, set: values })
        .returning();
      return mapVaultMeta(row!);
    },
    async delete(): Promise<void> {
      await db.delete(vaultMeta).where(eq(vaultMeta.id, 1));
    },
  };
}

// ── ProjectRepository ────────────────────────────────────────────────────────
function projectRepository(db: OspDatabase): ProjectRepository {
  return {
    async list(): Promise<Project[]> {
      const rows = await db.select().from(project).orderBy(project.name);
      return rows.map(mapProject);
    },
    async getByOpId(opId: OpId): Promise<Project | null> {
      const [row] = await db
        .select()
        .from(project)
        .where(eq(project.opId, opId))
        .limit(1);
      return row ? mapProject(row) : null;
    },
    async getByConnectionAndOpId(
      connectionId: number,
      opId: OpId,
    ): Promise<Project | null> {
      const [row] = await db
        .select()
        .from(project)
        .where(and(eq(project.connectionId, connectionId), eq(project.opId, opId)))
        .limit(1);
      return row ? mapProject(row) : null;
    },
    async upsertMany(rows: NewProject[]): Promise<void> {
      if (rows.length === 0) return;
      for (const r of rows) {
        await db
          .insert(project)
          .values({
            connectionId: r.connection_id,
            opId: r.op_id,
            identifier: r.identifier,
            name: r.name,
            lastSyncedAt: r.last_synced_at,
          })
          .onConflictDoUpdate({
            target: [project.connectionId, project.opId],
            set: {
              identifier: r.identifier,
              name: r.name,
              lastSyncedAt: r.last_synced_at,
            },
          });
      }
    },
    async setLastSyncedAt(opId: OpId, at: string): Promise<void> {
      await db
        .update(project)
        .set({ lastSyncedAt: at })
        .where(eq(project.opId, opId));
    },
  };
}

// ── ImportSelectionRepository ────────────────────────────────────────────────
function importSelectionRepository(db: OspDatabase): ImportSelectionRepository {
  return {
    async list(): Promise<ImportSelection[]> {
      const rows = await db
        .select()
        .from(importSelection)
        .orderBy(importSelection.id);
      return rows.map(mapImportSelection);
    },
    async getById(id: number): Promise<ImportSelection | null> {
      const [row] = await db
        .select()
        .from(importSelection)
        .where(eq(importSelection.id, id))
        .limit(1);
      return row ? mapImportSelection(row) : null;
    },
    async upsert(sel: NewImportSelection): Promise<ImportSelection> {
      // De-dupe on (connection, project, version); NULL compared explicitly
      // because a unique index treats NULLs as distinct — true of SQLite and,
      // identically, of Postgres's default NULLS DISTINCT.
      const [existing] = await db
        .select()
        .from(importSelection)
        .where(
          and(
            sel.connection_id == null
              ? isNull(importSelection.connectionId)
              : eq(importSelection.connectionId, sel.connection_id),
            eq(importSelection.projectOpId, sel.project_op_id),
            sel.version_op_id === null
              ? isNull(importSelection.versionOpId)
              : eq(importSelection.versionOpId, sel.version_op_id),
          ),
        )
        .limit(1);
      if (existing) {
        const [row] = await db
          .update(importSelection)
          .set({ projectName: sel.project_name, versionName: sel.version_name })
          .where(eq(importSelection.id, existing.id))
          .returning();
        return mapImportSelection(row!);
      }
      const [row] = await db
        .insert(importSelection)
        .values({
          connectionId: sel.connection_id,
          projectOpId: sel.project_op_id,
          projectName: sel.project_name,
          versionOpId: sel.version_op_id,
          versionName: sel.version_name,
          createdAt: nowIso(),
        })
        .returning();
      return mapImportSelection(row!);
    },
    async delete(id: number): Promise<boolean> {
      const [row] = await db
        .delete(importSelection)
        .where(eq(importSelection.id, id))
        .returning();
      return row != null;
    },
  };
}

// ── BacklogDismissalRepository ───────────────────────────────────────────────
function backlogDismissalRepository(db: OspDatabase): BacklogDismissalRepository {
  return {
    async listOpIds(): Promise<number[]> {
      const rows = await db
        .select({ id: backlogDismissal.wpOpId })
        .from(backlogDismissal);
      return rows.map((r) => r.id);
    },
    async add(opIds: number[]): Promise<void> {
      for (const id of opIds) {
        await db
          .insert(backlogDismissal)
          .values({ wpOpId: id, dismissedAt: nowIso() })
          .onConflictDoNothing();
      }
    },
    async remove(opIds: number[]): Promise<void> {
      if (opIds.length === 0) return;
      await db
        .delete(backlogDismissal)
        .where(inArray(backlogDismissal.wpOpId, opIds));
    },
  };
}

// ── WorkPackageCacheRepository ───────────────────────────────────────────────
function workPackageCacheRepository(
  db: OspDatabase,
): WorkPackageCacheRepository {
  return {
    async getByOpId(opId: OpId): Promise<WorkPackageCache | null> {
      const [row] = await db
        .select()
        .from(workPackageCache)
        .where(eq(workPackageCache.opId, opId))
        .limit(1);
      return row ? mapWorkPackage(row) : null;
    },
    async find(filter: WorkPackageCacheFilter): Promise<WorkPackageCache[]> {
      const conds: SQL[] = [];
      if (filter.projectOpId !== undefined)
        conds.push(eq(workPackageCache.projectOpId, filter.projectOpId));
      // Increment 19 (SPEC_19 §1.2): case-insensitive/trimmed match — a real OP
      // instance's status/priority naming drifts in casing across projects, and
      // an exact eq() silently returns zero rows (the reported "0 results" bug).
      if (filter.statusName !== undefined)
        conds.push(
          eq(
            sql`lower(trim(${workPackageCache.statusName}))`,
            filter.statusName.trim().toLowerCase(),
          ),
        );
      if (filter.assigneeOpId !== undefined)
        conds.push(eq(workPackageCache.assigneeOpId, filter.assigneeOpId));
      if (filter.versionOpId !== undefined)
        conds.push(eq(workPackageCache.versionOpId, filter.versionOpId));
      // Increment 23 (SPEC_23 §2): connection-scoped id match — null means the
      // connection-less legacy rows (`none:` key), a number means that exact
      // connection. Left out entirely when undefined (legacy bare-id path).
      if (filter.connectionId === null)
        conds.push(isNull(workPackageCache.connectionId));
      else if (filter.connectionId !== undefined)
        conds.push(eq(workPackageCache.connectionId, filter.connectionId));
      if (filter.priority !== undefined)
        conds.push(
          eq(
            sql`lower(trim(${workPackageCache.priority}))`,
            filter.priority.trim().toLowerCase(),
          ),
        );
      if (filter.hasEstimate === true)
        conds.push(isNotNull(workPackageCache.estimatedHours));
      if (filter.hasEstimate === false)
        conds.push(isNull(workPackageCache.estimatedHours));
      const rows = await db
        .select()
        .from(workPackageCache)
        .where(and(...conds))
        .orderBy(workPackageCache.opId);
      return rows.map(mapWorkPackage);
    },
    async getManyByOpIds(opIds: OpId[]): Promise<WorkPackageCache[]> {
      if (opIds.length === 0) return [];
      const rows = await db
        .select()
        .from(workPackageCache)
        .where(inArray(workPackageCache.opId, opIds));
      return rows.map(mapWorkPackage);
    },
    async upsertMany(rows: NewWorkPackageCache[]): Promise<void> {
      if (rows.length === 0) return;
      const cachedAt = nowIso();
      for (const r of rows) {
        const values = wpCacheValues(r, cachedAt);
        await db
          .insert(workPackageCache)
          .values(values)
          .onConflictDoUpdate({
            target: workPackageCache.opId,
            set: { ...values, opId: undefined },
          });
      }
    },
    async maxUpdatedAtOp(projectOpId: OpId): Promise<string | null> {
      // Increment 27: `updated_at_op` is a real timestamptz now, so the raw
      // max() aggregate escapes the isoTimestamp custom type and node-postgres
      // hands back a Date (PGlite likewise). Normalise here — every caller
      // feeds this straight into an OP `updatedAt >d` filter as an ISO string.
      const [row] = await db
        .select({
          max: sql<string | Date | null>`max(${workPackageCache.updatedAtOp})`,
        })
        .from(workPackageCache)
        .where(eq(workPackageCache.projectOpId, projectOpId));
      const max = row?.max ?? null;
      if (max == null) return null;
      return max instanceof Date ? max.toISOString() : new Date(max).toISOString();
    },
    async deleteMany(opIds: OpId[]): Promise<void> {
      if (opIds.length === 0) return;
      await db.delete(workPackageCache).where(inArray(workPackageCache.opId, opIds));
    },
    async setConnectionIdForProject(projectOpId: OpId, connectionId: number): Promise<void> {
      await db
        .update(workPackageCache)
        .set({ connectionId })
        .where(eq(workPackageCache.projectOpId, projectOpId));
    },
    async setConnectionIdForOpIds(opIds: OpId[], connectionId: number): Promise<void> {
      if (opIds.length === 0) return;
      await db
        .update(workPackageCache)
        .set({ connectionId })
        .where(inArray(workPackageCache.opId, opIds));
    },

    // ── Increment 20 (SPEC_20 §2) — staging ──────────────────────────────────
    async stageBatch(syncRunId: number, rows: NewWorkPackageCache[]): Promise<void> {
      if (rows.length === 0) return;
      const cachedAt = nowIso();
      // ONE multi-row insert per chunk, not a loop over rows — staging has no
      // unique constraint on op_id, so no conflict handling is needed.
      // Increment 27: chunked because Postgres caps a single statement at 65535
      // bind parameters and this row shape carries 22 columns. The sync engine
      // pages at 100 rows so one chunk is the normal case; the chunking only
      // matters if a future caller hands over a very large batch.
      for (let i = 0; i < rows.length; i += COMMIT_STAGING_CHUNK) {
        const chunk = rows.slice(i, i + COMMIT_STAGING_CHUNK);
        await db
          .insert(workPackageCacheStaging)
          .values(chunk.map((r) => ({ ...wpCacheValues(r, cachedAt), syncRunId })));
      }
    },
    async commitStaging(syncRunId: number): Promise<number> {
      const staged = await db
        .select()
        .from(workPackageCacheStaging)
        .where(eq(workPackageCacheStaging.syncRunId, syncRunId));
      if (staged.length === 0) return 0;
      // Merge in chunks, each its own short transaction, yielding the event
      // loop between chunks so a large merge never blocks for one long
      // uninterrupted stretch (this is what keeps the app usable even DURING
      // the final merge, not just during page accumulation).
      // On conflict, take the freshly-staged values (excluded.*) — a proper
      // batched upsert where each row keeps its OWN values, unlike a static
      // set object which would clobber every conflicting row identically.
      const conflictSet = {
        connectionId: sql`excluded.connection_id`,
        projectOpId: sql`excluded.project_op_id`,
        subject: sql`excluded.subject`,
        typeName: sql`excluded.type_name`,
        statusName: sql`excluded.status_name`,
        statusIsClosed: sql`excluded.status_is_closed`,
        assigneeOpId: sql`excluded.assignee_op_id`,
        assigneeName: sql`excluded.assignee_name`,
        estimatedHours: sql`excluded.estimated_hours`,
        remainingHours: sql`excluded.remaining_hours`,
        spentHours: sql`excluded.spent_hours`,
        storyPoints: sql`excluded.story_points`,
        versionOpId: sql`excluded.version_op_id`,
        versionName: sql`excluded.version_name`,
        priority: sql`excluded.priority`,
        parentOpId: sql`excluded.parent_op_id`,
        percentageDone: sql`excluded.percentage_done`,
        updatedAtOp: sql`excluded.updated_at_op`,
        rawJson: sql`excluded.raw_json`,
        cachedAt: sql`excluded.cached_at`,
      };
      for (let i = 0; i < staged.length; i += COMMIT_STAGING_CHUNK) {
        const chunk = staged.slice(i, i + COMMIT_STAGING_CHUNK);
        const chunkValues = chunk.map((s) => ({
          connectionId: s.connectionId,
          opId: s.opId,
          projectOpId: s.projectOpId,
          subject: s.subject,
          typeName: s.typeName,
          statusName: s.statusName,
          statusIsClosed: s.statusIsClosed,
          assigneeOpId: s.assigneeOpId,
          assigneeName: s.assigneeName,
          estimatedHours: s.estimatedHours,
          remainingHours: s.remainingHours,
          spentHours: s.spentHours,
          storyPoints: s.storyPoints,
          versionOpId: s.versionOpId,
          versionName: s.versionName,
          priority: s.priority,
          parentOpId: s.parentOpId,
          percentageDone: s.percentageDone,
          updatedAtOp: s.updatedAtOp,
          rawJson: s.rawJson,
          cachedAt: s.cachedAt,
        }));
        // Each chunk is its own short transaction: one multi-row upsert
        // statement instead of thousands of one-per-row inserts.
        await db.transaction(async (tx) => {
          await tx
            .insert(workPackageCache)
            .values(chunkValues)
            .onConflictDoUpdate({
              target: workPackageCache.opId,
              set: conflictSet,
            });
        });
        // Yield the event loop between chunks.
        await new Promise((resolve) => setImmediate(resolve));
      }
      await db
        .delete(workPackageCacheStaging)
        .where(eq(workPackageCacheStaging.syncRunId, syncRunId));
      return staged.length;
    },
    async dropStaging(syncRunId: number): Promise<void> {
      await db
        .delete(workPackageCacheStaging)
        .where(eq(workPackageCacheStaging.syncRunId, syncRunId));
    },
    async clearAllStaging(): Promise<void> {
      await db.delete(workPackageCacheStaging);
    },
  };
}

// ── EstimateOverrideRepository ───────────────────────────────────────────────
function estimateOverrideRepository(
  db: OspDatabase,
): EstimateOverrideRepository {
  return {
    async getByWpOpId(wpOpId: OpId): Promise<EstimateOverride | null> {
      const [row] = await db
        .select()
        .from(estimateOverride)
        .where(eq(estimateOverride.wpOpId, wpOpId))
        .limit(1);
      return row ? mapEstimateOverride(row) : null;
    },
    async getManyByWpOpIds(wpOpIds: OpId[]): Promise<EstimateOverride[]> {
      if (wpOpIds.length === 0) return [];
      const rows = await db
        .select()
        .from(estimateOverride)
        .where(inArray(estimateOverride.wpOpId, wpOpIds));
      return rows.map(mapEstimateOverride);
    },
    async upsert(input: NewEstimateOverride): Promise<EstimateOverride> {
      const updatedAt = nowIso();
      const values = {
        wpOpId: input.wp_op_id,
        planningHours: input.planning_hours,
        note: input.note,
        updatedAt,
      };
      const [row] = await db
        .insert(estimateOverride)
        .values(values)
        .onConflictDoUpdate({
          target: estimateOverride.wpOpId,
          set: {
            planningHours: input.planning_hours,
            note: input.note,
            updatedAt,
          },
        })
        .returning();
      return mapEstimateOverride(row!);
    },
  };
}

// ── SprintRepository ─────────────────────────────────────────────────────────
function sprintRepository(db: OspDatabase): SprintRepository {
  return {
    async list(): Promise<Sprint[]> {
      const rows = await db.select().from(sprint).orderBy(desc(sprint.id));
      return rows.map(mapSprint);
    },
    async getById(id: number): Promise<Sprint | null> {
      const [row] = await db
        .select()
        .from(sprint)
        .where(eq(sprint.id, id))
        .limit(1);
      return row ? mapSprint(row) : null;
    },
    async listByStatus(status: Sprint["status"]): Promise<Sprint[]> {
      const rows = await db
        .select()
        .from(sprint)
        .where(eq(sprint.status, status))
        .orderBy(desc(sprint.id));
      return rows.map(mapSprint);
    },
    async create(input: NewSprint): Promise<Sprint> {
      const [row] = await db
        .insert(sprint)
        .values({
          name: input.name,
          startDate: input.start_date,
          endDate: input.end_date,
          status: input.status,
          capacityMode: input.capacity_mode,
          createdAt: nowIso(),
        })
        .returning();
      return mapSprint(row!);
    },
    async update(
      id: number,
      patch: Partial<NewSprint & { status: Sprint["status"] }> & SprintRetroPatch,
    ): Promise<Sprint> {
      const set: Record<string, unknown> = {};
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.start_date !== undefined) set.startDate = patch.start_date;
      if (patch.end_date !== undefined) set.endDate = patch.end_date;
      if (patch.status !== undefined) set.status = patch.status;
      if (patch.capacity_mode !== undefined)
        set.capacityMode = patch.capacity_mode;
      // Increment 12: retrospective-planning columns.
      if (patch.is_retrospective !== undefined)
        set.isRetrospective = patch.is_retrospective;
      if (patch.retro_seed_kind !== undefined)
        set.retroSeedKind = patch.retro_seed_kind;
      if (patch.retro_seed_value !== undefined)
        set.retroSeedValue = patch.retro_seed_value;
      if (patch.retro_replayed_at !== undefined)
        set.retroReplayedAt = patch.retro_replayed_at;
      const [row] = await db
        .update(sprint)
        .set(set)
        .where(eq(sprint.id, id))
        .returning();
      return mapSprint(row!);
    },
    async activate(
      id: number,
      activatedAt: string,
      baselineTotalHours: number,
    ): Promise<Sprint> {
      const [row] = await db
        .update(sprint)
        .set({ status: "active", activatedAt, baselineTotalHours })
        .where(eq(sprint.id, id))
        .returning();
      return mapSprint(row!);
    },
    async close(
      id: number,
      completedHours: number,
      closedAt: string,
      lockReason: LockReason,
    ): Promise<Sprint> {
      const [row] = await db
        .update(sprint)
        .set({
          status: "closed",
          completedHours,
          closedAt,
          isLocked: true,
          lockedAt: closedAt,
          lockReason,
        })
        .where(eq(sprint.id, id))
        .returning();
      return mapSprint(row!);
    },
    async reactivate(id: number): Promise<Sprint> {
      // Increment 31 (docs/INCREMENT_31_CONTRACTS.md §2b step 3): reactivate
      // undoes a freeze too, not just a lock — clear frozen_at AND every
      // sprint_item.frozen_* column for this sprint in the SAME operation, so
      // a re-finish (later) starts from a genuinely clean snapshot rather than
      // one a stale write could resurrect. Both writes happen unconditionally
      // (mirrors the rest of this method) — the caller enforces the "was
      // locked" + date-window guards.
      const [row] = await db
        .update(sprint)
        .set({
          status: "active",
          isLocked: false,
          lockReason: null,
          lockedAt: null,
          closedAt: null,
          frozenAt: null,
        })
        .where(eq(sprint.id, id))
        .returning();
      await db
        .update(sprintItem)
        .set({
          frozenEffectiveHours: null,
          frozenAssigneeOpId: null,
          frozenAssigneeName: null,
          frozenStatusName: null,
          frozenStatusIsClosed: null,
          frozenParentOpId: null,
          frozenConnectionId: null,
          frozenProjectOpId: null,
          frozenRemainingHours: null,
        })
        .where(eq(sprintItem.sprintId, id));
      return mapSprint(row!);
    },
    async setFrozen(id: number, frozenAt: string): Promise<Sprint> {
      const [row] = await db
        .update(sprint)
        .set({ frozenAt })
        .where(eq(sprint.id, id))
        .returning();
      return mapSprint(row!);
    },
    async deleteWithCascade(id: number): Promise<boolean> {
      return await db.transaction(async (tx) => {
        const [exists] = await tx
          .select({ id: sprint.id })
          .from(sprint)
          .where(eq(sprint.id, id))
          .limit(1);
        if (!exists) return false;
        // Dependency order: children referencing sprint_update_run first, then
        // every table that FKs sprint, then the sprint row itself (SPEC_11 §2).
        // Increment 27: Postgres enforces these FKs unconditionally (SQLite only
        // did with PRAGMA foreign_keys=ON), so this order is now load-bearing.
        await tx.delete(ticketChangelogEntry).where(eq(ticketChangelogEntry.sprintId, id));
        await tx.delete(sprintUpdateRun).where(eq(sprintUpdateRun.sprintId, id));
        await tx.delete(ticketBaseline).where(eq(ticketBaseline.sprintId, id));
        await tx.delete(burndownSnapshot).where(eq(burndownSnapshot.sprintId, id));
        await tx.delete(sprintClosureReport).where(eq(sprintClosureReport.sprintId, id));
        await tx.delete(sprintMemberCapacity).where(eq(sprintMemberCapacity.sprintId, id));
        // Increment 13 (SPEC_13 §6): sprint-scoped retro capacity audit trail.
        // NOTE: user_name_alias is DELIBERATELY not cascaded — aliases are
        // connection-scoped and apply retroactively across sprints.
        await tx.delete(capacityEditAudit).where(eq(capacityEditAudit.sprintId, id));
        await tx.delete(remainingStatusRule).where(eq(remainingStatusRule.sprintId, id));
        await tx.delete(doneStatusRule).where(eq(doneStatusRule.sprintId, id));
        await tx.delete(sprintItem).where(eq(sprintItem.sprintId, id));
        await tx.delete(sprint).where(eq(sprint.id, id));
        return true;
      });
    },
  };
}

// ── TicketBaselineRepository ─────────────────────────────────────────────────
function ticketBaselineRepository(db: OspDatabase): TicketBaselineRepository {
  return {
    async listBySprint(sprintId: number): Promise<TicketBaseline[]> {
      const rows = await db
        .select()
        .from(ticketBaseline)
        .where(eq(ticketBaseline.sprintId, sprintId));
      return rows.map(mapTicketBaseline);
    },
    async getBySprintAndWp(sprintId: number, wpOpId: OpId): Promise<TicketBaseline | null> {
      const [row] = await db
        .select()
        .from(ticketBaseline)
        .where(and(eq(ticketBaseline.sprintId, sprintId), eq(ticketBaseline.wpOpId, wpOpId)))
        .limit(1);
      return row ? mapTicketBaseline(row) : null;
    },
    async upsertMany(rows: NewTicketBaseline[]): Promise<void> {
      for (const r of rows) {
        await db
          .insert(ticketBaseline)
          .values({
            sprintId: r.sprint_id,
            wpOpId: r.wp_op_id,
            capturedAt: r.captured_at,
            subject: r.subject,
            statusName: r.status_name,
            statusIsClosed: r.status_is_closed,
            assigneeOpId: r.assignee_op_id,
            accountableOpId: r.accountable_op_id,
            // Increment 9 (SPEC_09 §3): set on INSERT only — deliberately
            // absent from the ON CONFLICT UPDATE `set` below, so a defensive
            // re-capture (healMissingActivation) can never overwrite the
            // frozen original owner the grey redistribution math depends on.
            originalAssigneeOpId: r.original_assignee_op_id,
            estimatedHours: r.estimated_hours,
            remainingHours: r.remaining_hours,
            spentHours: r.spent_hours,
            versionOpId: r.version_op_id,
            rawJson: r.raw_json,
            origin: r.origin,
            // Increment 12 (SPEC_12 §2/§4): reconstruction provenance.
            reconstructed: r.reconstructed,
            reconstructionGapsJson: r.reconstruction_gaps_json,
            // Increment 13 (SPEC_13 §1): raw journal-reconstructed assignee name.
            assigneeNameRaw: r.assignee_name_raw,
          })
          .onConflictDoUpdate({
            target: [ticketBaseline.sprintId, ticketBaseline.wpOpId],
            set: {
              capturedAt: r.captured_at,
              subject: r.subject,
              statusName: r.status_name,
              statusIsClosed: r.status_is_closed,
              assigneeOpId: r.assignee_op_id,
              accountableOpId: r.accountable_op_id,
              estimatedHours: r.estimated_hours,
              remainingHours: r.remaining_hours,
              spentHours: r.spent_hours,
              versionOpId: r.version_op_id,
              rawJson: r.raw_json,
              origin: r.origin,
              reconstructed: r.reconstructed,
              reconstructionGapsJson: r.reconstruction_gaps_json,
              // Re-resolution happens at read time; the raw name is stable, so
              // refresh it on re-capture (e.g. re-seed) too.
              assigneeNameRaw: r.assignee_name_raw,
            },
          });
      }
    },
  };
}

// ── SprintUpdateRunRepository ────────────────────────────────────────────────
function sprintUpdateRunRepository(db: OspDatabase): SprintUpdateRunRepository {
  return {
    async start(
      sprintId: number,
      kind: UpdateRunKind,
      triggeredBy: UpdateRunTriggeredBy,
    ): Promise<SprintUpdateRun> {
      const [row] = await db
        .insert(sprintUpdateRun)
        .values({ sprintId, kind, triggeredBy, startedAt: nowIso(), status: "running" })
        .returning();
      return mapSprintUpdateRun(row!);
    },
    async progress(id: number, processed: number, total: number | null): Promise<void> {
      await db
        .update(sprintUpdateRun)
        .set(total === null ? { wpCount: processed } : { wpCount: processed, totalCount: total })
        .where(eq(sprintUpdateRun.id, id));
    },
    async finish(
      id: number,
      status: SyncStatus,
      wpCount: number | null,
      changesCount: number | null,
      error: string | null,
      finishedAt: string,
    ): Promise<SprintUpdateRun> {
      const [row] = await db
        .update(sprintUpdateRun)
        .set({ status, wpCount, changesCount, error, finishedAt })
        .where(eq(sprintUpdateRun.id, id))
        .returning();
      return mapSprintUpdateRun(row!);
    },
    async listBySprint(sprintId: number): Promise<SprintUpdateRun[]> {
      const rows = await db
        .select()
        .from(sprintUpdateRun)
        .where(eq(sprintUpdateRun.sprintId, sprintId))
        .orderBy(desc(sprintUpdateRun.id));
      return rows.map(mapSprintUpdateRun);
    },
    async latestBySprint(sprintId: number): Promise<SprintUpdateRun | null> {
      const [row] = await db
        .select()
        .from(sprintUpdateRun)
        .where(eq(sprintUpdateRun.sprintId, sprintId))
        .orderBy(desc(sprintUpdateRun.id))
        .limit(1);
      return row ? mapSprintUpdateRun(row) : null;
    },
    async recoverOrphaned(): Promise<number> {
      // Consolidation Round (Concept 8) — crash recovery, a byte-for-byte mirror
      // of SyncRunRepository.recoverOrphaned() above but keyed on
      // sprint_update_run. A fresh process can never own a row left `running` by
      // a killed predecessor (activation/update/finish/retro-replay), so every
      // such row is unconditionally orphaned. Mark them aborted with a
      // diagnostic error; return how many were recovered.
      // Increment 27: counted via RETURNING rather than a driver result field —
      // node-postgres exposes `rowCount`, PGlite `affectedRows`, and this
      // repository has to behave identically on both.
      const recovered = await db
        .update(sprintUpdateRun)
        .set({
          status: "aborted",
          finishedAt: nowIso(),
          error:
            "Recovered at startup: no live process could own a running sprint_update_run",
        })
        .where(eq(sprintUpdateRun.status, "running"))
        .returning({ id: sprintUpdateRun.id });
      return recovered.length;
    },
  };
}

// ── TicketChangelogRepository ────────────────────────────────────────────────
function ticketChangelogRepository(db: OspDatabase): TicketChangelogRepository {
  return {
    async listByTicket(sprintId: number, wpOpId: OpId): Promise<TicketChangelogEntry[]> {
      const rows = await db
        .select()
        .from(ticketChangelogEntry)
        .where(
          and(eq(ticketChangelogEntry.sprintId, sprintId), eq(ticketChangelogEntry.wpOpId, wpOpId)),
        )
        .orderBy(ticketChangelogEntry.occurredAt, ticketChangelogEntry.id);
      return rows.map(mapChangelogEntry);
    },
    async listBySprint(sprintId: number): Promise<TicketChangelogEntry[]> {
      const rows = await db
        .select()
        .from(ticketChangelogEntry)
        .where(eq(ticketChangelogEntry.sprintId, sprintId))
        .orderBy(ticketChangelogEntry.occurredAt, ticketChangelogEntry.id);
      return rows.map(mapChangelogEntry);
    },
    async insertMany(rows: NewChangelogEntry[]): Promise<number> {
      let inserted = 0;
      for (const r of rows) {
        const returned = await db
          .insert(ticketChangelogEntry)
          .values({
            sprintId: r.sprint_id,
            wpOpId: r.wp_op_id,
            updateRunId: r.update_run_id,
            occurredAt: r.occurred_at,
            actorOpId: r.actor_op_id,
            actorName: r.actor_name,
            kind: r.kind,
            detailJson: r.detail_json,
            source: r.source,
            opJournalId: r.op_journal_id,
            dedupKey: r.dedup_key,
          })
          .onConflictDoNothing({ target: ticketChangelogEntry.dedupKey })
          .returning({ id: ticketChangelogEntry.id });
        // Empty RETURNING == the dedup_key already existed and nothing was
        // written; that is the counted-as-skipped case, exactly as before.
        if (returned.length > 0) inserted += 1;
      }
      return inserted;
    },
  };
}

// ── SprintItemRepository ─────────────────────────────────────────────────────
function sprintItemRepository(db: OspDatabase): SprintItemRepository {
  return {
    async listBySprint(sprintId: number): Promise<SprintItem[]> {
      const rows = await db
        .select()
        .from(sprintItem)
        .where(eq(sprintItem.sprintId, sprintId))
        .orderBy(sprintItem.id);
      return rows.map(mapSprintItem);
    },
    async getBySprintAndWp(
      sprintId: number,
      wpOpId: OpId,
    ): Promise<SprintItem | null> {
      const [row] = await db
        .select()
        .from(sprintItem)
        .where(
          and(eq(sprintItem.sprintId, sprintId), eq(sprintItem.wpOpId, wpOpId)),
        )
        .limit(1);
      return row ? mapSprintItem(row) : null;
    },
    async findByWpOpIds(wpOpIds: OpId[]): Promise<SprintItem[]> {
      if (wpOpIds.length === 0) return [];
      const rows = await db
        .select()
        .from(sprintItem)
        .where(inArray(sprintItem.wpOpId, wpOpIds));
      return rows.map(mapSprintItem);
    },
    async add(input: NewSprintItem): Promise<SprintItem> {
      const [row] = await db
        .insert(sprintItem)
        .values({
          sprintId: input.sprint_id,
          wpOpId: input.wp_op_id,
          plannedHours: input.planned_hours,
          outcome: input.outcome,
          origin: input.origin,
          // Increment 25 (SPEC_25 §4): a retroactive add passes a BACKDATED
          // added_at; every other caller omits it and gets nowIso(), unchanged.
          addedAt: input.added_at ?? nowIso(),
          retroSource: input.retro_source ?? null,
        })
        .returning();
      return mapSprintItem(row!);
    },
    async setOutcome(
      id: number,
      outcome: SprintItemOutcome,
      removedAt?: string | null,
    ): Promise<SprintItem> {
      const set: Record<string, unknown> = { outcome };
      if (removedAt !== undefined) set.removedAt = removedAt;
      const [row] = await db
        .update(sprintItem)
        .set(set)
        .where(eq(sprintItem.id, id))
        .returning();
      return mapSprintItem(row!);
    },
    async deleteMany(ids: number[]): Promise<void> {
      if (ids.length === 0) return;
      await db.delete(sprintItem).where(inArray(sprintItem.id, ids));
    },
    async listFrozenSnapshot(sprintId: number): Promise<FrozenSprintItemSnapshot[]> {
      // Increment 31 (docs/INCREMENT_31_CONTRACTS.md §2c) — one indexed query
      // (sprint_item_sprint_idx), same shape whether or not the sprint is
      // actually frozen; callers gate on `sprint.frozen_at`.
      const rows = await db
        .select()
        .from(sprintItem)
        .where(eq(sprintItem.sprintId, sprintId))
        .orderBy(sprintItem.id);
      return rows.map(mapFrozenSprintItemSnapshot);
    },
    async writeFreezeSnapshot(
      sprintId: number,
      rows: Array<{ item_id: number } & FrozenSprintItemFields>,
    ): Promise<void> {
      // Increment 31 (docs/INCREMENT_31_CONTRACTS.md §2b step 3) — one UPDATE
      // per row, scoped to BOTH id and sprintId so a caller-supplied item_id
      // from a different sprint can never write here (defence in depth; the
      // real guarantee is freeze.ts deriving every row from
      // listBySprint(sprintId)). Not batched into a single statement — this
      // runs at most once per sprint per grace deadline, not a hot path, and
      // per-row UPDATEs keep the write trivially reviewable.
      for (const r of rows) {
        await db
          .update(sprintItem)
          .set({
            frozenEffectiveHours: r.frozen_effective_hours,
            frozenAssigneeOpId: r.frozen_assignee_op_id,
            frozenAssigneeName: r.frozen_assignee_name,
            frozenStatusName: r.frozen_status_name,
            frozenStatusIsClosed: r.frozen_status_is_closed,
            frozenParentOpId: r.frozen_parent_op_id,
            frozenConnectionId: r.frozen_connection_id,
            frozenProjectOpId: r.frozen_project_op_id,
            frozenRemainingHours: r.frozen_remaining_hours,
          })
          .where(and(eq(sprintItem.id, r.item_id), eq(sprintItem.sprintId, sprintId)));
      }
    },
  };
}

// ── TeamMemberRepository ─────────────────────────────────────────────────────
function teamMemberRepository(db: OspDatabase): TeamMemberRepository {
  return {
    async list(): Promise<TeamMember[]> {
      const rows = await db.select().from(teamMember).orderBy(teamMember.name);
      return rows.map(mapTeamMember);
    },
    async getById(id: number): Promise<TeamMember | null> {
      const [row] = await db
        .select()
        .from(teamMember)
        .where(eq(teamMember.id, id))
        .limit(1);
      return row ? mapTeamMember(row) : null;
    },
    async getByOpUserId(opUserId: number): Promise<TeamMember | null> {
      const [row] = await db
        .select()
        .from(teamMember)
        .where(eq(teamMember.opUserId, opUserId))
        .limit(1);
      return row ? mapTeamMember(row) : null;
    },
    async getByName(name: string): Promise<TeamMember | null> {
      const [row] = await db
        .select()
        .from(teamMember)
        .where(eq(teamMember.name, name))
        .orderBy(teamMember.id)
        .limit(1);
      return row ? mapTeamMember(row) : null;
    },
    async upsert(input: NewTeamMember & { id?: number }): Promise<TeamMember> {
      if (input.id !== undefined) {
        const [row] = await db
          .update(teamMember)
          .set({
            opUserId: input.op_user_id,
            name: input.name,
            defaultHoursPerDay: input.default_hours_per_day,
          })
          .where(eq(teamMember.id, input.id))
          .returning();
        return mapTeamMember(row!);
      }
      const [row] = await db
        .insert(teamMember)
        .values({
          opUserId: input.op_user_id,
          name: input.name,
          defaultHoursPerDay: input.default_hours_per_day,
        })
        .returning();
      return mapTeamMember(row!);
    },
    async setRole(id: number, role: TeamMember["role"]): Promise<TeamMember> {
      // Increment 14 (SPEC_14 §2): the ONLY writer of team_member.role — an
      // ordinary upsert()/provisioning call can never clobber a human's choice.
      const [row] = await db
        .update(teamMember)
        .set({ role })
        .where(eq(teamMember.id, id))
        .returning();
      return mapTeamMember(row!);
    },
  };
}

// ── CapacityRepository ───────────────────────────────────────────────────────
function capacityRepository(db: OspDatabase): CapacityRepository {
  return {
    async listBySprint(sprintId: number): Promise<SprintMemberCapacity[]> {
      const rows = await db
        .select()
        .from(sprintMemberCapacity)
        .where(eq(sprintMemberCapacity.sprintId, sprintId))
        .orderBy(sprintMemberCapacity.id);
      return rows.map(mapCapacity);
    },
    async replaceForSprint(
      sprintId: number,
      rows: NewSprintMemberCapacity[],
    ): Promise<SprintMemberCapacity[]> {
      return await db.transaction(async (tx) => {
        await tx
          .delete(sprintMemberCapacity)
          .where(eq(sprintMemberCapacity.sprintId, sprintId));
        const out: SprintMemberCapacity[] = [];
        for (const r of rows) {
          const [row] = await tx
            .insert(sprintMemberCapacity)
            .values({
              sprintId: r.sprint_id,
              memberId: r.member_id,
              availableHours: r.available_hours,
              ptoDays: r.pto_days,
            })
            .returning();
          out.push(mapCapacity(row!));
        }
        return out;
      });
    },
  };
}

// ── DoneStatusRuleRepository ─────────────────────────────────────────────────
function doneStatusRuleRepository(db: OspDatabase): DoneStatusRuleRepository {
  return {
    async listBySprint(sprintId: number): Promise<DoneStatusRule[]> {
      const rows = await db
        .select()
        .from(doneStatusRule)
        .where(eq(doneStatusRule.sprintId, sprintId))
        .orderBy(doneStatusRule.id);
      return rows.map(mapDoneStatusRule);
    },
    async replaceForSprint(
      sprintId: number,
      rows: NewDoneStatusRule[],
    ): Promise<DoneStatusRule[]> {
      return await db.transaction(async (tx) => {
        await tx
          .delete(doneStatusRule)
          .where(eq(doneStatusRule.sprintId, sprintId));
        const out: DoneStatusRule[] = [];
        for (const r of rows) {
          const [row] = await tx
            .insert(doneStatusRule)
            .values({
              sprintId: r.sprint_id,
              statusName: r.status_name,
              countsAs: r.counts_as,
            })
            .returning();
          out.push(mapDoneStatusRule(row!));
        }
        return out;
      });
    },
  };
}

// ── RemainingStatusRuleRepository (SPEC_11 §6) ───────────────────────────────
function remainingStatusRuleRepository(db: OspDatabase): RemainingStatusRuleRepository {
  return {
    async listBySprint(sprintId: number): Promise<RemainingStatusRule[]> {
      const rows = await db
        .select()
        .from(remainingStatusRule)
        .where(eq(remainingStatusRule.sprintId, sprintId))
        .orderBy(remainingStatusRule.id);
      return rows.map(mapRemainingStatusRule);
    },
    async replaceForSprint(
      sprintId: number,
      rows: NewRemainingStatusRule[],
    ): Promise<RemainingStatusRule[]> {
      return await db.transaction(async (tx) => {
        await tx
          .delete(remainingStatusRule)
          .where(eq(remainingStatusRule.sprintId, sprintId));
        const out: RemainingStatusRule[] = [];
        for (const r of rows) {
          const [row] = await tx
            .insert(remainingStatusRule)
            .values({ sprintId: r.sprint_id, statusName: r.status_name })
            .returning();
          out.push(mapRemainingStatusRule(row!));
        }
        return out;
      });
    },
  };
}

// ── DoneRuleRepository (Increment 14, SPEC_14 §2) ────────────────────────────
// GLOBAL role-aware done matrix (no sprint_id). Seeded by migration 0014 with
// the ten DEFAULT_DONE_RULES rows; `replace` is a full swap (PUT sends the
// whole edited matrix).
function doneRuleRepository(db: OspDatabase): DoneRuleRepository {
  return {
    async list(): Promise<DoneRule[]> {
      const rows = await db.select().from(doneRule).orderBy(doneRule.id);
      return rows.map(mapDoneRule);
    },
    async replace(
      rows: Array<{ status_name: string; kind: DoneRule["kind"] }>,
    ): Promise<DoneRule[]> {
      return await db.transaction(async (tx) => {
        await tx.delete(doneRule);
        const out: DoneRule[] = [];
        for (const r of rows) {
          const [row] = await tx
            .insert(doneRule)
            .values({ statusName: r.status_name, kind: r.kind })
            .returning();
          out.push(mapDoneRule(row!));
        }
        return out;
      });
    },
  };
}

// ── ReportConfigRepository (Increment 14, SPEC_14 §3/§7 #5) ──────────────────
// Singleton (id always 1). Migration 0014 seeds the row, but get() defensively
// materializes it if missing so the closure/report logic never hits a null.
function reportConfigRepository(db: OspDatabase): ReportConfigRepository {
  const ensure = async (): Promise<ReturnType<typeof mapReportConfig>> => {
    const [existing] = await db
      .select()
      .from(reportConfig)
      .where(eq(reportConfig.id, 1))
      .limit(1);
    if (existing) return mapReportConfig(existing);
    // Increment 27: the select→insert gap is a real await point now, so two
    // concurrent first-callers would both try to insert id=1 and one would hit a
    // primary-key violation. onConflictDoNothing makes the materialisation
    // idempotent; the loser re-reads the winner's row.
    const [inserted] = await db
      .insert(reportConfig)
      .values({ id: 1, overshootThresholdPct: 25 })
      .onConflictDoNothing({ target: reportConfig.id })
      .returning();
    if (inserted) return mapReportConfig(inserted);
    const [row] = await db
      .select()
      .from(reportConfig)
      .where(eq(reportConfig.id, 1))
      .limit(1);
    return mapReportConfig(row!);
  };
  return {
    async get(): Promise<ReportConfig> {
      return await ensure();
    },
    async setOvershootThresholdPct(pct: number): Promise<ReportConfig> {
      await ensure();
      const [row] = await db
        .update(reportConfig)
        .set({ overshootThresholdPct: pct })
        .where(eq(reportConfig.id, 1))
        .returning();
      return mapReportConfig(row!);
    },
    async setFreezeGraceDays(days: number): Promise<ReportConfig> {
      // Increment 31 (docs/INCREMENT_31_CONTRACTS.md §1) — same
      // ensure-then-update shape as setOvershootThresholdPct; the DB column
      // default (3) covers pre-migration rows, `ensure()` covers a
      // never-materialized singleton.
      await ensure();
      const [row] = await db
        .update(reportConfig)
        .set({ freezeGraceDays: days })
        .where(eq(reportConfig.id, 1))
        .returning();
      return mapReportConfig(row!);
    },
  };
}

// ── SyncRunRepository ────────────────────────────────────────────────────────
function syncRunRepository(db: OspDatabase): SyncRunRepository {
  return {
    async start(kind: SyncKind): Promise<SyncRun> {
      const [row] = await db
        .insert(syncRun)
        .values({ kind, status: "running", startedAt: nowIso() })
        .returning();
      return mapSyncRun(row!);
    },
    async progress(id: number, processed: number, total: number | null): Promise<void> {
      // Increment 20 (SPEC_20 §3): every progress() call ALSO stamps
      // last_progress_at — this is the heartbeat the watchdog reads.
      const lastProgressAt = nowIso();
      await db
        .update(syncRun)
        .set(
          total === null
            ? { wpCount: processed, lastProgressAt }
            : { wpCount: processed, totalCount: total, lastProgressAt },
        )
        .where(eq(syncRun.id, id));
    },
    async finish(
      id: number,
      status: SyncStatus,
      wpCount: number | null,
      error: string | null,
      finishedAt: string,
    ): Promise<SyncRun> {
      const [row] = await db
        .update(syncRun)
        .set({ status, wpCount, error, finishedAt })
        .where(eq(syncRun.id, id))
        .returning();
      return mapSyncRun(row!);
    },
    async latest(): Promise<SyncRun | null> {
      const [row] = await db
        .select()
        .from(syncRun)
        .orderBy(desc(syncRun.id))
        .limit(1);
      return row ? mapSyncRun(row) : null;
    },
    async current(): Promise<SyncRun | null> {
      const [row] = await db
        .select()
        .from(syncRun)
        .where(eq(syncRun.status, "running"))
        .orderBy(desc(syncRun.id))
        .limit(1);
      return row ? mapSyncRun(row) : null;
    },
    async getById(id: number): Promise<SyncRun | null> {
      const [row] = await db
        .select()
        .from(syncRun)
        .where(eq(syncRun.id, id))
        .limit(1);
      return row ? mapSyncRun(row) : null;
    },
    async requestCancel(id: number): Promise<SyncRun | null> {
      // Idempotent: flip cancel_requested only while still running; otherwise a
      // no-op that returns the row unchanged (finishing before this lands is
      // not an error — SPEC_19 §2c).
      await db
        .update(syncRun)
        .set({ cancelRequested: true })
        .where(and(eq(syncRun.id, id), eq(syncRun.status, "running")));
      const [row] = await db
        .select()
        .from(syncRun)
        .where(eq(syncRun.id, id))
        .limit(1);
      return row ? mapSyncRun(row) : null;
    },
    async isCancelled(id: number): Promise<boolean> {
      // Minimal poll — only the flag, no full-row map (called between pages).
      const [row] = await db
        .select({ cancelRequested: syncRun.cancelRequested })
        .from(syncRun)
        .where(eq(syncRun.id, id))
        .limit(1);
      return row?.cancelRequested ?? false;
    },
    async recoverOrphaned(): Promise<number> {
      // Increment 22 (SPEC_22 §1) — crash recovery. Same write style as finish()
      // above, but keyed on status='running' (not a run id): a fresh process can
      // never own a row left `running` by a killed predecessor, so every such
      // row is unconditionally orphaned. Mark them aborted with a diagnostic
      // error. Increment 27: the count comes from RETURNING, not a driver result
      // field — node-postgres exposes `rowCount`, PGlite `affectedRows`, and the
      // repository must behave identically on both (same pattern as
      // userNameAliasRepository.delete).
      const recovered = await db
        .update(syncRun)
        .set({
          status: "aborted",
          finishedAt: nowIso(),
          error:
            "Recovered at startup: no live process could own a running sync_run",
        })
        .where(eq(syncRun.status, "running"))
        .returning({ id: syncRun.id });
      return recovered.length;
    },
  };
}

// ── SyncWatermarkRepository (Increment 29, CONTRACTS §3) ────────────────────
function syncWatermarkRepository(db: OspDatabase): SyncWatermarkRepository {
  /** `connection_id = $1` for a real id, `connection_id IS NULL` for the legacy
   * group. `eq(col, null)` renders `= NULL`, which matches NOTHING in SQL — the
   * legacy null group would silently never be found. */
  const connMatch = (connectionId: number | null): SQL =>
    connectionId === null
      ? isNull(syncWatermark.connectionId)
      : eq(syncWatermark.connectionId, connectionId);

  return {
    async get(connectionId: number | null, projectOpId: OpId): Promise<string | null> {
      const [row] = await db
        .select({ watermarkAt: syncWatermark.watermarkAt })
        .from(syncWatermark)
        .where(
          and(connMatch(connectionId), eq(syncWatermark.projectOpId, projectOpId)),
        )
        .limit(1);
      return row?.watermarkAt ?? null;
    },
    async set(
      connectionId: number | null,
      projectOpId: OpId,
      watermarkAt: string,
    ): Promise<void> {
      // Deliberately a read-then-write rather than `onConflictDoUpdate` on the
      // unique index: in Postgres, NULLs are DISTINCT in a unique index by
      // default, so `ON CONFLICT (connection_id, project_op_id)` never fires
      // for the legacy `connection_id IS NULL` group and would quietly insert a
      // duplicate row on every successful sync — the watermark would then be
      // read non-deterministically. `NULLS NOT DISTINCT` is only expressible on
      // a unique CONSTRAINT in this Drizzle version, and CONTRACTS §3 freezes
      // this as a unique INDEX, so correctness lives here instead. Safe without
      // a transaction: only one sync runs at a time (the POST /sync guard), and
      // this is the sole writer of the table.
      const [existing] = await db
        .select({ id: syncWatermark.id })
        .from(syncWatermark)
        .where(
          and(connMatch(connectionId), eq(syncWatermark.projectOpId, projectOpId)),
        )
        .limit(1);
      if (existing) {
        await db
          .update(syncWatermark)
          .set({ watermarkAt })
          .where(eq(syncWatermark.id, existing.id));
        return;
      }
      await db.insert(syncWatermark).values({ connectionId, projectOpId, watermarkAt });
    },
    async clearForConnection(connectionId: number | null): Promise<void> {
      await db.delete(syncWatermark).where(connMatch(connectionId));
    },
  };
}

// ── BurndownRepository ───────────────────────────────────────────────────────
function burndownRepository(db: OspDatabase): BurndownRepository {
  return {
    async listBySprint(sprintId: number): Promise<BurndownSnapshot[]> {
      const rows = await db
        .select()
        .from(burndownSnapshot)
        .where(eq(burndownSnapshot.sprintId, sprintId))
        .orderBy(burndownSnapshot.snapshotDate);
      return rows.map(mapBurndown);
    },
    async getBySprintAndDate(
      sprintId: number,
      date: string,
    ): Promise<BurndownSnapshot | null> {
      const [row] = await db
        .select()
        .from(burndownSnapshot)
        .where(
          and(
            eq(burndownSnapshot.sprintId, sprintId),
            eq(burndownSnapshot.snapshotDate, date),
          ),
        )
        .limit(1);
      return row ? mapBurndown(row) : null;
    },
    async upsert(input: NewBurndownSnapshot): Promise<BurndownSnapshot> {
      const values = {
        sprintId: input.sprint_id,
        snapshotDate: input.snapshot_date,
        remainingHours: input.remaining_hours,
        loggedHours: input.logged_hours,
        idealHours: input.ideal_hours,
        doneCount: input.done_count,
        totalCount: input.total_count,
        // Increment 12 (SPEC_12 §1/§5): live nightly point vs reconstructed replay.
        source: input.source,
      };
      const [row] = await db
        .insert(burndownSnapshot)
        .values(values)
        .onConflictDoUpdate({
          target: [burndownSnapshot.sprintId, burndownSnapshot.snapshotDate],
          set: {
            remainingHours: input.remaining_hours,
            loggedHours: input.logged_hours,
            idealHours: input.ideal_hours,
            doneCount: input.done_count,
            totalCount: input.total_count,
            source: input.source,
          },
        })
        .returning();
      return mapBurndown(row!);
    },
  };
}

// ── ClosureReportRepository ──────────────────────────────────────────────────
function closureReportRepository(db: OspDatabase): ClosureReportRepository {
  return {
    async getBySprint(sprintId: number): Promise<SprintClosureReport | null> {
      const [row] = await db
        .select()
        .from(sprintClosureReport)
        .where(eq(sprintClosureReport.sprintId, sprintId))
        .orderBy(desc(sprintClosureReport.id))
        .limit(1);
      return row ? mapClosureReport(row) : null;
    },
    async upsert(input: NewClosureReport): Promise<SprintClosureReport> {
      const generatedAt = nowIso();
      const [existing] = await db
        .select()
        .from(sprintClosureReport)
        .where(eq(sprintClosureReport.sprintId, input.sprint_id))
        .limit(1);
      if (existing) {
        const [row] = await db
          .update(sprintClosureReport)
          .set({
            generatedAt,
            doneJson: input.done_json,
            notDoneJson: input.not_done_json,
            versionChangeJson: input.version_change_json,
          })
          .where(eq(sprintClosureReport.id, existing.id))
          .returning();
        return mapClosureReport(row!);
      }
      const [row] = await db
        .insert(sprintClosureReport)
        .values({
          sprintId: input.sprint_id,
          generatedAt,
          doneJson: input.done_json,
          notDoneJson: input.not_done_json,
          versionChangeJson: input.version_change_json,
        })
        .returning();
      return mapClosureReport(row!);
    },
  };
}

// ── UserNameAliasRepository (SPEC_13 §1a) ────────────────────────────────────
function userNameAliasRepository(db: OspDatabase): UserNameAliasRepository {
  return {
    async listByConnection(connectionId: number): Promise<UserNameAlias[]> {
      const rows = await db
        .select()
        .from(userNameAlias)
        .where(eq(userNameAlias.connectionId, connectionId))
        .orderBy(userNameAlias.id);
      return rows.map(mapUserNameAlias);
    },
    async listAll(): Promise<UserNameAlias[]> {
      const rows = await db.select().from(userNameAlias).orderBy(userNameAlias.id);
      return rows.map(mapUserNameAlias);
    },
    async getById(id: number): Promise<UserNameAlias | null> {
      const [row] = await db
        .select()
        .from(userNameAlias)
        .where(eq(userNameAlias.id, id))
        .limit(1);
      return row ? mapUserNameAlias(row) : null;
    },
    async upsert(input: NewUserNameAlias): Promise<UserNameAlias> {
      const [row] = await db
        .insert(userNameAlias)
        .values({
          connectionId: input.connection_id,
          journalName: input.journal_name,
          opUserId: input.op_user_id ?? null,
          mergeIntoName: input.merge_into_name ?? null,
        })
        // Re-posting the same (connection, journal_name) corrects the target
        // instead of 409ing (SPEC_13 §1a — fixing a mistaken alias is expected
        // UX). Both escape-hatch fields are overwritten so re-posting fully
        // replaces the prior mapping (op_user_id ⇄ merge_into_name).
        .onConflictDoUpdate({
          target: [userNameAlias.connectionId, userNameAlias.journalName],
          set: {
            opUserId: input.op_user_id ?? null,
            mergeIntoName: input.merge_into_name ?? null,
          },
        })
        .returning();
      return mapUserNameAlias(row!);
    },
    async delete(id: number): Promise<boolean> {
      // Increment 27: RETURNING instead of a driver-specific affected-rows field
      // (see syncRunRepository.recoverOrphaned) — works on node-postgres and
      // PGlite alike.
      const deleted = await db
        .delete(userNameAlias)
        .where(eq(userNameAlias.id, id))
        .returning({ id: userNameAlias.id });
      return deleted.length > 0;
    },
  };
}

// ── CapacityEditAuditRepository (SPEC_13 §6) ─────────────────────────────────
function capacityEditAuditRepository(db: OspDatabase): CapacityEditAuditRepository {
  return {
    async listBySprint(sprintId: number): Promise<CapacityEditAuditEntry[]> {
      const rows = await db
        .select()
        .from(capacityEditAudit)
        .where(eq(capacityEditAudit.sprintId, sprintId))
        .orderBy(desc(capacityEditAudit.id));
      return rows.map(mapCapacityEditAudit);
    },
    async add(input: NewCapacityEditAudit): Promise<CapacityEditAuditEntry> {
      const [row] = await db
        .insert(capacityEditAudit)
        .values({
          sprintId: input.sprint_id,
          changesJson: input.changes_json,
          editedAt: nowIso(),
        })
        .returning();
      return mapCapacityEditAudit(row!);
    },
  };
}

// ── OffSprintTimeRepository (Increment 32, docs/INCREMENT_32_CONTRACTS.md §2) ─
function offSprintTimeRepository(db: OspDatabase): OffSprintTimeRepository {
  return {
    async listBySprint(sprintId: number) {
      const rows = await db
        .select()
        .from(offSprintTimeEntry)
        .where(eq(offSprintTimeEntry.sprintId, sprintId))
        .orderBy(offSprintTimeEntry.id);
      return rows.map(mapOffSprintTimeEntry);
    },
    // Transactional delete+insert, same shape as capacityRepository/
    // doneStatusRuleRepository above — every sprint update run REPLACES the
    // full set (§0.3: "a report of current truth, not history").
    async replaceForSprint(sprintId: number, rows: NewOffSprintTimeEntry[]) {
      return await db.transaction(async (tx) => {
        await tx.delete(offSprintTimeEntry).where(eq(offSprintTimeEntry.sprintId, sprintId));
        const out: OffSprintTimeEntry[] = [];
        for (const r of rows) {
          const [row] = await tx
            .insert(offSprintTimeEntry)
            .values({
              sprintId: r.sprint_id,
              connectionId: r.connection_id,
              opTimeEntryId: r.op_time_entry_id,
              wpOpId: r.wp_op_id,
              wpSubject: r.wp_subject,
              actorOpId: r.actor_op_id,
              actorName: r.actor_name,
              spentOn: r.spent_on,
              hours: r.hours,
              fetchedAt: r.fetched_at,
            })
            .returning();
          out.push(mapOffSprintTimeEntry(row!));
        }
        return out;
      });
    },
  };
}

/** Aggregate of every repository the backend consumes (dependency-injected). */
export interface Repositories {
  connections: ConnectionRepository;
  vaultMeta: VaultMetaRepository;
  projects: ProjectRepository;
  importSelections: ImportSelectionRepository;
  backlogDismissals: BacklogDismissalRepository;
  workPackages: WorkPackageCacheRepository;
  estimateOverrides: EstimateOverrideRepository;
  sprints: SprintRepository;
  sprintItems: SprintItemRepository;
  teamMembers: TeamMemberRepository;
  capacities: CapacityRepository;
  doneStatusRules: DoneStatusRuleRepository;
  /** Increment 14 (SPEC_14 §2) — implement doneRuleRepository(db) in this file. */
  doneRules: DoneRuleRepository;
  /** Increment 14 (SPEC_14 §3/§7 #5) — implement reportConfigRepository(db) in this file. */
  reportConfig: ReportConfigRepository;
  remainingStatusRules: RemainingStatusRuleRepository;
  syncRuns: SyncRunRepository;
  /** Increment 29 (CONTRACTS §3) — per-(connection, project) incremental cutoff. */
  watermarks: SyncWatermarkRepository;
  burndown: BurndownRepository;
  closureReports: ClosureReportRepository;
  ticketBaselines: TicketBaselineRepository;
  sprintUpdateRuns: SprintUpdateRunRepository;
  ticketChangelog: TicketChangelogRepository;
  userNameAliases: UserNameAliasRepository;
  capacityEditAudits: CapacityEditAuditRepository;
  /** Increment 32 (docs/INCREMENT_32_CONTRACTS.md §2) — the roster-wide
   * off-sprint time report. */
  offSprintTime: OffSprintTimeRepository;
}

/** Build all repository implementations bound to a single Drizzle handle. */
export function createRepositories(db: OspDatabase): Repositories {
  return {
    connections: connectionRepository(db),
    vaultMeta: vaultMetaRepository(db),
    projects: projectRepository(db),
    importSelections: importSelectionRepository(db),
    backlogDismissals: backlogDismissalRepository(db),
    workPackages: workPackageCacheRepository(db),
    estimateOverrides: estimateOverrideRepository(db),
    sprints: sprintRepository(db),
    sprintItems: sprintItemRepository(db),
    teamMembers: teamMemberRepository(db),
    capacities: capacityRepository(db),
    doneStatusRules: doneStatusRuleRepository(db),
    doneRules: doneRuleRepository(db),
    reportConfig: reportConfigRepository(db),
    remainingStatusRules: remainingStatusRuleRepository(db),
    syncRuns: syncRunRepository(db),
    watermarks: syncWatermarkRepository(db),
    burndown: burndownRepository(db),
    closureReports: closureReportRepository(db),
    ticketBaselines: ticketBaselineRepository(db),
    sprintUpdateRuns: sprintUpdateRunRepository(db),
    ticketChangelog: ticketChangelogRepository(db),
    userNameAliases: userNameAliasRepository(db),
    capacityEditAudits: capacityEditAuditRepository(db),
    offSprintTime: offSprintTimeRepository(db),
  };
}
