import { readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Scenario } from "../scenario-types";
import { handleAdmin } from "./admin";
import {
  loadScenarioRegistry,
  MockEngineError,
  ScenarioEngine,
  type ScenarioView,
} from "./engine";
import {
  activityToHal,
  collection,
  membershipToHal,
  paginateCollection,
  parseFiltersParam,
  parseSortBy,
  projectToHal,
  sortWorkPackages,
  statusToHal,
  timeEntriesFilterError,
  timeEntryMatches,
  timeEntryToHal,
  userToHal,
  versionToHal,
  workPackageMatches,
  workPackageToHal,
  type HalCollectionLike,
} from "./hal";

/**
 * Mock OpenProject v3 server (SPEC §9 Fáze 0 + SPEC_03 Increment 3).
 *
 * Two modes per server INSTANCE (each instance owns its own ScenarioEngine):
 *  - FIXTURE mode (default): behaves exactly like the legacy static mock —
 *    /api/v3/work_packages + /api/v3/time_entries re-read fixtures/data/*.json
 *    on every request (fixtures/sim.ts edits surface without a restart).
 *  - SCENARIO mode (after POST /__mock/load/:name): OP GETs are served from
 *    the in-memory, time-driven scenario state.
 *
 * /api/v3/* stays GET-only in BOTH modes (mirrors the real read-only
 * constraint). Mutations happen only via the admin namespace /__mock/*,
 * which op-client never calls.
 *
 * Run:  pnpm --filter @osp/fixtures start   (or: pnpm mock:op)
 * Env:  MOCK_OP_PORT (default 8099), MOCK_OP_HOST (default 127.0.0.1),
 *       MOCK_OP_LOG=1 to log requests.
 */

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

function load<T>(file: string): T {
  return JSON.parse(readFileSync(join(DATA_DIR, file), "utf8")) as T;
}

// Static fixtures cached at init (same as the legacy mock). Work packages and
// time entries are re-read FRESH per request in fixture mode (see below).
const usersMe = load<unknown>("users-me.json");
const projects = load<unknown>("projects.json");
const statuses = load<unknown>("statuses.json");
const versions = load<unknown>("versions.json");
const schema = load<unknown>("schema.json");

interface WorkPackageLike {
  id?: number;
  _links?: {
    project?: { href?: string | null };
    version?: { href?: string | null };
  };
}

interface VersionLike {
  _links?: { definingProject?: { href?: string | null } };
}

/** Extract the numeric project id from a WP's _links.project href, if any. */
function wpProjectId(wp: WorkPackageLike): string | null {
  const href = wp._links?.project?.href ?? null;
  const m = href ? /\/projects\/(\d+)/.exec(href) : null;
  return m ? m[1]! : null;
}

/** Extract the numeric version id from a WP's _links.version href, if any. */
function wpVersionId(wp: WorkPackageLike): string | null {
  const href = wp._links?.version?.href ?? null;
  const m = href ? /\/versions\/(\d+)/.exec(href) : null;
  return m ? m[1]! : null;
}

/**
 * Legacy filter helper (fixture mode): first value of a `filters` clause for
 * `key`, or null. Mirrors real OP's lenient parsing.
 */
function filterValueFrom(filtersParam: string | null, key: string): string | null {
  return filterValuesFrom(filtersParam, key)?.[0] ?? null;
}

/**
 * ALL values of a `filters` clause for `key`, or null when the clause is
 * absent. Real OpenProject has always accepted a multi-value clause
 * (`{"id":{"operator":"=","values":["1","2","3"]}}`) and matches ANY of them;
 * `filterValueFrom` above kept only the FIRST, so a 100-id bulk fetch
 * (Increment 29's `syncByOpIds`) would have matched exactly one work package
 * and made a correct client look broken for reasons that are not in the app.
 * This is protocol parity, not test convenience — scenario mode already got it
 * right (`workPackageMatches` uses `values.includes`), fixture mode did not.
 */
