import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AdvanceDayResult, Scenario } from "../scenario-types";
import { createRecordingMockOpServer, type RecordingMockOpServer } from "./index";

/**
 * HTTP-level tests of scenario mode: OP v3 GETs from state, the /__mock/*
 * admin API, per-instance isolation and the advance-day app helper — driven
 * through real sockets exactly like the app and Agent M2's panel/CLI will.
 */

function httpScenario(): Scenario {
  return {
    name: "http-mini",
    description: "scenario-mode HTTP test",
    startDate: "2026-07-01",
    seed: {
      users: [
        { key: "dev", id: 11, name: "Dev One", login: "dev", me: true },
        { key: "tester", id: 12, name: "Tess Tester" },
        { key: "customer", id: 13, name: "Cust Omer" },
      ],
      versions: [{ key: "sprint1", id: 900, name: "Sprint 1", projectId: 3 }],
      workPackages: [
        {
          key: "epic",
          subject: "Epic over 80h",
          project: 3,
          status: "In progress",
          assignee: "dev",
          accountable: "customer",
          estimatedHours: 80,
          remainingHours: 80,
          version: "sprint1",
        },
        {
          key: "small",
          subject: "Small task",
          project: 3,
          status: "New",
          assignee: "tester",
          estimatedHours: 7.5,
          remainingHours: 7.5,
        },
      ],
      timeEntries: [{ wp: "epic", user: "dev", hours: 2, spentOn: "2026-06-30" }],
    },
    timeline: [
      {
        day: 1,
        events: [
          { t: "logTime", wp: "epic", user: "dev", hours: 6 },
          { t: "setRemaining", wp: "epic", hours: 74 },
        ],
      },
      {
        day: 3,
        events: [
          {
            t: "addWorkPackage",
            wp: {
              key: "added",
              subject: "Scope creep",
              project: 3,
              status: "New",
              assignee: "dev",
              estimatedHours: 4,
            },
          },
        ],
      },
    ],
  };
}

interface HalWp {
  id: number;
  subject: string;
  estimatedTime: string | null;
  remainingTime: string | null;
  spentTime: string | null;
  updatedAt: string;
  _links: Record<string, { href: string | null; title?: string }>;
}

interface HalCollection<T> {
  _type: string;
  total: number;
  count: number;
  pageSize: number;
  offset: number;
  _embedded: { elements: T[] };
  _links: Record<string, { href: string } | undefined>;
}

let mock: RecordingMockOpServer;

beforeAll(async () => {
  mock = await createRecordingMockOpServer("127.0.0.1", {
    scenarios: [httpScenario()],
  });
});
afterAll(async () => {
  await mock.close();
});

beforeEach(async () => {
  // Every test starts freshly loaded at day 0 (load = full reset).
  const res = await fetch(`${mock.url}/__mock/load/http-mini`, { method: "POST" });
  expect(res.status).toBe(200);
});

async function getJson<T>(path: string): Promise<{ status: number; json: T }> {
  const res = await fetch(`${mock.url}${path}`);
  return { status: res.status, json: (await res.json()) as T };
}

