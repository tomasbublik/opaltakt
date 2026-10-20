import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRecordingMockOpServer,
  type RecordingMockOpServer,
} from "@osp/fixtures";
import {
  createOpClient,
  ReadOnlyViolationError,
  type OpRequestOptions,
} from "@osp/op-client";
import {
  AddConnectionResponse,
  BacklogResponse,
  SprintResponse,
  SyncRun,
} from "@osp/contracts";
// Direct heartbeat import (Agent A, apps/api source — same pattern as harness.ts).
import { startHeartbeat } from "../../apps/api/src/scheduler/heartbeat";
import {
  activateSprint,
  addConnection,
  bootRealApp,
  call,
  connectToOp,
  initAndUnlockVault,
  type RealApp,
} from "./harness";
import { addDays, mockAdmin, OPERATOR_MARK, S2, S4 } from "./scenario-helpers";

/**
 * READ-ONLY GUARD (SPEC §2 — the hard, non-negotiable constraint).
 *
 * Two independent layers of proof:
 *   1. Unit — the op-client `request()` primitive MUST throw
 *      ReadOnlyViolationError for POST/PATCH/PUT/DELETE *before any network I/O*
 *      (asserted by a recording OP server that observes ZERO requests for those
 *      attempts). Every high-level client method must also only ever GET.
 *   2. System — boot the REAL Fastify app + REAL sync engine against a recording
 *      mock OP server, drive a full connect → projects → sync → backlog flow, and
 *      assert the DISTINCT set of HTTP methods that reached OP is exactly {GET}.
 *      Nothing anywhere may POST/PATCH/PUT/DELETE to OpenProject.
 */

const NON_GET: ReadonlyArray<"POST" | "PATCH" | "PUT" | "DELETE"> = [
  "POST",
  "PATCH",
  "PUT",
  "DELETE",
];

describe("read-only guard (op-client, unit)", () => {
  let mock: RecordingMockOpServer;

  beforeAll(async () => {
    mock = await createRecordingMockOpServer();
  });
  afterAll(async () => {
    await mock.close();
  });

  it("request() throws ReadOnlyViolationError for every non-GET method, before any network call", () => {
    const client = createOpClient({ baseUrl: mock.url, token: "t" });
    for (const method of NON_GET) {
      // `method` is typed to GET-only; cast to attempt a violation at runtime.
      const opts = { path: "/api/v3/users/me", method } as unknown as OpRequestOptions;
      expect(() => client.request(opts)).toThrow(ReadOnlyViolationError);
    }
    // The guard fired synchronously — NOT ONE request reached OpenProject.
    expect(mock.requests).toHaveLength(0);
    expect(mock.methods).toEqual([]);
  });

  it("a legitimate GET does reach OP (proves the recorder actually records)", async () => {
    mock.reset();
    const client = createOpClient({ baseUrl: mock.url, token: "t" });
    const me = await client.getCurrentUser();
    expect(me.id).toBe(1);
    expect(mock.methodSet()).toEqual(new Set(["GET"]));
  });

  it("exercising every high-level client method emits GET and only GET", async () => {
    mock.reset();
    const client = createOpClient({ baseUrl: mock.url, token: "t" });
    await client.getCurrentUser();
    await client.getProjects();
    await client.getWorkPackages({ pageSize: 2, offset: 1 });
    await client.getTimeEntries({});
    await client.getVersions();
    await client.getVersions(3);
    await client.getStatuses();
    await client.getWorkPackageSchema();
    expect(mock.requests.length).toBeGreaterThan(0);
    expect(mock.methodSet()).toEqual(new Set(["GET"]));
  });
});

