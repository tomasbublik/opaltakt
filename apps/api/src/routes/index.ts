import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  type ActivateSprintResponse,
  AddConnectionBody,
  type AddConnectionResponse,
  AddSprintItemBody,
  AddSprintItemByIdBody,
  CarrySprintItemBody,
  type CarrySprintItemResponse,
  DoubleCountFixBody,
  type DoubleCountFixResponse,
  BacklogQuery,
  BacklogFilterOptionsQuery,
  type BacklogFilterOptionsResponse,
  type BacklogItem,
  type CancelSyncResponse,
  type CapacityAuditResponse,
  type CapacityResponse,
  type ChangelogDetail,
  type ChangelogEntryView,
  type ClosureReportResponse,
  type ClosureStatsResponse,
  type Connection,
  CreateUserAliasBody,
  FinishSprintBody,
  ConnectionIdParams,
  type ConnectionsHealthResponse,
  type ConnectionsResponse,
  CreateEstimateOverrideBody,
  CreateSprintBody,
  type DeleteConnectionResponse,
  type DeleteSprintResponse,
  ReactivateSprintBody,
  type ReactivateSprintResponse,
  ImportIdParams,
  type ImportsResponse,
  ImportWorkPackageBody,
  type OffSprintTimeResponse,
  type OpConnection,
  type OpUserSummary,
  type PeopleResponse,
  PersonIdParams,
  type ProjectsResponse,
  type ReportDetailResponse,
  type ReportsListResponse,
  ReportSprintParams,
  SetPersonRoleBody,
  type DoneRulesResponse,
  UpdateDoneRulesBody,
  type SprintItem,
  type WorkPackageCache,
  type RebuildBurndownResponse,
  RemoveFromBacklogBody,
  type RemoveFromBacklogResponse,
  type RemoveImportResponse,
  RetroSeedBody,
  type RetroSeedResponse,
  type RetroPreviewResponse,
  SetCapacityBody,
  type SprintPeopleResponse,
  type SprintPersonEntry,
  type TeamMember,
  type UserAliasResponse,
  type UserAliasesResponse,
  type SprintItemsDetailedResponse,
  SprintIdParams,
  SprintItemParams,
  type SnapshotResponse,
  type SprintUpdateRunResponse,
  type SprintUpdateRunsResponse,
  type SyncKind,
  type SyncRun,
  type ConnectionSyncOutcome,
  type SyncCoverage,
  type SyncRefreshAllResponse,
  DeleteOutOfSelectionBody,
  type DeleteOutOfSelectionResponse,
  type OutOfSelectionEntry,
  type OutOfSelectionResponse,
  type SyncStatusResponse,
  TicketChangelogParams,
  type TicketChangelogResponse,
  TriggerSnapshotBody,
  TriggerSyncBody,
  UpdateConnectionBody,
  UpdateSprintBody,
  UpdateSprintRunBody,
  VaultChangePassphraseBody,
  VaultInitBody,
  VaultResetBody,
  type VaultResetResponse,
  type VaultStatusResponse,
  VaultUnlockBody,
  type VersionExportResponse,
  type VersionsResponse,
  type AppConfigResponse,
  UpdateAppConfigBody,
} from "@osp/contracts";
import {
  DEFAULT_ACTIVATION_TIMEOUT_MS,
  fetchAllTimeEntries,
  fetchEarliestTimeEntryDate,
  fetchWorkPackageById,
  instrumentOpClient,
  OpHttpError,
  parseIsoDuration,
  parseOpId,
  withTimeout,
  type OpClient,
  type OpStatus,
  type OpUser,
} from "@osp/op-client";
// Increment 29: `registerHardCancelController`/`unregisterHardCancelController`
// are gone from this file — the coverage pass no longer creates its own
// `sync_run`, so registering the AbortController is `engine.syncByOpIds`'s job
// (CONTRACTS §2). apps/api must not own a second hard-cancel lifecycle.
import {
  hardCancelRun,
  hardCancelSprintUpdateRun,
  toWorkPackageCacheRow,
} from "@osp/sync";
import type { AppDeps } from "../deps";
import { AppError } from "../errors";
import { computeAggregate, type HealthKind, type HealthResult } from "../health/index";
import { connTokenBlob } from "../vault/index";
import { effectiveEstimate } from "../logic/estimate";
import { leafEffort } from "../logic/doubleCounting";
import { buildPersonResolver } from "../logic/personResolver";
import { createUserNameResolver, unknownUserLabel } from "../logic/userNames";
import { type IdentityResolver } from "../logic/identityResolver";
import {
  buildBaseline,
  runScopedActivation,
  type ScopedActivationPartition,
} from "../logic/sprintUpdate";
import {
  resolveNeededConnectionIds,
  validateNeededConnections,
} from "../logic/activationScope";
import { buildBurndown } from "../logic/burndown";
import { computeVelocity } from "../logic/velocity";
import { createRetroService, replayDayCount, type RetroService } from "../logic/retro";
import { writeSprintExport } from "../logic/sprintExport";
import {
  buildVersionDeepLink,
  computeAndStoreClosureReport,
  performClosure,
  readStoredClosureReport,
} from "../logic/closure";
import { computeClosureStats, computeClosureStatsWithInternals } from "../logic/closureStats";
import {
  buildReportDetail,
  buildReportsList,
  generateReportPdf,
  type PdfRenderer,
} from "../logic/report";
import { HIDDEN_BACKLOG_STATUSES } from "../logic/backlogStatus";
import { buildSprintItemsDetailed as buildSprintItemsDetailedShared } from "../logic/sprintItemsDetailed";
import {
  computeSprintCapacity,
  localOnlyCapacityDeps,
  makeConnectionResolvers as makeConnectionResolversShared,
  materializeReconstructedMember as materializeReconstructedMemberShared,
} from "../logic/capacitySummary";
import { generateSprintStatusPdf } from "../logic/statusReport";
import { fail, mapOpError, parseOrThrow } from "./helpers";
import { mayContactOp } from "../auth/index";

/**
 * Increment 14 (SPEC_14 §2 consequence #1) — map a team_member.role to the role
 * a capacity LINE reports. A person whose role is still "unset" is treated as a
 * developer for capacity purposes (plannable, editable, counted in totals) so
 * existing all-"unset" sprints don't silently lose their capacity aggregate;
 * only an EXPLICIT tester/customer/other marks a line non-developer (grey,
 * excluded from totals). The done-matrix (§2) treats "unset" differently — as
 * "ambiguous" — because there admitting-not-inferring is the whole point; here
 * the safe default is "keep the pre-Increment-14 behavior until told otherwise".
 */
// Identity unification: the "unset → developer" capacity default now lives in
// the ONE shared identity module (`capacityEffectiveRole`, @osp/contracts) —
// closureStats applies the SAME default, so a person /capacity counts can no
// longer be invisible on /closure-stats. The local helper is deleted.

// HIDDEN_BACKLOG_STATUSES moved to logic/backlogStatus.ts (Increment 36) so
// logic/capacitySummary.ts's extracted capacity computation shares the SAME
// literal, never a second copy that could drift.

/**
 * Increment 23 (SPEC_23 §2) — parse a `FilterOptionEntry.key`
 * (`${connection_id}:${op_id}` or `none:${op_id}` for a legacy connection-less
 * row) back into its `(connectionId, id)` pair. `connectionId` is `null` for
 * the `none:` form. Returns null for a malformed key so the caller can fall
 * back to the legacy bare-id field rather than throwing. This is the collision-
 * proof replacement for matching by a bare `op_user_id`/`op_version_id`, which
 * repeats across servers (Alan Turing@mock and Cameron Dalby@Acme are
 * both OP id 3).
 */
function parseFilterKey(key: string): { connectionId: number | null; id: number } | null {
  const idx = key.indexOf(":");
  if (idx < 0) return null;
  const connPart = key.slice(0, idx);
  const id = Number(key.slice(idx + 1));
  if (!Number.isInteger(id)) return null;
  if (connPart === "none") return { connectionId: null, id };
  const connectionId = Number(connPart);
  if (!Number.isInteger(connectionId)) return null;
  return { connectionId, id };
}

/**
 * REST handlers (SPEC §7), dependency-injected via AppDeps. Inputs validated
 * with the frozen Zod schemas from @osp/contracts; responses shaped to the
 * contract types. OpenProject stays READ-ONLY (the injected client is GET-only).
 */
