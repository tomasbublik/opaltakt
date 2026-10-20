import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { createRecordingMockOpServer, type RecordingMockOpServer } from "@osp/fixtures";
import { checkOpHealth } from "./health";

let mock: RecordingMockOpServer;

beforeAll(async () => {
  mock = await createRecordingMockOpServer();
});

afterAll(async () => {
  await mock.close();
});

describe("checkOpHealth", () => {
  it("ok path: GET /api/v3/users/me only, ok:true, latency >= 0, error null", async () => {
    mock.reset();
    const result = await checkOpHealth({ baseUrl: mock.url, token: "t" });
    expect(result.ok).toBe(true);
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeNull();
    expect(mock.methodSet()).toEqual(new Set(["GET"]));
    expect(mock.requests.map((r) => r.path)).toEqual(["/api/v3/users/me"]);
  });

  it("never throws on connection refused; error is a short network reason", async () => {
    // Grab an ephemeral port and release it so nothing listens there.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as { port: number };
    await new Promise<void>((resolve, reject) =>
      probe.close((err) => (err ? reject(err) : resolve())),
    );

    const result = await checkOpHealth({
      baseUrl: `http://127.0.0.1:${port}`,
      token: "t",
      timeoutMs: 2_000,
    });
    expect(result.ok).toBe(false);
    expect(result.error).not.toBeNull();
    expect(result.error).toMatch(/ECONNREFUSED|refused/i);
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("never throws on a fetch-blocked URL (e.g. bad port); reason is short and non-null", async () => {
    // Port 9 is on the fetch spec's blocked-port list: undici rejects it
    // before any network I/O ("bad port"). Still a clean failure result.
    const result = await checkOpHealth({
      baseUrl: "http://127.0.0.1:9",
      token: "t",
      timeoutMs: 2_000,
    });
    expect(result.ok).toBe(false);
    expect(result.error).not.toBeNull();
    expect((result.error ?? "").length).toBeLessThan(200);
  });

  it("maps HTTP failures to 'HTTP <status>' and does NOT retry", async () => {
    let calls = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls += 1;
      return new Response("boom", { status: 503 });
    });
    // Even with a retry-happy caller config, the probe must stay single-shot.
    const result = await checkOpHealth({ baseUrl: mock.url, token: "t", maxRetries: 5 });
    fetchSpy.mockRestore();
    expect(result).toMatchObject({ ok: false, error: "HTTP 503" });
    expect(calls).toBe(1);
  });

  it("maps 401 to 'HTTP 401'", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("nope", { status: 401 }));
    const result = await checkOpHealth({ baseUrl: mock.url, token: "bad" });
    fetchSpy.mockRestore();
    expect(result.ok).toBe(false);
    expect(result.error).toBe("HTTP 401");
  });

  it("aborts a hung server after timeoutMs with a 'timeout after N ms' error", async () => {
    // A server that accepts the request and never responds.
    const hang: Server = createServer(() => {
      /* hold the request open */
    });
    await new Promise<void>((resolve) => hang.listen(0, "127.0.0.1", resolve));
    const { port } = hang.address() as { port: number };

    const start = performance.now();
    const result = await checkOpHealth({
      baseUrl: `http://127.0.0.1:${port}`,
      token: "t",
      timeoutMs: 100,
    });
    const elapsed = performance.now() - start;

    hang.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      hang.close((err) => (err ? reject(err) : resolve())),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe("timeout after 100 ms");
    // Failed fast (well under any default), and the timer was honoured.
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(2_000);
  });
});
