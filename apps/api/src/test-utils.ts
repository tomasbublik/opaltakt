import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DbHandle, type Repositories } from "@osp/db";
import { OpHttpError } from "@osp/op-client";
import type {
  HalCollection,
  OpActivity,
  OpClient,
  OpClientConfig,
  OpMembership,
  OpProject,
  OpStatus,
  OpTimeEntry,
  OpUser,
  OpVersion,
  OpWorkPackage,
  OpWorkPackageSchema,
  WorkPackagesQuery,
} from "@osp/op-client";
import { createSyncEngine, type SnapshotWriter, type SyncEngine } from "@osp/sync";
import type { SyncRun } from "@osp/contracts";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { buildApp } from "./app";
import type { AuthOptions, AuthUser, OidcProvider } from "./auth/index";
import type { EntraAuthConfig } from "./auth/config";
import { recoverOrphanedRuns } from "./server";
import { resolveDeps, type AppDeps, type PartialAppDeps } from "./deps";

/**
 * Test harness: an in-memory (migrated) DB + FAKE op-client / sync engine so
 * contract tests never touch a real OpenProject (SPEC §9 parallelization rule).
 *
 * Increment 27 (SQLite → Postgres, CONTRACTS §7): "in-memory" now means
 * **PGlite** — an in-process PostgreSQL build, the structural replacement for
 * SQLite's `:memory:`. One fresh instance per `buildTestApp()` (~235 ms), no
 * server, no ports, no cleanup, vitest workers stay parallel. Consequences for
 * anything written against this harness:
 *
 *   • `openDb()` is async and `handle.close()` is async — always `await` both.
 *   • `DbHandle.sqlite` is gone; raw SQL goes through `DbHandle.raw` (a PGlite
 *     client or a `pg.Pool`), via the `rawQuery` helper below.
 *   • Raw SQL is POSTGRES: `$1` placeholders (not `?`), `true`/`false` (not
 *     `1`/`0`), and ONE statement per call (PGlite rejects multi-statement
 *     prepared statements, SQLSTATE 42601).
 *   • Foreign keys are enforced natively and unconditionally — SQLite only did
 *     so with `PRAGMA foreign_keys = ON`, so fixtures must insert parents
 *     before children.
 */

function coll<T>(elements: T[]): HalCollection<T> {
  return {
    _type: "Collection",
    total: elements.length,
    count: elements.length,
    pageSize: 100,
    offset: 1,
    _embedded: { elements },
    _links: { self: { href: "/api/v3/self" } },
  };
}

export interface FakeOpData {
  user?: OpUser;
  projects?: OpProject[];
  /** Increment 4: keyed by wp id, for op.getActivities(wpId). */
  activitiesByWpId?: Record<number, OpActivity[]>;
  /** Increment 4: canned work packages for op.getWorkPackages (honours the
   * `id = [...]` scoped filter the sprint-update engine sends). */
  workPackages?: OpWorkPackage[];
  /** Increment 4: canned statuses for op.getStatuses (isClosed lookups). */
  statuses?: OpStatus[];
  /** Increment 4: canned time entries for op.getTimeEntries. */
  timeEntries?: OpTimeEntry[];
  /** Increment 11 (SPEC_11 §4): canned users for op.getUser(id) (name resolution). */
  usersById?: Record<number, OpUser>;
  /** Increment 13 (SPEC_13 §1): the connection's user directory for
   * op.getUsers()/fetchAllUsers (exact-match identity index). Defaults to the
   * values of usersById (so a single source of truth covers both). */
  users?: OpUser[];
  /** Increment 13 (SPEC_13 §1a, revised): project memberships for
   * op.getMemberships() — the NON-admin (name → id) identity source. Honours a
   * `project = [...]` filter when present. */
  memberships?: OpMembership[];
  /**
   * Increment 32 (docs/INCREMENT_32_CONTRACTS.md §3, step 2) — makes
   * op.getTimeEntries throw an `OpHttpError(400)` (the SPEC_07
   * OP_QUERY_INVALID shape) whenever the query's `filters` include ANY of
   * these keys, so a test can exercise the off-sprint fetch's degrade ladder
   * against an "older OP" that rejects the `user`/`spent_on` filter.
   */
  timeEntriesRejectFilterKeys?: readonly ("user" | "spent_on")[];
}

