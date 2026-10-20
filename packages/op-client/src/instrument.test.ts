import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRecordingMockOpServer, type RecordingMockOpServer } from "@osp/fixtures";
import { createOpClient } from "./impl";
import { ReadOnlyViolationError } from "./client";
import { withHardCancel } from "./hardCancel";
import { instrumentOpClient, type OpCallReport } from "./instrument";

let mock: RecordingMockOpServer;

beforeAll(async () => {
  mock = await createRecordingMockOpServer();
});

afterAll(async () => {
  await mock.close();
});

function makeWrapped(onResult: (r: OpCallReport) => void) {
  const client = createOpClient({ baseUrl: mock.url, token: "t", maxRetries: 0 });
  return instrumentOpClient(client, onResult);
}

describe("instrumentOpClient", () => {
  it("reports a success for a direct request()", async () => {
    const reports: OpCallReport[] = [];
    const wrapped = makeWrapped((r) => reports.push(r));
    await wrapped.request({ path: "/api/v3/users/me" });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ ok: true, error: null });
    expect(reports[0]!.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("get* helpers report through the wrapper (this.request indirection)", async () => {
    const reports: OpCallReport[] = [];
    const wrapped = makeWrapped((r) => reports.push(r));
    const projects = await wrapped.getProjects();
    expect(projects._embedded.elements.length).toBeGreaterThan(0);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ ok: true, error: null });
  });

  it("reports every call, including detached methods and query-carrying helpers", async () => {
    const reports: OpCallReport[] = [];
    const wrapped = makeWrapped((r) => reports.push(r));
    const { getStatuses } = wrapped; // detached — must still instrument
    await getStatuses();
    await wrapped.getWorkPackages({ pageSize: 2, offset: 1 });
    await wrapped.getTimeEntries({});
    expect(reports).toHaveLength(3);
    expect(reports.every((r) => r.ok)).toBe(true);
  });

  it("reports a failure with a short error and still rejects", async () => {
    const reports: OpCallReport[] = [];
    const wrapped = makeWrapped((r) => reports.push(r));
    await expect(
      wrapped.request({ path: "/api/v3/nonexistent" }),
    ).rejects.toThrow();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ ok: false, error: "HTTP 404" });
  });

  it("HTTP 400 (OP rejected our query) reports ok:true — must not flip health to fail (SPEC_07 §3)", async () => {
    const reports: OpCallReport[] = [];
    const wrapped = makeWrapped((r) => reports.push(r));
    const filters = JSON.stringify([{ workPackage: { operator: "=", values: ["1"] } }]);
    await expect(
      wrapped.request({ path: "/api/v3/time_entries", query: { filters } }),
    ).rejects.toThrow();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ ok: true, error: null });
  });

  it("a throwing onResult never surfaces into the caller", async () => {
    const wrapped = makeWrapped(() => {
      throw new Error("observer bug");
    });
    const me = await wrapped.getCurrentUser();
    expect(me.id).toBe(1);
  });

  it("ReadOnlyViolationError propagates SYNCHRONOUSLY and is NOT reported", () => {
    const onResult = vi.fn();
    const wrapped = makeWrapped(onResult);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(() =>
      wrapped.request({ path: "/api/v3/work_packages", method: "POST" as never }),
    ).toThrow(ReadOnlyViolationError);
    // No I/O attempted → no report (piggyback counts network attempts only).
    expect(onResult).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("sends only GET to the wire across all wrapped calls", async () => {
    mock.reset();
    const wrapped = makeWrapped(() => {});
    await Promise.all([
      wrapped.getCurrentUser(),
      wrapped.getProjects(),
      wrapped.getVersions(),
      wrapped.getWorkPackageSchema(),
    ]);
    expect(mock.methodSet()).toEqual(new Set(["GET"]));
  });

  it("Increment 20: a user cancellation (via an outer withHardCancel layer) is NOT reported as a health failure", async () => {
    // A cancelled sync must not flip the connection's health to
    // unhealthy/stale — that's a deliberate user choice, not evidence the
    // connection is broken. Confirmed live: without this, an aborted sync's
    // OWN cancellation reported ok:false here, and the next backlog read
    // (computing `stale` from that health status) showed rows as newly
    // stale even though the cache itself was never touched — a rollback
    // byte-identical check failed on this field alone.
    //
    // A hung fake request (not the real mock server) makes the abort timing
    // deterministic — a real HTTP round-trip could race a 10ms abort.
    const reports: OpCallReport[] = [];
    const hangingClient = {
      request(options: { signal?: AbortSignal }): Promise<never> {
        return new Promise<never>((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(options.signal!.reason ?? new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      },
      getWorkPackages(this: { request: (o: unknown) => Promise<unknown> }, query: unknown) {
        return this.request({ path: "/api/v3/work_packages", query });
      },
    } as unknown as Parameters<typeof instrumentOpClient>[0];
    const instrumented = instrumentOpClient(hangingClient, (r) => reports.push(r));
    const external = new AbortController();
    const wrapped = withHardCancel(instrumented, {
      timeoutMs: 5000,
      signal: external.signal,
    });
    setTimeout(() => external.abort(), 10);
    await expect(wrapped.getWorkPackages({})).rejects.toThrow(/cancelled/i);
    expect(reports).toHaveLength(0);
  });
});