describe("read-only guard (full app + sync + vault + health, system)", () => {
  let mock: RecordingMockOpServer;
  let mock2: RecordingMockOpServer;
  let harness: RealApp;
  let connectionId: number;

  beforeAll(async () => {
    mock = await createRecordingMockOpServer();
    mock2 = await createRecordingMockOpServer();
    harness = await bootRealApp();
  });
  afterAll(async () => {
    await harness.close();
    await mock.close();
    await mock2.close();
  });

  it("full Increment-2 flow — vault init → add connection → sync → add-by-id → health check — touches OP with GET only", async () => {
    const vault = await initAndUnlockVault(harness.app);
    expect(vault.status).toBeGreaterThanOrEqual(200);
    expect(vault.status).toBeLessThan(300);
    // Vault endpoints are local-only: nothing may have reached OP yet.
    expect(mock.requests).toHaveLength(0);

    const conn = await addConnection(harness.app, mock.url, "sync-token", {
      default_project_op_id: 3,
    });
    expect(conn.status).toBe(201);
    connectionId = AddConnectionResponse.parse(conn.json).id;

    const projects = await call(harness.app, "GET", "/api/projects");
    expect(projects.status).toBe(200);

    const sync = await call(harness.app, "POST", "/api/sync", { project_op_id: 3 });
    expect(sync.status).toBe(200);
    expect(SyncRun.parse(sync.json).status).toBe("success");

    const backlog = await call(harness.app, "GET", "/api/backlog?projectId=3");
    expect(backlog.status).toBe(200);

    // Add a single ticket by OP id (targets a WP the project sync never saw).
    const byId = await call(harness.app, "POST", "/api/work-packages", {
      op_id: 1013,
    });
    expect(byId.status).toBe(201);

    // Explicit health check — SPEC_02 §8: "health check je GET".
    const test = await call(
      harness.app,
      "POST",
      `/api/connections/${connectionId}/test`,
    );
    expect(test.status).toBe(200);

    // THE assertion: across the entire run, OpenProject saw GET and nothing else.
    expect(mock.requests.length).toBeGreaterThan(0);
    expect(mock.methodSet()).toEqual(new Set(["GET"]));
    // Belt-and-suspenders: no single recorded request was a mutation.
    const mutations = mock.requests.filter((r) => r.method !== "GET");
    expect(mutations).toEqual([]);
  });

  it("a direct heartbeat tick (Agent A scheduler) probes OP with GET only", async () => {
    mock.reset();
    const heartbeat = startHeartbeat({
      // One idle candidate pointing at the recorder; never-active → always due.
      listConnections: async () => [
        {
          id: connectionId,
          base_url: mock.url,
          last_activity_at: null,
          last_check_at: null,
          has_token: true,
          enabled: true,
        },
      ],
      isVaultLocked: () => false,
      getClientConfig: async () => ({ baseUrl: mock.url, token: "sync-token" }),
      recordCheck: async () => {},
      tickMs: 3_600_000, // never fires on its own; we drive tickNow()
    });
    try {
      await heartbeat.tickNow();
    } finally {
      heartbeat.stop();
    }
    expect(mock.requests.length).toBeGreaterThan(0);
    expect(mock.methodSet()).toEqual(new Set(["GET"]));
    // The probe is exactly the documented health check endpoint.
    expect(mock.requests.every((r) => r.path === "/api/v3/users/me")).toBe(true);
  });

  it("a SECOND registered server (multi-connection) also only ever sees GET", async () => {
    const conn2 = await addConnection(harness.app, mock2.url, "second-token");
    expect(conn2.status).toBe(201);
    const id2 = AddConnectionResponse.parse(conn2.json).id;

    const test2 = await call(harness.app, "POST", `/api/connections/${id2}/test`);
    expect(test2.status).toBe(200);

    // Aggregate health walks ALL servers — still nothing but GET anywhere.
    const health = await call(harness.app, "GET", "/api/connections/health");
    expect(health.status).toBe(200);

    expect(mock2.requests.length).toBeGreaterThan(0);
    expect(mock2.methodSet()).toEqual(new Set(["GET"]));
    expect(mock.methodSet()).toEqual(new Set(["GET"])); // first server untouched by mutations too
  });
});