/** A canned READ-ONLY op client (all methods GET-only by contract). Reads
 * `data` at CALL time, so tests may mutate the passed object between requests
 * (e.g. inject activities after activation, then trigger an update). */
export function makeFakeOpClient(data: FakeOpData = {}): OpClient {
  const user: OpUser = data.user ?? { _type: "User", id: 1, name: "Test User", login: "test" };
  const projects: OpProject[] = data.projects ?? [
    { _type: "Project", id: 100, identifier: "proj-a", name: "Project A" },
  ];
  return {
    request: <T>() => Promise.resolve(undefined as T),
    getCurrentUser: () => Promise.resolve(user),
    getProjects: () => Promise.resolve(coll<OpProject>(projects)),
    getWorkPackages: (query: WorkPackagesQuery) => {
      const wps = data.workPackages ?? [];
      // Honour a scoped `id = [...]` filter (what the sprint-update engine sends).
      const idFilter = (query?.filters ?? []).find(
        (f): f is { id: { values?: string[] } } =>
          typeof f === "object" && f !== null && "id" in f,
      );
      if (idFilter) {
        const ids = new Set((idFilter.id.values ?? []).map((v) => Number(v)));
        return Promise.resolve(coll<OpWorkPackage>(wps.filter((w) => ids.has(w.id))));
      }
      return Promise.resolve(coll<OpWorkPackage>(wps));
    },
    getTimeEntries: (query) => {
      const filters = (query?.filters as unknown[]) ?? [];
      // Increment 32: reject a configured filter key with a real OpHttpError
      // 400 — the shape `fetchOffSprintTimeEntriesDegrading`'s `isQueryInvalid`
      // keys its degrade ladder on (SPEC_07 OP_QUERY_INVALID).
      for (const key of data.timeEntriesRejectFilterKeys ?? []) {
        if (filters.some((f) => typeof f === "object" && f !== null && key in f)) {
          return Promise.reject(
            new OpHttpError(400, "/api/v3/time_entries", `unsupported filter: ${key}`),
          );
        }
      }
      let entries = data.timeEntries ?? [];
      // Honour a `user = [...]` filter (what the off-sprint fetch sends) —
      // matches each entry's _links.user id.
      const userFilter = filters.find(
        (f): f is { user: { values?: string[] } } =>
          typeof f === "object" && f !== null && "user" in f,
      );
      if (userFilter) {
        const ids = new Set((userFilter.user.values ?? []).map((v) => Number(v)));
        entries = entries.filter((e) => {
          const uid = Number(e._links.user.href?.split("/").pop());
          return ids.has(uid);
        });
      }
      // Honour a `spent_on >=d [...]` filter (server-side lower-bound
      // optimization — the off-sprint fetch always re-applies the full
      // window client-side regardless, so this is realism, not correctness).
      const spentOnFilter = filters.find(
        (f): f is { spent_on: { values?: string[] } } =>
          typeof f === "object" && f !== null && "spent_on" in f,
      );
      const from = spentOnFilter?.spent_on.values?.[0];
      if (from) entries = entries.filter((e) => e.spentOn >= from);
      return Promise.resolve(coll<OpTimeEntry>(entries));
    },
    getVersions: () => Promise.resolve(coll<OpVersion>([])),
    getStatuses: () => Promise.resolve(coll<OpStatus>(data.statuses ?? [])),
    getWorkPackageSchema: () =>
      Promise.resolve({ _type: "Schema" } as OpWorkPackageSchema),
    getActivities: (wpId: number) =>
      Promise.resolve(coll<OpActivity>(data.activitiesByWpId?.[wpId] ?? [])),
    getUser: (id: number) => Promise.resolve(data.usersById?.[id] ?? null),
    getUsers: () =>
      Promise.resolve(
        coll<OpUser>(data.users ?? Object.values(data.usersById ?? {})),
      ),
    getMemberships: (query) => {
      const all = data.memberships ?? [];
      // Honour a scoped `project = [...]` filter (what fetchProjectMemberships
      // sends), matching each membership's _links.project href.
      const projFilter = ((query?.filters as unknown[]) ?? []).find(
        (f): f is { project: { values?: string[] } } =>
          typeof f === "object" && f !== null && "project" in f,
      );
      if (projFilter) {
        const ids = new Set((projFilter.project.values ?? []).map((v) => Number(v)));
        return Promise.resolve(
          coll<OpMembership>(
            all.filter((m) => {
              const href = m._links.project?.href ?? "";
              const pid = Number(href.split("/").pop());
              return ids.has(pid);
            }),
          ),
        );
      }
      return Promise.resolve(coll<OpMembership>(all));
    },
  };
}

