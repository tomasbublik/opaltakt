/**
 * Tests for the scenario CLI (fixtures/scenario.ts) driven IN-PROCESS against
 * a tiny node:http fake of the /__mock admin API — no mock engine and no
 * subprocess needed. The fake records every request (method, path, body) so
 * we can assert the exact admin calls and payloads the CLI produces.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  AdvanceDayResult,
  MockStateSummary,
  ScenarioSummary,
} from "../scenario-types";
import { run, type CliIo } from "../scenario";

// ── Fake /__mock server ──────────────────────────────────────────────────────

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

const requests: Recorded[] = [];
let advanceDayResponse: AdvanceDayResult;
let server: Server;
let baseUrl: string;

const STATE: MockStateSummary = {
  scenario: "s5-burndown-happy",
  day: 2,
  date: "2026-07-03",
  total_days: 8,
  pending_days: 6,
  work_packages: [
    {
      id: 1501,
      key: "reports",
      subject: "Implement report scheduling",
      status: "In progress",
      assignee: "Dev Dvořák",
      accountable: "Karel Zákazník",
      estimated_hours: 16,
      remaining_hours: 4,
      spent_hours: 12,
      version: null,
      updated_at: "2026-07-03T09:00:00Z",
    },
  ],
};

const SCENARIOS: ScenarioSummary[] = [
  { name: "s1-accountable-handoff", description: "handoff", start_date: "2026-07-01", total_days: 8 },
  { name: "s5-burndown-happy", description: "baseline", start_date: "2026-07-01", total_days: 8 },
];

function respond(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const path = req.url ?? "";
      requests.push({ method: req.method ?? "", path, body: raw ? JSON.parse(raw) : undefined });
      if (req.method === "GET" && path === "/__mock/scenarios") return respond(res, 200, SCENARIOS);
      if (req.method === "GET" && path === "/__mock/state") return respond(res, 200, STATE);
      if (req.method === "POST" && path === "/__mock/load/s5-burndown-happy") {
        return respond(res, 200, { ...STATE, day: 0, date: "2026-07-01", pending_days: 8 });
      }
      if (req.method === "POST" && path === "/__mock/advance-day") {
        return respond(res, 200, advanceDayResponse);
      }
      if (req.method === "POST" && path === "/__mock/goto-day/3") {
        return respond(res, 200, { ...STATE, day: 3, date: "2026-07-04", pending_days: 5 });
      }
      if (req.method === "POST" && path === "/__mock/inject-urgent") {
        return respond(res, 200, {
          work_package: { ...STATE.work_packages[0], id: 5001, subject: "URGENT: escalation", status: "Confirmed" },
        });
      }
      if (req.method === "POST" && path === "/__mock/reset") return respond(res, 200, { mode: "fixtures" });
      return respond(res, 404, { message: `no such scenario` });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

beforeEach(() => {
  requests.length = 0;
  advanceDayResponse = { day: 3, date: "2026-07-04", applied_events: 4 };
});

// ── IO capture ───────────────────────────────────────────────────────────────

function io(): CliIo & { outLines: string[]; errLines: string[] } {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    out: (l) => outLines.push(l),
    err: (l) => errLines.push(l),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("scenario CLI", () => {
  it("list prints every scenario with its day count", async () => {
    const t = io();
    expect(await run(["list"], baseUrl, t)).toBe(0);
    expect(requests).toEqual([{ method: "GET", path: "/__mock/scenarios", body: undefined }]);
    const text = t.outLines.join("\n");
    expect(text).toContain("s1-accountable-handoff");
    expect(text).toContain("s5-burndown-happy");
    expect(text).toContain("8");
  });

  it("load POSTs /__mock/load/:name and renders the day-0 state", async () => {
    const t = io();
    expect(await run(["load", "s5-burndown-happy"], baseUrl, t)).toBe(0);
    expect(requests[0]).toMatchObject({ method: "POST", path: "/__mock/load/s5-burndown-happy" });
    const text = t.outLines.join("\n");
    expect(text).toContain('loaded "s5-burndown-happy" at day 0');
    expect(text).toContain("day: 0/8");
    expect(text).toContain("Implement report scheduling");
  });

  it("state renders scenario, clock and the WP table", async () => {
    const t = io();
    expect(await run(["state"], baseUrl, t)).toBe(0);
    const text = t.outLines.join("\n");
    expect(text).toContain("scenario: s5-burndown-happy");
    expect(text).toContain("day: 2/8  date: 2026-07-03  pending days: 6");
    expect(text).toContain("1501");
    expect(text).toContain("Karel Zákazník");
  });

  it("day without --app sends an EMPTY body (no app helper)", async () => {
    const t = io();
    expect(await run(["day"], baseUrl, t)).toBe(0);
    expect(requests[0]).toEqual({ method: "POST", path: "/__mock/advance-day", body: {} });
    expect(t.outLines[0]).toBe("advanced to day 3 (2026-07-04), applied 4 event(s)");
  });

  it("day --app sends app_url with sync+snapshot defaulting to true", async () => {
    advanceDayResponse = {
      day: 3,
      date: "2026-07-04",
      applied_events: 4,
      app: { sync: { ok: true, detail: null }, snapshot: { ok: true, detail: null } },
    };
    const t = io();
    expect(await run(["day", "--app", "http://127.0.0.1:3001"], baseUrl, t)).toBe(0);
    expect(requests[0]?.body).toEqual({ app_url: "http://127.0.0.1:3001", sync: true, snapshot: true });
    expect(t.outLines).toContain("  sync: OK");
    expect(t.outLines).toContain("  snapshot: OK");
  });

  it("day --app --no-sync --no-snapshot disables the helpers in the payload", async () => {
    const t = io();
    expect(await run(["day", "--app", "http://x:1", "--no-sync", "--no-snapshot"], baseUrl, t)).toBe(0);
    expect(requests[0]?.body).toEqual({ app_url: "http://x:1", sync: false, snapshot: false });
  });

  it("day reports failed app helpers on stderr with their detail", async () => {
    advanceDayResponse = {
      day: 3,
      date: "2026-07-04",
      applied_events: 4,
      app: { sync: { ok: false, detail: "HTTP 423 VAULT_LOCKED" }, snapshot: { ok: true, detail: null } },
    };
    const t = io();
    expect(await run(["day", "--app", "http://127.0.0.1:3001"], baseUrl, t)).toBe(0);
    expect(t.errLines).toContain("  sync: FAILED — HTTP 423 VAULT_LOCKED");
    expect(t.outLines).toContain("  snapshot: OK");
  });

  it("goto POSTs /__mock/goto-day/:n", async () => {
    const t = io();
    expect(await run(["goto", "3"], baseUrl, t)).toBe(0);
    expect(requests[0]).toMatchObject({ method: "POST", path: "/__mock/goto-day/3" });
    expect(t.outLines.join("\n")).toContain("day: 3/8");
  });

  it("goto rejects a non-numeric day without calling the mock", async () => {
    const t = io();
    expect(await run(["goto", "banana"], baseUrl, t)).toBe(1);
    expect(requests).toEqual([]);
    expect(t.errLines[0]).toContain("non-negative day");
  });

  it("urgent POSTs /__mock/inject-urgent and prints the injected WP", async () => {
    const t = io();
    expect(await run(["urgent"], baseUrl, t)).toBe(0);
    expect(requests[0]).toMatchObject({ method: "POST", path: "/__mock/inject-urgent" });
    expect(t.outLines[0]).toContain('injected urgent WP #5001 "URGENT: escalation"');
  });

  it("reset POSTs /__mock/reset", async () => {
    const t = io();
    expect(await run(["reset"], baseUrl, t)).toBe(0);
    expect(requests[0]).toMatchObject({ method: "POST", path: "/__mock/reset" });
    expect(t.outLines[0]).toContain("fixture mode");
  });

  it("HTTP errors exit non-zero with status + body detail", async () => {
    const t = io();
    expect(await run(["load", "nope"], baseUrl, t)).toBe(1);
    expect(t.errLines[0]).toContain("HTTP 404");
    expect(t.errLines[0]).toContain("no such scenario");
  });

  it("an unreachable mock exits non-zero with a helpful message", async () => {
    const t = io();
    expect(await run(["state"], "http://127.0.0.1:9", t)).toBe(1);
    expect(t.errLines[0]).toContain("cannot reach mock at http://127.0.0.1:9");
  });

  it("unknown commands and missing args exit 1 with usage", async () => {
    const t = io();
    expect(await run(["frobnicate"], baseUrl, t)).toBe(1);
    expect(t.errLines.join("\n")).toContain("Usage:");
    const t2 = io();
    expect(await run(["load"], baseUrl, t2)).toBe(1);
    expect(t2.errLines[0]).toContain("requires a scenario name");
    const t3 = io();
    expect(await run([], baseUrl, t3)).toBe(1);
    expect(t3.outLines.join("\n")).toContain("Usage:");
  });
});