describe("read-only guard (Increment 4 — full sprint lifecycle is GET-only, system)", () => {
  let mock: RecordingMockOpServer;
  let harness: RealApp;

  beforeAll(async () => {
    mock = await createRecordingMockOpServer();
    harness = await bootRealApp();
  });
  afterAll(async () => {
    await harness.close();
    await mock.close();
  });

  it("connect → sync → activate → update×3 → finish emits GET /api/v3/* only, incl. the activities + time_entries reads", async () => {
    await connectToOp(harness.app, mock.url, "lifecycle-token", 3);
    const sync = await call(harness.app, "POST", "/api/sync", { project_op_id: 3 });
    expect(sync.status).toBe(200);
    expect(SyncRun.parse(sync.json).status).toBe("success");

    const backlog = BacklogResponse.parse(
      (await call(harness.app, "GET", "/api/backlog?projectId=3")).json,
    );
    expect(backlog.length).toBeGreaterThanOrEqual(2);

    const created = await call(harness.app, "POST", "/api/sprints", {
      name: "read-only lifecycle sprint",
      start_date: "2026-07-01",
      end_date: "2026-07-09",
    });
    const sprintId = SprintResponse.parse(created.json).id;
    for (const wp of backlog.slice(0, 2)) {
      await call(harness.app, "POST", `/api/sprints/${sprintId}/items`, { wp_op_id: wp.op_id });
    }

    const activated = await activateSprint(harness.app, sprintId);
    expect(activated.status, `activate: ${JSON.stringify(activated.json)}`).toBe(200);
    for (let i = 0; i < 3; i += 1) {
      const upd = await call(harness.app, "POST", `/api/sprints/${sprintId}/update`, {});
      expect(upd.status, `update ${i}: ${JSON.stringify(upd.json)}`).toBe(200);
    }
    const finish = await call(harness.app, "POST", `/api/sprints/${sprintId}/finish`, {});
    expect(finish.status, `finish: ${JSON.stringify(finish.json)}`).toBe(200);

    // THE assertion: the whole lifecycle spoke to OpenProject with GET only,
    // including the changelog-engine reads (activities + time_entries).
    const v3 = mock.requests.filter((r) => r.path.startsWith("/api/v3/"));
    expect(v3.length).toBeGreaterThan(0);
    expect(new Set(v3.map((r) => r.method))).toEqual(new Set(["GET"]));
    expect(
      v3.some((r) => /\/api\/v3\/work_packages\/\d+\/activities$/.test(r.path)),
      "the update engine must have read journals (activities)",
    ).toBe(true);
    expect(
      v3.some((r) => r.path === "/api/v3/time_entries"),
      "the update engine must have read time entries",
    ).toBe(true);
    // Belt-and-suspenders: no mutation anywhere.
    expect(mock.requests.filter((r) => r.method !== "GET")).toEqual([]);
  }, 60_000);
});

describe("read-only guard (SPEC_03 scenario mode — /__mock/* is operator-only)", () => {
  let mock: RecordingMockOpServer;
  let harness: RealApp;

  beforeAll(async () => {
    mock = await createRecordingMockOpServer();
    harness = await bootRealApp();
  });
  afterAll(async () => {
    await harness.close();
    await mock.close();
  });

  it("with a scenario loaded, the app's full flow still emits GET /api/v3/* only — every /__mock hit is the operator's own", async () => {
    // The OPERATOR (this test) drives the scenario. Every admin request goes
    // through mockAdmin(), which tags itself with ?operator=1 — so afterwards we
    // can attribute 100% of the /__mock traffic and prove the app made NONE.
    const admin = mockAdmin(mock.url);
    await admin.requireScenario(S2);
    const loaded = await admin.load(S2);
    expect(loaded.scenario).toBe(S2);

    // The app's full Increment-2/3 flow against the scenario state.
    await initAndUnlockVault(harness.app);
    const conn = await addConnection(harness.app, mock.url, "scenario-token", {
      default_project_op_id: 3,
    });
    expect(conn.status).toBe(201);
    const connectionId = AddConnectionResponse.parse(conn.json).id;

    const sync = await call(harness.app, "POST", "/api/sync", { project_op_id: 3 });
    expect(sync.status).toBe(200);
    expect(SyncRun.parse(sync.json).status).toBe("success");

    // Add a single ticket by OP id (scenario ids live at 5001+, per contract).
    const anyWpId = loaded.work_packages[0]?.id;
    expect(anyWpId).toBeDefined();
    const byId = await call(harness.app, "POST", "/api/work-packages", {
      op_id: anyWpId,
    });
    expect(byId.status).toBe(201);

    // Explicit health check (GET /users/me under the hood).
    const test = await call(
      harness.app,
      "POST",
      `/api/connections/${connectionId}/test`,
    );
    expect(test.status).toBe(200);

    // Operator moves the clock mid-flow, app syncs again — still nothing but GET.
    await admin.advanceDay();
    const resync = await call(harness.app, "POST", "/api/sync", {});
    expect(resync.status).toBe(200);

    // ── grep of traffic (SPEC_03 §9) ─────────────────────────────────────────
    // 1. On the OpenProject namespace, the DISTINCT method set is exactly {GET}.
    const v3 = mock.requests.filter((r) => r.path.startsWith("/api/v3/"));
    expect(v3.length).toBeGreaterThan(0);
    expect(new Set(v3.map((r) => r.method))).toEqual(new Set(["GET"]));

    // 2. The APP never requested any /__mock/* path: every recorded /__mock hit
    //    carries the operator tag that only this test's admin client appends.
    const adminHits = mock.requests.filter((r) => r.path.startsWith("/__mock/"));
    expect(adminHits.length).toBeGreaterThan(0); // load + advance-day + …
    for (const r of adminHits) {
      expect(
        r.search.includes(OPERATOR_MARK),
        `untagged /__mock request — the app must never call the admin API: ${r.method} ${r.path}${r.search}`,
      ).toBe(true);
    }

    // 3. Belt-and-suspenders: every non-GET request anywhere is operator /__mock.
    for (const r of mock.requests.filter((r) => r.method !== "GET")) {
      expect(r.path.startsWith("/__mock/"), `${r.method} ${r.path}`).toBe(true);
    }
  }, 60_000);
});

