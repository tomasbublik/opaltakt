import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { OpHealthResult } from "@osp/op-client";
import {
  startHeartbeat,
  type HeartbeatCandidate,
  type HeartbeatDeps,
} from "./heartbeat";

/**
 * Local recording mock OP: answers GET /api/v3/users/me and records every
 * method + path so tests can assert the heartbeat only ever GETs (SPEC §2).
 * No network beyond 127.0.0.1.
 */
interface RecordingServer {
  url: string;
  methods: string[];
  paths: string[];
  reset(): void;
  close(): Promise<void>;
}

function startRecordingOpServer(): Promise<RecordingServer> {
  const methods: string[] = [];
  const paths: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    methods.push(req.method ?? "GET");
    paths.push(url.pathname);
    if (url.pathname === "/api/v3/users/me") {
      const body = JSON.stringify({ _type: "User", id: 1, name: "mock" });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ _type: "Error", message: "not found" }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        methods,
        paths,
        reset: () => {
          methods.length = 0;
          paths.length = 0;
        },
        close: () =>
          new Promise<void>((res2, rej) =>
            server.close((err) => (err ? rej(err) : res2())),
          ),
      });
    });
  });
}

let mock: RecordingServer;

beforeAll(async () => {
  mock = await startRecordingOpServer();
});

afterAll(async () => {
  await mock.close();
});

const NOW = new Date("2026-07-10T12:00:00.000Z");
const agoIso = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

function candidate(over: Partial<HeartbeatCandidate> = {}): HeartbeatCandidate {
  return {
    id: 1,
    base_url: mock.url,
    last_activity_at: null,
    last_check_at: null,
    has_token: true,
    enabled: true,
    ...over,
  };
}

/** Deps with everything happy-path; tests override what they exercise. */
function makeDeps(over: Partial<HeartbeatDeps> = {}) {
  const recorded: Array<{ id: number; result: OpHealthResult }> = [];
  const deps: HeartbeatDeps = {
    listConnections: vi.fn(async () => [candidate()]),
    isVaultLocked: () => false,
    getClientConfig: vi.fn(async () => ({ baseUrl: mock.url, token: "t" })),
    recordCheck: vi.fn(async (id: number, result: OpHealthResult) => {
      recorded.push({ id, result });
    }),
    // Huge tick so only explicit tickNow() drives the tests (unref'd anyway).
    tickMs: 3_600_000,
    idleMs: 20_000,
    timeoutMs: 1_000,
    now: () => NOW,
    onError: vi.fn(),
    ...over,
  };
  return { deps, recorded };
}

