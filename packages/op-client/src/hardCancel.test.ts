import { describe, expect, it } from "vitest";
import type { OpClient, OpRequestOptions } from "./client";
import {
  OpCancelledError,
  isOpCancelledError,
  withHardCancel,
} from "./hardCancel";
import { instrumentOpClient } from "./instrument";
import { OpTimeoutError } from "./timeout";

/**
 * Increment 20 (SPEC_20 §1) — withHardCancel unit tests.
 *
 * The fake client implements `request` (honouring the injected AbortSignal, the
 * way real `fetch` does) and routes its typed methods through `this.request`,
 * so the `.call(wrapped)` rebinding funnels every call through the timed+retried
 * wrapper — exactly like the real impl.
 */
function fakeClient(
  handler: (options: OpRequestOptions, attempt: number) => Promise<unknown>,
): OpClient {
  let calls = 0;
  const c = {
    request(options: OpRequestOptions): Promise<unknown> {
      calls += 1;
      return handler(options, calls);
    },
    getWorkPackages(this: OpClient, query: unknown): Promise<unknown> {
      return this.request({ path: "/api/v3/work_packages", query: query as never });
    },
  } as unknown as OpClient;
  return c;
}

/** A request that hangs until its injected signal aborts (like a hung fetch). */
function hangUntilAbort(options: OpRequestOptions): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const s = options.signal;
    if (s?.aborted) {
      reject(s.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    s?.addEventListener(
      "abort",
      () => reject(s.reason ?? new DOMException("Aborted", "AbortError")),
      { once: true },
    );
  });
}

const delay = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

describe("withHardCancel (SPEC_20 §1)", () => {
  it("(a) a per-attempt timeout fires and the call is retried up to maxRetries, then fails", async () => {
    let attempts = 0;
    const client = fakeClient((options) => {
      attempts += 1;
      return hangUntilAbort(options); // always times out
    });
    const wrapped = withHardCancel(client, {
      timeoutMs: 20,
      maxRetries: 2,
      baseBackoffMs: 1,
    });

    const t0 = Date.now();
    await expect(wrapped.getWorkPackages({})).rejects.toBeInstanceOf(OpTimeoutError);
    // 1 initial attempt + 2 retries = 3 total.
    expect(attempts).toBe(3);
    // Bounded by ~3×(20ms timeout) + tiny backoffs, never anywhere near a real
    // 30s per-request default.
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("(b) an external cancel during an in-flight request is NOT retried and rejects promptly + distinguishably", async () => {
    const external = new AbortController();
    let attempts = 0;
    const client = fakeClient((options) => {
      attempts += 1;
      return hangUntilAbort(options);
    });
    const wrapped = withHardCancel(client, {
      timeoutMs: 5000,
      maxRetries: 3,
      baseBackoffMs: 1,
      signal: external.signal,
    });

    const t0 = Date.now();
    setTimeout(() => external.abort(), 10);
    const err = await wrapped.getWorkPackages({}).then(
      () => null,
      (e: unknown) => e,
    );

    expect(isOpCancelledError(err)).toBe(true);
    expect(err).toBeInstanceOf(OpCancelledError);
    expect(attempts).toBe(1); // never retried
    expect(Date.now() - t0).toBeLessThan(1000); // well under the 5s timeout
  });

  it("(c) an external cancel DURING a backoff sleep also resolves promptly, not after the full backoff", async () => {
    const external = new AbortController();
    let attempts = 0;
    const client = fakeClient((options) => {
      attempts += 1;
      return hangUntilAbort(options); // first attempt times out → enters backoff
    });
    const wrapped = withHardCancel(client, {
      timeoutMs: 10, // times out fast → into backoff
      maxRetries: 5,
      baseBackoffMs: 10_000, // a LONG backoff we must NOT wait out
      signal: external.signal,
    });

    const t0 = Date.now();
    // Fire the cancel while we're sitting in the 10s backoff after attempt 1.
    setTimeout(() => external.abort(), 50);
    const err = await wrapped.getWorkPackages({}).then(
      () => null,
      (e: unknown) => e,
    );

    expect(isOpCancelledError(err)).toBe(true);
    expect(attempts).toBe(1); // only the first attempt ran; no second request
    // Resolved via the interrupted backoff, nowhere near the 10s delay.
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("(d) a normal fast response is unaffected (passthrough)", async () => {
    let attempts = 0;
    const payload = { _embedded: { elements: [{ id: 1 }] }, total: 1 };
    const client = fakeClient((_options) => {
      attempts += 1;
      return Promise.resolve(payload);
    });
    const wrapped = withHardCancel(client, { timeoutMs: 5000 });

    const result = await wrapped.getWorkPackages({});
    expect(result).toBe(payload);
    expect(attempts).toBe(1);
  });

  it("propagates a non-abort error untouched (impl already retried network/5xx)", async () => {
    const boom = new Error("network exhausted");
    let attempts = 0;
    const client = fakeClient(() => {
      attempts += 1;
      return Promise.reject(boom);
    });
    const wrapped = withHardCancel(client, { timeoutMs: 5000, maxRetries: 3 });

    await expect(wrapped.getWorkPackages({})).rejects.toBe(boom);
    expect(attempts).toBe(1); // not retried at this layer
  });

  it("composes correctly on top of an ALREADY-wrapped client (instrumentOpClient) — the real end-to-end incident", async () => {
    // apps/api ALWAYS builds its OP client via instrumentOpClient(raw, cb)
    // first (health piggybacking, buildOpClient in routes/index.ts), then
    // hands THAT to createSyncEngine, which wraps it again with
    // withHardCancel. Before the composability fix (instrument.ts/timeout.ts/
    // hardCancel.ts's typed methods switched from arrow-closures-over-a-fixed-
    // `wrapped` to regular methods reading `this` dynamically), this exact
    // composition silently never threaded the outer signal down to the real
    // request — a hung request would ignore both the 30s timeout AND an
    // explicit cancel, reproducing the actual reported production incident.
    // Confirmed live (manual repro against the real API + mock OP) before
    // this fix landed: a cancelled sync took the full mock latency (45s) to
    // finish instead of aborting in ~1s.
    const external = new AbortController();
    let attempts = 0;
    const reports: unknown[] = [];
    const raw = fakeClient((options) => {
      attempts += 1;
      return hangUntilAbort(options);
    });
    const instrumented = instrumentOpClient(raw, (r) => reports.push(r));
    const wrapped = withHardCancel(instrumented, {
      timeoutMs: 5000,
      maxRetries: 3,
      baseBackoffMs: 1,
      signal: external.signal,
    });

    const t0 = Date.now();
    setTimeout(() => external.abort(), 10);
    const err = await wrapped.getWorkPackages({}).then(
      () => null,
      (e: unknown) => e,
    );

    expect(isOpCancelledError(err)).toBe(true);
    expect(attempts).toBe(1); // the RAW client's request actually received the signal
    // The core proof: this resolves in ~10-20ms (cancel-triggered), not
    // anywhere near the 5s timeout — the composed signal genuinely reached
    // the innermost fetch-equivalent, through BOTH wrapper layers.
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