/** A fake sync engine that records a successful sync_run via the repos. */
export function makeFakeSyncEngineFactory(repos: Repositories) {
  return (op: OpClient): SyncEngine => {
    // Real engine for importWorkPackage (does the OP GET + mapping + cache) so a
    // single-ticket import can be tested by injecting an op client that returns it.
    const real = createSyncEngine({
      op,
      projects: repos.projects,
      workPackages: repos.workPackages,
      sprintItems: repos.sprintItems,
      syncRuns: repos.syncRuns,
      sprints: repos.sprints,
    });
    return {
      async sync(options): Promise<SyncRun> {
        const run = await repos.syncRuns.start(options.kind ?? "full");
        const at = new Date().toISOString();
        await repos.projects.upsertMany([
          {
            op_id: options.projectOpId,
            identifier: `proj-${options.projectOpId}`,
            name: `Project ${options.projectOpId}`,
            last_synced_at: at,
          },
        ]);
        await repos.projects.setLastSyncedAt(options.projectOpId, at);
        return repos.syncRuns.finish(run.id, "success", 0, null, at);
      },
      // Increment 29 (CONTRACTS §2) — delegate to the REAL engine so the
      // coverage pass exercises the genuine batching / staging / orphan-
      // detection code against the fake OP client above. A test controls the
      // outcome purely through `opData.workPackages`: an id the fake OP does not
      // return comes back in `missingOpIds` (an orphan candidate), which is
      // exactly the shape the route reports.
      syncByOpIds: (opIds, signal) => real.syncByOpIds(opIds, signal),
      importWorkPackage: (opId) => real.importWorkPackage(opId),
      fetchWorkPackageRow: (opId) => real.fetchWorkPackageRow(opId),
    };
  };
}

export function makeFakeSnapshotWriter(): SnapshotWriter {
  return {
    writeSnapshot: () => Promise.resolve(),
    writeSnapshotsForActiveSprints: () => Promise.resolve(),
  };
}

export interface TestApp {
  app: FastifyInstance;
  repos: Repositories;
  /** Resolved deps — gives tests direct access to the vault / health tracker. */
  deps: AppDeps;
  /**
   * Raw driver handle (PGlite client / `pg.Pool`) — e.g. to seed a LEGACY
   * plaintext connection, or to force a state the repository API refuses to
   * produce. Go through `rawQuery`/`rawOne` rather than using this directly.
   */
  raw: DbHandle["raw"];
  close(): Promise<void>;
}

/**
 * Issue raw parameterised SQL against the underlying driver and return rows.
 * `pg.Pool#query` and `PGlite#query` both resolve to `{ rows }`, so this single
 * helper keeps every raw-SQL test engine-agnostic (and gives one place to adapt
 * if the driver shape changes). See the POSTGRES caveats in the file header.
 */
export async function rawQuery<T = Record<string, unknown>>(
  raw: DbHandle["raw"],
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const driver = raw as { query: (sql: string, params?: unknown[]) => Promise<{ rows: T[] }> };
  const res = await driver.query(sql, params);
  return res.rows;
}

/** `rawQuery` for a statement expected to yield at most one row. */
export async function rawOne<T = Record<string, unknown>>(
  raw: DbHandle["raw"],
  sql: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  return (await rawQuery<T>(raw, sql, params))[0];
}

/**
 * Normalise an ISO datetime for comparison — Increment 27.
 *
 * Timestamp columns are real `timestamptz` now, so a stored value makes a
 * string → Date → timestamptz → Date → string round trip and comes back in
 * `Date#toISOString()`'s canonical form, which ALWAYS carries milliseconds:
 *
 *     written "2026-07-06T00:00:00Z"  →  read "2026-07-06T00:00:00.000Z"
 *
 * The instant is identical and both forms satisfy `IsoDateTime`
 * (`z.string().datetime({ offset: true })`), and no application code compares
 * these fields as strings — but a test pinning the exact bytes would now fail
 * for no semantic reason. Compare instants:
 *
 *     expect(instant(item.added_at)).toBe(instant("2026-07-06T00:00:00Z"));
 */