export function createRoutes(deps: AppDeps): FastifyPluginAsync {
  const { repos, vault, healthTracker } = deps;
  const nowIso = (): string => deps.now().toISOString();

  /** Map the internal row to the token-free API shape (SPEC_02: no token ever). */
  function toConnection(c: OpConnection): Connection {
    return {
      id: c.id,
      base_url: c.base_url,
      label: c.label,
      default_project_op_id: c.default_project_op_id,
      is_current: c.is_current,
      enabled: c.enabled,
      has_token: c.token_ct != null || c.token_encrypted != null,
      created_at: c.created_at,
      health: {
        last_activity_at: c.last_activity_at,
        last_check_at: c.last_check_at,
        last_status: c.last_status,
        last_latency_ms: c.last_latency_ms,
        last_error: c.last_error,
      },
    };
  }

  async function buildHealthPayload(): Promise<ConnectionsHealthResponse> {
    const list = await repos.connections.list();
    return {
      // SPEC_10 §a: a disconnected server counts as NOT-OK for the aggregate —
      // it is no longer contributing a live, healthy connection, whatever its
      // stale last_status says. (Superseded reasoning, kept for history:
      // Increment 7 EXCLUDED disabled rows from this computation entirely,
      // which meant 1-of-2 servers disconnected still averaged to 100% ok
      // among the remaining row → wrongly green. SPEC_10's bug report is
      // exactly that: acme disconnected, mock ok, dot stayed green.)
      aggregate: computeAggregate(
        list.map((c) => (c.enabled ? c.last_status : "fail")),
        vault.isLocked(),
      ),
      connections: list.map(toConnection),
    };
  }

  /**
   * Resolve the CURRENT connection into a ready OP client: requires an unlocked
   * vault + a stored token. The token is decrypted AD-HOC and goes out of scope
   * as soon as the client is built; the client is instrumented so every real OP
   * call piggybacks health ("activity", SPEC_02 §4).
   */
  function buildOpClient(conn: OpConnection, token: string): OpClient {
    const client = deps.opClientFactory({ baseUrl: conn.base_url, token });
    return instrumentOpClient(client, (r) => {
      void healthTracker.record(conn.id, r, "activity").catch(() => {});
    });
  }

  /**
   * Resolve a SPECIFIC connection into a ready OP client: requires an unlocked
   * vault + a stored token + the connection to be enabled (Disconnect/Connect
   * toggle). The token is decrypted AD-HOC and goes out of scope as soon as the
   * client is built; the client is instrumented so every real OP call
   * piggybacks health ("activity", SPEC_02 §4).
   */
  async function requireOpClientForConnection(
    connId: number,
  ): Promise<{ op: OpClient; conn: OpConnection }> {
    const conn = await repos.connections.getById(connId);
    if (!conn) fail("CONNECTION_NOT_FOUND", `Connection ${connId} not found`);
    if (!conn.enabled)
      fail("CONNECTION_DISABLED", `Connection "${conn.base_url}" is disconnected`);
    if (vault.isLocked())
      fail("VAULT_LOCKED", "The vault is locked — unlock it to talk to OpenProject");
    const blob = connTokenBlob(conn);
    if (!blob)
      fail(
        "NO_CONNECTION",
        `Connection ${conn.base_url} has no token stored (vault was reset?)`,
      );
    const op = buildOpClient(conn, vault.decryptToken(blob));
    return { op, conn };
  }

  /**
   * Resolve the CURRENT connection into a ready OP client — see
   * requireOpClientForConnection for the shared logic/semantics.
   */
  async function requireOpClient(): Promise<{ op: OpClient; conn: OpConnection }> {
    const conn = await repos.connections.getCurrent();
    if (!conn) fail("NO_CONNECTION", "No OpenProject connection configured");
    return requireOpClientForConnection(conn.id);
  }

  /**
   * SPEC_10 §e — the per-connection client resolver the sprint LIFECYCLE
   * (activate via PATCH shortcut / update / finish) uses: a timeout-wrapped OP
   * client for ONE connection. Reuses requireOpClientForConnection (which throws
   * a clear per-connection CONNECTION_DISABLED / VAULT_LOCKED / NO_CONNECTION for
   * a NEEDED-but-unavailable connection) and the SAME withTimeout cap /activate
   * already applies, so a needed connection can't hang the request indefinitely.
   */
  async function buildTimeoutClientForConnection(connId: number): Promise<OpClient> {
    const { op } = await requireOpClientForConnection(connId);
    return withTimeout(op, DEFAULT_ACTIVATION_TIMEOUT_MS);
  }

  /**
   * Increment 12 (SPEC_12) — the retrospective-planning service, bound to the
   * SAME per-connection timeout client resolver the lifecycle uses (scoping
   * invariant, SPEC_11 §1). Rebuilt per call so it always sees fresh repos/vault.
   */
  function retroService(): RetroService {
    return createRetroService({
      repos,
      reconstruct: deps.reconstruct,
      buildClientForConnection: buildTimeoutClientForConnection,
      now: deps.now,
    });
  }

  /**
   * Like requireOpClient() but returns null instead of throwing when OP is
   * unreachable (no connection / disabled / locked vault / no token). Used by
   * the PATCH activation shortcut so activating a sprint still works offline
   * (falling back to a plain status flip without a baseline) — mirrors
   * index.ts's makeOpClient.
   */
  async function tryOpClient(): Promise<OpClient | null> {
    // Consolidation Round (Concept 9): don't re-inline the enabled/locked/token
    // checks — delegate to the ONE canonical resolver and swallow exactly the
    // expected "OP not currently reachable" conditions (no connection / disabled
    // / locked vault / no token), returning null for them so the PATCH
    // activation shortcut still falls back to an offline status flip.
    try {
      const { op } = await requireOpClient();
      return op;
    } catch (err) {
      if (
        err instanceof AppError &&
        (err.code === "NO_CONNECTION" ||
          err.code === "CONNECTION_DISABLED" ||
          err.code === "VAULT_LOCKED" ||
          err.code === "CONNECTION_NOT_FOUND")
      ) {
        return null;
      }
      throw err;
    }
  }

  /**
   * One timed GET /users/me against a server (uses the injected client factory,
   * so tests can fake it). Never throws — failure is data, not an error: a
   * currently unreachable server must still be addable (SPEC_02 §7).
   */
  async function probeServer(
    baseUrl: string,
    token: string,
  ): Promise<{ user: OpUser | null; result: HealthResult }> {
    const probe = deps.opClientFactory({ baseUrl, token });
    const started = Date.now();
    try {
      const user = await probe.getCurrentUser();
      return {
        user,
        result: { ok: true, latency_ms: Date.now() - started, error: null },
      };
    } catch (err) {
      return {
        user: null,
        result: {
          ok: false,
          latency_ms: Date.now() - started,
          error: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  /** Probe + record health + return the refreshed row. */
  async function testConnection(
    conn: OpConnection,
    token: string,
    kind: HealthKind,
  ): Promise<{ user: OpUser | null; fresh: OpConnection }> {
    const { user, result } = await probeServer(conn.base_url, token);
    await healthTracker.record(conn.id, result, kind);
    const fresh = (await repos.connections.getById(conn.id)) ?? conn;
    return { user, fresh };
  }

  async function getSprintOrThrow(id: number) {
    const sprint = await repos.sprints.getById(id);
    if (!sprint) fail("SPRINT_NOT_FOUND", `Sprint ${id} not found`);
    return sprint;
  }

  /** Leaf-level total planned hours for a sprint's live items (SPEC §6). */
  async function sprintLeafPlanned(sprintId: number): Promise<number> {
    const items = (await repos.sprintItems.listBySprint(sprintId)).filter(
      (i) => i.outcome !== "removed",
    );
    if (items.length === 0) return 0;
    const wps = await repos.workPackages.getManyByOpIds(
      items.map((i) => i.wp_op_id),
    );
    const overrides = await repos.estimateOverrides.getManyByWpOpIds(
      items.map((i) => i.wp_op_id),
    );
    const wpById = new Map(wps.map((w) => [w.op_id, w]));
    const ovById = new Map(overrides.map((o) => [o.wp_op_id, o]));
    const effortItems = items.map((it) => {
      const wp = wpById.get(it.wp_op_id);
      const eff = effectiveEstimate(
        wp?.estimated_hours ?? null,
        wp?.remaining_hours ?? null,
        ovById.get(it.wp_op_id)?.planning_hours ?? null,
      );
      return {
        wp_op_id: it.wp_op_id,
        parent_op_id: wp?.parent_op_id ?? null,
        hours: it.planned_hours ?? eff,
      };
    });
    return leafEffort(effortItems).total;
  }

  /**
   * SPEC_13 §1/§3, extracted to `logic/capacitySummary.ts` in Increment 36
   * (docs/INCREMENT_36_CONTRACTS.md §2) so the status PDF's capacity table can
   * reuse the SAME resolver-building logic (with a no-OP-calls deps bag).
   * This wrapper keeps `buildSprintPeople`'s call site unchanged.
   */
  function makeConnectionResolvers(
    wps: readonly WorkPackageCache[],
    opAllowed = true,
  ): (connId: number) => Promise<IdentityResolver> {
    return makeConnectionResolversShared(
      {
        repos,
        // Increment 39 — a Viewer never causes OP traffic: the shared resolver
        // already treats a rejecting client builder as "OP unreachable" and
        // falls back to aliases + cached assignees (the status-PDF path).
        buildClientForConnection: opAllowed
          ? buildTimeoutClientForConnection
          : localOnlyCapacityDeps(repos).buildClientForConnection,
      },
      wps,
    );
  }

  /**
   * SPEC_13 §1a (revised), extracted to `logic/capacitySummary.ts` in
   * Increment 36 alongside `makeConnectionResolvers` (§2) — `buildPeople`
   * below is the only remaining caller in THIS file (the retro-planning
   * capacity roster caller now lives in the shared module too).
   */
  async function materializeReconstructedMember(
    name: string,
    opUserId: number | null,
    cache: Map<string, TeamMember>,
  ): Promise<TeamMember> {
    return materializeReconstructedMemberShared(repos, name, opUserId, cache);
  }

  /**
   * SPEC_13 §1a (REVISED) — GET /sprints/:id/people: EVERY distinct person
   * holding retro-reconstructed work in the sprint (grouped by canonical NAME,
   * via the SAME resolver as capacity/preview), with summed effective hours,
   * ticket count, and op_user_id WHEN known (null is normal and non-blocking —
   * informational, never a filter). Replaces the old unresolved-names route: it
   * lists resolved and unresolved people alike.
   */
  async function buildSprintPeople(
    sprintId: number,
    opAllowed = true,
  ): Promise<SprintPeopleResponse> {
    const items = (await repos.sprintItems.listBySprint(sprintId)).filter(
      (i) => i.outcome !== "removed" && i.outcome !== "removed_mid_sprint",
    );
    const baselines = await repos.ticketBaselines.listBySprint(sprintId);
    const baselineByWp = new Map(baselines.map((b) => [b.wp_op_id, b]));
    const wps = await repos.workPackages.getManyByOpIds(items.map((i) => i.wp_op_id));
    const wpById = new Map(wps.map((w) => [w.op_id, w]));
    const overrides = await repos.estimateOverrides.getManyByWpOpIds(items.map((i) => i.wp_op_id));
    const ovById = new Map(overrides.map((o) => [o.wp_op_id, o]));
    const currentConn = await repos.connections.getCurrent();
    const resolverFor = makeConnectionResolvers(wps, opAllowed);
    // Group EVERY person the SAME way computeCapacity does: by op_user_id when
    // known (so two spellings / a merge_into_name that resolve to one account
    // fold together), else by canonical name (so an id-less person keeps their
    // own entry). `_exact` marks that a contributing name IS an index hit — the
    // authoritative current display name, preferred over an aliased spelling.
    const acc = new Map<string, SprintPersonEntry & { _exact?: boolean }>();
    for (const it of items) {
      const b = baselineByWp.get(it.wp_op_id);
      if (!b || !b.assignee_name_raw) continue;
      const wp = wpById.get(it.wp_op_id);
      const connId = wp?.connection_id ?? currentConn?.id ?? null;
      if (connId === null) continue;
      const identity = (await resolverFor(connId)).resolve(b.assignee_name_raw);
      const name = identity.canonical_name ?? b.assignee_name_raw;
      const eff =
        effectiveEstimate(
          b.estimated_hours,
          b.remaining_hours,
          ovById.get(it.wp_op_id)?.planning_hours ?? null,
        ) ?? 0;
      const key =
        identity.op_user_id != null ? `id:${connId}:${identity.op_user_id}` : `nm:${connId}:${name}`;
      const cur =
        acc.get(key) ??
        { connection_id: connId, name, op_user_id: identity.op_user_id, hours: 0, ticket_count: 0 };
      cur.hours += eff;
      cur.ticket_count += 1;
      if (cur.op_user_id == null && identity.op_user_id != null) cur.op_user_id = identity.op_user_id;
      // An exact index hit is the canonical current name — adopt it over an alias.
      if (identity.resolution === "exact") {
        cur.name = name;
        cur._exact = true;
      }
      acc.set(key, cur);
    }
    return [...acc.values()].map(({ _exact, ...entry }) => entry);
  }

  /**
   * Increment 28 (§2c), extracted to `logic/sprintItemsDetailed.ts` in
   * Increment 36 (docs/INCREMENT_36_CONTRACTS.md §2) so the sprint status PDF
   * can reuse the EXACT SAME assembly `GET /sprints/:id/items/detailed`
   * serves, never a second implementation of frozen/dimming/origin logic.
   * This wrapper keeps every existing call site in this file unchanged.
   */
  async function buildSprintItemsDetailed(id: number): Promise<SprintItemsDetailedResponse> {
    return buildSprintItemsDetailedShared(repos, id);
  }

  /**
   * SPEC §7, SPEC_14 §2, SPEC_17 §4a, extracted to `logic/capacitySummary.ts`
   * in Increment 36 (docs/INCREMENT_36_CONTRACTS.md §2) so the status PDF's
   * capacity table reuses the EXACT SAME computation `GET /sprints/:id/capacity`
   * uses — never a second implementation. This wrapper supplies the REAL
   * vault-backed OP-client resolvers, so behaviour here is byte-identical to
   * before the extraction (the pre-existing route tests, left unedited, prove
   * it) — only the status PDF's own call (`logic/statusReport.ts`) passes the
   * no-OP-calls deps bag instead.
   */
  async function buildCapacityResponse(
    sprintId: number,
    opAllowed = true,
  ): Promise<CapacityResponse> {
    return computeSprintCapacity(
      // Increment 39 — a Viewer's read takes the SAME no-OP-calls deps bag the
      // status PDF uses (identical "OP unreachable" fallbacks, no new path).
      opAllowed
        ? { repos, tryOpClient, buildClientForConnection: buildTimeoutClientForConnection }
        : localOnlyCapacityDeps(repos),
      sprintId,
      nowIso(),
    );
  }

  /**
   * Increment 32 (docs/INCREMENT_32_CONTRACTS.md §4) — GET
   * /sprints/:id/off-sprint-time. Read-only aggregate of whatever
   * `fetchAndPersistOffSprintTime` (apps/api/src/logic/sprintUpdate.ts) last
   * wrote for this sprint — no OP call on this path, so it works with a
   * locked vault. Actors fold through the SAME canonical resolver every other
   * identity surface uses (buildPersonResolver), so two spellings of one
   * person collapse into a single per_person entry here too.
   */
  async function buildOffSprintTimeResponse(sprintId: number): Promise<OffSprintTimeResponse> {
    const sprint = await getSprintOrThrow(sprintId);
    const rows = await repos.offSprintTime.listBySprint(sprintId);
    const personResolver = await buildPersonResolver(repos);

    let fetchedAt: string | null = null;
    let totalHours = 0;
    interface PersonAgg {
      op_user_id: number;
      name: string;
      total_hours: number;
      tickets: Map<number, { subject: string | null; hours: number; connection_id: number | null }>;
    }
    const byPerson = new Map<string, PersonAgg>();

    for (const row of rows) {
      if (fetchedAt === null || row.fetched_at > fetchedAt) fetchedAt = row.fetched_at;
      totalHours += row.hours;
      // Every row carries a real actor_op_id (NOT NULL on the table), so
      // resolve() always returns a person here (null is only the "no id AND
      // no usable name" unassigned case, which cannot occur for this table).
      const resolved = personResolver.resolve(row.connection_id, row.actor_op_id, row.actor_name);
      const opUserId = resolved?.op_user_id ?? row.actor_op_id;
      const name = resolved?.name ?? row.actor_name ?? `User ${row.actor_op_id}`;
      const key = resolved?.key ?? `id:${row.connection_id ?? "null"}:${row.actor_op_id}`;
      let agg = byPerson.get(key);
      if (!agg) {
        agg = { op_user_id: opUserId, name, total_hours: 0, tickets: new Map() };
        byPerson.set(key, agg);
      }
      agg.total_hours += row.hours;
      const ticket = agg.tickets.get(row.wp_op_id);
      if (ticket) {
        ticket.hours += row.hours;
      } else {
        agg.tickets.set(row.wp_op_id, {
          subject: row.wp_subject,
          hours: row.hours,
          connection_id: row.connection_id,
        });
      }
    }

    const perPerson = [...byPerson.values()]
      .map((agg) => ({
        op_user_id: agg.op_user_id,
        name: agg.name,
        total_hours: agg.total_hours,
        tickets: [...agg.tickets.entries()]
          .map(([wpOpId, t]) => ({
            wp_op_id: wpOpId,
            subject: t.subject,
            hours: t.hours,
            connection_id: t.connection_id,
          }))
          .sort((a, b) => b.hours - a.hours || a.wp_op_id - b.wp_op_id),
      }))
      // §4: sorted by total_hours desc, then name.
      .sort((a, b) => b.total_hours - a.total_hours || a.name.localeCompare(b.name));

    return {
      window: { from: sprint.start_date, to: sprint.end_date },
      fetched_at: fetchedAt,
      total_hours: totalHours,
      per_person: perPerson,
    };
  }

  /**
   * Increment 14 (SPEC_14 §2) — GET /api/people. Every person seen holding
   * sprint work (across ALL sprints) is materialized into a team_member (so
   * they're assignable a role in Settings→People), then listed with their role
   * and a ticket_count = how many live sprint items currently hold them. The
   * holder is the ticket's CURRENT assignee (live work_package_cache), falling
   * back to a frozen/reconstructed baseline assignee when the cache is gone.
   *
   * Increment 15 (SPEC_15 §2/§5): CURRENT/baseline-only materialization misses
   * exactly the people this increment's whole premise is about — a developer
   * who held a ticket only BETWEEN baseline and current (e.g. redistributed
   * away, or handed off after finishing it) never appears as either "current"
   * or "baseline", yet still needs a settable role for their capacity segment
   * to render. So this ALSO materializes (a) the ticket's BASELINE holder
   * (`assignee_name_raw`/`original_assignee_op_id` — distinct from `wp`'s
   * CURRENT assignee, which may differ) and (b) every distinct logger from
   * this sprint's `time_logged` changelog rows (attribution by whoever
   * logged it, never by assignee — same principle closure stats already
   * uses). ticket_count still reflects CURRENT holdings only (unchanged
   * meaning); baseline-only/logger-only people materialize with count 0.
   * No OP mutation, GET-only; materialization is a local DB write.
   */
  async function buildPeople(): Promise<PeopleResponse> {
    const memberCache = new Map<string, TeamMember>();
    const countByMemberId = new Map<number, number>();
    const sprints = await repos.sprints.list();
    for (const s of sprints) {
      const items = (await repos.sprintItems.listBySprint(s.id)).filter(
        (i) => i.outcome !== "removed" && i.outcome !== "removed_mid_sprint",
      );
      if (items.length === 0) continue;
      const wps = await repos.workPackages.getManyByOpIds(items.map((i) => i.wp_op_id));
      const wpById = new Map(wps.map((w) => [w.op_id, w]));
      const baselines = await repos.ticketBaselines.listBySprint(s.id);
      const baselineByWp = new Map(baselines.map((b) => [b.wp_op_id, b]));
      for (const it of items) {
        const wp = wpById.get(it.wp_op_id);
        const b = baselineByWp.get(it.wp_op_id);
        const name = wp?.assignee_name ?? b?.assignee_name_raw ?? null;
        const opUserId = wp?.assignee_op_id ?? b?.assignee_op_id ?? null;
        if (name) {
          const member = await materializeReconstructedMember(name, opUserId, memberCache);
          countByMemberId.set(member.id, (countByMemberId.get(member.id) ?? 0) + 1);
        }
        // Baseline holder — may differ from the current `wp` assignee above
        // (redistributed/handed-off tickets); materialize without counting
        // (ticket_count stays "currently held", unchanged semantics). NAME
        // only — never `original_assignee_op_id`/`assignee_op_id` here: for a
        // retro-reconstructed row those ids are NOT journal-derivable and are
        // baked from the CURRENT live assignee as a fallback (retro.ts's own
        // "never trust the baked assignee_op_id for a retro row" — SPEC_13
        // §1), so passing it through would risk colliding this NAME's
        // materialization onto a DIFFERENT person's already-materialized id
        // (e.g. the ticket's current holder) instead of creating its own row.
        if (b?.assignee_name_raw) {
          await materializeReconstructedMember(b.assignee_name_raw, null, memberCache);
        }
      }
      // Every distinct time_logged actor AND every distinct assignee named in
      // an assignee_changed event this sprint — a developer who only ever
      // held a ticket TRANSIENTLY (neither its baseline nor current holder,
      // e.g. briefly assigned then handed off without logging — SPEC_15 §2
      // row 7 "churned_away") must still be materializable to receive a role.
      const changelog = await repos.ticketChangelog.listBySprint(s.id);
      for (const e of changelog) {
        if (e.kind === "time_logged" && e.actor_name) {
          await materializeReconstructedMember(e.actor_name, e.actor_op_id, memberCache);
          continue;
        }
        if (e.kind !== "assignee_changed") continue;
        const detail = JSON.parse(e.detail_json) as ChangelogDetail;
        if (detail.kind !== "assignee_changed") continue;
        if (detail.from) await materializeReconstructedMember(detail.from, null, memberCache);
        if (detail.to) await materializeReconstructedMember(detail.to, null, memberCache);
      }
    }
    const all = await repos.teamMembers.list();
    return all.map((m) => ({ ...m, ticket_count: countByMemberId.get(m.id) ?? 0 }));
  }

  /**
   * Record a LOCAL scope change (SPEC_05 §3/§4): a mid-sprint add/remove has no
   * OP journal, so we mint a minimal update run to satisfy the changelog's NOT
   * NULL update_run_id FK and insert one `scope_added`/`scope_removed` entry
   * with source="local", actor "Planner" (this app has no per-user session
   * identity — Phase-0 decision, SPEC_05 §9.4). The dedup_key carries the
   * timestamp so distinct actions never collide; a same-instant repeat is a
   * harmless no-op via the UNIQUE dedup_key.
   */
  async function logLocalScopeChange(
    sprintId: number,
    wpOpId: number,
    action: "add" | "remove",
    detail: ChangelogDetail,
    at: string,
  ): Promise<void> {
    const run = await repos.sprintUpdateRuns.start(sprintId, "update", "manual");
    const inserted = await repos.ticketChangelog.insertMany([
      {
        sprint_id: sprintId,
        wp_op_id: wpOpId,
        update_run_id: run.id,
        occurred_at: at,
        actor_op_id: null,
        actor_name: "Planner",
        kind: action === "add" ? "scope_added" : "scope_removed",
        detail_json: JSON.stringify(detail),
        source: "local",
        op_journal_id: null,
        dedup_key: `local:${action}:${sprintId}:${wpOpId}:${at}`,
      },
    ]);
    await repos.sprintUpdateRuns.finish(run.id, "success", 1, inserted, null, at);
  }

  /**
   * Increment 28 (§2c) — the ONE removal implementation, shared by
   * DELETE /sprints/:id/items/:wpId and both double-count bulk fixes. On an
   * ACTIVE sprint this is `removed_mid_sprint` (SPEC_05 §4: the row and its
   * already-logged hours are KEPT, only the commitment goes away) and it logs a
   * `scope_removed` changelog entry; in planning it is the plain `removed`
   * outcome. NO OpenProject call, ever.
   */
  async function removeSprintItemFromSprint(
    sprint: Awaited<ReturnType<typeof getSprintOrThrow>>,
    wpId: number,
  ): Promise<SprintItem> {
    const item = await repos.sprintItems.getBySprintAndWp(sprint.id, wpId);
    if (!item || item.outcome === "removed" || item.outcome === "removed_mid_sprint")
      fail("WORK_PACKAGE_NOT_FOUND", `WP ${wpId} not in sprint ${sprint.id}`);
    const now = nowIso();
    if (sprint.status === "active") {
      // The logged_hours in the changelog is best-effort from the cache.
      const cached = await repos.workPackages.getByOpId(wpId);
      const updated = await repos.sprintItems.setOutcome(item.id, "removed_mid_sprint", now);
      await logLocalScopeChange(
        sprint.id,
        wpId,
        "remove",
        {
          kind: "scope_removed",
          hours: item.planned_hours,
          logged_hours: cached?.spent_hours ?? null,
        },
        now,
      );
      return updated;
    }
    return repos.sprintItems.setOutcome(item.id, "removed", now);
  }

  /**
   * Increment 34 (docs/INCREMENT_34_CONTRACTS.md §5) — the ONE "add/restore a
   * ticket into a sprint" implementation, shared by POST /sprints/:id/items and
   * POST /sprints/:id/items/:wpId/carry. Resolves the estimate-of-record per the
   * TARGET sprint's own status/retrospective rules — exactly as the plain add
   * route always has: an ACTIVE sprint live-fetches the WP from OP (GET only),
   * refreshes its cache row, and captures an `added_mid_sprint` baseline; a
   * PLANNING sprint reads the local cache (or, for a retrospective sprint,
   * reconstructs it) — then creates or revives the `sprint_item` row.
   * `requestedPlannedHours` lets a caller pin an explicit `planned_hours`
   * (the plain /items route's optional body field); pass `undefined` to always
   * take the resolved estimate-of-record, which is what carry-over wants (a
   * carried 150h task with 100h remaining enters the target at 100h).
   */
  async function addSprintItem(
    sprint: Awaited<ReturnType<typeof getSprintOrThrow>>,
    wpOpId: number,
    requestedPlannedHours: number | null | undefined,
  ): Promise<SprintItem> {
    const id = sprint.id;
    const isActive = sprint.status === "active";
    const now = nowIso();

    // An item is "in the sprint" unless it's been removed (either kind). A
    // removed row is re-addable (we never delete rows — SPEC §4).
    const existing = await repos.sprintItems.getBySprintAndWp(id, wpOpId);
    if (
      existing &&
      existing.outcome !== "removed" &&
      existing.outcome !== "removed_mid_sprint"
    )
      fail("ITEM_ALREADY_IN_SPRINT", `WP ${wpOpId} already in sprint ${id}`);

    // Resolve the estimate-of-record. In a RUNNING sprint the ticket may not be
    // in the local cache yet, so read it straight from OP (GET only), refresh
    // the scoped cache, and capture a baseline otisk (SPEC_05 §4).
    let plannedEstimate: number | null;
    if (isActive) {
      // Increment 11 (SPEC_11 §1) FIX + SPEC_05 §4 reconciliation: resolve the
      // connection to fetch from FROM THE WORK PACKAGE ITSELF (its own cached
      // source_connection_id) WHEN it is already cached — a mock-only ticket
      // must hit the mock server even if the CURRENT connection (e.g. acme)
      // is disabled (the reported CONNECTION_DISABLED-on-Add bug). But a
      // GENUINELY NEW ticket added mid-sprint may not be cached yet (SPEC_05
      // §4: "dočti baseline WP z OP") — for that case, and only that case,
      // fall back to the current connection so the brand-new add still works.
      const cachedWp = await repos.workPackages.getByOpId(wpOpId);
      const { op, conn } =
        cachedWp?.connection_id != null
          ? await requireOpClientForConnection(cachedWp.connection_id)
          : await requireOpClient();
      let opWp;
      try {
        opWp = await fetchWorkPackageById(op, wpOpId);
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw mapOpError(err);
      }
      if (!opWp)
        fail("WORK_PACKAGE_NOT_FOUND", `Work package ${wpOpId} not found in OpenProject`);
      const statuses = await op.getStatuses();
      const statusById = new Map<number, OpStatus>();
      for (const s of statuses._embedded.elements) statusById.set(s.id, s);
      // Refresh the scoped cache (spentFallback null: a brand-new add has no
      // aggregated time entries yet — the next update pass fills it in).
      // Increment 22 (SPEC_22 §3.2) — connection_id is stamped at write time
      // via toWorkPackageCacheRow's required connectionId arg (Concept 5), so a
      // brand-new mid-sprint add never lands as an un-attributed "SERVER —" row.
      await repos.workPackages.upsertMany([toWorkPackageCacheRow(opWp, statusById, null, conn.id)]);
      // Baseline otisk captured at the moment of adding (origin=added_mid_sprint).
      await repos.ticketBaselines.upsertMany([
        buildBaseline(id, opWp, statusById, now, "added_mid_sprint"),
      ]);
      const override = await repos.estimateOverrides.getByWpOpId(wpOpId);
      plannedEstimate = effectiveEstimate(
        parseIsoDuration(opWp.estimatedTime),
        parseIsoDuration(opWp.remainingTime),
        override?.planning_hours ?? null,
      );
    } else if (sprint.is_retrospective) {
      // SPEC_12 §2 path C: a manual add onto a RETROSPECTIVE planning sprint
      // reconstructs the ticket to its start_date state (Work/assignee/status
      // as of that day, from OP journals) and captures a reconstructed
      // baseline — instead of reading the live cache. So a plain add-from-
      // backlog is baselined-to-start exactly like a version/id seed.
      try {
        plannedEstimate = await retroService().reconstructManualAdd(id, wpOpId);
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw mapOpError(err);
      }
    } else {
      const wp = await repos.workPackages.getByOpId(wpOpId);
      if (!wp) fail("WORK_PACKAGE_NOT_FOUND", `Work package ${wpOpId} not in cache`);
      const override = await repos.estimateOverrides.getByWpOpId(wpOpId);
      plannedEstimate = effectiveEstimate(
        wp.estimated_hours,
        wp.remaining_hours,
        override?.planning_hours ?? null,
      );
    }
    const planned = requestedPlannedHours ?? plannedEstimate;

    let item: SprintItem;
    if (existing) {
      // Re-add: origin is preserved (setOutcome doesn't touch it) — a removed
      // baseline ticket coming back counts as baseline green again; a re-added
      // mid-sprint ticket stays red.
      item = await repos.sprintItems.setOutcome(existing.id, "planned", null);
    } else {
      item = await repos.sprintItems.add({
        sprint_id: id,
        wp_op_id: wpOpId,
        planned_hours: planned,
        outcome: "planned",
        origin: isActive ? "added_mid_sprint" : "baseline",
      });
    }

    if (isActive) {
      // Un-dismiss from the backlog if it was previously removed, then log the
      // local scope_added change (no OP journal exists for a local action).
      await repos.backlogDismissals.remove([wpOpId]);
      await logLocalScopeChange(
        id,
        wpOpId,
        "add",
        { kind: "scope_added", hours: planned },
        now,
      );
    }
    return item;
  }

  return async (app: FastifyInstance): Promise<void> => {
    // ═════ Vault (SPEC_02 §3/§5). The passphrase is parsed, used, and NEVER ═══
    // ═════ echoed or logged; responses carry only the status flags.        ═══

    // ── GET /vault/status ────────────────────────────────────────────────────
    app.get("/vault/status", { config: { access: "viewer" } }, async (): Promise<VaultStatusResponse> => vault.status());

    // ── POST /vault/init — create the vault (auto-unlocks) + migrate legacy ──
    app.post("/vault/init", { config: { access: "planner" } }, async (req, reply) => {
      const body = parseOrThrow(VaultInitBody, req.body);
      await vault.init(body.passphrase);
      const res: VaultStatusResponse = await vault.status();
      return reply.code(201).send(res);
    });

    // ── POST /vault/unlock ───────────────────────────────────────────────────
    app.post("/vault/unlock", { config: { access: "planner" } }, async (req): Promise<VaultStatusResponse> => {
      const body = parseOrThrow(VaultUnlockBody, req.body);
      await vault.unlock(body.passphrase);
      return vault.status();
    });

    // ── POST /vault/lock — drop the in-memory key ────────────────────────────
    app.post("/vault/lock", { config: { access: "planner" } }, async (): Promise<VaultStatusResponse> => {
      vault.lock();
      return vault.status();
    });

    // ── POST /vault/change-passphrase — re-keys every stored token ──────────
    app.post("/vault/change-passphrase", { config: { access: "planner" } }, async (req): Promise<VaultStatusResponse> => {
      const body = parseOrThrow(VaultChangePassphraseBody, req.body);
      await vault.changePassphrase(body.old_passphrase, body.new_passphrase);
      return vault.status();
    });

    // ── POST /vault/reset — forget the vault, wipe tokens (URLs survive) ─────
    app.post("/vault/reset", { config: { access: "planner" } }, async (req): Promise<VaultResetResponse> => {
      parseOrThrow(VaultResetBody, req.body);
      return vault.reset();
    });

    // ═════ Connections (SPEC_02 §5) — multi-server registry. No response ═════
    // ═════ ever contains a token (plaintext or encrypted).               ═════

    // ── GET /connections ─────────────────────────────────────────────────────
    app.get("/connections", { config: { access: "viewer" } }, async (): Promise<ConnectionsResponse> => {
      return (await repos.connections.list()).map(toConnection);
    });

    // ── POST /connections — add a server (requires an unlocked vault) ────────
    app.post("/connections", { config: { access: "planner" } }, async (req, reply) => {
      const body = parseOrThrow(AddConnectionBody, req.body);
      if (vault.isLocked())
        fail("VAULT_LOCKED", "Unlock the vault before adding a connection");
      if (await repos.connections.getByBaseUrl(body.base_url))
        fail("CONNECTION_EXISTS", `A connection for ${body.base_url} already exists`);

      // Validate via GET /users/me. A failing probe does NOT reject — the
      // connection is stored with health "fail" (SPEC_02 §7) and no `user`.
      const { user, result } = await probeServer(body.base_url, body.token);

      // Encrypt BEFORE create(): the row only ever carries the blob.
      const blob = vault.encryptToken(body.token);
      let created: OpConnection;
      try {
        created = await repos.connections.create({
          base_url: body.base_url,
          label: body.label ?? null,
          token_ct: blob.ct,
          token_nonce: blob.nonce,
          token_tag: blob.tag,
          default_project_op_id: body.default_project_op_id ?? null,
        });
      } catch {
        // UNIQUE(base_url) — race with the pre-check above.
        fail("CONNECTION_EXISTS", `A connection for ${body.base_url} already exists`);
      }
      await healthTracker.record(created.id, result, "activity");
      const fresh = (await repos.connections.getById(created.id)) ?? created;
      const userSummary: OpUserSummary | null = user
        ? { op_id: user.id, name: user.name, ...(user.login ? { login: user.login } : {}) }
        : null;
      const res: AddConnectionResponse = {
        ...toConnection(fresh),
        ...(userSummary ? { user: userSummary } : {}),
      };
      return reply.code(201).send(res);
    });

    // ── PATCH /connections/:id — label / default project / token / current ───
    app.patch("/connections/:id", { config: { access: "planner" } }, async (req): Promise<Connection> => {
      const { id } = parseOrThrow(ConnectionIdParams, req.params);
      const body = parseOrThrow(UpdateConnectionBody, req.body);
      const existing = await repos.connections.getById(id);
      if (!existing) fail("CONNECTION_NOT_FOUND", `Connection ${id} not found`);
      if (body.label !== undefined || body.default_project_op_id !== undefined) {
        await repos.connections.update(id, {
          ...(body.label !== undefined ? { label: body.label } : {}),
          ...(body.default_project_op_id !== undefined
            ? { default_project_op_id: body.default_project_op_id }
            : {}),
        });
      }
      if (body.token !== undefined) {
        if (vault.isLocked())
          fail("VAULT_LOCKED", "Unlock the vault before replacing a token");
        // Encrypted immediately; setEncryptedToken also clears any legacy slot.
        await repos.connections.setEncryptedToken(id, vault.encryptToken(body.token));
      }
      if (body.current === true) await repos.connections.setCurrent(id);
      if (body.enabled !== undefined) {
        await repos.connections.setEnabled(id, body.enabled);
        // Push an immediate SSE update (Increment 8 §2) — enabled isn't a
        // health-probe outcome, so record() never fires for it on its own.
        healthTracker.notify();
      }
      return toConnection((await repos.connections.getById(id)) ?? existing);
    });

    // ── DELETE /connections/:id ──────────────────────────────────────────────
    app.delete("/connections/:id", { config: { access: "planner" } }, async (req): Promise<DeleteConnectionResponse> => {
      const { id } = parseOrThrow(ConnectionIdParams, req.params);
      const deleted = await repos.connections.delete(id);
      if (!deleted) fail("CONNECTION_NOT_FOUND", `Connection ${id} not found`);
      return { deleted: true };
    });

    // ── POST /connections/:id/test — run a health check NOW ─────────────────
    app.post("/connections/:id/test", { config: { access: "planner" } }, async (req): Promise<Connection> => {
      const { id } = parseOrThrow(ConnectionIdParams, req.params);
      const conn = await repos.connections.getById(id);
      if (!conn) fail("CONNECTION_NOT_FOUND", `Connection ${id} not found`);
      if (vault.isLocked())
        fail("VAULT_LOCKED", "Unlock the vault to test a connection");
      const blob = connTokenBlob(conn);
      if (!blob)
        fail(
          "NO_CONNECTION",
          `Connection ${conn.base_url} has no token stored (vault was reset?)`,
        );
      // Decrypted ad-hoc for the probe; not retained.
      const { fresh } = await testConnection(conn, vault.decryptToken(blob), "check");
      return toConnection(fresh);
    });

    // ── GET /connections/health — per-server + aggregate color ──────────────
    app.get(
      "/connections/health",
      { config: { access: "viewer" } },
      async (): Promise<ConnectionsHealthResponse> => buildHealthPayload(),
    );

    // ── GET /connections/health/stream — SSE push (SPEC_02 §5) ──────────────
    app.get("/connections/health/stream", { config: { access: "viewer" } }, (req, reply) => {
      // Long-lived stream: take over the raw socket from Fastify.
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const send = (): void => {
        void buildHealthPayload()
          .then((payload) => {
            reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
          })
          .catch(() => {
            // DB gone (shutdown) — the close handler cleans up.
          });
      };
      send(); // current state immediately
      const unsubscribe = healthTracker.onChange(send);
      const keepalive = setInterval(() => {
        reply.raw.write(": ping\n\n");
      }, 15_000);
      keepalive.unref?.();
      req.raw.on("close", () => {
        unsubscribe();
        clearInterval(keepalive);
        reply.raw.end();
      });
    });

    // ── GET /projects (from OP, across every ENABLED connection) ─────────────
    // Grouped-by-server Import picker (multi-connection): a project's op_id is
    // only unique WITHIN a server, so every project is tagged with the
    // connection it came from. With a single connection this behaves EXACTLY
    // like before (hard-fails on a locked vault / missing token / unreachable
    // OP); with 2+ connections, a single misconfigured or briefly-unreachable
    // server is skipped rather than blanking the whole picker — otherwise one
    // flaky server would hide every OTHER server's already-imported projects.
    app.get("/projects", { config: { access: "planner" } }, async () => {
      const connections = (await repos.connections.list()).filter((c) => c.enabled);
      if (connections.length === 0)
        fail("NO_CONNECTION", "No OpenProject connection configured");
      if (vault.isLocked())
        fail("VAULT_LOCKED", "The vault is locked — unlock it to talk to OpenProject");

      const existing = await repos.projects.list();
      const lastSyncedByKey = new Map(
        existing.map((p) => [`${p.connection_id}:${p.op_id}`, p.last_synced_at]),
      );
      const single = connections.length === 1;

      for (const conn of connections) {
        const blob = connTokenBlob(conn);
        if (!blob) {
          if (single)
            fail(
              "NO_CONNECTION",
              `Connection ${conn.base_url} has no token stored (vault was reset?)`,
            );
          continue;
        }
        const op = buildOpClient(conn, vault.decryptToken(blob));
        let collection;
        try {
          collection = await op.getProjects();
        } catch (err) {
          if (single) throw mapOpError(err);
          continue;
        }
        await repos.projects.upsertMany(
          collection._embedded.elements.map((p) => ({
            connection_id: conn.id,
            op_id: p.id,
            identifier: p.identifier,
            name: p.name,
            last_synced_at: lastSyncedByKey.get(`${conn.id}:${p.id}`) ?? null,
          })),
        );
      }

      const enabledIds = new Set(connections.map((c) => c.id));
      const connById = new Map(connections.map((c) => [c.id, c]));
      const res: ProjectsResponse = (await repos.projects.list())
        .filter((p) => p.connection_id != null && enabledIds.has(p.connection_id))
        .map((p) => {
          const conn = connById.get(p.connection_id!)!;
          return { ...p, connection_base_url: conn.base_url, connection_label: conn.label };
        });
      return res;
    });

    // ── POST /sync ───────────────────────────────────────────────────────────
    app.post("/sync", { config: { access: "planner" } }, async (req) => {
      const body = parseOrThrow(TriggerSyncBody, req.body ?? {});
      const running = await repos.syncRuns.current();
      // Increment 22 (SPEC_22 §1.3) — an informative 409, not a bare one. Since
      // recoverOrphaned() runs at boot, a genuinely orphaned run can no longer
      // reach this path after a restart; so when this fires now it's honest —
      // something really IS running (or went stale mid-lifetime and the 60s
      // watchdog hasn't fired yet). `runId` lets the frontend offer "Cancel it?"
      // wired to the existing POST /sync/:runId/cancel.
      if (running)
        fail(
          "SYNC_IN_PROGRESS",
          `A sync is already running (started ${running.started_at})`,
          {
            runId: running.id,
            started_at: running.started_at,
            last_progress_at: running.last_progress_at,
          },
        );
      const isRefreshAll = body.project_op_id == null;
      // Increment 29 (CONTRACTS §5): `full_refresh` is meaningful ONLY for a
      // refresh-all — for a single-project import it is ignored, exactly like
      // `connection_id` already is. Clearing a connection's watermarks from a
      // one-project call would widen the cutoff of every OTHER project on that
      // server as a side effect of importing one.
      const fullRefresh = isRefreshAll && body.full_refresh === true;

      if (!isRefreshAll) {
        // Additive import of ONE project [+version] from ONE server.
        const { op, conn } =
          body.connection_id !== undefined
            ? await requireOpClientForConnection(body.connection_id)
            : await requireOpClient();
        const engine = deps.syncEngineFactory(op);
        const projectOpId = body.project_op_id!;
        const projectName =
          (await repos.projects.getByConnectionAndOpId(conn.id, projectOpId))?.name ??
          `Project ${projectOpId}`;
        let versionName: string | null = null;
        if (body.version_op_id != null) {
          try {
            const versions = await op.getVersions(projectOpId);
            versionName =
              versions._embedded.elements.find((v) => v.id === body.version_op_id)
                ?.name ?? null;
          } catch {
            // best-effort name; the id is what matters for filtering.
          }
        }
        await repos.importSelections.upsert({
          connection_id: conn.id,
          project_op_id: projectOpId,
          project_name: projectName,
          version_op_id: body.version_op_id ?? null,
          version_name: versionName,
        });
        try {
          const run = await engine.sync({
            projectOpId,
            versionOpId: body.version_op_id ?? null,
            kind: body.kind ?? "full",
            // Increment 29 (CONTRACTS §3) — the watermark KEY. Without it every
            // connection would share one `(null, project)` watermark row and
            // server A's run would set server B's cutoff.
            connectionId: conn.id,
          });
          // packages/sync builds cache rows without connection context (SPEC_07
          // §1/§4) — stamp it here using the connection THIS sync just resolved.
          await repos.workPackages.setConnectionIdForProject(projectOpId, conn.id);
          return run;
        } catch (err) {
          if (err instanceof AppError) throw err;
          throw new AppError("SYNC_FAILED", err instanceof Error ? err.message : "sync failed");
        }
      }

      // No project → REFRESH every recorded import, EACH AGAINST THE CONNECTION
      // IT WAS IMPORTED FROM (not just whichever connection is "current" right
      // now) — otherwise refreshing a project imported from server A while
      // server B is current would silently query the wrong OP for it (the same
      // bug class as the Platform/versions 404: wrong-server data, not "OP
      // unreachable"). Legacy rows with no recorded connection (pre-migration)
      // fall back to current, matching their original single-connection era.
      type Sel = { projectOpId: number; versionOpId: number | null };
      const imports = await repos.importSelections.list();
      let bySelConn = new Map<number | null, Sel[]>();
      for (const s of imports) {
        const list = bySelConn.get(s.connection_id) ?? [];
        list.push({ projectOpId: s.project_op_id, versionOpId: s.version_op_id });
        bySelConn.set(s.connection_id, list);
      }
      if (bySelConn.size === 0) {
        const conn = await repos.connections.getCurrent();
        if (conn?.default_project_op_id != null) {
          bySelConn = new Map([
            [conn.id, [{ projectOpId: conn.default_project_op_id, versionOpId: null }]],
          ]);
        }
      }

      // Nothing imported and no default project to fall back to — this is a
      // genuine caller error (there is literally nothing to refresh), unchanged
      // from before. Every OTHER outcome below is a 200 with a per-connection
      // breakdown, never a batch-wide throw.
      if (bySelConn.size === 0)
        fail("BAD_REQUEST", "No project specified and nothing imported yet");

      // Legacy cached tickets with no recorded connection (pre-migration) are
      // attributed to the CURRENT connection — computed ONCE so a null-owner
      // ticket is only ever re-fetched by one connection group, not every one.
      const currentConn = await repos.connections.getCurrent();
      const currentConnId = currentConn?.id ?? null;
      const connById = new Map(
        (await repos.connections.list()).map((c) => [c.id, c]),
      );

      // Increment 23 (SPEC_23 §1) — per-connection isolation. A disconnected/
      // unreachable/vault-locked connection is SKIPPED and REPORTED; it must
      // NEVER abort the batch, so a single dead mock server can't stop a healthy
      // Acme connection from syncing (the confirmed CONNECTION_DISABLED 409
      // bug). `CONNECTION_DISABLED` stays fatal ONLY for a single-project sync
      // that needs that one connection — the `!isRefreshAll` branch above, which
      // still throws directly, unchanged (SPEC_23 §7 decision 2).
      //
      // Consolidation Round (Concept 9 / Escalation A): this is the deliberate
      // `isolate` half of activationScope.ts's CONNECTION_MULTI_POLICY — the
      // OPPOSITE of Activation/Update/Finish's `requireAll` gate
      // (validateNeededConnections there fails FAST if ANY needed connection is
      // down). The divergence is intentional and frozen: a refresh just re-reads
      // existing data (partial is better than none), whereas freezing/committing
      // a baseline from partial connections would be silently wrong. Do NOT
      // "align" the two paths without re-reading Escalation A.
      const outcomes: ConnectionSyncOutcome[] = [];
      let last: SyncRun | null = null;
      // An Abort click during a multi-connection refresh still stops the ENTIRE
      // remaining batch (a user cancelled the whole "Sync now"), distinct from a
      // per-connection skip/error — this flag unwinds the outer loop.
      let batchAborted = false;

      for (const [connectionId, sels] of bySelConn) {
        if (batchAborted) break;
        // The connection row this group belongs to, for labelling the outcome —
        // a null (legacy) group maps to the current connection.
        const groupConn =
          connectionId !== null ? connById.get(connectionId) ?? null : currentConn ?? null;
        const outcomeConnId = groupConn?.id ?? connectionId ?? null;
        const label = groupConn?.label ?? null;

        // Resolve the OP client. Any failure HERE is a "can't even start" — the
        // connection is disabled, has no token, the vault is locked, etc.: SKIP
        // it (never fatal to the batch). connection_id must be a valid LocalId;
        // a legacy null group with no current connection has none, so it's only
        // logged, not reported as an outcome (no valid id to attach).
        let op: OpClient;
        let conn: OpConnection;
        try {
          ({ op, conn } =
            connectionId !== null
              ? await requireOpClientForConnection(connectionId)
              : await requireOpClient());
        } catch (err) {
          const code = err instanceof AppError ? err.code : undefined;
          // VAULT_LOCKED is a GLOBAL condition (the vault holds every
          // connection's token) — it is not a property of THIS connection, so
          // silently marking one connection "skipped" for it would misreport
          // "nothing needed syncing" to the caller when actually nothing
          // COULD sync. Preserve the pre-Increment-23 contract: a locked
          // vault still hard-fails the whole "Sync now" request (423), same
          // as every other OP-facing endpoint. Only a genuinely per-connection
          // failure (disabled/unreachable) is isolated below.
          if (code === "VAULT_LOCKED") throw err;
          const message =
            code === "CONNECTION_DISABLED"
              ? "disconnected"
              : err instanceof Error
                ? err.message
                : "unreachable";
          if (outcomeConnId !== null) {
            outcomes.push({
              connection_id: outcomeConnId,
              connection_label: label,
              status: "skipped",
              run: null,
              // CONTRACTS §4.3 — nothing was attempted for this connection, so
              // there is nothing to measure. A zeroed coverage block would read
              // as "everything is stale" instead of "not measured".
              coverage: null,
              message,
            });
          } else {
            req.log.warn(
              { connectionId, message },
              "sync refresh-all: skipped a connection-less import group with no current connection",
            );
          }
          continue;
        }

        // From here a sync attempt has STARTED against a resolved connection.
        // A failure now is an "error" outcome — still isolated, never fatal to
        // the batch (SPEC_23 §1.4).
        try {
          const engine = deps.syncEngineFactory(op);

          // Increment 29 (CONTRACTS §5) — a FULL refresh drops every stored
          // watermark for this connection FIRST, so each selection's sync and
          // the coverage pass below rebuild their cutoffs from scratch and a
          // permanently-missed change cannot survive indefinitely.
          if (fullRefresh) await repos.watermarks.clearForConnection(conn.id);

          // Increment 29 (CONTRACTS §1.1) — captured BEFORE this group's first
          // engine.sync(). Everything cached at/after this instant was
          // (re)written by THIS group's pass; everything older was not, whatever
          // the reason. That empirical definition is the whole point: the
          // previous fix enumerated the known escape routes (project not in the
          // selection) and therefore missed the version-scoped one (§0a).
          //
          // Deliberately the REAL clock, not the injectable `nowIso()`: it is
          // compared against `work_package_cache.cached_at`, which the @osp/db
          // layer stamps with `new Date()`. Mixing an injected test clock with
          // the DB's real one would make the comparison meaningless.
          const groupStartedAt = new Date().toISOString();
          const groupStartedMs = Date.parse(groupStartedAt);

          let connLast: SyncRun | null = null;
          // A sub-sync that finishes as status "error" (the engine catches a
          // fetch/HTTP failure and finishes the run WITHOUT throwing) is a
          // genuine error DURING an attempted sync (SPEC_23 §1.4) — record it
          // and surface an "error" outcome, still isolated from the batch.
          let connError: string | null = null;
          for (const sel of sels) {
            // A manual sync is a FULL refresh so field changes (e.g. a changed
            // estimate) are always pulled in — incremental "updatedAt" filtering
            // can miss them depending on the OP instance.
            const run = await engine.sync({
              projectOpId: sel.projectOpId,
              versionOpId: sel.versionOpId,
              kind: "full",
              // Increment 29 (CONTRACTS §3) — watermark key (see above).
              connectionId: conn.id,
            });
            // An aborted sub-sync wrote nothing (engine rollback) — the user
            // cancelled the whole "Sync now"; stop the entire batch.
            if (run.status === "aborted") {
              batchAborted = true;
              break;
            }
            if (run.status === "error") {
              connError = run.error ?? "sync failed";
              break;
            }
            connLast = run;
            // Same connection-stamping as the single-project path above.
            await repos.workPackages.setConnectionIdForProject(sel.projectOpId, conn.id);
          }

          if (connError !== null) {
            if (outcomeConnId !== null) {
              outcomes.push({
                connection_id: outcomeConnId,
                connection_label: label,
                status: "error",
                run: null,
                // Increment 29 (CONTRACTS §4.3) — no coverage for an error
                // outcome: nothing measurable was completed, and a zeroed block
                // would read as "everything is stale" rather than "not measured".
                coverage: null,
                message: connError,
              });
            }
            continue;
          }

          // ── Increment 29 (CONTRACTS §1.3) — THE COVERAGE PASS ──────────────
          // Replaces the hand-rolled one-by-one "orphans" loop that used to live
          // here. That loop asked only "is this row's PROJECT in the selection?",
          // which is why the version-scoped hole survived it: a row whose project
          // IS selected but whose version is NOT was filtered out by the
          // paginated sync AND considered already-covered by the orphans pass, so
          // no run ever fetched it again (CONTRACTS §0a — the confirmed #11948
          // "48 week-old rows"). The rule below is empirical instead of
          // enumerative, so a future FOURTH escape route needs no new code:
          // anything this connection owns that wasn't re-cached by this group's
          // syncs is stale, whatever the reason, and gets fetched by id.
          //
          // "Tickets added by id" and "tickets in a sprint" deliberately have NO
          // special case (CONTRACTS §1.4): they are cache rows, so they are
          // covered by construction. Adding an "always in scope" list back would
          // recreate exactly the enumerative reasoning that produced the bug.
          //
          // What is preserved verbatim from the old loop: abort ⇒ the engine
          // rolls back and `batchAborted` unwinds the whole outer batch; the
          // sync_run is never left unfinished; hard-cancel works — except that
          // registering the AbortController is now `syncByOpIds`'s own job
          // (CONTRACTS §2), not this route's, which also kills the old N+1
          // one-OP-request-per-orphan fetch.
          let orphanOpIds: number[] = [];
          if (!batchAborted) {
            const stale = (await repos.workPackages.find({})).filter(
              (w) =>
                (w.connection_id ?? currentConnId) === conn.id &&
                Date.parse(w.cached_at) < groupStartedMs,
            );
            if (stale.length > 0) {
              const result = await engine.syncByOpIds(stale.map((w) => w.op_id));
              if (result.run?.status === "aborted") {
                // The engine already dropped its staging rows and finished the
                // run — nothing was written. Unwind the batch, same as a
                // cancelled selection sync above.
                batchAborted = true;
              } else if (result.run?.status === "error") {
                connError = result.run.error ?? "coverage sync failed";
              } else {
                // packages/sync builds rows with connection_id null (it only
                // ever sees a pre-built OpClient) — stamp the connection THIS
                // group resolved, exactly as the per-project path does.
                if (result.refreshedOpIds.length > 0)
                  await repos.workPackages.setConnectionIdForOpIds(
                    result.refreshedOpIds,
                    conn.id,
                  );
                orphanOpIds = result.missingOpIds;
                if (result.run) connLast = result.run;
              }
            }
          }

          if (connError !== null) {
            if (outcomeConnId !== null) {
              outcomes.push({
                connection_id: outcomeConnId,
                connection_label: label,
                status: "error",
                run: null,
                coverage: null,
                message: connError,
              });
            }
            continue;
          }

          // ── Increment 29 (CONTRACTS §4.1) — coverage, RECOUNTED FROM THE DB ─
          // Never accumulated in a JS variable while fetching. A count derived
          // from "what we believe we sent" is precisely the reporting that let
          // this bug hide behind `status: success` for weeks; the database is
          // the only witness that can contradict the code.
          let coverage: SyncCoverage | null = null;
          if (!batchAborted) {
            const owned = (await repos.workPackages.find({})).filter(
              (w) => (w.connection_id ?? currentConnId) === conn.id,
            );
            const refreshed = owned.filter(
              (w) => Date.parse(w.cached_at) >= groupStartedMs,
            ).length;
            const oldest = owned.reduce<string | null>(
              (min, w) =>
                min === null || Date.parse(w.cached_at) < Date.parse(min)
                  ? w.cached_at
                  : min,
              null,
            );
            coverage = {
              total_cached: owned.length,
              refreshed,
              not_refreshed: owned.length - refreshed,
              // CONTRACTS §4.2 — REPORTED, never auto-deleted. A row hidden by
              // OP permissions is indistinguishable from a deleted one, and
              // hard-deleting the user's sprint history on a guess is not a
              // recoverable mistake. Deletion is the user's explicit action
              // (POST /backlog/out-of-selection/delete).
              orphan_op_ids: orphanOpIds,
              oldest_cached_at: oldest,
            };
            if (orphanOpIds.length > 0) {
              req.log.warn(
                {
                  connectionId: conn.id,
                  count: orphanOpIds.length,
                  opIds: orphanOpIds.slice(0, 20),
                },
                "sync coverage: cached tickets OpenProject no longer returns " +
                  "(orphan candidates) — REPORTED, not deleted (CONTRACTS §4.2)",
              );
            }
            if (coverage.not_refreshed > 0) {
              req.log.warn(
                {
                  connectionId: conn.id,
                  not_refreshed: coverage.not_refreshed,
                  total_cached: coverage.total_cached,
                  oldest_cached_at: coverage.oldest_cached_at,
                },
                "sync coverage: some cached tickets were NOT refreshed by this run",
              );
            }
          }

          if (outcomeConnId !== null) {
            outcomes.push({
              connection_id: outcomeConnId,
              connection_label: label,
              status: batchAborted ? "error" : "synced",
              run: batchAborted ? null : connLast,
              coverage: batchAborted ? null : coverage,
              message: batchAborted ? "sync cancelled" : "synced",
            });
          }
          if (!batchAborted && connLast && connLast.status === "success") last = connLast;
        } catch (err) {
          if (outcomeConnId !== null) {
            outcomes.push({
              connection_id: outcomeConnId,
              connection_label: label,
              status: "error",
              run: null,
              coverage: null,
              message: err instanceof Error ? err.message : "sync failed",
            });
          }
          continue;
        }
      }

      // Increment 22 (SPEC_22 §3.4) — surface, don't silently drop. Every
      // refresh group above claims a ticket via `w.connection_id ?? currentConnId`.
      // A cached row whose connection_id is STILL null after the 0018 backfill
      // + write-time stamping AND with no current connection to fall back to
      // (currentConnId null — no connections at all) belongs to no group and
      // vanishes from every re-fetch. Rare, but the spec requires it be
      // reported rather than skipped in silence.
      const unresolved = (await repos.workPackages.find({})).filter(
        (w) => (w.connection_id ?? currentConnId) === null,
      );
      if (unresolved.length > 0) {
        req.log.warn(
          {
            count: unresolved.length,
            opIds: unresolved.slice(0, 20).map((w) => w.op_id),
          },
          "sync refresh-all: cached tickets with no resolvable connection_id " +
            "were skipped (SPEC_22 §3.4) — no connection owns them and none is current",
        );
      }

      // Increment 29 (CONTRACTS §5) — `SyncKind` is deliberately NOT extended
      // with a fourth value (it is a closed enum the UI switches on); this flag
      // is how a caller tells the daily/on-demand full refresh from a "Sync now".
      const res: SyncRefreshAllResponse = {
        connections: outcomes,
        last,
        full_refresh: fullRefresh,
      };
      return res;
    });

    // ── GET /versions?projectId&connectionId — versions of one project (OP) ──
    app.get("/versions", { config: { access: "planner" } }, async (req) => {
      const raw = (req.query ?? {}) as Record<string, string | undefined>;
      if (raw.projectId === undefined) fail("BAD_REQUEST", "projectId is required");
      const projectOpId = Number(raw.projectId);
      // Which server projectId belongs to — omit for the current connection
      // (back-compat; a project's own connection_id is the correct value once
      // the multi-server picker knows it, since op ids repeat across servers).
      const { op } =
        raw.connectionId !== undefined
          ? await requireOpClientForConnection(Number(raw.connectionId))
          : await requireOpClient();
      let collection;
      try {
        collection = await op.getVersions(projectOpId);
      } catch (err) {
        // Real OpenProject 404s a project's versions sub-resource when the
        // Backlogs/versions module isn't enabled for that project, rather than
        // returning an empty collection — this is a legitimate "no versions
        // here", not an unreachable server. Degrade to an empty list so the
        // Import screen still works (version filter is optional); any other
        // status still maps to a real error.
        if (err instanceof OpHttpError && err.status === 404) {
          return [] satisfies VersionsResponse;
        }
        throw mapOpError(err);
      }
      const res: VersionsResponse = collection._embedded.elements.map((v) => ({
        op_id: v.id,
        name: v.name,
      }));
      return res;
    });

    // ── GET /imports — recorded additive import selections ───────────────────
    app.get("/imports", { config: { access: "planner" } }, async () => {
      const [selections, connections] = await Promise.all([
        repos.importSelections.list(),
        repos.connections.list(),
      ]);
      const connById = new Map(connections.map((c) => [c.id, c]));
      const res: ImportsResponse = selections.map((s) => {
        const conn = s.connection_id !== null ? connById.get(s.connection_id) : undefined;
        return {
          ...s,
          connection_base_url: conn?.base_url ?? null,
          connection_label: conn?.label ?? null,
        };
      });
      return res;
    });

    // ── DELETE /imports/:id — forget an import + cascade to the local backlog ─
    // Never touches the connected OP server (local-only, like /backlog/remove).
    // Cascade rule: removes backlog tickets no longer covered by any remaining
    // import selection for that (connection, project), INCLUDING tickets in a
    // still-"planning" sprint — but NEVER a ticket in an active or closed/
    // historical sprint (SPEC: those stay untouched regardless).
    app.delete("/imports/:id", { config: { access: "planner" } }, async (req): Promise<RemoveImportResponse> => {
      const { id } = parseOrThrow(ImportIdParams, req.params);
      const sel = await repos.importSelections.getById(id);
      if (!sel) fail("IMPORT_NOT_FOUND", `Import ${id} not found`);
      await repos.importSelections.delete(id);

      // What's still covered by a REMAINING selection for the same (connection,
      // project) — an "all versions" selection covers everything; otherwise
      // only the specific versions still recorded stay covered.
      const remaining = (await repos.importSelections.list()).filter(
        (s) => s.connection_id === sel.connection_id && s.project_op_id === sel.project_op_id,
      );
      const keepsAllVersions = remaining.some((s) => s.version_op_id === null);
      const keptVersionIds = new Set(
        remaining.filter((s) => s.version_op_id !== null).map((s) => s.version_op_id),
      );

      const candidates = keepsAllVersions
        ? []
        : (await repos.workPackages.find({ projectOpId: sel.project_op_id })).filter((wp) => {
            if (wp.version_op_id != null && keptVersionIds.has(wp.version_op_id)) return false;
            // A version-scoped import only owns tickets of THAT version.
            if (sel.version_op_id !== null) return wp.version_op_id === sel.version_op_id;
            return true;
          });
      const candidateOpIds = candidates.map((wp) => wp.op_id);

      // Split by sprint membership: active/closed-and-still-in-grace sprint
      // membership is untouchable, regardless of outcome (a removed_mid_sprint
      // ticket in an active sprint still keeps its logged-time history —
      // SPEC_05). Increment 31 (docs/INCREMENT_31_CONTRACTS.md §3) narrows the
      // old "active || closed" rule to "active || (closed && !frozen)" — a
      // FROZEN closed sprint reads every number from its own `frozen_*`
      // snapshot (§0/§2c), so deleting its cache rows is provably harmless;
      // only the post-finish GRACE WINDOW (closed, not yet frozen) still needs
      // the live cache and stays protected.
      const items = await repos.sprintItems.findByWpOpIds(candidateOpIds);
      const sprints = await repos.sprints.list();
      const sprintById = new Map(sprints.map((s) => [s.id, s]));
      const protects = (sprintId: number): boolean => {
        const s = sprintById.get(sprintId);
        if (!s) return false;
        return s.status === "active" || (s.status === "closed" && s.frozen_at === null);
      };
      const protectedOpIds = new Set(
        items.filter((it) => protects(it.sprint_id)).map((it) => it.wp_op_id),
      );
      const planningItemIds = items
        .filter(
          (it) => sprintById.get(it.sprint_id)?.status === "planning" && !protectedOpIds.has(it.wp_op_id),
        )
        .map((it) => it.id);

      const removableOpIds = candidateOpIds.filter((opId) => !protectedOpIds.has(opId));

      await repos.sprintItems.deleteMany(planningItemIds);
      await repos.workPackages.deleteMany(removableOpIds);
      await repos.backlogDismissals.remove(removableOpIds);

      return {
        deleted: true,
        removed_ticket_count: removableOpIds.length,
        protected_ticket_count: protectedOpIds.size,
      };
    });

    // ── POST /work-packages — add a single ticket to the backlog by OP id ────
    // Fetches exactly one work package from OP via a GET id-filter and caches it.
    app.post("/work-packages", { config: { access: "planner" } }, async (req, reply) => {
      const body = parseOrThrow(ImportWorkPackageBody, req.body);
      const { op, conn } = await requireOpClient();
      const engine = deps.syncEngineFactory(op);
      let wp;
      try {
        wp = await engine.importWorkPackage(body.op_id);
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw mapOpError(err);
      }
      if (!wp)
        fail(
          "WORK_PACKAGE_NOT_FOUND",
          `Work package ${body.op_id} not found in OpenProject`,
        );
      // packages/sync builds the cache row without connection context; stamp it
      // here so a later multi-connection "Sync now" refreshes it from the RIGHT
      // server (re-upsert on the same op_id — a no-op besides this one field).
      await repos.workPackages.upsertMany([{ ...wp, connection_id: conn.id }]);
      // Explicitly adding a ticket un-hides it if it was previously removed.
      await repos.backlogDismissals.remove([body.op_id]);
      return reply.code(201).send(wp);
    });

    // ── POST /snapshot — burndown snapshots for every ACTIVE sprint ──────────
    // The nightly job body on demand (SPEC_03 §6: lets the scenario mock's
    // advance-day helper grow a burndown day-by-day). Date defaults to today.
    app.post("/snapshot", { config: { access: "planner" } }, async (req) => {
      const body = parseOrThrow(TriggerSnapshotBody, req.body ?? {});
      const date = body.date ?? deps.now().toISOString().slice(0, 10);
      const { op } = await requireOpClient();
      const writer = deps.snapshotWriterFactory(op);
      await writer.writeSnapshotsForActiveSprints(date);
      const active = await repos.sprints.listByStatus("active");
      const res: SnapshotResponse = { date, active_sprints: active.length };
      return res;
    });

    // ── GET /sync/status ─────────────────────────────────────────────────────
    app.get("/sync/status", { config: { access: "viewer" } }, async () => {
      const current = await repos.syncRuns.current();
      const last = await repos.syncRuns.latest();
      // Local data only — reads the current connection's default project but
      // does NOT call OP, so it works with a locked vault too.
      const conn = await repos.connections.getCurrent();
      let lastSyncedAt: string | null = null;
      // Prefer the default project's last sync; otherwise the most recently synced
      // project; otherwise fall back to the latest successful sync run. Without
      // this fallback the header showed "never" whenever no default project was set.
      if (conn?.default_project_op_id != null) {
        const p = await repos.projects.getByOpId(conn.default_project_op_id);
        lastSyncedAt = p?.last_synced_at ?? null;
      }
      if (lastSyncedAt == null) {
        const synced = (await repos.projects.list())
          .map((p) => p.last_synced_at)
          .filter((d): d is string => d != null)
          .sort();
        lastSyncedAt = synced.at(-1) ?? null;
      }
      if (lastSyncedAt == null && last?.status === "success") {
        lastSyncedAt = last.finished_at;
      }
      // Increment 19 (SPEC_19 §2b): live elapsed for the running sync, computed
      // fresh from the one source of truth (started_at); null when idle.
      const res: SyncStatusResponse = {
        current,
        last,
        last_synced_at: lastSyncedAt,
        current_elapsed_ms: current ? Date.now() - Date.parse(current.started_at) : null,
      };
      return res;
    });

    // ── POST /sync/:runId/cancel ─────────────────────────────────────────────
    // Increment 19 (SPEC_19 §2c): request cancellation of a running sync. The
    // engine's page loop observes cancel_requested and rolls back (writes
    // nothing) before flipping to "aborted". Idempotent — safe if the run
    // already finished (returns the row unchanged); 404 for an unknown id.
    app.post("/sync/:runId/cancel", { config: { access: "planner" } }, async (req): Promise<CancelSyncResponse> => {
      const raw = (req.params ?? {}) as Record<string, string | undefined>;
      const runId = Number(raw.runId);
      if (!Number.isInteger(runId) || runId <= 0)
        fail("BAD_REQUEST", "runId must be a positive integer");
      // Increment 20 (SPEC_20 §2/§3): the DB flag alone never interrupted a
      // hung request. ALSO physically abort whatever OP request is in flight
      // for this run — idempotent, returns false if nothing's registered
      // (already finished / unknown id). Both, not either/or.
      hardCancelRun(runId);
      const run = await repos.syncRuns.requestCancel(runId);
      if (!run) fail("NOT_FOUND", `Sync run ${runId} not found`);
      return run;
    });

    // ── Shared backlog visibility (Increment 19, SPEC_19 §3) ─────────────────
    // The SINGLE source of the "currently-visible backlog given a filter subset"
    // rules — cache find() + connectionId post-filter + enrichment +
    // HIDDEN_BACKLOG_STATUSES + local-dismissal exclusion. Both GET /backlog and
    // GET /backlog/filter-options call this so an option offered by the latter is
    // guaranteed to yield rows in the former (no zero-result options). Does NOT
    // apply hasEstimate — that's a non-facet post-filter GET /backlog layers on.
    async function visibleBacklog(f: BacklogFilterOptionsQuery): Promise<BacklogItem[]> {
      // Increment 23 (SPEC_23 §2): the connection-safe assignee/version match.
      // A `*Key` (`${connection_id}:${op_id}`) takes precedence over the legacy
      // bare-id field and scopes the id to ITS connection, so id 3 on the mock
      // never matches id 3 on Acme. A malformed key falls back to the legacy
      // field. `assignee`/`version` (bare id, no key) keep the old behaviour.
      const aKey = f.assigneeKey ? parseFilterKey(f.assigneeKey) : null;
      const vKey = f.versionKey ? parseFilterKey(f.versionKey) : null;
      const assigneeOpId = aKey ? aKey.id : f.assignee;
      const versionOpId = vKey ? vKey.id : f.version;
      // Both keys carry a connection; a WP row has exactly ONE connection, so if
      // they disagree nothing can match (return the empty set rather than
      // silently applying just one). Otherwise the single connection constraint
      // is whichever key(s) supplied it.
      let keyConn: number | null | undefined = undefined;
      if (aKey && vKey) {
        if (aKey.connectionId !== vKey.connectionId) return [];
        keyConn = aKey.connectionId;
      } else if (aKey) keyConn = aKey.connectionId;
      else if (vKey) keyConn = vKey.connectionId;

      let wps = await repos.workPackages.find({
        ...(f.projectId !== undefined ? { projectOpId: f.projectId } : {}),
        ...(f.status ? { statusName: f.status } : {}),
        ...(assigneeOpId ? { assigneeOpId } : {}),
        ...(versionOpId ? { versionOpId } : {}),
        ...(keyConn !== undefined ? { connectionId: keyConn } : {}),
        ...(f.priority ? { priority: f.priority } : {}),
      });
      if (f.connectionId !== undefined) {
        wps = wps.filter((w) => w.connection_id === f.connectionId);
      }
      const projectNameByOpId = new Map(
        (await repos.projects.list()).map((p) => [p.op_id, p.name]),
      );
      const connById = new Map((await repos.connections.list()).map((c) => [c.id, c]));
      const opIds = wps.map((w) => w.op_id);
      const overrides = await repos.estimateOverrides.getManyByWpOpIds(opIds);
      const ovById = new Map(overrides.map((o) => [o.wp_op_id, o]));
      const items = await repos.sprintItems.findByWpOpIds(opIds);
      const sprints = await repos.sprints.list();
      const statusById = new Map(sprints.map((s) => [s.id, s.status]));
      const inSprint = new Set(
        items
          .filter(
            (it) =>
              it.outcome !== "removed" &&
              it.outcome !== "removed_mid_sprint" &&
              statusById.get(it.sprint_id) !== "closed",
          )
          .map((it) => it.wp_op_id),
      );
      let result: BacklogItem[] = wps.map((w) => {
        const override = ovById.get(w.op_id)?.planning_hours ?? null;
        const conn = w.connection_id !== null ? connById.get(w.connection_id) : undefined;
        return {
          ...w,
          project_name: projectNameByOpId.get(w.project_op_id) ?? null,
          override_hours: override,
          effective_hours: effectiveEstimate(w.estimated_hours, w.remaining_hours, override),
          in_sprint: inSprint.has(w.op_id),
          connection_base_url: conn?.base_url ?? null,
          connection_label: conn?.label ?? null,
          stale: conn === undefined ? false : !conn.enabled || conn.last_status === "fail",
        };
      });
      result = result.filter(
        (r) => !HIDDEN_BACKLOG_STATUSES.has((r.status_name ?? "").trim().toLowerCase()),
      );
      const dismissed = new Set(await repos.backlogDismissals.listOpIds());
      result = result.filter((r) => !dismissed.has(r.op_id));
      return result;
    }

    // ── GET /backlog/filter-options (Increment 19, SPEC_19 §1/§3) ────────────
    // CASCADING options: each facet is computed from the visible backlog with
    // every OTHER active filter applied but that facet's OWN field dropped, so
    // an option can never produce zero rows for the current combination.
    app.get("/backlog/filter-options", { config: { access: "viewer" } }, async (req) => {
      const raw = (req.query ?? {}) as Record<string, string | undefined>;
      const q = parseOrThrow(BacklogFilterOptionsQuery, {
        projectId: raw.projectId !== undefined ? Number(raw.projectId) : undefined,
        status: raw.status,
        assignee: raw.assignee !== undefined ? Number(raw.assignee) : undefined,
        version: raw.version !== undefined ? Number(raw.version) : undefined,
        assigneeKey: raw.assigneeKey,
        versionKey: raw.versionKey,
        priority: raw.priority,
        connectionId: raw.connectionId !== undefined ? Number(raw.connectionId) : undefined,
      });
      // Cascading: drop a facet's OWN field(s) — including its Increment-23
      // `*Key` companion — so the option list is never narrowed by the value
      // already selected for that same facet.
      const [forProjects, forStatuses, forAssignees, forVersions, forPriorities, forServers] =
        await Promise.all([
          visibleBacklog({ ...q, projectId: undefined }),
          visibleBacklog({ ...q, status: undefined }),
          visibleBacklog({ ...q, assignee: undefined, assigneeKey: undefined }),
          visibleBacklog({ ...q, version: undefined, versionKey: undefined }),
          visibleBacklog({ ...q, priority: undefined }),
          visibleBacklog({ ...q, connectionId: undefined }),
        ]);
      // Increment 21 (SPEC_21 §3.4) — case-insensitive/trimmed dedup pojistka:
      // the write-side canonicalization (Agent A) is the primary fix, but a
      // future write bug must not silently reintroduce a visible duplicate
      // ("in progress" vs "In progress") in the filter dropdown. Dedup on the
      // trimmed/lower-cased key, keeping the FIRST actual value seen (which,
      // post-canonicalization, is the canonical spelling) as the representative.
      const uniqStr = (xs: (string | null)[]): string[] => {
        const byKey = new Map<string, string>();
        for (const x of xs) {
          if (x == null) continue;
          const trimmed = x.trim();
          if (trimmed === "") continue;
          const key = trimmed.toLowerCase();
          if (!byKey.has(key)) byKey.set(key, trimmed);
        }
        return [...byKey.values()].sort((a, b) => a.localeCompare(b));
      };
      // Increment 23 (SPEC_23 §2): dedup by the connection-safe `key`
      // (`${connection_id}:${op_id}`, or `none:${op_id}` for a legacy
      // connection-less row), NOT by bare `id`. Two people sharing a numeric
      // OP id across servers (Alan Turing@mock / Cameron Dalby@Acme, both
      // id 3) now yield TWO distinct entries instead of silently merging into
      // one — the fix for both the "Cameron missing from the dropdown" and
      // the cross-server data-leak halves of the bug.
      type FilterOptionEntry = BacklogFilterOptionsResponse["assignees"][number];
      const optionEntries = (
        rows: BacklogItem[],
        getId: (w: BacklogItem) => number | null,
        getName: (w: BacklogItem) => string | null,
      ): FilterOptionEntry[] => {
        const byKey = new Map<string, FilterOptionEntry>();
        for (const w of rows) {
          const id = getId(w);
          if (id == null) continue;
          const key = `${w.connection_id ?? "none"}:${id}`;
          if (!byKey.has(key))
            byKey.set(key, {
              id,
              name: getName(w) ?? String(id),
              key,
              connection_id: w.connection_id,
              connection_label: w.connection_label ?? w.connection_base_url ?? null,
            });
        }
        return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
      };
      // servers: one entry per distinct connection_id in the (connectionId-
      // dropped) visible set, labelled label ?? base_url (already enriched onto
      // the item by visibleBacklog).
      const serverName = new Map<number, string>();
      for (const w of forServers) {
        if (w.connection_id != null && !serverName.has(w.connection_id))
          serverName.set(
            w.connection_id,
            w.connection_label ?? w.connection_base_url ?? String(w.connection_id),
          );
      }
      const res: BacklogFilterOptionsResponse = {
        projects: uniqStr(forProjects.map((w) => w.project_name)),
        statuses: uniqStr(forStatuses.map((w) => w.status_name)),
        assignees: optionEntries(
          forAssignees,
          (w) => w.assignee_op_id,
          (w) => w.assignee_name,
        ),
        versions: optionEntries(
          forVersions,
          (w) => w.version_op_id,
          (w) => w.version_name,
        ),
        priorities: uniqStr(forPriorities.map((w) => w.priority)),
        servers: [...serverName.entries()]
          .map(([id, name]) => ({ id, name }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
      return res;
    });

    // ── GET /backlog (from cache) ────────────────────────────────────────────
    app.get("/backlog", { config: { access: "viewer" } }, async (req) => {
      // Query params arrive as strings; BacklogQuery expects numeric OpIds.
      const raw = (req.query ?? {}) as Record<string, string | undefined>;
      const q = parseOrThrow(BacklogQuery, {
        projectId: raw.projectId !== undefined ? Number(raw.projectId) : undefined,
        status: raw.status,
        assignee: raw.assignee !== undefined ? Number(raw.assignee) : undefined,
        version: raw.version !== undefined ? Number(raw.version) : undefined,
        assigneeKey: raw.assigneeKey,
        versionKey: raw.versionKey,
        priority: raw.priority,
        hasEstimate: raw.hasEstimate,
        connectionId: raw.connectionId !== undefined ? Number(raw.connectionId) : undefined,
      });
      // projectId omitted → union across ALL imported projects (additive
      // backlog). Visibility (find + connection filter + enrichment + hidden-
      // statuses + dismissal) is the SHARED helper GET /backlog/filter-options
      // uses, so options and the list can never disagree.
      let result = await visibleBacklog(q);
      if (q.hasEstimate === true)
        result = result.filter((r) => r.effective_hours !== null);
      if (q.hasEstimate === false)
        result = result.filter((r) => r.effective_hours === null);
      return result;
    });

    // ── Out-of-selection cleanup (Increment 29, CONTRACTS §6) ────────────────
    /**
     * A cached row is IN SELECTION when some import_selection S satisfies
     *   S.connection ≡ R.connection ∧ S.project = R.project
     *   ∧ (S.version IS NULL  ∨  S.version = R.version)
     * Note the version ASYMMETRY — the same one that caused the coverage bug
     * (CONTRACTS §0a): a project-wide selection covers EVERY version, a
     * version-scoped one covers only its own. A row matching no such S is out
     * of selection: nothing will ever refresh it through an import again, so it
     * sits in the cache forever unless the coverage pass keeps re-fetching it.
     *
     * Returns the predicate plus the resolved current-connection fallback, so
     * the listing and the delete endpoint can never drift apart.
     */
    async function outOfSelectionContext(): Promise<{
      currentConnId: number | null;
      inSelection: (row: WorkPackageCache) => boolean;
    }> {
      const currentConn = await repos.connections.getCurrent();
      const currentConnId = currentConn?.id ?? null;
      const selections = await repos.importSelections.list();
      return {
        currentConnId,
        inSelection: (row) => {
          const owner = row.connection_id ?? currentConnId;
          return selections.some(
            (s) =>
              (s.connection_id ?? currentConnId) === owner &&
              s.project_op_id === row.project_op_id &&
              (s.version_op_id === null || s.version_op_id === row.version_op_id),
          );
        },
      };
    }

    /**
     * PROTECTION (CONTRACTS §6, revised by Increment 31 —
     * docs/INCREMENT_31_CONTRACTS.md §3): a ticket referenced by a
     * `sprint_item` in a NON-FROZEN sprint — planning, active, or closed
     * still within its grace window — protects it from deletion. A FROZEN
     * closed sprint (`frozen_at != null`) no longer protects: every number it
     * reports comes from its own `sprint_item.frozen_*` snapshot (§0/§2c), so
     * deleting the underlying `work_package_cache` row is PROVABLY harmless —
     * invariant 10 (CAPACITY_BAR_RULES §6) exists precisely to guarantee this.
     * Returns BOTH buckets (protecting vs. frozen-only) per op_id, so callers
     * can render/re-validate the `protected` rule while still surfacing the
     * frozen membership informationally (`in_sprint`/`frozen_sprint_names`).
     * Deliberately WIDER in the "protecting" sense than the DELETE /imports/:id
     * cascade (which does delete planning-sprint items): that one is undoing a
     * specific import the user just asked to forget; this is a bulk cache
     * sweep where a wrong guess is unrecoverable.
     */
    async function sprintNamesByOpId(
      opIds: number[],
    ): Promise<{ protecting: Map<number, string[]>; frozen: Map<number, string[]> }> {
      const protecting = new Map<number, string[]>();
      const frozen = new Map<number, string[]>();
      if (opIds.length === 0) return { protecting, frozen };
      const items = await repos.sprintItems.findByWpOpIds(opIds);
      if (items.length === 0) return { protecting, frozen };
      const sprintById = new Map((await repos.sprints.list()).map((s) => [s.id, s]));
      for (const it of items) {
        const s = sprintById.get(it.sprint_id);
        if (s === undefined) continue;
        const bucket = s.frozen_at !== null ? frozen : protecting;
        const list = bucket.get(it.wp_op_id) ?? [];
        if (!list.includes(s.name)) list.push(s.name);
        bucket.set(it.wp_op_id, list);
      }
      return { protecting, frozen };
    }

    // ── GET /backlog/out-of-selection ────────────────────────────────────────
    app.get("/backlog/out-of-selection", { config: { access: "planner" } }, async (): Promise<OutOfSelectionResponse> => {
      const { currentConnId, inSelection } = await outOfSelectionContext();
      const rows = (await repos.workPackages.find({})).filter((w) => !inSelection(w));
      const [projects, connections, sprintNameInfo] = await Promise.all([
        repos.projects.list(),
        repos.connections.list(),
        sprintNamesByOpId(rows.map((w) => w.op_id)),
      ]);
      // Project names are connection-scoped (`op_id` repeats across servers),
      // with a bare-op_id fallback for legacy rows that predate connection
      // attribution — same shape as everywhere else in this file.
      const projectByKey = new Map(
        projects.map((p) => [`${p.connection_id ?? "none"}:${p.op_id}`, p.name]),
      );
      const projectByOpId = new Map(projects.map((p) => [p.op_id, p.name]));
      const connById = new Map(connections.map((c) => [c.id, c]));

      const entries: OutOfSelectionEntry[] = rows.map((w) => {
        const owner = w.connection_id ?? currentConnId;
        const protectingNames = sprintNameInfo.protecting.get(w.op_id) ?? [];
        const frozenNames = sprintNameInfo.frozen.get(w.op_id) ?? [];
        return {
          op_id: w.op_id,
          subject: w.subject,
          project_op_id: w.project_op_id,
          project_name:
            projectByKey.get(`${owner ?? "none"}:${w.project_op_id}`) ??
            projectByOpId.get(w.project_op_id) ??
            null,
          version_op_id: w.version_op_id,
          version_name: w.version_name,
          connection_id: w.connection_id,
          connection_label:
            (w.connection_id !== null ? connById.get(w.connection_id) : undefined)?.label ??
            null,
          cached_at: w.cached_at,
          updated_at_op: w.updated_at_op,
          // Informational — member of SOME sprint, protecting or frozen alike.
          in_sprint: protectingNames.length > 0 || frozenNames.length > 0,
          sprint_names: protectingNames,
          frozen_sprint_names: frozenNames,
          // THE deletability rule (Increment 31, §3).
          protected: protectingNames.length > 0,
        };
      });
      entries.sort((a, b) => a.op_id - b.op_id);
      return {
        entries,
        total: entries.length,
        protected_count: entries.filter((e) => e.protected).length,
      };
    });

    // ── POST /backlog/out-of-selection/delete ────────────────────────────────
    // LOCAL ONLY. Deletes `work_package_cache` rows — never writes to
    // OpenProject (the read-only invariant is not relaxed by a delete
    // endpoint), and never touches sprint items, baselines, changelogs or
    // closure data: everything a sprint references is protected, so that holds
    // by construction rather than by a caller remembering to filter.
    //
    // DISTINCT from POST /backlog/remove, which only records a *dismissal* (the
    // row stays cached, hidden from the backlog view). Do not merge them.
    app.post("/backlog/out-of-selection/delete", { config: { access: "planner" } }, async (req) => {
      const body = parseOrThrow(DeleteOutOfSelectionBody, req.body);
      const { inSelection } = await outOfSelectionContext();
      // Re-validate EVERY id server-side: the client's list can be stale by the
      // time it posts (a sprint may have claimed a ticket, an import may have
      // re-covered it). Partial success is the NORMAL outcome and is a 200.
      const requested = [...new Set(body.op_ids)];
      const cached = await repos.workPackages.getManyByOpIds(requested);
      const cachedByOpId = new Map(cached.map((w) => [w.op_id, w]));
      // Increment 31 (docs/INCREMENT_31_CONTRACTS.md §3): re-validation uses
      // the SAME `protected` rule as the GET listing — a ticket whose only
      // sprint membership is a FROZEN sprint is deletable; only `protecting`
      // (non-frozen) membership blocks it.
      const sprintNameInfo = await sprintNamesByOpId(requested);

      const removed: number[] = [];
      const protectedEntries: DeleteOutOfSelectionResponse["protected"] = [];
      const rejected: DeleteOutOfSelectionResponse["rejected"] = [];
      for (const opId of requested) {
        const names = sprintNameInfo.protecting.get(opId) ?? [];
        if (names.length > 0) {
          protectedEntries.push({ op_id: opId, sprint_names: names });
          continue;
        }
        const row = cachedByOpId.get(opId);
        if (row === undefined) {
          rejected.push({ op_id: opId, reason: "not_cached" });
          continue;
        }
        if (inSelection(row)) {
          rejected.push({ op_id: opId, reason: "in_selection" });
          continue;
        }
        removed.push(opId);
      }
      await repos.workPackages.deleteMany(removed);
      // A deleted row can no longer be "dismissed from the backlog" — drop the
      // dismissal too, so re-importing the ticket later behaves like a fresh one.
      await repos.backlogDismissals.remove(removed);
      const res: DeleteOutOfSelectionResponse = {
        removed,
        protected: protectedEntries,
        rejected,
      };
      return res;
    });

    // ── POST /backlog/remove — hide work packages from the backlog (local) ────
    // Purely local: records a dismissal so these op ids stop showing in the
    // backlog. Never touches OpenProject. The WPs stay cached.
    app.post("/backlog/remove", { config: { access: "planner" } }, async (req) => {
      const body = parseOrThrow(RemoveFromBacklogBody, req.body);
      await repos.backlogDismissals.add(body.wp_op_ids);
      const res: RemoveFromBacklogResponse = { removed: body.wp_op_ids.length };
      return res;
    });

    // ── POST /estimate-override ──────────────────────────────────────────────
    app.post("/estimate-override", { config: { access: "planner" } }, async (req, reply) => {
      const body = parseOrThrow(CreateEstimateOverrideBody, req.body);
      const saved = await repos.estimateOverrides.upsert({
        wp_op_id: body.wp_op_id,
        planning_hours: body.planning_hours,
        note: body.note ?? null,
      });
      return reply.code(201).send(saved);
    });

    // ── GET /sprints ─────────────────────────────────────────────────────────
    app.get("/sprints", { config: { access: "viewer" } }, async () => repos.sprints.list());

    // ── POST /sprints ────────────────────────────────────────────────────────
    app.post("/sprints", { config: { access: "planner" } }, async (req, reply) => {
      const body = parseOrThrow(CreateSprintBody, req.body);
      const created = await repos.sprints.create({
        name: body.name,
        start_date: body.start_date,
        end_date: body.end_date,
        status: "planning",
        capacity_mode: body.capacity_mode,
      });
      return reply.code(201).send(created);
    });

    // ── PATCH /sprints/:id ───────────────────────────────────────────────────
    app.patch("/sprints/:id", { config: { access: "planner" } }, async (req) => {
      const { id } = parseOrThrow(SprintIdParams, req.params);
      const body = parseOrThrow(UpdateSprintBody, req.body);
      const sprint = await getSprintOrThrow(id);
      if (sprint.is_locked)
        fail("SPRINT_LOCKED", `Sprint "${sprint.name}" is locked`, { sprintName: sprint.name });

      // Activation shortcut (SPEC_04): status→active from planning delegates to
      // the lifecycle engine so activation captures a ticket_baseline + first
      // burndown point — this is how the unchanged "Activate" button (a PATCH)
      // gets baseline capture for free. If OP isn't reachable (no connection /
      // locked vault) we fall back to a plain status flip so activation still
      // works offline; any OTHER fields in the body are applied normally.
      if (body.status === "active" && sprint.status === "planning") {
        const op = await tryOpClient();
        if (op) {
          try {
            if (sprint.is_retrospective) {
              // SPEC_12 §2: activating a retro sprint is a day-by-day REPLAY.
              // The PATCH path has no progress polling, so run it SYNCHRONOUSLY
              // (awaited) then return the resulting sprint. runReplay finishes
              // its own run and, on error, leaves the sprint in "planning".
              const run = await repos.sprintUpdateRuns.start(id, "activation", "manual");
              await retroService().runReplay(id, run.id);
              const after = await repos.sprints.getById(id);
              if (after && after.status === "planning") {
                // Replay failed → surface the run's error instead of a silent no-op.
                const latest = await repos.sprintUpdateRuns.latestBySprint(id);
                throw new AppError("INTERNAL", latest?.error ?? "retro replay failed");
              }
            } else {
              // SPEC_10 §e: the lifecycle scopes to the sprint's own connections;
              // tryOpClient() above still gates the offline fallback (a plain
              // status flip) when OP is unreachable at all.
              await deps
                .sprintLifecycleFactory({ buildClientForConnection: buildTimeoutClientForConnection })
                .activate(id);
            }
          } catch (err) {
            if (err instanceof AppError) throw err;
            throw mapOpError(err);
          }
          const { status: _status, ...rest } = body;
          if (Object.keys(rest).length > 0) await repos.sprints.update(id, rest);
          return (await repos.sprints.getById(id)) ?? sprint;
        }
      }
      return repos.sprints.update(id, body);
    });

    // ── DELETE /sprints/:id (SPEC_11 §2) — hard delete + cascade ──────────────
    // Works in EVERY status (planning/active/closed/locked): an intentional
    // destructive escape hatch (client confirms a yes/no modal), distinct from
    // the closed-sprint EDIT immutability. Deletes all dependent history in one
    // transaction and NEVER touches OP (read-only invariant holds). Lets the
    // user repeatedly re-create + re-test a sprint against the mock.
    app.delete("/sprints/:id", { config: { access: "planner" } }, async (req): Promise<DeleteSprintResponse> => {
      const { id } = parseOrThrow(SprintIdParams, req.params);
      await getSprintOrThrow(id); // 404 if it doesn't exist
      // SPEC_12 §6: write a full JSON snapshot BEFORE the cascade — a cheap
      // insurance policy after the Increment-11 data-loss incident. If the
      // export write fails, the whole delete fails (throw) — NEVER delete
      // without a successful export first.
      let exportPath: string;
      try {
        exportPath = await writeSprintExport(
          { repos, buildCapacity: buildCapacityResponse, now: deps.now, ...deps.sprintExport },
          id,
        );
      } catch (err) {
        throw new AppError(
          "INTERNAL",
          `Pre-delete export failed; sprint NOT deleted: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      await repos.sprints.deleteWithCascade(id);
      return { sprint_id: id, deleted: true, export_path: exportPath };
    });

    // ── POST /sprints/:id/reactivate (SPEC_11 §8b) — reverse a lock ───────────
    // Only for a LOCKED sprint (else 409) whose window still contains today
    // (start_date ≤ today ≤ end_date, else 409) — a deliberate, date-gated,
    // audited escape hatch that softens Increment 4's "lock is irreversible".
    // Records a sprint_update_run (kind="reactivate") as the who/when audit
    // trail; runs NO scoped OP fetch (pure state flip, so it never contacts OP).
    app.post("/sprints/:id/reactivate", { config: { access: "planner" } }, async (req): Promise<ReactivateSprintResponse> => {
      const { id } = parseOrThrow(SprintIdParams, req.params);
      const body = parseOrThrow(ReactivateSprintBody, req.body ?? {});
      const sprint = await getSprintOrThrow(id);
      if (!sprint.is_locked) {
        // No dedicated error code in the frozen registry — CONFLICT (409) with a
        // machine-readable reason the frontend can branch on.
        fail("CONFLICT", `Sprint "${sprint.name}" is not locked`, {
          reason: "SPRINT_NOT_LOCKED",
          sprintName: sprint.name,
        });
      }
      // "now" via the same injected clock the scheduler/auto-lock use (mirrors
      // the real-clock-vs-scenario-calendar pattern) — compare date-only,
      // inclusive of both endpoints (ISO YYYY-MM-DD string compare is safe).
      const today = nowIso().slice(0, 10);
      if (today < sprint.start_date || today > sprint.end_date) {
        fail(
          "CONFLICT",
          `Sprint "${sprint.name}" can only be reactivated between ${sprint.start_date} and ${sprint.end_date}`,
          { reason: "REACTIVATE_WINDOW_CLOSED", sprintName: sprint.name },
        );
      }
      const triggeredBy = body.triggered_by ?? "manual";
      // Audit marker: a pure who/when record, no scoped fetch (started/finished
      // both "now", success). This is the sprint's reactivation trail.
      const run = await repos.sprintUpdateRuns.start(id, "reactivate", triggeredBy);
      await repos.sprintUpdateRuns.finish(run.id, "success", null, null, null, nowIso());
      return repos.sprints.reactivate(id);
    });

    // ── POST /sprints/:id/items ──────────────────────────────────────────────
    // ── GET /sprints/:id/items — items of ONE sprint (per-sprint membership) ──
    app.get("/sprints/:id/items", { config: { access: "viewer" } }, async (req) => {
      const { id } = parseOrThrow(SprintIdParams, req.params);
      await getSprintOrThrow(id);
      return repos.sprintItems.listBySprint(id);
    });

    // ── GET /sprints/:id/items/detailed — items ENRICHED for board rendering ─
    // SPEC_07 §5: sourced from work_package_cache DIRECTLY (never the backlog
    // dismissal filter), with a ticket_baseline fallback for an active/closed
    // sprint whose cache row is gone. See the SprintItemDetail contract doc.
    app.get("/sprints/:id/items/detailed", { config: { access: "viewer" } }, async (req) => {
      const { id } = parseOrThrow(SprintIdParams, req.params);
      return buildSprintItemsDetailed(id);
    });

    app.post("/sprints/:id/items", { config: { access: "planner" } }, async (req, reply) => {
      const { id } = parseOrThrow(SprintIdParams, req.params);
      const body = parseOrThrow(AddSprintItemBody, req.body);
      const sprint = await getSprintOrThrow(id);
      if (sprint.status === "closed")
        fail("SPRINT_CLOSED", `Sprint "${sprint.name}" is closed`, { sprintName: sprint.name });
      // Locked ⟹ closed (close() sets both), so SPRINT_CLOSED already fires
      // above; this documents the lifecycle lock and is forward-compatible.
      if (sprint.is_locked)
        fail("SPRINT_LOCKED", `Sprint "${sprint.name}" is locked`, { sprintName: sprint.name });

      const item = await addSprintItem(sprint, body.wp_op_id, body.planned_hours);
      return reply.code(201).send(item);
    });

    // ── POST /sprints/:id/items/:wpId/carry (Increment 34 §5) ────────────────
    // Carry an unfinished ticket from a (typically closed/locked/frozen) SOURCE
    // sprint into a chosen open TARGET sprint. The source is NEVER mutated —
    // its item keeps whatever outcome it already has, which is the entire
    // point (a closed sprint's ticket_baseline/changelog history must stay
    // intact). The target-side add reuses `addSprintItem` — the SAME
    // implementation POST /sprints/:id/items uses — so a `planning` target
    // gets a normal baseline add (local cache read, remaining-preferring
    // estimate) and an `active` target gets the existing mid-sprint-add path
    // (OP GET, `added_mid_sprint` origin, baseline captured now, `scope_added`
    // changelog entry) — byte-identical to a manual re-add there.
    app.post("/sprints/:id/items/:wpId/carry", { config: { access: "planner" } }, async (req, reply): Promise<CarrySprintItemResponse> => {
      const { id, wpId } = parseOrThrow(SprintItemParams, req.params);
      const body = parseOrThrow(CarrySprintItemBody, req.body);

      // Source: any status is a valid carry-FROM sprint — closed/locked/frozen
      // are all fine, carrying never mutates it. The item just has to exist
      // and not already be removed (same "in the sprint" test every other
      // items route uses).
      const source = await getSprintOrThrow(id);
      const sourceItem = await repos.sprintItems.getBySprintAndWp(id, wpId);
      if (
        !sourceItem ||
        sourceItem.outcome === "removed" ||
        sourceItem.outcome === "removed_mid_sprint"
      )
        fail("WORK_PACKAGE_NOT_FOUND", `WP ${wpId} not in sprint ${id}`);

      if (body.target_sprint_id === id)
        fail("CONFLICT", `Target sprint must differ from source sprint "${source.name}"`, {
          sprintName: source.name,
        });

      const target = await getSprintOrThrow(body.target_sprint_id);
      if (target.status !== "planning" && target.status !== "active")
        fail(
          "CONFLICT",
          `Sprint "${target.name}" is not open for carry-over (status: ${target.status})`,
          { sprintName: target.name, reason: "TARGET_NOT_OPEN" },
        );
      if (target.is_locked)
        fail("SPRINT_LOCKED", `Sprint "${target.name}" is locked`, { sprintName: target.name });
      if (target.frozen_at !== null)
        fail(
          "SPRINT_FROZEN",
          `Sprint "${target.name}" is frozen — reactivate it to unfreeze`,
          { sprintName: target.name },
        );

      // Undefined ⟹ addSprintItem always resolves the target's own current
      // estimate-of-record (remaining-preferring) — never the source's.
      await addSprintItem(target, wpId, undefined);
      const res: CarrySprintItemResponse = {
        carried: true,
        target_sprint_id: target.id,
        wp_op_id: wpId,
      };
      return reply.code(201).send(res);
    });

    // ── POST /sprints/:id/items/by-id (SPEC_25) — retroactive add by OP id ────
    // Add a ticket to a sprint DIRECTLY by its OP id, ALWAYS live-fetched from OP
    // (bypassing backlog/cache/filters/version/status — the intended target is a
    // done/tested "overnight AU" ticket that finished before it ever surfaced in
    // the backlog). Its sprint membership is BACKDATED to when the work actually
    // happened (earliest time-entry spentOn, else the ticket's createdAt), so the
    // burndown/capacity/closure numbers reflect reality, not "today".
    // origin="added_retroactively" (counts as a red "±Change" mid-sprint bump,
    // never Planned — Increment 16/17 already handle it, scopeCapacity.ts).
    app.post("/sprints/:id/items/by-id", { config: { access: "planner" } }, async (req, reply) => {
      const { id } = parseOrThrow(SprintIdParams, req.params);
      const body = parseOrThrow(AddSprintItemByIdBody, req.body);
      const sprint = await getSprintOrThrow(id);
      if (sprint.status === "closed")
        fail("SPRINT_CLOSED", `Sprint "${sprint.name}" is closed`, { sprintName: sprint.name });
      // Locked ⟹ immutable (Increment 4). Unlike the plain /items handler we
      // enrich `details` with a Reactivate hint: this endpoint is user-facing at
      // BOTH planning and active stages and SPEC_25 §3/§4 wants "use Reactivate"
      // surfaced. `reactivatable` tells the frontend (Agent C) whether the
      // Reactivate escape hatch is even open (its window still contains today —
      // same date gate POST /sprints/:id/reactivate enforces, SPEC_11 §8b).
      if (sprint.is_locked) {
        const today = nowIso().slice(0, 10);
        fail(
          "SPRINT_LOCKED",
          `Sprint "${sprint.name}" is locked — reactivate it to add tickets`,
          {
            sprintName: sprint.name,
            hint: "reactivate",
            reactivatable: today >= sprint.start_date && today <= sprint.end_date,
          },
        );
      }

      const now = nowIso();

      // Dup guard: an item is "in the sprint" unless removed (either kind); a
      // removed row is re-addable — mirror the plain /items handler exactly.
      const existing = await repos.sprintItems.getBySprintAndWp(id, body.wp_op_id);
      if (
        existing &&
        existing.outcome !== "removed" &&
        existing.outcome !== "removed_mid_sprint"
      )
        fail("ITEM_ALREADY_IN_SPRINT", `WP ${body.wp_op_id} already in sprint ${id}`);

      // Connection policy — deliberately SIMPLER than /items: ALWAYS either the
      // explicit body.connection_id or the current default. We do NOT infer it
      // from a pre-cached row's source_connection_id (the whole point of this
      // endpoint is that the ticket is NOT in the cache/backlog yet). A
      // disconnected explicit target surfaces CONNECTION_DISABLED (Increment 23
      // §7.2 — legitimately fatal here), thrown inside
      // requireOpClientForConnection; we deliberately don't swallow it.
      const { op, conn } =
        body.connection_id !== undefined
          ? await requireOpClientForConnection(body.connection_id)
          : await requireOpClient();

      // Live-fetch the WP by id — ALWAYS from OP, regardless of sprint status.
      let opWp;
      try {
        opWp = await fetchWorkPackageById(op, body.wp_op_id);
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw mapOpError(err);
      }
      if (!opWp)
        fail("WORK_PACKAGE_NOT_FOUND", `Work package ${body.wp_op_id} not found in OpenProject`);

      // Backdate (SPEC_25 §4): earliest logged spentOn ⟹ "first_time_entry",
      // else the ticket's own createdAt ⟹ "created_at". sprint_item.added_at
      // stores an ISO instant; the burndown gate below compares DATE-ONLY
      // (slice(0,10)), so the time component is cosmetic — we anchor a time-entry
      // day at START-of-day (T00:00:00Z), i.e. "scope existed from the beginning
      // of the day the work started", consistent with the changelog's "(as of
      // DD/MM/YYYY)" phrasing.
      let earliestSpentOn: string | null;
      try {
        earliestSpentOn = await fetchEarliestTimeEntryDate(op, body.wp_op_id);
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw mapOpError(err);
      }
      let backdatedIso: string;
      let retroSource: "first_time_entry" | "created_at";
      if (earliestSpentOn !== null) {
        backdatedIso = `${earliestSpentOn}T00:00:00Z`;
        retroSource = "first_time_entry";
      } else {
        // createdAt is optional on OpWorkPackage; a WP with neither logged time
        // NOR a known createdAt is degenerate — fall back to `now` so added_at
        // (NOT NULL) is never null (the honest "unknown day, recorded now").
        backdatedIso = opWp.createdAt ?? now;
        retroSource = "created_at";
      }

      // Ingest this ticket's ENTIRE logged-time history as time_logged changelog
      // rows (Phase-2 integration fix, SPEC_25 §2/§8 "developer pálil čas →
      // červený segment ... v Delivered"): the normal per-sprint update pass
      // (sprintUpdate.ts) only ever ingests entries with `spentOn >=
      // activatedAt`, which would silently drop EVERY entry on a retroactively-
      // added ticket (its whole point is logging that predates the sprint).
      // Without this, closureStats/developerSegments sees zero logged hours for
      // the developer and misclassifies the segment `idle` (grey) instead of the
      // promised RED `acquired` — found live by Agent D's e2e during Phase 2.
      // Reuses the EXACT dedup_key convention sprintUpdate.ts uses
      // (`s<sprintId>:time_entry:<entryId>`) so a later ordinary "Update Sprint"
      // pass can never double-insert these rows.
      const wpTimeEntries = await fetchAllTimeEntries(op, {
        filters: [
          { entity_type: { operator: "=", values: ["WorkPackage"] } },
          { entity_id: { operator: "=", values: [String(body.wp_op_id)] } },
        ],
      });
      if (wpTimeEntries.length > 0) {
        const nameResolver = createUserNameResolver(op);
        const logRun = await repos.sprintUpdateRuns.start(id, "update", "manual");
        const logRows = [];
        for (const e of wpTimeEntries) {
          const actorHref = e._links.user.href;
          const actorOpId = parseOpId(actorHref);
          const actorName =
            actorHref === null
              ? null
              : (e._links.user.title ??
                (actorOpId !== null
                  ? ((await nameResolver.resolve(actorOpId)) ?? unknownUserLabel(actorOpId))
                  : null));
          logRows.push({
            sprint_id: id,
            wp_op_id: body.wp_op_id,
            update_run_id: logRun.id,
            occurred_at: e.createdAt ?? `${e.spentOn}T12:00:00Z`,
            actor_op_id: actorOpId,
            actor_name: actorName,
            kind: "time_logged" as const,
            detail_json: JSON.stringify({
              kind: "time_logged",
              hours: parseIsoDuration(e.hours) ?? 0,
              spent_on: e.spentOn,
            }),
            source: "time_entry" as const,
            op_journal_id: null,
            dedup_key: `s${id}:time_entry:${e.id}`,
          });
        }
        const logInserted = await repos.ticketChangelog.insertMany(logRows);
        await repos.sprintUpdateRuns.finish(logRun.id, "success", 1, logInserted, null, now);
      }

      // Refresh the scoped cache + stamp connection_id (Increment 22: never leave
      // an un-attributed "SERVER —" row) + capture a baseline otisk. captured_at
      // is `now` (real wall-clock when we recorded it), NOT the backdated day:
      // this reads the ticket's CURRENT (already-done) state, it does not
      // reconstruct historical state — only sprint_item.added_at is backdated.
      const statuses = await op.getStatuses();
      const statusById = new Map<number, OpStatus>();
      for (const s of statuses._embedded.elements) statusById.set(s.id, s);
      await repos.workPackages.upsertMany([toWorkPackageCacheRow(opWp, statusById, null, conn.id)]);
      await repos.ticketBaselines.upsertMany([
        buildBaseline(id, opWp, statusById, now, "added_retroactively"),
      ]);

      // Estimate-of-record: effectiveEstimate. A done ticket has remaining=0, so
      // the Increment-16 rule falls back to Work (how much got burned) — exactly
      // what SPEC_25 §2 wants; no change to estimate.ts needed.
      const override = await repos.estimateOverrides.getByWpOpId(body.wp_op_id);
      const planned = effectiveEstimate(
        parseIsoDuration(opWp.estimatedTime),
        parseIsoDuration(opWp.remainingTime),
        override?.planning_hours ?? null,
      );

      let item;
      if (existing) {
        // Re-add a previously-removed row: setOutcome preserves origin/added_at,
        // so we don't rewrite the history of a row that was baseline/mid-sprint.
        item = await repos.sprintItems.setOutcome(existing.id, "planned", null);
      } else {
        item = await repos.sprintItems.add({
          sprint_id: id,
          wp_op_id: body.wp_op_id,
          planned_hours: planned,
          outcome: "planned",
          origin: "added_retroactively",
          added_at: backdatedIso,
          retro_source: retroSource,
        });
      }

      // Un-dismiss from the backlog + ALWAYS log the scope change (a deliberate
      // difference from /items, which only logs when active): SPEC_25 §4 wants an
      // audit trail even for a planning-stage retroactive add. backdated_to
      // carries the real day for the "(as of DD/MM/YYYY)" phrasing; actor_name is
      // "Planner" (the app's established local-change convention).
      await repos.backlogDismissals.remove([body.wp_op_id]);
      await logLocalScopeChange(
        id,
        body.wp_op_id,
        "add",
        { kind: "scope_added", hours: planned, backdated_to: backdatedIso.slice(0, 10) },
        now,
      );

      // Burndown backdating — the genuinely new capability, only meaningful for an
      // ACTIVE sprint (a planning sprint has no committed burndown yet).
      // rebuildBurndown is now origin-aware: an added_retroactively item only
      // counts from its own added_at day onward, so the scope bump lands on the
      // RIGHT day, not today.
      if (sprint.status === "active") {
        await retroService().rebuildBurndown(id);
      }

      return reply.code(201).send(item);
    });

    // ── DELETE /sprints/:id/items/:wpId ──────────────────────────────────────
    app.delete("/sprints/:id/items/:wpId", { config: { access: "planner" } }, async (req) => {
      const { id, wpId } = parseOrThrow(SprintItemParams, req.params);
      const sprint = await getSprintOrThrow(id);
      if (sprint.status === "closed")
        fail("SPRINT_CLOSED", `Sprint "${sprint.name}" is closed`, { sprintName: sprint.name });
      if (sprint.is_locked)
        fail("SPRINT_LOCKED", `Sprint "${sprint.name}" is locked`, { sprintName: sprint.name });
      // Local scope reduction (SPEC_05 §4): on an active sprint this marks
      // removed_mid_sprint — the row is NEVER deleted; already-logged hours stay
      // counted in burndown/velocity (packages/sync's computeSnapshot). NO OP
      // call at all. Increment 28 §2c moved the body into
      // `removeSprintItemFromSprint` so the bulk double-count fixes reuse the
      // exact same semantics instead of re-implementing them.
      return removeSprintItemFromSprint(sprint, wpId);
    });

    // ── POST /sprints/:id/double-count/remove-parents ─────────────────────────
    // ── POST /sprints/:id/double-count/remove-children ────────────────────────
    // Increment 28 (INCREMENT_28_CONTRACTS §2c) — the one-click fix for a
    // parent/child collision inside one sprint. Both go through the EXISTING
    // removal path (`removeSprintItemFromSprint`), so on an ACTIVE sprint the
    // rows become `removed_mid_sprint` and keep their logged hours (SPEC_05) —
    // never a hard delete that would lose history. Allowed in `planning` and
    // `active`; 409 SPRINT_LOCKED on a locked sprint (Increment 4 immutability)
    // and 409 SPRINT_CLOSED on a closed one (same guard the DELETE route uses).
    // Detection is read from the SAME builder the board renders, so the server
    // can never remove a ticket the user wasn't shown as flagged.
    const doubleCountFix = async (
      req: FastifyRequest,
      side: "parents" | "children",
    ): Promise<DoubleCountFixResponse> => {
      const { id } = parseOrThrow(SprintIdParams, req.params);
      const body = parseOrThrow(DoubleCountFixBody, req.body ?? {});
      const sprint = await getSprintOrThrow(id);
      // Contracts §2c names SPRINT_LOCKED explicitly for a locked sprint, and
      // `finish` sets BOTH is_locked and status=closed — so the lock is checked
      // FIRST here (unlike DELETE /items/:wpId, which reports SPRINT_CLOSED for
      // that same sprint). Both are 409; this is only about which code the
      // client sees for the case the contract names.
      if (sprint.is_locked)
        fail("SPRINT_LOCKED", `Sprint "${sprint.name}" is locked`, { sprintName: sprint.name });
      if (sprint.status === "closed")
        fail("SPRINT_CLOSED", `Sprint "${sprint.name}" is closed`, { sprintName: sprint.name });

      const before = await buildSprintItemsDetailed(id);
      const flagged = before
        .filter((it) =>
          side === "parents"
            ? it.double_count_children.length > 0
            : it.double_count_parent_of !== null,
        )
        .map((it) => it.op_id);
      // An explicit subset may only NARROW the flagged set — it can never be
      // used to remove an unrelated ticket through this endpoint.
      const requested = body.wp_op_ids ? new Set(body.wp_op_ids) : null;
      const targets = requested ? flagged.filter((wpId) => requested.has(wpId)) : flagged;

      const removed: number[] = [];
      for (const wpId of targets) {
        await removeSprintItemFromSprint(sprint, wpId);
        removed.push(wpId);
      }
      return { removed_wp_op_ids: removed, items: await buildSprintItemsDetailed(id) };
    };

    app.post("/sprints/:id/double-count/remove-parents", { config: { access: "planner" } }, async (req) =>
      doubleCountFix(req, "parents"),
    );
    app.post("/sprints/:id/double-count/remove-children", { config: { access: "planner" } }, async (req) =>
      doubleCountFix(req, "children"),
    );

    // ── PUT /sprints/:id/capacity ────────────────────────────────────────────
    // ── GET /sprints/:id/capacity — read persisted capacity + computed lines ──
    app.get("/sprints/:id/capacity", { config: { access: "viewer" } }, async (req) => {
      const { id } = parseOrThrow(SprintIdParams, req.params);
      await getSprintOrThrow(id);
      return buildCapacityResponse(id, mayContactOp(req));
    });

    app.put("/sprints/:id/capacity", { config: { access: "planner" } }, async (req) => {
      const { id } = parseOrThrow(SprintIdParams, req.params);
      const body = parseOrThrow(SetCapacityBody, req.body);
      const sprint = await getSprintOrThrow(id);
      // SPEC_13 §6: a RETROSPECTIVE sprint's capacity is a reconstructed
      // historical figure, not a live commitment — it stays editable regardless
      // of status/lock (edits are audited below). A NORMAL sprint's rule is
      // UNCHANGED: capacity is defined during planning, locked once it leaves it.
      if (!sprint.is_retrospective) {
        if (sprint.is_locked)
          fail("SPRINT_LOCKED", `Sprint "${sprint.name}" is locked`, { sprintName: sprint.name });
        if (sprint.status !== "planning") {
          fail(
            "SPRINT_NOT_PLANNING",
            `Capacity can only be changed while sprint "${sprint.name}" is in planning (status: ${sprint.status})`,
            { sprintName: sprint.name },
          );
        }
      }
      // SPEC_13 §6: audit capacity edits made on a retro sprint AFTER planning
      // (the only case the guard above lets through in a non-planning state).
      const auditThisEdit = sprint.is_retrospective && sprint.status !== "planning";
      const capacityBefore = auditThisEdit ? await repos.capacities.listBySprint(id) : [];
      if (body.capacity_mode && body.capacity_mode !== sprint.capacity_mode) {
        await repos.sprints.update(id, { capacity_mode: body.capacity_mode });
      }
      // Resolve each entry to a team member id, auto-provisioning one per OP user
      // (deduped by op_user_id) so the frontend can set capacity per assignee.
      // SPEC_11 §4: a provisioned member's name is resolved (body → op.getUser →
      // readable "Unknown user (<id>)"), NEVER fabricated as "User <id>".
      const nameResolver = createUserNameResolver(await tryOpClient());
      const rows: { sprint_id: number; member_id: number; available_hours: number; pto_days: number }[] = [];
      for (const m of body.members) {
        let memberId = m.member_id ?? null;
        if (memberId == null && m.op_user_id != null) {
          const existing = await repos.teamMembers.getByOpUserId(m.op_user_id);
          const tm =
            existing ??
            (await repos.teamMembers.upsert({
              op_user_id: m.op_user_id,
              name:
                m.name ??
                (await nameResolver.resolve(m.op_user_id)) ??
                unknownUserLabel(m.op_user_id),
              default_hours_per_day: 8,
            }));
          memberId = tm.id;
        }
        if (memberId == null) continue;
        rows.push({ sprint_id: id, member_id: memberId, available_hours: m.available_hours, pto_days: m.pto_days });
      }
      await repos.capacities.replaceForSprint(id, rows);
      // SPEC_13 §6: record the diff (before/after available_hours + pto_days per
      // member) for a post-planning retro edit — the audit trail this uniquely
      // allows past the normal capacity lock.
      if (auditThisEdit) {
        const beforeByMember = new Map(capacityBefore.map((c) => [c.member_id, c]));
        const afterByMember = new Map(rows.map((r) => [r.member_id, r]));
        const changes: Record<
          number,
          {
            available_hours: { from: number | null; to: number | null };
            pto_days: { from: number | null; to: number | null };
          }
        > = {};
        for (const memberId of new Set([...beforeByMember.keys(), ...afterByMember.keys()])) {
          const b = beforeByMember.get(memberId);
          const a = afterByMember.get(memberId);
          const fromAvail = b?.available_hours ?? null;
          const toAvail = a?.available_hours ?? null;
          const fromPto = b?.pto_days ?? null;
          const toPto = a?.pto_days ?? null;
          if (fromAvail !== toAvail || fromPto !== toPto) {
            changes[memberId] = {
              available_hours: { from: fromAvail, to: toAvail },
              pto_days: { from: fromPto, to: toPto },
            };
          }
        }
        await repos.capacityEditAudits.add({ sprint_id: id, changes_json: JSON.stringify(changes) });
      }
      return buildCapacityResponse(id);
    });

    // ── GET /sprints/:id/capacity-audit (SPEC_13 §6) ─────────────────────────
    // The trail of capacity edits made after a retrospective sprint left
    // planning (empty for a normal sprint, which can never make such an edit).
    app.get("/sprints/:id/capacity-audit", { config: { access: "viewer" } }, async (req) => {
      const { id } = parseOrThrow(SprintIdParams, req.params);
      await getSprintOrThrow(id);
      const res: CapacityAuditResponse = await repos.capacityEditAudits.listBySprint(id);
      return res;
    });

    // ── GET /sprints/:id/off-sprint-time (Increment 32, INCREMENT_32_CONTRACTS §4)
    // "What are the developers ACTUALLY working on" — read-only, works with a
    // locked vault (stored rows only, no OP call on this path).
    app.get("/sprints/:id/off-sprint-time", { config: { access: "viewer" } }, async (req): Promise<OffSprintTimeResponse> => {
      const { id } = parseOrThrow(SprintIdParams, req.params);
      return buildOffSprintTimeResponse(id);
    });

    // ── GET /sprints/:id/people (SPEC_13 §1a, REVISED) ───────────────────────
    // EVERY person holding retro-reconstructed work in the sprint, with summed
    // hours, ticket count, and op_user_id when known (null is normal, not a
    // filter). NOT gated on sprint status or is_retrospective — readable in any
    // state ([] naturally for a non-retro sprint, whose baselines carry no
    // assignee_name_raw). No OP mutation, GET-only.
    app.get("/sprints/:id/people", { config: { access: "viewer" } }, async (req) => {
      const { id } = parseOrThrow(SprintIdParams, req.params);
      await getSprintOrThrow(id);
      const res: SprintPeopleResponse = await buildSprintPeople(id, mayContactOp(req));
      return res;
    });

    // ── User name aliases (SPEC_13 §1a) — connection-scoped journal→user map ──
    // Alias management is intentionally NOT gated on any sprint state (they're
    // connection-scoped and apply retroactively across sprints). Resolution
    // happens fresh at read time, so a new alias immediately re-buckets that
    // name's hours on the next capacity/preview/people read.
    app.get("/user-aliases", { config: { access: "viewer" } }, async (req) => {
      const { connectionId } = parseOrThrow(
        z.object({ connectionId: z.coerce.number().int().positive() }),
        req.query,
      );
      const res: UserAliasesResponse = await repos.userNameAliases.listByConnection(connectionId);
      return res;
    });

    app.post("/user-aliases", { config: { access: "planner" } }, async (req) => {
      // The frozen contract's zod .refine() already guarantees at least one of
      // op_user_id / merge_into_name is present (a request satisfying neither
      // 400s at the parse layer), so no extra check is needed here.
      const body = parseOrThrow(CreateUserAliasBody, req.body);
      // Thin mapping table: the connection must exist, but op_user_id is NOT
      // required to be an already-cached user (an alias may target a user OP has
      // but the app hasn't cached yet) — SPEC_13 §1a: don't over-validate.
      const conn = await repos.connections.getById(body.connection_id);
      if (!conn)
        fail("CONNECTION_NOT_FOUND", `Connection ${body.connection_id} not found`);
      // Duplicate (connection_id, journal_name) UPSERTs the target rather than
      // 409ing — correcting a mistaken alias by re-posting is reasonable UX.
      // Both escape hatches (op_user_id pin, merge_into_name fold) are persisted.
      const res: UserAliasResponse = await repos.userNameAliases.upsert({
        connection_id: body.connection_id,
        journal_name: body.journal_name,
        op_user_id: body.op_user_id,
        merge_into_name: body.merge_into_name,
      });
      return res;
    });

    app.delete("/user-aliases/:id", { config: { access: "planner" } }, async (req) => {
      const { id } = parseOrThrow(
        z.object({ id: z.coerce.number().int().positive() }),
        req.params,
      );
      const deleted = await repos.userNameAliases.delete(id);
      return { deleted };
    });

    // ═════ Increment 14 (SPEC_14 §2) — people roles + role-aware done matrix ══

    // ── GET /api/people — every person seen in sprint work, role + ticket_count.
    app.get("/people", { config: { access: "viewer" } }, async (): Promise<PeopleResponse> => buildPeople());

    // ── PUT /api/people/:id/role — the ONLY way a person's role changes. ──────
    app.put("/people/:id/role", { config: { access: "planner" } }, async (req): Promise<TeamMember> => {
      const { id } = parseOrThrow(PersonIdParams, req.params);
      const body = parseOrThrow(SetPersonRoleBody, req.body);
      const existing = await repos.teamMembers.getById(id);
      if (!existing) fail("NOT_FOUND", `Person ${id} not found`);
      return repos.teamMembers.setRole(id, body.role);
    });

    // ── GET/PUT /api/done-rules — the GLOBAL role-aware done matrix (§2). ──────
    app.get("/done-rules", { config: { access: "viewer" } }, async (): Promise<DoneRulesResponse> => repos.doneRules.list());

    app.put("/done-rules", { config: { access: "planner" } }, async (req): Promise<DoneRulesResponse> => {
      const body = parseOrThrow(UpdateDoneRulesBody, req.body);
      return repos.doneRules.replace(body.rules);
    });

    // ── GET/PUT /api/config — the app-level settings singleton (Increment 31,
    // docs/INCREMENT_31_CONTRACTS.md §3). Reads/writes `report_config`
    // directly — no OP calls, so this works with a locked vault (unlike almost
    // everything else in this file, there is no `requireOpClient()` here).
    app.get("/config", { config: { access: "viewer" } }, async (): Promise<AppConfigResponse> => {
      const cfg = await repos.reportConfig.get();
      return {
        overshoot_threshold_pct: cfg.overshoot_threshold_pct,
        freeze_grace_days: cfg.freeze_grace_days,
      };
    });

    app.put("/config", { config: { access: "planner" } }, async (req): Promise<AppConfigResponse> => {
      const body = parseOrThrow(UpdateAppConfigBody, req.body);
      // Either field may be omitted (zod's .refine requires at least one) —
      // apply only what was sent, mirroring PUT /people/:id/role's "one thing
      // changes per call" shape but allowing both in one request too.
      if (body.overshoot_threshold_pct !== undefined) {
        await repos.reportConfig.setOvershootThresholdPct(body.overshoot_threshold_pct);
      }
      if (body.freeze_grace_days !== undefined) {
        await repos.reportConfig.setFreezeGraceDays(body.freeze_grace_days);
      }
      const cfg = await repos.reportConfig.get();
      return {
        overshoot_threshold_pct: cfg.overshoot_threshold_pct,
        freeze_grace_days: cfg.freeze_grace_days,
      };
    });

    // ═════ Increment 14 (SPEC_14 §3/§4) — closure statistics + reports ════════
    // ⛔ Every route below is READ-ONLY w.r.t. sprint state (View ≠ lock,
    // SPEC_11 §8a): none touches sprint.status/is_locked/locked_at/lock_reason.

    // ── GET /api/sprints/:id/closure-stats — role-aware buckets + stats (§3). ─
    app.get("/sprints/:id/closure-stats", { config: { access: "viewer" } }, async (req): Promise<ClosureStatsResponse> => {
      const { id } = parseOrThrow(SprintIdParams, req.params);
      await getSprintOrThrow(id);
      return computeClosureStats(repos, id, nowIso());
    });

    // ── GET /api/reports — closed sprints only, newest-closed first (§4). ──────
    app.get("/reports", { config: { access: "viewer" } }, async (): Promise<ReportsListResponse> => buildReportsList(repos));

    // ── GET /api/reports/:id — detail (stats + burndown), from stored data. ───
    app.get("/reports/:id", { config: { access: "viewer" } }, async (req): Promise<ReportDetailResponse> => {
      const { id } = parseOrThrow(ReportSprintParams, req.params);
      await getSprintOrThrow(id);
      return buildReportDetail(repos, id, nowIso());
    });

    // ── POST /api/reports/:id/pdf — stream application/pdf (also writes to
    //    exports/report-<sprint>-<timestamp>.pdf). READ-ONLY on sprint state. ──
    app.post("/reports/:id/pdf", { config: { access: "viewer" } }, async (req, reply) => {
      const { id } = parseOrThrow(ReportSprintParams, req.params);
      await getSprintOrThrow(id);
      const now = deps.now();
      const { bytes, file_path } = await generateReportPdf(repos, id, {
        generatedAt: now.toISOString(),
        renderPdf: deps.pdfRenderer,
        // Reuse the same exports/ dir override the pre-delete JSON writer uses,
        // so tests point PDFs at a throwaway dir instead of the repo root.
        exportsDir: deps.sprintExport?.exportsDir,
      });
      reply
        .header("Content-Type", "application/pdf")
        .header("Content-Disposition", `attachment; filename="${file_path.split("/").pop()}"`)
        .header("X-Report-Path", file_path);
      return reply.send(bytes);
    });

    // ── POST /sprints/:id/status-pdf (Increment 36, docs/INCREMENT_36_CONTRACTS
    //    .md §2) — stream application/pdf (also writes to
    //    exports/sprint-status-<sprint>-<timestamp>.pdf). Works for EVERY
    //    sprint state (planning/active/closed, frozen or not) — the ONLY 404
    //    is an unknown sprint, so `getSprintOrThrow` alone gates it (no
    //    closed/locked check, unlike most other sprint-scoped routes).
    //    READ-ONLY on sprint state; makes NO OpenProject call (§0 pillar 1). ──
    app.post("/sprints/:id/status-pdf", { config: { access: "viewer" } }, async (req, reply) => {
      const { id } = parseOrThrow(SprintIdParams, req.params);
      await getSprintOrThrow(id);
      const now = deps.now();
      const { bytes, file_path } = await generateSprintStatusPdf(repos, id, {
        generatedAt: now.toISOString(),
        renderPdf: deps.pdfRenderer,
        // Reuse the same exports/ dir override the pre-delete JSON writer uses,
        // so tests point PDFs at a throwaway dir instead of the repo root.
        exportsDir: deps.sprintExport?.exportsDir,
      });
      reply
        .header("Content-Type", "application/pdf")
        .header("Content-Disposition", `attachment; filename="${file_path.split("/").pop()}"`)
        .header("X-Report-Path", file_path);
      return reply.send(bytes);
    });

    // ── GET /sprints/:id/burndown ────────────────────────────────────────────
    app.get("/sprints/:id/burndown", { config: { access: "viewer" } }, async (req) => {
      const { id } = parseOrThrow(SprintIdParams, req.params);
      const sprint = await getSprintOrThrow(id);
      // Anchor the ideal line on the FROZEN baseline once activated so scope
      // creep is visible against a fixed total (SPEC_05 §4); before activation
      // fall back to the live leaf-planned recompute — identical to the fallback
      // packages/sync's computeSnapshot uses, keeping the two in sync.
      const totalPlanned = sprint.baseline_total_hours ?? (await sprintLeafPlanned(id));
      const snapshots = await repos.burndown.listBySprint(id);
      return buildBurndown(sprint, totalPlanned, snapshots);
    });

    // ── POST /sprints/:id/rebuild-burndown (SPEC_12 §5) ──────────────────────
    // Recompute burndown_snapshot rows from OP journals + time entries for ANY
    // sprint — including a LOCKED one: a pure read/recompute that NEVER touches
    // sprint.status/is_locked/locked_at/lock_reason (same "view ≠ lock"
    // principle as SPEC_11 §8a's closure-report split). Every point comes back
    // source="reconstructed".
    app.post("/sprints/:id/rebuild-burndown", { config: { access: "planner" } }, async (req) => {
      const { id } = parseOrThrow(SprintIdParams, req.params);
      await getSprintOrThrow(id);
      try {
        const res: RebuildBurndownResponse = await retroService().rebuildBurndown(id);
        return res;
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw mapOpError(err);
      }
    });

    // ── POST /sprints/:id/retro/seed (SPEC_12 §2) ────────────────────────────
    // Bulk-add candidate tickets by OP version (default) or a pasted id list,
    // each reconstructed to its start_date state (Work/assignee/status as of
    // that day — regardless of CURRENT status, so e.g. `tested` tickets the
    // backlog hides are pulled in too). planning + is_retrospective only.
    app.post("/sprints/:id/retro/seed", { config: { access: "planner" } }, async (req) => {
      const { id } = parseOrThrow(SprintIdParams, req.params);
      const body = parseOrThrow(RetroSeedBody, req.body);
      await getSprintOrThrow(id);
      try {
        const res: RetroSeedResponse = await retroService().seed(id, body);
        return res;
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw mapOpError(err);
      }
    });

    // ── GET /sprints/:id/retro/preview (SPEC_12 §2) ──────────────────────────
    // Read-only "this is what it looked like on start_date" for the current
    // items (seeded OR manually added) — no writes. planning + is_retrospective.
    app.get("/sprints/:id/retro/preview", { config: { access: "planner" } }, async (req) => {
      const { id } = parseOrThrow(SprintIdParams, req.params);
      await getSprintOrThrow(id);
      try {
        const res: RetroPreviewResponse = await retroService().preview(id);
        return res;
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw mapOpError(err);
      }
    });

    // ── GET /sprints/:id/velocity ────────────────────────────────────────────
    app.get("/sprints/:id/velocity", { config: { access: "viewer" } }, async (req) => {
      const { id } = parseOrThrow(SprintIdParams, req.params);
      await getSprintOrThrow(id);
      const closed = (await repos.sprints.listByStatus("closed")).filter(
        (s) => s.id !== id,
      );
      const currentConn = await repos.connections.getCurrent();
      const history = [];
      for (const s of closed) {
        // Increment 37 (docs/INCREMENT_37_CONTRACTS.md §1/§2.3;
        // CAPACITY_BAR_RULES §6 invariant 5 extension) — Velocity shows the
        // SAME numbers as Closure: `planned_hours`/`completed_hours` are
        // this sprint's `computeClosureStats` totals verbatim (never the old
        // leaf-planned sum or the close-time bake), and `by_connection`
        // partitions the exact per-ticket CREDITED delivered amounts
        // `developerSegments` produced — so it sums to `completed_hours`
        // EXACTLY, by construction (a dropped-credit ticket is simply absent
        // from the map, never a phantom 0). Connection of a ticket =
        // frozen_connection_id (frozen sprint) ?? live cache connection_id ??
        // current connection — the pre-existing fallback convention.
        const { stats, deliveredByTicket } = await computeClosureStatsWithInternals(
          repos,
          s.id,
          nowIso(),
        );
        const wpIds = [...deliveredByTicket.keys()];
        const [velWps, velFrozen] = await Promise.all([
          repos.workPackages.getManyByOpIds(wpIds),
          s.frozen_at != null
            ? repos.sprintItems.listFrozenSnapshot(s.id)
            : Promise.resolve([]),
        ]);
        const velWpById = new Map(velWps.map((w) => [w.op_id, w]));
        const velFrozenByWp = new Map(velFrozen.map((f) => [f.wp_op_id, f]));
        const hoursByConn = new Map<number | null, number>();
        for (const [wpOpId, hours] of deliveredByTicket) {
          const connId =
            velFrozenByWp.get(wpOpId)?.frozen_connection_id ??
            velWpById.get(wpOpId)?.connection_id ??
            currentConn?.id ??
            null;
          hoursByConn.set(connId, (hoursByConn.get(connId) ?? 0) + hours);
        }
        const by_connection = [];
        for (const [connId, completed_hours] of hoursByConn) {
          const conn = connId != null ? await repos.connections.getById(connId) : null;
          by_connection.push({
            connection_id: conn?.id ?? connId ?? 0,
            base_url: conn?.base_url ?? "(unknown server)",
            label: conn?.label ?? null,
            completed_hours,
          });
        }
        history.push({
          sprint_id: s.id,
          name: s.name,
          end_date: s.end_date,
          planned_hours: stats.total_planned_hours,
          completed_hours: stats.total_delivered_hours,
          by_connection,
        });
      }
      return computeVelocity(history);
    });

    // ── POST /sprints/:id/close ──────────────────────────────────────────────
    // SPEC_11 §8a: "View / regenerate closure report" is a READ-ish operation —
    // it computes + persists the report but MUST NOT lock a still-active sprint
    // (the reported bug: clicking it silently finished a running sprint). The
    // lock is now EXCLUSIVE to POST /finish (which calls performClosure).
    app.post("/sprints/:id/close", { config: { access: "planner" } }, async (req) => {
      const { id } = parseOrThrow(SprintIdParams, req.params);
      const sprint = await getSprintOrThrow(id);
      // Idempotent on an ALREADY-closed sprint: return the stored report.
      if (sprint.status === "closed") {
        return readStoredClosureReport(repos, id, nowIso());
      }
      // Active/planning: compute + store + return WITHOUT touching status/lock,
      // so it can be regenerated repeatedly while the sprint keeps running.
      return computeAndStoreClosureReport(repos, id);
    });

    // ── POST /sprints/:id/activate (SPEC_09 §1) — SCOPED + ASYNC activation ───
    // Only the connections the sprint's tickets actually live on are contacted
    // (disconnected/irrelevant servers are ignored, #7); the OP fetch + baseline
    // capture run in the BACKGROUND, so the response returns the started run
    // immediately (#1/#2) and the frontend polls GET /sprints/:id/updates.
    app.post("/sprints/:id/activate", { config: { access: "planner" } }, async (req) => {
      const { id } = parseOrThrow(SprintIdParams, req.params);
      const sprint = await getSprintOrThrow(id);
      // Guard synchronously, before creating a run or touching OP (re-activation-proof).
      if (sprint.status !== "planning") {
        fail(
          "SPRINT_NOT_PLANNING",
          `Sprint "${sprint.name}" is not in planning (status: ${sprint.status})`,
          { sprintName: sprint.name },
        );
      }

      // ── Retrospective fork (SPEC_12 §2) ──────────────────────────────────
      // A retro sprint activates via a day-by-day REPLAY (baseline @ start_date
      // reconstructed from journals, per-day reconstructed burndown, changelog,
      // scope churn) instead of the "capture current state" scoped activation.
      // Create the run (total_count = DAYS to replay, NOT the ticket count every
      // other run kind uses — see runReplay's progress note), respond
      // immediately, and replay in the BACKGROUND so the frontend polls
      // GET /sprints/:id/updates for "day X / Y" exactly like a normal
      // activation. runReplay finishes the run itself on both success/error.
      if (sprint.is_retrospective) {
        const today = deps.now().toISOString().slice(0, 10);
        const totalDays = replayDayCount(sprint.start_date, sprint.end_date, today);
        const run = await repos.sprintUpdateRuns.start(id, "activation", "manual");
        await repos.sprintUpdateRuns.progress(run.id, 0, totalDays);
        const svc = retroService();
        void svc.runReplay(id, run.id).catch(() => {
          // runReplay finishes the run itself; this only guards a truly
          // unexpected throw (never an unhandled rejection).
        });
        const res: ActivateSprintResponse = { ...run, wp_count: 0, total_count: totalDays };
        return res;
      }

      // Resolve the sprint's CURRENT scope → which connections it needs, LOCALLY
      // (work_package_cache.connection_id). A ticket with no cached connection
      // falls back to the current connection (pre-Increment-9 single-server behavior).
      const items = (await repos.sprintItems.listBySprint(id)).filter(
        (i) => i.outcome !== "removed",
      );
      const wpOpIds = items.map((i) => i.wp_op_id);
      const cacheRows = await repos.workPackages.getManyByOpIds(wpOpIds);
      const connByWp = new Map(cacheRows.map((w) => [w.op_id, w.connection_id]));
      const currentConn = await repos.connections.getCurrent();
      const scopeItems = wpOpIds.map((wp) => ({
        wp_op_id: wp,
        connection_id: connByWp.get(wp) ?? currentConn?.id ?? null,
      }));
      const neededIds = resolveNeededConnectionIds(scopeItems);

      // Pre-validate BEFORE creating a run / contacting anything (SPEC_09 §1 #4):
      // a disconnected or vault-locked NEEDED server is reported instantly (409
      // ACTIVATION_CONNECTIONS_UNAVAILABLE, with a Reconnect-able per-server
      // list); an irrelevant disconnected server never appears here.
      const connections = await repos.connections.list();
      const blocking = validateNeededConnections(neededIds, connections, vault.isLocked());
      if (blocking.length > 0) {
        throw new AppError(
          "ACTIVATION_CONNECTIONS_UNAVAILABLE",
          `Sprint "${sprint.name}" needs ${blocking.length} connection(s) that are unavailable`,
          { connections: blocking },
        );
      }
      // Items present but no resolvable connection at all (no cache connection,
      // no current connection) — same hard error the old inline path raised.
      if (wpOpIds.length > 0 && neededIds.length === 0) {
        fail("NO_CONNECTION", "No OpenProject connection configured");
      }

      // Build one timeout-wrapped client per needed connection + partition the
      // sprint's tickets by connection. requireOpClientForConnection re-checks
      // the same conditions validateNeededConnections just passed → won't throw.
      const connById = new Map(connections.map((c) => [c.id, c]));
      const partitions: ScopedActivationPartition[] = [];
      for (const connId of neededIds) {
        const { op } = await requireOpClientForConnection(connId);
        const conn = connById.get(connId);
        partitions.push({
          connectionId: connId,
          label: conn?.label ?? conn?.base_url ?? `connection ${connId}`,
          op: withTimeout(op, DEFAULT_ACTIVATION_TIMEOUT_MS),
          wpOpIds: scopeItems.filter((s) => s.connection_id === connId).map((s) => s.wp_op_id),
        });
      }

      // Create the run immediately, set total_count up front (mirrors
      // runUpdateCore's progress(runId, 0, count)), and respond right away — the
      // OP fetch + baseline capture happen in the background (SPEC_09 §1 #2).
      const run = await repos.sprintUpdateRuns.start(id, "activation", "manual");
      await repos.sprintUpdateRuns.progress(run.id, 0, wpOpIds.length);

      // First-burndown-point writer — best-effort from a needed connection's
      // client (or the current connection); a no-op when none is usable.
      let snapshotOp: OpClient | null = partitions[0]?.op ?? null;
      if (!snapshotOp && currentConn && currentConn.enabled && !vault.isLocked()) {
        try {
          snapshotOp = (await requireOpClientForConnection(currentConn.id)).op;
        } catch {
          snapshotOp = null;
        }
      }
      const snapshotWriter = snapshotOp
        ? deps.snapshotWriterFactory(snapshotOp)
        : { writeSnapshot: () => Promise.resolve(), writeSnapshotsForActiveSprints: () => Promise.resolve() };

      void runScopedActivation(
        { repos, snapshotWriter, now: deps.now },
        id,
        run.id,
        nowIso(),
        partitions,
      ).catch(() => {
        // runScopedActivation finishes the run itself on both paths; this only
        // guards against a truly unexpected throw (never an unhandled rejection).
      });

      const res: ActivateSprintResponse = { ...run, wp_count: 0, total_count: wpOpIds.length };
      return res;
    });

    // ── POST /sprints/:id/update (SPEC_04) — scoped diff + changelog pass ─────
    app.post("/sprints/:id/update", { config: { access: "planner" } }, async (req) => {
      const { id } = parseOrThrow(SprintIdParams, req.params);
      const body = parseOrThrow(UpdateSprintRunBody, req.body ?? {});
      await getSprintOrThrow(id);
      try {
        // SPEC_10 §e: scope to the sprint's OWN connections — an unrelated
        // disconnected server (e.g. acme) is never contacted, so a mock-only
        // sprint no longer fails on CONNECTION_DISABLED. A needed-but-unavailable
        // connection surfaces its own clear error from the resolver.
        const run = await deps
          .sprintLifecycleFactory({ buildClientForConnection: buildTimeoutClientForConnection })
          .update(id, body.triggered_by ?? "manual");
        const res: SprintUpdateRunResponse = run;
        return res;
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw mapOpError(err);
      }
    });

    // ── GET /sprints/:id/updates (SPEC_04) — update-run history, newest first ─
    app.get("/sprints/:id/updates", { config: { access: "viewer" } }, async (req) => {
      const { id } = parseOrThrow(SprintIdParams, req.params);
      await getSprintOrThrow(id);
      const res: SprintUpdateRunsResponse = await repos.sprintUpdateRuns.listBySprint(id);
      return res;
    });

    // ── POST /sprints/:id/updates/:runId/cancel (Consolidation Round, Concept 8) ─
    // Physically cancel a running activation/update/finish/retro-replay run,
    // mirroring POST /sync/:runId/cancel. sprint_update_run has no
    // cancel_requested DB flag (unlike sync_run) — the hard-cancel registry IS
    // the mechanism: hardCancelSprintUpdateRun aborts this run's AbortController
    // so the in-flight OP request is interrupted near-instantly, and the run's
    // own catch finishes it "aborted" (runFinishStatus maps OpCancelledError).
    // Idempotent — `cancelled:false` if nothing is registered (already finished
    // / unknown id); 404 only for a runId that never belonged to this sprint.
    app.post("/sprints/:id/updates/:runId/cancel", { config: { access: "planner" } }, async (req) => {
      const { id } = parseOrThrow(SprintIdParams, req.params);
      await getSprintOrThrow(id);
      const raw = (req.params ?? {}) as Record<string, string | undefined>;
      const runId = Number(raw.runId);
      if (!Number.isInteger(runId) || runId <= 0)
        fail("BAD_REQUEST", "runId must be a positive integer");
      const run = (await repos.sprintUpdateRuns.listBySprint(id)).find((r) => r.id === runId);
      if (!run) fail("NOT_FOUND", `Sprint update run ${runId} not found`);
      const cancelled = hardCancelSprintUpdateRun(runId);
      return { run_id: runId, cancelled, run };
    });

    // ── POST /sprints/:id/finish (SPEC_04) — final update + irreversible lock ─
    app.post("/sprints/:id/finish", { config: { access: "planner" } }, async (req) => {
      const { id } = parseOrThrow(SprintIdParams, req.params);
      const body = parseOrThrow(FinishSprintBody, req.body ?? {});
      await getSprintOrThrow(id);
      try {
        // SPEC_10 §e: same scoping as /update — Finish contacts only the sprint's
        // own connections, never an unrelated disconnected server.
        const report = await deps
          .sprintLifecycleFactory({ buildClientForConnection: buildTimeoutClientForConnection })
          .finish(id, body.triggered_by ?? "manual", "finished");
        const res: ClosureReportResponse = report;
        return res;
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw mapOpError(err);
      }
    });

    // ── GET /sprints/:id/tickets/:wpId/changelog (SPEC_04) — oldest first ─────
    app.get("/sprints/:id/tickets/:wpId/changelog", { config: { access: "viewer" } }, async (req) => {
      const { id, wpId } = parseOrThrow(TicketChangelogParams, req.params);
      await getSprintOrThrow(id);
      const rows = await repos.ticketChangelog.listByTicket(id, wpId);
      const res: TicketChangelogResponse = rows.map((r) => {
        const { detail_json, ...rest } = r;
        const view: ChangelogEntryView = {
          ...rest,
          detail: JSON.parse(detail_json) as ChangelogDetail,
        };
        return view;
      });
      return res;
    });

    // ── GET /sprints/:id/version-export ──────────────────────────────────────
    app.get("/sprints/:id/version-export", { config: { access: "viewer" } }, async (req) => {
      const { id } = parseOrThrow(SprintIdParams, req.params);
      await getSprintOrThrow(id);
      // Only builds a deep-link from base_url — no OP call, no vault needed.
      const conn = await repos.connections.getCurrent();
      if (!conn) fail("NO_CONNECTION", "No OpenProject connection configured");

      // Version-change candidates = carried / not-done live items.
      const items = (await repos.sprintItems.listBySprint(id)).filter(
        (i) => i.outcome === "carried" || i.outcome === "planned",
      );
      const wps = await repos.workPackages.getManyByOpIds(
        items.map((i) => i.wp_op_id),
      );
      const wpById = new Map(wps.map((w) => [w.op_id, w]));
      const rules = await repos.doneStatusRules.listBySprint(id);
      const notDone = items.filter((it) => {
        const wp = wpById.get(it.wp_op_id);
        // Carried are always candidates; planned only if not currently done.
        if (it.outcome === "carried") return true;
        return !(wp?.status_is_closed && !rules.some((r) => r.status_name === wp.status_name && r.counts_as === "rejected"));
      });
      const wpOpIds = notDone.map((i) => i.wp_op_id);

      // Resolve project identifier from the first WP's project.
      let identifier = "";
      const firstWp = wpById.get(wpOpIds[0] ?? -1);
      if (firstWp) {
        const project = await repos.projects.getByOpId(firstWp.project_op_id);
        identifier = project?.identifier ?? String(firstWp.project_op_id);
      } else if (conn.default_project_op_id != null) {
        const project = await repos.projects.getByOpId(conn.default_project_op_id);
        identifier = project?.identifier ?? String(conn.default_project_op_id);
      }

      const res: VersionExportResponse = {
        sprint_id: id,
        wp_op_ids: wpOpIds,
        deep_link: buildVersionDeepLink(conn.base_url, identifier, wpOpIds),
      };
      return res;
    });
  };
}