describe("read-only guard (Increment 5 — live scope changes stay GET-only, system)", () => {
  let mock: RecordingMockOpServer;
  let harness: RealApp;

  beforeAll(async () => {
    mock = await createRecordingMockOpServer();
  });
  afterAll(async () => {
    if (harness) await harness.close();
    await mock.close();
  });

  it("connect → sync → activate → mid-sprint add → update → mid-sprint remove → finish is GET-only on /api/v3/*", async () => {
    const admin = mockAdmin(mock.url);
    await admin.requireScenario(S4);
    const clock = { now: new Date("2026-07-01T00:00:00.000Z") };
    harness = await bootRealApp({ now: () => clock.now });

    const loaded = await admin.load(S4);
    const d0 = loaded.date!;

    await connectToOp(harness.app, mock.url, "inc5-token", 3);
    const sync = await call(harness.app, "POST", "/api/sync", { project_op_id: 3 });
    expect(SyncRun.parse(sync.json).status).toBe("success");

    const created = await call(harness.app, "POST", "/api/sprints", {
      name: "Increment-5 read-only sprint",
      start_date: d0,
      end_date: addDays(d0, 8),
    });
    const sprintId = SprintResponse.parse(created.json).id;
    for (const wp of [1401, 1403]) {
      const added = await call(harness.app, "POST", `/api/sprints/${sprintId}/items`, { wp_op_id: wp });
      expect(added.status, `add ${wp}: ${JSON.stringify(added.json)}`).toBe(201);
    }
    expect((await activateSprint(harness.app, sprintId)).status).toBe(200);

    // Advance to day 3 so the urgent WP exists in OP, then ADD it mid-sprint.
    for (let n = 1; n <= 3; n += 1) {
      const adv = await admin.advanceDay();
      clock.now = new Date(`${adv.date}T12:00:00.000Z`);
    }
    const midAdd = await call(harness.app, "POST", `/api/sprints/${sprintId}/items`, { wp_op_id: 1451 });
    expect(midAdd.status, `mid-sprint add: ${JSON.stringify(midAdd.json)}`).toBe(201);

    // Mid-sprint update pass.
    const upd = await call(harness.app, "POST", `/api/sprints/${sprintId}/update`, {});
    expect(upd.status, `mid-sprint update: ${JSON.stringify(upd.json)}`).toBe(200);

    // Mid-sprint remove (local only — must not touch OP at all).
    const midRemove = await call(harness.app, "DELETE", `/api/sprints/${sprintId}/items/1403`);
    expect(midRemove.status, `mid-sprint remove: ${JSON.stringify(midRemove.json)}`).toBeLessThan(300);

    const finish = await call(harness.app, "POST", `/api/sprints/${sprintId}/finish`, {});
    expect(finish.status, `finish: ${JSON.stringify(finish.json)}`).toBe(200);

    // THE assertion: across the WHOLE live-scope lifecycle, OP saw GET only.
    const v3 = mock.requests.filter((r) => r.path.startsWith("/api/v3/"));
    expect(v3.length).toBeGreaterThan(0);
    expect(new Set(v3.map((r) => r.method))).toEqual(new Set(["GET"]));
    expect(mock.requests.filter((r) => r.method !== "GET" && r.path.startsWith("/api/v3/"))).toEqual([]);
  }, 90_000);
});