describe("heartbeat", () => {
  it("checks a connection idle for more than idleMs and records ok with latency >= 0", async () => {
    mock.reset();
    const { deps, recorded } = makeDeps({
      listConnections: async () => [
        candidate({ last_activity_at: agoIso(30_000), last_check_at: agoIso(25_000) }),
      ],
    });
    const hb = startHeartbeat(deps);
    await hb.tickNow();
    hb.stop();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ id: 1, result: { ok: true, error: null } });
    expect(recorded[0]!.result.latency_ms).toBeGreaterThanOrEqual(0);
    // The probe is exactly one GET /api/v3/users/me — nothing else on the wire.
    expect(mock.methods).toEqual(["GET"]);
    expect(mock.paths).toEqual(["/api/v3/users/me"]);
  });

  it("connections with both timestamps null count as never-seen and are checked", async () => {
    const { deps, recorded } = makeDeps();
    const hb = startHeartbeat(deps);
    await hb.tickNow();
    hb.stop();
    expect(recorded).toHaveLength(1);
  });

  it("recent real traffic (fresh last_activity_at) suppresses the ping", async () => {
    const { deps, recorded } = makeDeps({
      listConnections: async () => [
        // Piggyback saw traffic 5 s ago even though the last explicit check is old.
        candidate({ last_activity_at: agoIso(5_000), last_check_at: agoIso(300_000) }),
      ],
    });
    const hb = startHeartbeat(deps);
    await hb.tickNow();
    hb.stop();
    expect(recorded).toHaveLength(0);
    expect(deps.getClientConfig).not.toHaveBeenCalled();
  });

  it("a fresh last_check_at also suppresses re-checking", async () => {
    const { deps, recorded } = makeDeps({
      listConnections: async () => [
        candidate({ last_activity_at: null, last_check_at: agoIso(10_000) }),
      ],
    });
    const hb = startHeartbeat(deps);
    await hb.tickNow();
    hb.stop();
    expect(recorded).toHaveLength(0);
  });

  it("locked vault skips the whole tick (no listing, no checks)", async () => {
    const { deps, recorded } = makeDeps({ isVaultLocked: () => true });
    const hb = startHeartbeat(deps);
    await hb.tickNow();
    hb.stop();
    expect(deps.listConnections).not.toHaveBeenCalled();
    expect(recorded).toHaveLength(0);
  });

  it("skips connections without a token (they stay unknown)", async () => {
    const { deps, recorded } = makeDeps({
      listConnections: async () => [candidate({ has_token: false })],
    });
    const hb = startHeartbeat(deps);
    await hb.tickNow();
    hb.stop();
    expect(deps.getClientConfig).not.toHaveBeenCalled();
    expect(recorded).toHaveLength(0);
  });

  it("skips a disconnected (disabled) connection — never pinged (SPEC_07 §1)", async () => {
    const { deps, recorded } = makeDeps({
      listConnections: async () => [candidate({ enabled: false })],
    });
    const hb = startHeartbeat(deps);
    await hb.tickNow();
    hb.stop();
    expect(deps.getClientConfig).not.toHaveBeenCalled();
    expect(recorded).toHaveLength(0);
  });

  it("records ok:false with a non-null error for an unreachable server, without throwing", async () => {
    const { deps, recorded } = makeDeps({
      listConnections: async () => [candidate({ base_url: "http://127.0.0.1:9" })],
      getClientConfig: async () => ({ baseUrl: "http://127.0.0.1:9", token: "t" }),
    });
    const hb = startHeartbeat(deps);
    await hb.tickNow();
    hb.stop();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.result.ok).toBe(false);
    expect(recorded[0]!.result.error).not.toBeNull();
    // A dead connection is a RESULT, not a loop error.
    expect(deps.onError).not.toHaveBeenCalled();
  });

  it("a failing recordCheck goes to onError and does not kill the tick for others", async () => {
    const results: number[] = [];
    const { deps } = makeDeps({
      listConnections: async () => [candidate({ id: 1 }), candidate({ id: 2 })],
      recordCheck: async (id) => {
        if (id === 1) throw new Error("db down");
        results.push(id);
      },
    });
    const hb = startHeartbeat(deps);
    await hb.tickNow();
    hb.stop();
    expect(results).toEqual([2]);
    expect(deps.onError).toHaveBeenCalledTimes(1);
  });

  it("skips a tick while the previous one is still running (overlap guard)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const listConnections = vi.fn(async (): Promise<HeartbeatCandidate[]> => {
      await gate;
      return [];
    });
    const { deps } = makeDeps({ listConnections });
    const hb = startHeartbeat(deps);

    const first = hb.tickNow(); // blocks on the gate
    await hb.tickNow(); // overlaps → must return immediately, no second listing
    expect(listConnections).toHaveBeenCalledTimes(1);

    release();
    await first;
    // After the first tick finished, ticking works again.
    await hb.tickNow();
    hb.stop();
    expect(listConnections).toHaveBeenCalledTimes(2);
  });

  it("ticks on the interval and stop() stops it", async () => {
    const isVaultLocked = vi.fn(() => true); // locked → ticks are cheap no-ops
    const { deps } = makeDeps({ isVaultLocked, tickMs: 20 });
    const hb = startHeartbeat(deps);
    await new Promise((r) => setTimeout(r, 90));
    expect(isVaultLocked.mock.calls.length).toBeGreaterThanOrEqual(2);

    hb.stop();
    const after = isVaultLocked.mock.calls.length;
    await new Promise((r) => setTimeout(r, 80));
    expect(isVaultLocked.mock.calls.length).toBe(after);
  });
});
