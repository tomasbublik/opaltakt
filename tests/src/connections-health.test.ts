import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRecordingMockOpServer,
  UNREACHABLE_OP_URL,
  type RecordingMockOpServer,
} from "@osp/fixtures";
import {
  AddConnectionResponse,
  ConnectionsHealthResponse,
  ConnectionsResponse,
  DeleteConnectionResponse,
} from "@osp/contracts";
import {
  addConnection,
  bootRealApp,
  call,
  errorCode,
  initAndUnlockVault,
  TEST_PASSPHRASE,
  type RealApp,
} from "./harness";

/**
 * CONNECTIONS & HEALTH — the SPEC_02 §4/§8 color state machine, driven LIVE
 * through the real app:
 *
 *   neutral (nothing configured) → green (all ok) → orange (mix) →
 *   red (fail & no ok) → neutral (vault locked) → red again (unlock) …
 *
 * plus is_current semantics (PATCH {current:true} flips, DELETE of the current
 * row re-points) and the SSE stream's first frame parsing as
 * ConnectionsHealthResponse.
 */

async function aggregate(harness: RealApp): Promise<string> {
  const res = await call(harness.app, "GET", "/api/connections/health");
  expect(res.status).toBe(200);
  return ConnectionsHealthResponse.parse(res.json).aggregate;
}

describe("connections & health — aggregate color matrix (SPEC_02 §4)", () => {
  let mock: RecordingMockOpServer;
  let harness: RealApp;
  let okId: number;
  let deadId: number;

  beforeAll(async () => {
    mock = await createRecordingMockOpServer();
    harness = await bootRealApp();
    await initAndUnlockVault(harness.app);
  });

  afterAll(async () => {
    await harness.close();
    await mock.close().catch(() => {}); // may already be closed by the red step
  });

  it("0 connections → neutral", async () => {
    expect(await aggregate(harness)).toBe("neutral");
  });

  it("one validated (ok) connection → green", async () => {
    const res = await addConnection(harness.app, mock.url, "health-token-A");
    expect(res.status).toBe(201);
    const conn = AddConnectionResponse.parse(res.json);
    okId = conn.id;
    expect(conn.user?.op_id).toBe(1); // validation succeeded → user present
    expect(conn.health.last_status).toBe("ok");
    expect(conn.is_current).toBe(true); // first connection is auto-current

    expect(await aggregate(harness)).toBe("green");
  });

  it("duplicate base_url → 409 CONNECTION_EXISTS", async () => {
    const dup = await addConnection(harness.app, mock.url, "health-token-A2");
    expect(dup.status).toBe(409);
    expect(errorCode(dup.json)).toBe("CONNECTION_EXISTS");
  });

  it("an UNREACHABLE server is STORED anyway (no user, health fail) → orange", async () => {
    const res = await addConnection(
      harness.app,
      UNREACHABLE_OP_URL,
      "health-token-B",
    );
    expect(res.status).toBe(201); // stored despite the validation failure
    const conn = AddConnectionResponse.parse(res.json);
    deadId = conn.id;
    expect(conn.user).toBeUndefined(); // validation failed → no user in response
    expect(conn.health.last_status).toBe("fail");
    expect(conn.has_token).toBe(true); // token stored for when the server comes back

    // ≥1 ok and ≥1 not-ok → orange.
    expect(await aggregate(harness)).toBe("orange");
  });

  it("POST /:id/test on the unreachable one → still fail, last_error + last_check_at recorded", async () => {
    const test = await call(harness.app, "POST", `/api/connections/${deadId}/test`);
    expect(test.status).toBe(200); // the CHECK ran; the RESULT is fail
    expect(JSON.stringify(test.json ?? "")).not.toContain("health-token");

    const list = await call(harness.app, "GET", "/api/connections");
    const dead = ConnectionsResponse.parse(list.json).find((c) => c.id === deadId);
    expect(dead?.health.last_status).toBe("fail");
    expect(dead?.health.last_error).not.toBeNull();
    expect(dead?.health.last_check_at).not.toBeNull();

    expect(await aggregate(harness)).toBe("orange"); // unchanged — still 1 ok + 1 fail
  });

  it("the healthy server goes down → both fail → red", async () => {
    await mock.close(); // simulate the outage
    const test = await call(harness.app, "POST", `/api/connections/${okId}/test`);
    expect(test.status).toBe(200);

    const list = await call(harness.app, "GET", "/api/connections");
    const conns = ConnectionsResponse.parse(list.json);
    expect(conns.every((c) => c.health.last_status === "fail")).toBe(true);

    // ≥1 fail and 0 ok → red.
    expect(await aggregate(harness)).toBe("red");
  });

  it("locking the vault → neutral; unlocking → back to red (health data unchanged)", async () => {
    const lock = await call(harness.app, "POST", "/api/vault/lock");
    expect(lock.status).toBeGreaterThanOrEqual(200);
    expect(lock.status).toBeLessThan(300);
    expect(await aggregate(harness)).toBe("neutral");

    const unlock = await call(harness.app, "POST", "/api/vault/unlock", {
      passphrase: TEST_PASSPHRASE,
    });
    expect(unlock.status).toBeGreaterThanOrEqual(200);
    expect(unlock.status).toBeLessThan(300);
    expect(await aggregate(harness)).toBe("red");
  });

  it("PATCH {current: true} flips is_current; DELETE of the current row re-points it", async () => {
    // Make the unreachable one current.
    const patched = await call(harness.app, "PATCH", `/api/connections/${deadId}`, {
      current: true,
    });
    expect(patched.status).toBe(200);

    let conns = ConnectionsResponse.parse(
      (await call(harness.app, "GET", "/api/connections")).json,
    );
    expect(conns.find((c) => c.id === deadId)?.is_current).toBe(true);
    expect(conns.find((c) => c.id === okId)?.is_current).toBe(false);
    expect(conns.filter((c) => c.is_current)).toHaveLength(1); // exactly one current

    // Delete the CURRENT one → the remaining row becomes current.
    const del = await call(harness.app, "DELETE", `/api/connections/${deadId}`);
    expect(del.status).toBe(200);
    expect(DeleteConnectionResponse.parse(del.json).deleted).toBe(true);

    conns = ConnectionsResponse.parse(
      (await call(harness.app, "GET", "/api/connections")).json,
    );
    expect(conns).toHaveLength(1);
    expect(conns[0]!.id).toBe(okId);
    expect(conns[0]!.is_current).toBe(true);
  });
});

