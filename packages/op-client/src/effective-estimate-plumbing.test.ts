import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRecordingMockOpServer, type RecordingMockOpServer } from "@osp/fixtures";
import { createOpClient } from "./impl";
import { parseIsoDuration } from "./util";
import type { OpWorkPackage } from "./types";

/**
 * SPEC_16 §5 ("effectiveEstimate") plumbing check (Agent A's scope): proves
 * `remainingTime` survives the WHOLE op-client leg of the pipeline — scenario
 * seed -> mock OP HAL response -> real HTTP fetch through createOpClient ->
 * typed OpWorkPackage -> parseIsoDuration — with no gap or silent drop,
 * alongside `estimatedTime`. This is deliberately a REAL HTTP round trip
 * (createRecordingMockOpServer + createOpClient), not a hand-built object, so
 * it also exercises the mock's HAL serialization (fixtures/mock-op-server/
 * hal.ts's hoursToIsoDuration) and the client's read-only GET path.
 *
 * Uses fixtures/scenarios/s11-effective-estimate.ts's WP 1901, built to mirror
 * SPEC_16 §5's own worked example (ticket #11765: Work 24h, Remaining 18h) —
 * see that file's header for why id 1901 is used instead of 11765 itself
 * (11765 already names a DIFFERENT, already-baselined ticket in
 * s9-role-closure.ts with different numbers).
 *
 * Combining `estimatedTime`/`remainingTime` into one effectiveEstimate number
 * is explicitly OUT of scope here — that resolver is Agent B's
 * `apps/api/src/logic/estimate.ts`. This test only proves both raw inputs
 * arrive at that boundary intact.
 */

let mock: RecordingMockOpServer;

beforeAll(async () => {
  mock = await createRecordingMockOpServer();
  const res = await fetch(`${mock.url}/__mock/load/s11-effective-estimate`, {
    method: "POST",
  });
  expect(res.status).toBe(200);
});

afterAll(async () => {
  await mock.close();
});

function makeClient() {
  return createOpClient({ baseUrl: mock.url, token: "secret-token" });
}

describe("remainingTime plumbing through the real op-client HTTP path (SPEC_16 §5)", () => {
  it("carries estimatedTime/remainingTime for WP 1901 (Work 24h/Remaining 18h) unmangled", async () => {
    const c = makeClient();
    const page = await c.getWorkPackages({
      filters: [{ id: { operator: "=", values: ["1901"] } }],
      pageSize: 10,
    });
    const wp = page._embedded.elements.find((w) => w.id === 1901) as
      | OpWorkPackage
      | undefined;
    expect(wp).toBeDefined();
    // Raw HAL strings survive the fetch + schema typing untouched. Work is 24h,
    // which real OpenProject (and now the mock, Increment 22) serializes with a
    // day component: "P1D". Remaining is 18h → still sub-24h "PT18H".
    expect(wp?.estimatedTime).toBe("P1D");
    expect(wp?.remainingTime).toBe("PT18H");
    // And parseIsoDuration turns both into the exact hours SPEC_16 §5 expects.
    expect(parseIsoDuration(wp?.estimatedTime ?? null)).toBe(24);
    expect(parseIsoDuration(wp?.remainingTime ?? null)).toBe(18);
    // The whole point of the rule: remaining is nonzero AND differs from work.
    const est = parseIsoDuration(wp?.estimatedTime ?? null);
    const rem = parseIsoDuration(wp?.remainingTime ?? null);
    expect(rem).not.toBe(0);
    expect(rem).not.toBe(est);
  });

  it("also carries the remaining==work and remaining==0 fall-through cases (WPs 1902/1903) intact", async () => {
    const c = makeClient();
    const page = await c.getWorkPackages({ pageSize: 100 });
    const byId = new Map(page._embedded.elements.map((w) => [w.id, w]));

    const equalsWork = byId.get(1902);
    expect(parseIsoDuration(equalsWork?.estimatedTime ?? null)).toBe(8);
    expect(parseIsoDuration(equalsWork?.remainingTime ?? null)).toBe(8);

    const zeroRemaining = byId.get(1903);
    expect(parseIsoDuration(zeroRemaining?.estimatedTime ?? null)).toBe(12);
    expect(parseIsoDuration(zeroRemaining?.remainingTime ?? null)).toBe(0);
  });

  it("round-trips a day-spanning ≥24h estimate through the mock HTTP + op-client (Increment 22, WP 1905)", async () => {
    // The genuine end-to-end proof that was PREVIOUSLY IMPOSSIBLE: the mock now
    // serializes a ≥24h estimate with a day component (like real prod WP 11592:
    // remainingTime "P1DT5H" == 29h), and the real op-client HTTP + parseIsoDuration
    // leg turns it straight back into 29. Before Increment 22 the mock always
    // emitted "PT29H", so no fixture/e2e test could ever exercise the D path even
    // though the parser handled it correctly all along.
    const c = makeClient();
    const page = await c.getWorkPackages({
      filters: [{ id: { operator: "=", values: ["1905"] } }],
      pageSize: 10,
    });
    const wp = page._embedded.elements.find((w) => w.id === 1905) as
      | OpWorkPackage
      | undefined;
    expect(wp).toBeDefined();
    // The raw HAL string that crossed the wire really does carry a day component.
    expect(wp?.estimatedTime).toBe("P1DT5H");
    expect(wp?.remainingTime).toBe("P1DT5H");
    // …and it parses back to exactly 29h (1 day * 24 + 5), not a stale 30.
    expect(parseIsoDuration(wp?.estimatedTime ?? null)).toBe(29);
    expect(parseIsoDuration(wp?.remainingTime ?? null)).toBe(29);
  });
});