function filterValuesFrom(filtersParam: string | null, key: string): string[] | null {
  if (!filtersParam) return null;
  try {
    const clauses = JSON.parse(filtersParam) as Array<Record<string, unknown>>;
    for (const clause of clauses) {
      const c = clause?.[key] as { values?: unknown[] } | undefined;
      if (c && Array.isArray(c.values) && c.values.length > 0) {
        return c.values.map((v) => String(v));
      }
    }
  } catch {
    // Malformed filters → behave as unfiltered.
  }
  return null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** True for the two `work_packages` COLLECTION path shapes (never /activities
 * or /schema) — the ones a paged sync loops over, so the SPEC_19 §2 injected
 * latency slows exactly those and nothing else. */
function isWorkPackagesCollectionPath(path: string): boolean {
  return (
    path === "/api/v3/work_packages" ||
    /^\/api\/v3\/projects\/\d+\/work_packages$/.test(path)
  );
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Pagination params — pageSize defaults to 2 (legacy), offset to 1. */
function pageParams(url: URL): { offset: number; pageSize: number } {
  return {
    offset: Math.max(1, Number(url.searchParams.get("offset") ?? "1")),
    pageSize: Math.max(1, Number(url.searchParams.get("pageSize") ?? "2")),
  };
}

// ── Fixture mode (legacy static behavior — keep byte-for-byte compatible) ────

function paginateFixtureWorkPackages(
  source: unknown[],
  offset: number,
  pageSize: number,
): HalCollectionLike {
  return paginateCollection({
    type: "WorkPackageCollection",
    path: "/api/v3/work_packages",
    source,
    offset,
    pageSize,
  });
}

function handleFixtureGet(url: URL, res: ServerResponse): void {
  const path = url.pathname;

  // Increment 4: fixture mode has no journal history — empty, not 404 (a real
  // OP ticket with no activity yet behaves the same way).
  if (/^\/api\/v3\/work_packages\/\d+\/activities$/.test(path)) {
    return void sendJson(res, 200, {
      _type: "Collection",
      total: 0,
      count: 0,
      pageSize: 30,
      offset: 1,
      _embedded: { elements: [] },
      _links: { self: { href: path } },
    });
  }

  // Work packages listing — dynamic pagination + optional project filter.
  // Re-read the JSON FRESH so simulated status/time changes appear on next sync.
  if (path === "/api/v3/work_packages") {
    const allWorkPackages = load<WorkPackageLike[]>("work_packages.json");
    const { offset, pageSize } = pageParams(url);
    const filtersParam = url.searchParams.get("filters");
    const projectId = filterValueFrom(filtersParam, "project");
    const versionId = filterValueFrom(filtersParam, "version");
    // Multi-value `id` (real OP semantics): match ANY of the requested ids.
    const wpIds = filterValuesFrom(filtersParam, "id");
    const source = allWorkPackages.filter(
      (wp) =>
        (projectId === null || wpProjectId(wp) === projectId) &&
        (versionId === null || wpVersionId(wp) === versionId) &&
        (wpIds === null || wpIds.includes(String(wp.id))),
    );
    sendJson(res, 200, paginateFixtureWorkPackages(source, offset, pageSize));
    return;
  }

  // Project-scoped work packages (Increment 8 §1 fidelity — real OP supports
  // this alongside the global /work_packages?filters=[{project:...}]) — same
  // filtering, just with the project id taken from the path instead of query.
  const projWorkPackages = /^\/api\/v3\/projects\/(\d+)\/work_packages$/.exec(path);
  if (projWorkPackages) {
    const pid = projWorkPackages[1]!;
    const allWorkPackages = load<WorkPackageLike[]>("work_packages.json");
    const { offset, pageSize } = pageParams(url);
    const filtersParam = url.searchParams.get("filters");
    const versionId = filterValueFrom(filtersParam, "version");
    // Same multi-value `id` semantics as the global listing above.
    const wpIds = filterValuesFrom(filtersParam, "id");
    const source = allWorkPackages.filter(
      (wp) =>
        wpProjectId(wp) === pid &&
        (versionId === null || wpVersionId(wp) === versionId) &&
        (wpIds === null || wpIds.includes(String(wp.id))),
    );
    sendJson(res, 200, paginateFixtureWorkPackages(source, offset, pageSize));
    return;
  }

  if (path === "/api/v3/work_packages/schema") return void sendJson(res, 200, schema);
  if (path === "/api/v3/users/me") return void sendJson(res, 200, usersMe);
  // GET /api/v3/users (SPEC_13 §1) — the user COLLECTION. Scenario mode already
  // serves this; fixture mode did not (anything but /me and /:id 404'd). Keep
  // the two modes consistent: fixture mode only knows the "me" user, so the
  // directory is exactly that single user (same source as /users/me and the
  // /:id route below — no invented data). A real OP directory is paginated, but
  // one static user fits a single page, so we ignore offset/pageSize here.
  if (path === "/api/v3/users") {
    return void sendJson(res, 200, collection(path, [usersMe]));
  }
  // GET /api/v3/users/:id (SPEC_11 §4) — fixture mode only knows the "me" user;
  // any other id is a genuine 404 (unknown-user fallback path).
  const oneUserFixture = /^\/api\/v3\/users\/(\d+)$/.exec(path);
  if (oneUserFixture) {
    const uid = Number(oneUserFixture[1]!);
    if (uid === (usersMe as { id?: number }).id) return void sendJson(res, 200, usersMe);
    return void sendJson(res, 404, {
      _type: "Error",
      errorIdentifier: "urn:openproject-org:api:v3:errors:NotFound",
      message: `User ${uid} not found`,
    });
  }
  // GET /api/v3/memberships (SPEC_13 §1a) — the project roster; a NON-admin
  // identity source (unlike /api/v3/users). Fixture mode only knows the "me"
  // user, so the roster is exactly that one user as a membership of whatever
  // project was filtered (no invented people — same source as /users/me).
  if (path === "/api/v3/memberships") {
    const me = usersMe as { id: number; name: string };
    const projectId = filterValueFrom(url.searchParams.get("filters"), "project");
    const membership = {
      _type: "Membership",
      id: 1,
      _links: {
        self: { href: "/api/v3/memberships/1" },
        principal: { href: `/api/v3/users/${me.id}`, title: me.name },
        project:
          projectId === null
            ? { href: null }
            : { href: `/api/v3/projects/${projectId}`, title: `Project ${projectId}` },
      },
    };
    return void sendJson(res, 200, collection(path, [membership]));
  }
  if (path === "/api/v3/projects") return void sendJson(res, 200, projects);
  if (path === "/api/v3/statuses") return void sendJson(res, 200, statuses);
  // Re-read FRESH so simulated logged time appears on the next sync.
  if (path === "/api/v3/time_entries") {
    // Enforce the same real-OP filter contract as scenario mode (SPEC_07 §3):
    // the deprecated `workPackage` filter 400s instead of being silently
    // accepted, so a caller still sending it gets caught here too.
    const clauses = parseFiltersParam(url.searchParams.get("filters"));
    const filterError = timeEntriesFilterError(clauses);
    if (filterError) return void sendJson(res, 400, filterError);
    return void sendJson(res, 200, load<unknown>("time_entries.json"));
  }
  if (path === "/api/v3/versions") return void sendJson(res, 200, versions);
  // Project-scoped versions alias — filtered by definingProject.
  const projVersions = /^\/api\/v3\/projects\/(\d+)\/versions$/.exec(path);
  if (projVersions) {
    const pid = projVersions[1]!;
    const coll = versions as { _embedded: { elements: VersionLike[] } };
    const elements = coll._embedded.elements.filter((v) => {
      const href = v._links?.definingProject?.href ?? null;
      const m = href ? /\/projects\/(\d+)/.exec(href) : null;
      return m ? m[1] === pid : false;
    });
    return void sendJson(res, 200, {
      _type: "Collection",
      total: elements.length,
      count: elements.length,
      _embedded: { elements },
      _links: { self: { href: path } },
    });
  }

  sendJson(res, 404, {
    _type: "Error",
    errorIdentifier: "urn:openproject-org:api:v3:errors:NotFound",
    message: `No mock fixture for ${path}`,
  });
}

// ── Scenario mode (OP v3 GETs served from the engine's state) ────────────────

function handleScenarioGet(view: ScenarioView, url: URL, res: ServerResponse): void {
  const path = url.pathname;

  // Increment 4 (SPEC_04 §3): one WP's journal. Checked before the generic
  // /work_packages listing since the path shapes never collide.
  const activities = /^\/api\/v3\/work_packages\/(\d+)\/activities$/.exec(path);
  if (activities) {
    const wpId = Number(activities[1]!);
    const elements = view.journals
      .filter((j) => j.wpId === wpId)
      .map((j) => activityToHal(j, view));
    return void sendJson(res, 200, collection(path, elements));
  }

  if (path === "/api/v3/work_packages") {
    const { offset, pageSize } = pageParams(url);
    const clauses = parseFiltersParam(url.searchParams.get("filters"));
    const sort = parseSortBy(url.searchParams.get("sortBy"));
    const matched = view.workPackages.filter((wp) => workPackageMatches(wp, clauses, view));
    const source = sortWorkPackages(matched, sort).map((wp) => workPackageToHal(wp, view));
    sendJson(
      res,
      200,
      paginateCollection({
        type: "WorkPackageCollection",
        path,
        source,
        offset,
        pageSize,
      }),
    );
    return;
  }

  // Project-scoped work packages (Increment 8 §1 fidelity) — same matching as
  // the global route, plus an implicit project clause from the path.
  const projWorkPackages = /^\/api\/v3\/projects\/(\d+)\/work_packages$/.exec(path);
  if (projWorkPackages) {
    const pid = projWorkPackages[1]!;
    const { offset, pageSize } = pageParams(url);
    const clauses = parseFiltersParam(url.searchParams.get("filters"));
    clauses.push({ field: "project", operator: "=", values: [pid] });
    const sort = parseSortBy(url.searchParams.get("sortBy"));
    const matched = view.workPackages.filter((wp) => workPackageMatches(wp, clauses, view));
    const source = sortWorkPackages(matched, sort).map((wp) => workPackageToHal(wp, view));
    sendJson(
      res,
      200,
      paginateCollection({ type: "WorkPackageCollection", path, source, offset, pageSize }),
    );
    return;
  }

  if (path === "/api/v3/time_entries") {
    const { offset, pageSize } = pageParams(url);
    const clauses = parseFiltersParam(url.searchParams.get("filters"));
    // Real OP 400s the deprecated `workPackage` filter (SPEC_07 §3) — mirror
    // that instead of silently matching on it, so tests catch a caller that
    // still sends it.
    const filterError = timeEntriesFilterError(clauses);
    if (filterError) {
      sendJson(res, 400, filterError);
      return;
    }
    const source = view.timeEntries
      .filter((te) => timeEntryMatches(te, clauses, view))
      .map((te) => timeEntryToHal(te, view));
    sendJson(res, 200, paginateCollection({ type: "Collection", path, source, offset, pageSize }));
    return;
  }

  if (path === "/api/v3/statuses") {
    return void sendJson(res, 200, collection(path, view.statuses.map(statusToHal)));
  }
  if (path === "/api/v3/users/me") {
    // The seed user flagged me:true, else the first seeded user.
    const me = view.users.find((u) => u.me) ?? view.users[0];
    if (me === undefined) {
      return void sendJson(res, 404, {
        _type: "Error",
        errorIdentifier: "urn:openproject-org:api:v3:errors:NotFound",
        message: "Scenario has no seeded users",
      });
    }
    return void sendJson(res, 200, userToHal(me));
  }
  if (path === "/api/v3/users") {
    return void sendJson(res, 200, collection(path, view.users.map(userToHal)));
  }
  // GET /api/v3/memberships (SPEC_13 §1a) — the project's member roster, the
  // NON-admin identity source that replaces the admin-gated /users collection.
  // Scenario users aren't project-scoped, so a project filter returns the whole
  // seeded cast as members of that project (its `_links.principal` carries the
  // id + name identity resolution enriches from). Each seeded user → one
  // membership; the synthetic membership id is distinct from the user id.
  if (path === "/api/v3/memberships") {
    const clauses = parseFiltersParam(url.searchParams.get("filters"));
    const projectClause = clauses.find((c) => c.field === "project");
    const projectId =
      projectClause !== undefined && projectClause.values[0] !== undefined
        ? Number(projectClause.values[0])
        : null;
    const { offset, pageSize } = pageParams(url);
    const source = view.users.map((u, i) =>
      membershipToHal(9000 + i + 1, u, projectId, view),
    );
    return void sendJson(
      res,
      200,
      paginateCollection({ type: "Collection", path, source, offset, pageSize }),
    );
  }
  // GET /api/v3/users/:id (SPEC_11 §4) — single-user name resolution. Unknown
  // id → 404 (exercises the caller's "truly unknown user" fallback). Checked
  // after the "/users" and "/users/me" exact matches (never collides: :id is
  // numeric-only).
  const oneUser = /^\/api\/v3\/users\/(\d+)$/.exec(path);
  if (oneUser) {
    const uid = Number(oneUser[1]!);
    const user = view.users.find((u) => u.id === uid);
    if (user === undefined) {
      return void sendJson(res, 404, {
        _type: "Error",
        errorIdentifier: "urn:openproject-org:api:v3:errors:NotFound",
        message: `User ${uid} not found`,
      });
    }
    return void sendJson(res, 200, userToHal(user));
  }
  if (path === "/api/v3/projects") {
    return void sendJson(res, 200, collection(path, view.projects.map(projectToHal)));
  }
  if (path === "/api/v3/versions") {
    return void sendJson(
      res,
      200,
      collection(path, view.versions.map((v) => versionToHal(v, view))),
    );
  }
  const projVersions = /^\/api\/v3\/projects\/(\d+)\/versions$/.exec(path);
  if (projVersions) {
    const pid = Number(projVersions[1]!);
    const elements = view.versions
      .filter((v) => v.projectId === pid)
      .map((v) => versionToHal(v, view));
    return void sendJson(res, 200, collection(path, elements));
  }
  // Custom-field schema stays the captured static fixture in both modes.
  if (path === "/api/v3/work_packages/schema") return void sendJson(res, 200, schema);

  sendJson(res, 404, {
    _type: "Error",
    errorIdentifier: "urn:openproject-org:api:v3:errors:NotFound",
    message: `No mock endpoint for ${path}`,
  });
}

// ── Request routing (one engine per instance) ────────────────────────────────

async function route(
  engine: ScenarioEngine,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  // Logging is opt-in (keeps test output clean); enable with MOCK_OP_LOG=1.
  if (process.env.MOCK_OP_LOG) {
    // eslint-disable-next-line no-console
    console.log(`[mock-op] ${method} ${req.url}`);
  }

  try {
    // Admin namespace — NOT OpenProject; the only place mutations are allowed.
    if (path === "/__mock" || path.startsWith("/__mock/")) {
      await handleAdmin(engine, method, path, req, res);
      return;
    }

    // Read-only: refuse anything but GET (mirrors the real constraint).
    if (method !== "GET") {
      sendJson(res, 405, {
        _type: "Error",
        errorIdentifier: "urn:openproject-org:api:v3:errors:MethodNotAllowed",
        message: "Mock OpenProject is read-only; only GET is allowed.",
      });
      return;
    }

    // SPEC_19 §2 abort-test harness: delay ONLY work_packages collection
    // responses (both modes), so a paged sync stays in flight long enough to
    // click Abort. Applied here — after the read-only/method guards, before we
    // serialize the page — so it slows exactly the loop the sync engine pages
    // over. 0 (the default, and after any load/reset) is a no-op.
    const latency = engine.workPackagesLatency;
    if (latency > 0 && isWorkPackagesCollectionPath(path)) {
      await sleep(latency);
    }

    const view = engine.view();
    if (view !== null) handleScenarioGet(view, url, res);
    else handleFixtureGet(url, res);
  } catch (err) {
    if (err instanceof MockEngineError) {
      sendJson(res, err.status, { error: err.message });
      return;
    }
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

// ── Public factory + instances ───────────────────────────────────────────────

export interface MockOpHandlerOptions {
  /** Inject scenarios directly (tests); default = lazy ../scenarios registry. */
  scenarios?: Scenario[];
}

export interface MockOpInstance {
  engine: ScenarioEngine;
  handler: (req: IncomingMessage, res: ServerResponse) => void;
}

/**
 * Build a request handler with its OWN ScenarioEngine. Every server instance
 * (module singleton, recording servers, ad-hoc test servers) calls this, so
 * scenario state is never shared between instances.
 */
export function createMockOpHandler(options: MockOpHandlerOptions = {}): MockOpInstance {
  const engine = new ScenarioEngine(options.scenarios ?? loadScenarioRegistry);
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    // route() catches everything (incl. engine errors) — safe to fire-and-forget.
    void route(engine, req, res);
  };
  return { engine, handler };
}

/** Default port of the SECOND mock OP instance (`pnpm mock:op2`, SPEC_02 §7). */
export const SECOND_MOCK_OP_PORT = 8098;

/**
 * A base URL where nothing ever listens (port 9 = discard) — the intentionally
 * unreachable server for exercising the fail/red health states (SPEC_02 §7).
 * Connecting fails fast with ECONNREFUSED; no server needs to be started.
 */
export const UNREACHABLE_OP_URL = "http://127.0.0.1:9";

// Module-level singleton (legacy export) — with its own private engine.
const singleton = createMockOpHandler();

export const mockOpServer = createServer(singleton.handler);

/** The module-level server's engine (drives it via HTTP or directly). */
export const mockOpServerEngine = singleton.engine;

/** Start the server; returns the http.Server. Importable for tests. */
export function startMockOpServer(
  port = Number(process.env.MOCK_OP_PORT ?? 8099),
  host = process.env.MOCK_OP_HOST ?? "127.0.0.1",
): typeof mockOpServer {
  mockOpServer.listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(`[mock-op] listening on http://${host}:${port}`);
  });
  return mockOpServer;
}

// ── Recording factory (Agent D / tests) ─────────────────────────────────────

/** One observed inbound request (used by the read-only guard test). */
export interface RecordedRequest {
  method: string;
  path: string;
  search: string;
}

/**
 * A fresh, isolated mock OP server bound to an ephemeral port, which RECORDS
 * every HTTP method + path it receives — including /__mock/* admin traffic
 * (Agent V drives scenarios on ephemeral recording instances). Integration /
 * read-only-guard tests use this to assert that across a full sync run ZERO
 * non-GET requests arrive at /api/v3/* (SPEC §2). Unlike the module-level
 * `mockOpServer` singleton, each call gets its own `http.Server` AND its own
 * ScenarioEngine, so tests can run in isolation and in parallel.
 */
export interface RecordingMockOpServer {
  server: Server;
  /** Every method received, in order (e.g. ["GET","GET",...]). */
  methods: string[];
  /** Every request received, in order. */
  requests: RecordedRequest[];
  /** Base URL, e.g. "http://127.0.0.1:54123". */
  url: string;
  port: number;
  /** This instance's private scenario engine. */
  engine: ScenarioEngine;
  /** Distinct set of methods observed so far. */
  methodSet(): Set<string>;
  /** Clear the recorded history (e.g. between phases of a test). */
  reset(): void;
  close(): Promise<void>;
}

/** Start a fresh recording mock OP server on an ephemeral port. */
export function createRecordingMockOpServer(
  host = "127.0.0.1",
  options: MockOpHandlerOptions = {},
): Promise<RecordingMockOpServer> {
  const methods: string[] = [];
  const requests: RecordedRequest[] = [];
  const instance = createMockOpHandler(options);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    methods.push(req.method ?? "GET");
    requests.push({
      method: req.method ?? "GET",
      path: url.pathname,
      search: url.search,
    });
    instance.handler(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, host, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        server,
        methods,
        requests,
        url: `http://${host}:${port}`,
        port,
        engine: instance.engine,
        methodSet: () => new Set(methods),
        reset: () => {
          methods.length = 0;
          requests.length = 0;
        },
        close: () =>
          new Promise<void>((res, rej) =>
            server.close((err) => (err ? rej(err) : res())),
          ),
      });
    });
  });
}

// Re-export the engine surface so "@osp/fixtures" is the single entry point.
export {
  loadScenarioRegistry,
  MockEngineError,
  ScenarioEngine,
} from "./engine";
export type {
  EngineJournal,
  EngineJournalDetail,
  EngineTimeEntry,
  EngineUser,
  EngineVersion,
  EngineWorkPackage,
  ScenarioRegistry,
  ScenarioView,
} from "./engine";
export { hoursToIsoDuration } from "./hal";
