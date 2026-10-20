import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, HEALTH_POLL_INTERVAL_MS, subscribeConnectionsHealth } from "./api-client";
import { makeHealth } from "./test/fixtures";

/**
 * SPEC_02 §6: the health feed prefers SSE but must fall back to 5 s polling
 * when EventSource is unavailable (jsdom has none — the exact path the app
 * takes in these tests) or when the stream errors.
 */

function fetchOk(body: unknown) {
  return vi.fn().mockImplementation(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(body)),
    }),
  );
}

/** Flush pending microtasks (the fetch → json → onUpdate chain) under fake timers. */
async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe("subscribeConnectionsHealth (polling fallback)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("polls immediately and then every 5 s when EventSource is unavailable", async () => {
    expect(typeof EventSource).toBe("undefined"); // jsdom → polling path
    const health = makeHealth({ aggregate: "orange" });
    const fetchMock = fetchOk(health);
    vi.stubGlobal("fetch", fetchMock);
    const onUpdate = vi.fn();

    const unsubscribe = subscribeConnectionsHealth(onUpdate);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/connections/health", expect.anything());
    expect(onUpdate).toHaveBeenCalledWith(health);

    await vi.advanceTimersByTimeAsync(HEALTH_POLL_INTERVAL_MS);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onUpdate).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(HEALTH_POLL_INTERVAL_MS);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    unsubscribe();
    await vi.advanceTimersByTimeAsync(HEALTH_POLL_INTERVAL_MS * 3);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(onUpdate).toHaveBeenCalledTimes(3);
  });

  it("keeps polling quietly when a poll fails, and never calls onUpdate for it", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("backend down"));
    vi.stubGlobal("fetch", fetchMock);
    const onUpdate = vi.fn();

    const unsubscribe = subscribeConnectionsHealth(onUpdate);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onUpdate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(HEALTH_POLL_INTERVAL_MS);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onUpdate).not.toHaveBeenCalled();

    unsubscribe();
  });

  it("does not deliver a late result after unsubscribe", async () => {
    let resolveFetch: (v: unknown) => void = () => {};
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onUpdate = vi.fn();

    const unsubscribe = subscribeConnectionsHealth(onUpdate);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    unsubscribe();
    resolveFetch({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(makeHealth())),
    });
    await flush();
    expect(onUpdate).not.toHaveBeenCalled();
  });
});

/**
 * Increment 29 (contract §5/§6) — the request shapes for the new "Full
 * refresh" call and the out-of-selection cleanup pair. No filtering logic to
 * exercise here (that's the backend's, Agent B's); this just locks in that
 * the frontend sends exactly what the frozen contract specifies.
 */
describe("api — Increment 29 additions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("triggerSync sends full_refresh: true and no project_op_id for a Full refresh", async () => {
    const fetchMock = fetchOk({ connections: [], last: null, full_refresh: true });
    vi.stubGlobal("fetch", fetchMock);

    await api.triggerSync({ full_refresh: true });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sync",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ full_refresh: true }),
      }),
    );
  });

  it("getOutOfSelection GETs the cleanup listing endpoint", async () => {
    const fetchMock = fetchOk({ entries: [], total: 0, protected_count: 0 });
    vi.stubGlobal("fetch", fetchMock);

    const res = await api.getOutOfSelection();

    expect(fetchMock).toHaveBeenCalledWith("/api/backlog/out-of-selection", expect.objectContaining({ method: "GET" }));
    expect(res).toEqual({ entries: [], total: 0, protected_count: 0 });
  });

  it("deleteOutOfSelection POSTs the selected op_ids in one batch", async () => {
    const fetchMock = fetchOk({ removed: [1, 2], protected: [], rejected: [] });
    vi.stubGlobal("fetch", fetchMock);

    await api.deleteOutOfSelection([1, 2]);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/backlog/out-of-selection/delete",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ op_ids: [1, 2] }),
      }),
    );
  });
});

describe("subscribeConnectionsHealth (SSE)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("uses EventSource when available and falls back to polling on stream error", async () => {
    vi.useFakeTimers();
    const instances: FakeEventSource[] = [];
    class FakeEventSource {
      onmessage: ((ev: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      closed = false;
      constructor(readonly url: string) {
        instances.push(this);
      }
      close() {
        this.closed = true;
      }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const health = makeHealth({ aggregate: "green" });
    const fetchMock = fetchOk(health);
    vi.stubGlobal("fetch", fetchMock);
    const onUpdate = vi.fn();

    const unsubscribe = subscribeConnectionsHealth(onUpdate);
    expect(instances).toHaveLength(1);
    const source = instances[0]!;
    expect(source.url).toBe("/api/connections/health/stream");
    expect(fetchMock).not.toHaveBeenCalled();

    // A pushed frame is parsed and delivered.
    source.onmessage?.({ data: JSON.stringify(health) });
    expect(onUpdate).toHaveBeenCalledWith(health);

    // Stream error → the source is closed and polling takes over.
    source.onerror?.();
    expect(source.closed).toBe(true);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HEALTH_POLL_INTERVAL_MS);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    unsubscribe();
    await vi.advanceTimersByTimeAsync(HEALTH_POLL_INTERVAL_MS * 2);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