async function postJson<T>(path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${mock.url}${path}`, {
    method: "POST",
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as T };
}

function filtersParam(filters: unknown[]): string {
  return `filters=${encodeURIComponent(JSON.stringify(filters))}`;
}

describe("scenario mode — /api/v3/work_packages from state", () => {
  it("serves HAL WPs: ISO durations, spentTime null, separate accountable link", async () => {
    const { json } = await getJson<HalCollection<HalWp>>(
      "/api/v3/work_packages?pageSize=100",
    );
    expect(json._type).toBe("WorkPackageCollection");
    expect(json.total).toBe(2);

    const epic = json._embedded.elements.find((wp) => wp.id === 5001)!;
    // 80h ≥ 24h → real-OP-style day component (Increment 22): 80 == 3*24 + 8.
    expect(epic.estimatedTime).toBe("P3DT8H");
    expect(epic.remainingTime).toBe("P3DT8H");
    // spentTime is ALWAYS null in scenario mode → app must aggregate time entries.
    expect(epic.spentTime).toBeNull();
    expect(epic._links["assignee"]).toEqual({ href: "/api/v3/users/11", title: "Dev One" });
    // accountable is a SEPARATE link (SPEC_03 §2a), not derived from assignee.
    expect(epic._links["accountable"]).toEqual({
      href: "/api/v3/users/13",
      title: "Cust Omer",
    });
    expect(epic._links["status"]).toEqual({ href: "/api/v3/statuses/7", title: "In progress" });
    expect(epic._links["version"]).toEqual({ href: "/api/v3/versions/900", title: "Sprint 1" });
    expect(epic._links["project"]?.href).toBe("/api/v3/projects/3");

    const small = json._embedded.elements.find((wp) => wp.id === 5002)!;
    expect(small.estimatedTime).toBe("PT7H30M"); // 7.5h → fractional → minutes
    expect(small._links["accountable"]).toEqual({ href: null });
    expect(small._links["version"]).toEqual({ href: null });
  });

  it("keeps the legacy pagination defaults (pageSize 2 + offset links)", async () => {
    const { json } = await getJson<HalCollection<HalWp>>("/api/v3/work_packages");
    expect(json.pageSize).toBe(2);
    expect(json.offset).toBe(1);
    expect(json.count).toBe(2);
    expect(json._links["nextByOffset"]).toBeUndefined(); // exactly 2 WPs
  });

  it("filters by status NAME and by status id", async () => {
    for (const value of ["New", "1"]) {
      const { json } = await getJson<HalCollection<HalWp>>(
        `/api/v3/work_packages?${filtersParam([
          { status: { operator: "=", values: [value] } },
        ])}&pageSize=100`,
      );
      expect(json.total).toBe(1);
      expect(json._embedded.elements[0]?.id).toBe(5002);
    }
  });

  it("filters by assignee", async () => {
    const { json } = await getJson<HalCollection<HalWp>>(
      `/api/v3/work_packages?${filtersParam([
        { assignee: { operator: "=", values: ["11"] } },
      ])}&pageSize=100`,
    );
    expect(json.total).toBe(1);
    expect(json._embedded.elements[0]?.id).toBe(5001);
  });

  it("filters by id and project (sync engine's scoping)", async () => {
    const { json } = await getJson<HalCollection<HalWp>>(
      `/api/v3/work_packages?${filtersParam([
        { project: { operator: "=", values: ["3"] } },
        { id: { operator: "=", values: ["5001"] } },
      ])}&pageSize=100`,
    );
    expect(json.total).toBe(1);
    expect(json._embedded.elements[0]?.subject).toBe("Epic over 80h");
  });

  it("updatedAt >=d: a WP added on day 3 is the ONLY incremental hit for a day-2 marker", async () => {
    await postJson("/__mock/goto-day/3");
    const { json } = await getJson<HalCollection<HalWp>>(
      `/api/v3/work_packages?${filtersParam([
        { updatedAt: { operator: ">=d", values: ["2026-07-03T00:00:00Z"] } },
      ])}&pageSize=100`,
    );
    expect(json.total).toBe(1);
    expect(json._embedded.elements[0]?.subject).toBe("Scope creep");
    expect(json._embedded.elements[0]?.updatedAt).toBe("2026-07-04T09:00:00Z");
  });

  it("supports sortBy id/updatedAt asc|desc (default id asc)", async () => {
    await postJson("/__mock/goto-day/3");
    const byIdDesc = await getJson<HalCollection<HalWp>>(
      `/api/v3/work_packages?sortBy=${encodeURIComponent('[["id","desc"]]')}&pageSize=100`,
    );
    expect(byIdDesc.json._embedded.elements.map((wp) => wp.id)).toEqual([5003, 5002, 5001]);
    const byUpdatedDesc = await getJson<HalCollection<HalWp>>(
      `/api/v3/work_packages?sortBy=${encodeURIComponent('[["updatedAt","desc"]]')}&pageSize=100`,
    );
    expect(byUpdatedDesc.json._embedded.elements[0]?.id).toBe(5003);
    const defaultSort = await getJson<HalCollection<HalWp>>("/api/v3/work_packages?pageSize=100");
    expect(defaultSort.json._embedded.elements.map((wp) => wp.id)).toEqual([5001, 5002, 5003]);
  });

  it("keeps /api/v3/* GET-only in scenario mode too", async () => {
    const res = await fetch(`${mock.url}/api/v3/work_packages`, { method: "POST" });
    expect(res.status).toBe(405);
  });
});

describe("scenario mode — /api/v3/time_entries from state", () => {
  interface HalTe {
    id: number;
    hours: string;
    spentOn: string;
    _links: Record<string, { href: string | null; title?: string }>;
  }

  it("serves entries with ISO hours, spentOn and workPackage/user/project links", async () => {
    await postJson("/__mock/advance-day"); // day 1 logs 6h on the epic
    const { json } = await getJson<HalCollection<HalTe>>("/api/v3/time_entries?pageSize=100");
    expect(json.total).toBe(2);
    const logged = json._embedded.elements.find((te) => te.spentOn === "2026-07-02")!;
    expect(logged.hours).toBe("PT6H");
    expect(logged._links["workPackage"]?.href).toBe("/api/v3/work_packages/5001");
    expect(logged._links["user"]?.href).toBe("/api/v3/users/11");
    expect(logged._links["project"]?.href).toBe("/api/v3/projects/3");
  });

  it("filters by entity_type+entity_id, project_id and spentOn (single date, = and =d)", async () => {
    await postJson("/__mock/advance-day");
    const byWp = await getJson<HalCollection<HalTe>>(
      `/api/v3/time_entries?${filtersParam([
        { entity_type: { operator: "=", values: ["WorkPackage"] } },
        { entity_id: { operator: "=", values: ["5001"] } },
      ])}&pageSize=100`,
    );
    expect(byWp.json.total).toBe(2);
    for (const operator of ["=", "=d"]) {
      const bySpentOn = await getJson<HalCollection<HalTe>>(
        `/api/v3/time_entries?${filtersParam([
          { spentOn: { operator, values: ["2026-07-02"] } },
        ])}&pageSize=100`,
      );
      expect(bySpentOn.json.total).toBe(1);
      expect(bySpentOn.json._embedded.elements[0]?.hours).toBe("PT6H");
    }
    const byProject = await getJson<HalCollection<HalTe>>(
      `/api/v3/time_entries?${filtersParam([
        { project_id: { operator: "=", values: ["3"] } },
      ])}&pageSize=100`,
    );
    expect(byProject.json.total).toBe(2);
  });

  it("rejects the deprecated workPackage filter with 400 InvalidQuery (SPEC_07 §3)", async () => {
    await postJson("/__mock/advance-day");
    const res = await getJson<{ _type: string; errorIdentifier: string; message: string }>(
      `/api/v3/time_entries?${filtersParam([
        { workPackage: { operator: "=", values: ["5001"] } },
      ])}&pageSize=100`,
    );
    expect(res.status).toBe(400);
    expect(res.json.errorIdentifier).toBe("urn:openproject-org:api:v3:errors:InvalidQuery");
  });

  it("paginates like the work packages listing (fetch-all loop compatible)", async () => {
    await postJson("/__mock/advance-day");
    const page1 = await getJson<HalCollection<HalTe>>("/api/v3/time_entries?pageSize=1");
    expect(page1.json.total).toBe(2);
    expect(page1.json.count).toBe(1);
    expect(page1.json._links["nextByOffset"]?.href).toBe(
      "/api/v3/time_entries?offset=2&pageSize=1",
    );
    const page2 = await getJson<HalCollection<HalTe>>(
      "/api/v3/time_entries?pageSize=1&offset=2",
    );
    expect(page2.json.count).toBe(1);
    expect(page2.json._embedded.elements[0]?.id).not.toBe(
      page1.json._embedded.elements[0]?.id,
    );
  });
});

describe("scenario mode — reference endpoints from state", () => {
  it("statuses / users / users/me / projects / versions come from the seed", async () => {
    const statuses = await getJson<HalCollection<{ id: number; isClosed: boolean }>>(
      "/api/v3/statuses",
    );
    expect(statuses.json.total).toBe(10); // CANONICAL_STATUSES default
    expect(
      statuses.json._embedded.elements.filter((s) => s.isClosed).map((s) => s.id).sort(),
    ).toEqual([12, 14, 15]);

    const me = await getJson<{ id: number; name: string }>("/api/v3/users/me");
    expect(me.json).toMatchObject({ id: 11, name: "Dev One" });

    const users = await getJson<HalCollection<{ id: number }>>("/api/v3/users");
    expect(users.json._embedded.elements.map((u) => u.id)).toEqual([11, 12, 13]);

    const projects = await getJson<HalCollection<{ id: number; identifier: string }>>(
      "/api/v3/projects",
    );
    expect(projects.json._embedded.elements[0]).toMatchObject({
      id: 3,
      identifier: "demo-project",
    });

    const versions = await getJson<
      HalCollection<{ id: number; _links: { definingProject: { href: string } } }>
    >("/api/v3/projects/3/versions");
    expect(versions.json.total).toBe(1);
    expect(versions.json._embedded.elements[0]?._links.definingProject.href).toBe(
      "/api/v3/projects/3",
    );

    const empty = await getJson<HalCollection<unknown>>("/api/v3/projects/999/versions");
    expect(empty.json.total).toBe(0);
  });

  it("memberships (SPEC_13 §1a) — the seeded cast as a project's roster, principal id+name", async () => {
    const filters = filtersParam([{ project: { operator: "=", values: ["3"] } }]);
    const memberships = await getJson<
      HalCollection<{
        _type: string;
        _links: { principal: { href: string; title: string }; project: { href: string } };
      }>
    >(`/api/v3/memberships?${filters}&pageSize=100`);
    const els = memberships.json._embedded.elements;
    // One membership per seeded user (http-mini seeds ids 11/12/13).
    expect(els.map((m) => m._links.principal.href).sort()).toEqual([
      "/api/v3/users/11",
      "/api/v3/users/12",
      "/api/v3/users/13",
    ]);
    // The load-bearing bit for identity: principal carries BOTH id (href) + name.
    expect(els.every((m) => m._type === "Membership" && m._links.principal.title.length > 0)).toBe(
      true,
    );
    // The project filter is echoed onto each membership.
    expect(els.every((m) => m._links.project.href === "/api/v3/projects/3")).toBe(true);
  });
});

describe("admin API — state, inject-urgent, reset, validation", () => {
  it("GET /__mock/state reflects the loaded scenario", async () => {
    const { json } = await getJson<Record<string, unknown>>("/__mock/state");
    expect(json).toMatchObject({
      scenario: "http-mini",
      day: 0,
      date: "2026-07-01",
      total_days: 3,
      pending_days: 2,
    });
    const wps = json["work_packages"] as Array<Record<string, unknown>>;
    expect(wps.map((wp) => wp["key"])).toEqual(["epic", "small"]);
    expect(wps[0]).toMatchObject({ spent_hours: 2, assignee: "dev", accountable: "customer" });
  });

  it("POST /__mock/inject-urgent adds a WP visible to the OP listing with a bumped updatedAt", async () => {
    const { status, json } = await postJson<{ work_package: Record<string, unknown> }>(
      "/__mock/inject-urgent",
    );
    expect(status).toBe(200);
    expect(json.work_package).toMatchObject({ key: "urgent-1", id: 5003 });

    const listing = await getJson<HalCollection<HalWp>>("/api/v3/work_packages?pageSize=100");
    const urgent = listing.json._embedded.elements.find((wp) => wp.id === 5003)!;
    expect(urgent.subject).toMatch(/URGENT/);
    expect(urgent.updatedAt).toBe("2026-07-01T09:00:00Z"); // first mutation of day 0
  });

  it("POST /__mock/reset returns to fixture mode (static JSON again)", async () => {
    const reset = await postJson<{ mode: string }>("/__mock/reset");
    expect(reset.json).toEqual({ mode: "fixtures" });
    const { json } = await getJson<HalCollection<HalWp>>("/api/v3/work_packages");
    expect(json._embedded.elements[0]?.id).toBe(1001); // legacy fixture data
    const state = await getJson<{ scenario: string | null }>("/__mock/state");
    expect(state.json.scenario).toBeNull();
  });

  it("POST /__mock/set-latency-ms delays work_packages collection responses and resets on load (SPEC_19 §2)", async () => {
    // No latency by default — a collection fetch is near-instant.
    const fast = Date.now();
    await getJson<HalCollection<HalWp>>("/api/v3/work_packages?pageSize=100");
    expect(Date.now() - fast).toBeLessThan(150);

    // Arm a 200ms per-page delay.
    const set = await postJson<{ latency_ms: number }>("/__mock/set-latency-ms", { ms: 200 });
    expect(set.status).toBe(200);
    expect(set.json).toEqual({ latency_ms: 200 });

    const t0 = Date.now();
    await getJson<HalCollection<HalWp>>("/api/v3/work_packages?pageSize=100");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(190);

    // The delay hits ONLY work_packages collections — /__mock/state stays fast.
    const t1 = Date.now();
    await getJson<Record<string, unknown>>("/__mock/state");
    expect(Date.now() - t1).toBeLessThan(150);

    // A fresh load resets the latency to 0 (fast again).
    await fetch(`${mock.url}/__mock/load/http-mini`, { method: "POST" });
    const t2 = Date.now();
    await getJson<HalCollection<HalWp>>("/api/v3/work_packages?pageSize=100");
    expect(Date.now() - t2).toBeLessThan(150);
  });

  it("rejects a negative/non-finite set-latency-ms (a typo never silently disables the delay)", async () => {
    const neg = await postJson<{ error: string }>("/__mock/set-latency-ms", { ms: -5 });
    expect(neg.status).toBe(400);
    const nan = await postJson<{ error: string }>("/__mock/set-latency-ms", { ms: "oops" });
    expect(nan.status).toBe(400);
  });

  it("validates admin input: bad goto-day, unknown scenario, wrong method, unknown route", async () => {
    const badDay = await postJson<{ error: string }>("/__mock/goto-day/abc");
    expect(badDay.status).toBe(400);
    const unknown = await postJson<{ error: string }>("/__mock/load/no-such-scenario");
    expect(unknown.status).toBe(404);
    const wrongMethod = await fetch(`${mock.url}/__mock/load/http-mini`); // GET
    expect(wrongMethod.status).toBe(405);
    const noRoute = await postJson<{ error: string }>("/__mock/frobnicate");
    expect(noRoute.status).toBe(404);
  });

  it("records /__mock/* traffic on recording instances", () => {
    const adminHits = mock.requests.filter((r) => r.path.startsWith("/__mock/"));
    expect(adminHits.length).toBeGreaterThan(0);
    expect(adminHits.some((r) => r.method === "POST" && r.path === "/__mock/load/http-mini")).toBe(
      true,
    );
  });

  it("serves /__mock/ui without crashing (200 with M2's panel, else clean 404)", async () => {
    const ui = await fetch(`${mock.url}/__mock/ui`);
    expect([200, 404]).toContain(ui.status);
    const missing = await fetch(`${mock.url}/__mock/ui/definitely-not-here-xyz.js`);
    expect(missing.status).toBe(404);
    const traversal = await fetch(`${mock.url}/__mock/ui/..%2F..%2Fpackage.json`);
    expect(traversal.status).toBe(404);
  });
});

describe("per-instance isolation", () => {
  it("a scenario loaded in one server leaves a second server in fixture mode", async () => {
    const other = await createRecordingMockOpServer("127.0.0.1", {
      scenarios: [httpScenario()],
    });
    try {
      // `mock` has http-mini loaded (beforeEach); `other` was never loaded.
      const loaded = await getJson<HalCollection<HalWp>>("/api/v3/work_packages");
      expect(loaded.json._embedded.elements[0]?.id).toBe(5001);

      const otherWps = await fetch(`${other.url}/api/v3/work_packages`);
      const otherJson = (await otherWps.json()) as HalCollection<HalWp>;
      expect(otherJson._embedded.elements[0]?.id).toBe(1001); // still fixtures

      const otherState = await fetch(`${other.url}/__mock/state`);
      expect(((await otherState.json()) as { scenario: string | null }).scenario).toBeNull();

      // And the other direction: advancing `mock` never touches `other`.
      await postJson("/__mock/advance-day");
      const otherStateAfter = await fetch(`${other.url}/__mock/state`);
      expect(((await otherStateAfter.json()) as { day: number }).day).toBe(0);
    } finally {
      await other.close();
    }
  });
});

describe("advance-day app helper (SPEC_03 §6)", () => {
  let app: Server;
  let appUrl: string;
  /** Behavior switches for the fake Sprint Planner app. */
  const behavior = { syncStatus: 200, snapshotStatus: 200 };
  const seen: Array<{ path: string; body: unknown }> = [];

  beforeAll(async () => {
    app = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        seen.push({ path: req.url ?? "", body: raw === "" ? null : JSON.parse(raw) });
        const status = req.url === "/api/sync" ? behavior.syncStatus : behavior.snapshotStatus;
        const body =
          status === 200
            ? JSON.stringify({ ok: true })
            : JSON.stringify({ error: { code: "VAULT_LOCKED", message: "vault is locked" } });
        res.writeHead(status, { "content-type": "application/json" });
        res.end(body);
      });
    });
    appUrl = await new Promise<string>((resolve) => {
      app.listen(0, "127.0.0.1", () => {
        const { port } = app.address() as AddressInfo;
        resolve(`http://127.0.0.1:${port}`);
      });
    });
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      app.close((err) => (err ? reject(err) : resolve())),
    );
  });

  beforeEach(() => {
    behavior.syncStatus = 200;
    behavior.snapshotStatus = 200;
    seen.length = 0;
  });

  it("POSTs {app_url}/api/sync then /api/snapshot {date} and reports ok", async () => {
    const { status, json } = await postJson<AdvanceDayResult>("/__mock/advance-day", {
      app_url: appUrl,
    });
    expect(status).toBe(200);
    expect(json).toMatchObject({ day: 1, date: "2026-07-02", applied_events: 2 });
    expect(json.app?.sync).toEqual({ ok: true, detail: null });
    expect(json.app?.snapshot).toEqual({ ok: true, detail: null });
    expect(seen.map((s) => s.path)).toEqual(["/api/sync", "/api/snapshot"]);
    expect(seen[1]?.body).toEqual({ date: "2026-07-02" }); // the NEW current date
  });

  it("reports (never throws) app failures, e.g. HTTP 423 VAULT_LOCKED", async () => {
    behavior.snapshotStatus = 423;
    const { status, json } = await postJson<AdvanceDayResult>("/__mock/advance-day", {
      app_url: appUrl,
    });
    expect(status).toBe(200); // the day STILL advanced
    expect(json.day).toBe(1);
    expect(json.app?.sync?.ok).toBe(true);
    expect(json.app?.snapshot).toEqual({ ok: false, detail: "HTTP 423 VAULT_LOCKED" });
  });

  it("honors sync:false / snapshot:false switches", async () => {
    const { json } = await postJson<AdvanceDayResult>("/__mock/advance-day", {
      app_url: appUrl,
      sync: false,
    });
    expect(json.app?.sync).toBeUndefined();
    expect(json.app?.snapshot?.ok).toBe(true);
    expect(seen.map((s) => s.path)).toEqual(["/api/snapshot"]);
  });

  it("an unreachable app is reported as a failed helper, not an error", async () => {
    const { status, json } = await postJson<AdvanceDayResult>("/__mock/advance-day", {
      app_url: "http://127.0.0.1:9",
    });
    expect(status).toBe(200);
    expect(json.app?.sync?.ok).toBe(false);
    expect(typeof json.app?.sync?.detail).toBe("string");
    expect(json.app?.snapshot?.ok).toBe(false);
  });

  it("without app_url the result carries no app block at all", async () => {
    const { json } = await postJson<AdvanceDayResult>("/__mock/advance-day");
    expect(json.app).toBeUndefined();
    expect(seen).toEqual([]);
  });
});
