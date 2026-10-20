import { describe, expect, it, vi } from "vitest";
import type { OpClient, OpRequestOptions } from "./client";
import { ReadOnlyViolationError } from "./client";
import {
  DEFAULT_ACTIVATION_TIMEOUT_MS,
  OpTimeoutError,
  withTimeout,
} from "./timeout";

/**
 * A minimal stub OpClient whose `request` we fully control. Every get* helper
 * dispatches through `this.request`, mirroring the real impl — so wrapping this
 * with withTimeout and calling a get* helper proves the timeout funnels ALL
 * traffic, not just direct request() calls.
 */
function makeStubClient(requestImpl: OpClient["request"]): OpClient {
  const client: OpClient = {
    request: requestImpl,
    getCurrentUser() {
      return this.request({ path: "/api/v3/users/me" });
    },
    getUsers(query) {
      return this.request({ path: "/api/v3/users", query: query as never });
    },
    getUser(id) {
      return this.request({ path: `/api/v3/users/${id}` });
    },
    getMemberships(query) {
      return this.request({ path: "/api/v3/memberships", query: query as never });
    },
    getProjects() {
      return this.request({ path: "/api/v3/projects" });
    },
    getWorkPackages(query) {
      return this.request({ path: "/api/v3/work_packages", query: query as never });
    },
    getTimeEntries(query) {
      return this.request({ path: "/api/v3/time_entries", query: query as never });
    },
    getVersions() {
      return this.request({ path: "/api/v3/versions" });
    },
    getStatuses() {
      return this.request({ path: "/api/v3/statuses" });
    },
    getWorkPackageSchema() {
      return this.request({ path: "/api/v3/work_packages/schema" });
    },
    getActivities(wpId) {
      return this.request({ path: `/api/v3/work_packages/${wpId}/activities` });
    },
  };
  return client;
}

/** Never resolves; rejects with the signal's reason if/when it aborts (undici-like). */
function hangUntilAbort<T>(options: OpRequestOptions): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    const signal = options.signal;
    if (!signal) return;
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

describe("withTimeout", () => {
  it("exports a sensible default timeout", () => {
    expect(DEFAULT_ACTIVATION_TIMEOUT_MS).toBe(15_000);
  });

  it("a call that completes before the timeout resolves normally", async () => {
    const value = { _embedded: { elements: [] } };
    const client = makeStubClient(async () => value as never);
    const wrapped = withTimeout(client, 1_000);
    await expect(wrapped.request({ path: "/api/v3/projects" })).resolves.toBe(value);
    await expect(wrapped.getProjects()).resolves.toBe(value);
  });

  it("clears the timer on success (no leaked timeout)", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const client = makeStubClient(async () => ({}) as never);
    const wrapped = withTimeout(client, 1_000);
    await wrapped.request({ path: "/api/v3/projects" });
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it("a call that never resolves is aborted at ~timeoutMs and rejects with OpTimeoutError", async () => {
    const client = makeStubClient(hangUntilAbort);
    const wrapped = withTimeout(client, 50);
    const start = performance.now();
    const err = await wrapped
      .request({ path: "/api/v3/work_packages" })
      .then(() => null, (e: unknown) => e);
    const elapsed = performance.now() - start;
    expect(err).toBeInstanceOf(OpTimeoutError);
    expect((err as OpTimeoutError).timeoutMs).toBe(50);
    expect((err as OpTimeoutError).path).toBe("/api/v3/work_packages");
    expect((err as OpTimeoutError).message).toContain("timed out after 50 ms");
    // Fired roughly at the timeout, not instantly and not on a long delay.
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(2_000);
  });

  it("get* helpers funnel through the timed request (a hanging getProjects times out)", async () => {
    const client = makeStubClient(hangUntilAbort);
    const wrapped = withTimeout(client, 50);
    await expect(wrapped.getProjects()).rejects.toBeInstanceOf(OpTimeoutError);
  });

  it("a caller-supplied signal is not dropped — the caller's abort still rejects (and is NOT reported as a timeout)", async () => {
    const client = makeStubClient(hangUntilAbort);
    // Large timeout so OUR timer cannot be what aborts this.
    const wrapped = withTimeout(client, 10_000);
    const caller = new AbortController();
    const callerReason = new Error("caller cancelled");
    const promise = wrapped.request({ path: "/api/v3/projects", signal: caller.signal });
    caller.abort(callerReason);
    const err = await promise.then(() => null, (e: unknown) => e);
    expect(err).toBe(callerReason);
    expect(err).not.toBeInstanceOf(OpTimeoutError);
  });

  it("propagates a synchronous ReadOnlyViolationError without arming a lingering rejection", () => {
    const client = makeStubClient((options) => {
      const method = options.method ?? "GET";
      if (method !== "GET") throw new ReadOnlyViolationError(method);
      return Promise.resolve({} as never);
    });
    const wrapped = withTimeout(client, 1_000);
    expect(() =>
      wrapped.request({ path: "/api/v3/work_packages", method: "POST" as never }),
    ).toThrow(ReadOnlyViolationError);
  });
});