export function instant(value: string | null | undefined): string {
  if (value === null || value === undefined) return String(value);
  return new Date(value).toISOString();
}

export async function buildTestApp(
  overrides: Partial<PartialAppDeps> & {
    opData?: FakeOpData;
    opClientFactory?: (config: OpClientConfig) => OpClient;
    /**
     * Increment 39 — auth mode for this app. Default: `none` (synthetic local
     * Planner), so every pre-existing test keeps its behaviour. Use
     * `fakeAuthAs(...)` to act as Viewer / Planner / no-role / anonymous, or
     * `entraTestAuth()` to exercise the real cookie path.
     */
    auth?: AuthOptions;
  } = {},
): Promise<TestApp> {
  // Increment 27: a FRESH ephemeral PGlite instance per test app. Nothing is
  // shared between tests and nothing can reach a real Postgres server.
  const handle = await openDb({ ephemeral: true });
  const repos = handle.repositories;
  // Consolidation Round (Concept 8) — route the harness through the SAME boot
  // crash-recovery step buildServer() runs, so both sync_run and
  // sprint_update_run orphan recovery is exercised by every route test, not just
  // one integration test (a harmless no-op on a fresh in-memory DB).
  await recoverOrphanedRuns(repos);
  const deps = resolveDeps({
    repos,
    db: handle.db,
    opClientFactory:
      overrides.opClientFactory ?? (() => makeFakeOpClient(overrides.opData)),
    syncEngineFactory:
      overrides.syncEngineFactory ?? makeFakeSyncEngineFactory(repos),
    snapshotWriterFactory:
      overrides.snapshotWriterFactory ?? (() => makeFakeSnapshotWriter()),
    ...(overrides.reconstruct ? { reconstruct: overrides.reconstruct } : {}),
    // SPEC_12 §6: default the pre-delete export to a throwaway temp dir so the
    // test suite never writes into the real repo-root exports/ (a test can still
    // override exportsDir/writeFile/mkdir to assert export success/failure).
    sprintExport: {
      exportsDir: join(tmpdir(), `osp-test-exports-${process.pid}-${Math.random().toString(36).slice(2)}`),
      ...overrides.sprintExport,
    },
    ...(overrides.now ? { now: overrides.now } : {}),
    ...(overrides.pdfRenderer ? { pdfRenderer: overrides.pdfRenderer } : {}),
  });
  const app = await buildApp(deps, { auth: overrides.auth ?? { config: { mode: "none" } } });
  await app.ready();
  return {
    app,
    repos,
    deps,
    raw: handle.raw,
    close: async () => {
      await app.close();
      await handle.close();
    },
  };
}

/**
 * SPEC_09 §1: activation is now SCOPED + ASYNC — POST /activate returns the
 * STARTED run immediately and does the OP fetch/baseline capture in the
 * background. This helper kicks off activation and then polls GET
 * /sprints/:id/updates (the same contract the frontend uses) until the
 * activation run settles, so a test can assert on the post-activation state
 * (status active, baselines, burndown) synchronously as before. Throws if the
 * activation run errors or never finishes.
 */
export async function activateSprint(t: TestApp, sprintId: number): Promise<void> {
  const res = await t.app.inject({ method: "POST", url: `/api/sprints/${sprintId}/activate` });
  if (res.statusCode !== 200) {
    throw new Error(`activate failed: ${res.statusCode} ${res.payload}`);
  }
  await waitForActivation(t, sprintId);
}

/** Poll GET /sprints/:id/updates until the newest activation run leaves
 * "running" (fire-and-forget background job settles on the microtask queue). */
export async function waitForActivation(t: TestApp, sprintId: number): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const runs = (
      await t.app.inject({ method: "GET", url: `/api/sprints/${sprintId}/updates` })
    ).json() as Array<{ kind: string; status: string; error: string | null }>;
    const act = runs.find((r) => r.kind === "activation");
    if (act && act.status !== "running") {
      if (act.status === "error") {
        throw new Error(`activation run errored: ${act.error}`);
      }
      return;
    }
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`activation for sprint ${sprintId} did not finish`);
}

/** Shared test passphrase (≥ 8 chars per VaultInitBody). */
export const TEST_PASSPHRASE = "correct horse battery";