describe("connections & health — SSE stream (SPEC_02 §5)", () => {
  let mock: RecordingMockOpServer;
  let harness: RealApp;
  let baseUrl: string;

  beforeAll(async () => {
    mock = await createRecordingMockOpServer();
    harness = await bootRealApp();
    await initAndUnlockVault(harness.app);
    const added = await addConnection(harness.app, mock.url, "sse-token");
    expect(added.status).toBe(201);
    // SSE needs a REAL socket (inject can't stream) → listen on an ephemeral port.
    await harness.app.listen({ port: 0, host: "127.0.0.1" });
    const addr = harness.app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await harness.close();
    await mock.close();
  });

  it("GET /api/connections/health/stream emits a first data: frame that parses as ConnectionsHealthResponse", async () => {
    const controller = new AbortController();
    const killer = setTimeout(() => controller.abort(), 4_000); // keep the suite fast
    try {
      const res = await fetch(`${baseUrl}/api/connections/health/stream`, {
        headers: { accept: "text/event-stream" },
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      // Read until the first complete SSE event (blank-line terminated).
      while (!buf.includes("\n\n")) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
      const dataLine = /^data:\s?(.*)$/m.exec(buf);
      expect(dataLine, `no data: frame in SSE output: ${JSON.stringify(buf)}`).not.toBeNull();

      const payload = ConnectionsHealthResponse.parse(JSON.parse(dataLine![1]!));
      expect(payload.aggregate).toBe("green"); // one validated connection
      expect(payload.connections).toHaveLength(1);
      // Token-free even on the stream.
      expect(buf).not.toContain("sse-token");
    } finally {
      clearTimeout(killer);
      controller.abort(); // tear the stream down so no handle stays open
    }
  }, 10_000);
});

describe("Disconnect/Connect toggle (SPEC_10 §a) — disabled counts as NOT-OK in the aggregate", () => {
  let mock: RecordingMockOpServer;
  let harness: RealApp;

  beforeAll(async () => {
    mock = await createRecordingMockOpServer();
    harness = await bootRealApp();
    await initAndUnlockVault(harness.app);
  });

  afterAll(async () => {
    await harness.close();
    await mock.close();
  });

  it("PATCH {enabled:false} makes the connection NOT-OK in the aggregate (without hiding it) — even though last_status is still stale 'ok'", async () => {
    const added = await addConnection(harness.app, mock.url, "toggle-token");
    expect(added.status).toBe(201);
    const id = (added.json as { id: number }).id;

    expect(await aggregate(harness)).toBe("green"); // the one connection validated ok

    const disabled = await call(harness.app, "PATCH", `/api/connections/${id}`, {
      enabled: false,
    });
    expect(disabled.status).toBe(200);
    expect((disabled.json as { enabled: boolean }).enabled).toBe(false);

    // Its last_status is UNCHANGED (still "ok" from the add-time probe) — the
    // fix treats a disabled connection as not-ok for the AGGREGATE regardless
    // of its stale last_status, without mutating that stored status. It's
    // also still RETURNED in the list (frontend needs it to grey out, not to
    // disappear).
    const list = ConnectionsResponse.parse(
      (await call(harness.app, "GET", "/api/connections")).json,
    );
    const row = list.find((c) => c.id === id);
    expect(row?.health.last_status).toBe("ok");
    expect(row?.enabled).toBe(false);

    // SPEC_10 §a: with the only connection disabled, NONE count as ok → red
    // (NOT "neutral" — neutral is reserved for zero STORED connections or a
    // locked vault; a disabled-but-present connection is a real "not-ok").
    expect(await aggregate(harness)).toBe("red");

    // Reconnect restores it.
    const reconnected = await call(harness.app, "PATCH", `/api/connections/${id}`, {
      enabled: true,
    });
    expect(reconnected.status).toBe(200);
    expect(await aggregate(harness)).toBe("green");
  });

  it("SPEC_10 §a: 1-of-2 disabled is orange, not green", async () => {
    // Reuses the connection the previous test left enabled (same describe-
    // block harness) as "a"; adds a second, distinct-base_url connection "b".
    const existing = ConnectionsResponse.parse(
      (await call(harness.app, "GET", "/api/connections")).json,
    );
    const idA = existing[0]!.id;
    const mock2 = await createRecordingMockOpServer();
    try {
      const b = await addConnection(harness.app, mock2.url, "toggle-b");
      const idB = (b.json as { id: number }).id;
      expect(await aggregate(harness)).toBe("green");

      await call(harness.app, "PATCH", `/api/connections/${idB}`, { enabled: false });
      expect(await aggregate(harness)).toBe("orange");

      await call(harness.app, "PATCH", `/api/connections/${idB}`, { enabled: true });
      await call(harness.app, "PATCH", `/api/connections/${idA}`, { enabled: true });
    } finally {
      await mock2.close();
    }
  });
});