/** POST /api/vault/init — expects a fresh (uninitialized) vault. */
export async function initVault(
  t: TestApp,
  passphrase: string = TEST_PASSPHRASE,
): Promise<void> {
  const res = await t.app.inject({
    method: "POST",
    url: "/api/vault/init",
    payload: { passphrase },
  });
  if (res.statusCode !== 201) {
    throw new Error(`vault init failed: ${res.statusCode} ${res.payload}`);
  }
}

/** POST /api/connections against the faked OP (vault must be unlocked). */
export async function addConnection(
  t: TestApp,
  overrides: Partial<{
    base_url: string;
    token: string;
    label: string;
    default_project_op_id: number;
  }> = {},
): Promise<unknown> {
  const res = await t.app.inject({
    method: "POST",
    url: "/api/connections",
    payload: {
      base_url: "https://op.example.com",
      token: "secret-token",
      default_project_op_id: 100,
      ...overrides,
    },
  });
  if (res.statusCode !== 201) {
    throw new Error(`add connection failed: ${res.statusCode} ${res.payload}`);
  }
  return res.json();
}

/**
 * Seed a PRE-INCREMENT-2 row: plaintext token in the legacy `token_encrypted`
 * slot, no encrypted blob. Only raw SQL can produce this state — the repository
 * API is encrypted-only by design.
 *
 * Increment 27: Postgres syntax — `$n` placeholders and a real boolean
 * `true` for `is_current` (SQLite's `1` is not a boolean in PG).
 */
export async function seedLegacyPlaintextConnection(
  t: TestApp,
  baseUrl: string,
  plaintextToken: string,
  defaultProjectOpId: number | null = 100,
): Promise<void> {
  await rawQuery(
    t.raw,
    `INSERT INTO op_connection
       (base_url, token_encrypted, default_project_op_id, is_current, created_at, last_status)
     VALUES ($1, $2, $3, true, $4, 'unknown')`,
    [baseUrl, plaintextToken, defaultProjectOpId, new Date()],
  );
}

// ── Increment 39 — auth test helpers ───────────────────────────────────────

/** A syntactically valid but FAKE entra config (no network is ever made). */
export function fakeEntraConfig(overrides: Partial<EntraAuthConfig> = {}): EntraAuthConfig {
  return {
    mode: "entra",
    tenantId: "00000000-0000-0000-0000-000000000000",
    clientId: "11111111-1111-1111-1111-111111111111",
    clientSecret: "fake-client-secret",
    publicUrl: "http://localhost:5173",
    sessionSecret: randomBytes(32),
    ...overrides,
  };
}

/** An OIDC fake: builds a recognisable URL, `exchange` returns canned claims. */
export function fakeOidc(
  exchange: OidcProvider["exchange"] = async () => {
    throw new Error("fakeOidc: no exchange configured");
  },
): OidcProvider {
  return {
    authorizationUrl: ({ redirectUri, state, nonce, codeChallenge }) =>
      `https://idp.test/authorize?${new URLSearchParams({
        redirect_uri: redirectUri,
        state,
        nonce,
        code_challenge: codeChallenge,
      }).toString()}`,
    exchange,
    endSessionUrl: (post) =>
      `https://idp.test/logout?${new URLSearchParams({ post_logout_redirect_uri: post }).toString()}`,
  };
}

export function testUser(roles: string[], name = "Test Person"): AuthUser {
  return { sub: `sub-${name}`, oid: null, name, email: "person@example.test", roles };
}

/**
 * Entra-mode auth where EVERY request acts as `user` (null = anonymous) — the
 * resolver seam, no cookies involved. E.g. `fakeAuthAs(testUser(["Viewer"]))`.
 */
export function fakeAuthAs(user: AuthUser | null): AuthOptions {
  return { config: fakeEntraConfig(), oidc: fakeOidc(), resolveUser: () => user };
}

/** Real entra cookie path with a fake OIDC provider and an optional clock. */
export function entraTestAuth(
  opts: { oidc?: OidcProvider; nowSeconds?: () => number; config?: Partial<EntraAuthConfig> } = {},
): AuthOptions & { config: EntraAuthConfig } {
  return {
    config: fakeEntraConfig(opts.config),
    oidc: opts.oidc ?? fakeOidc(),
    ...(opts.nowSeconds ? { nowSeconds: opts.nowSeconds } : {}),
  };
}
