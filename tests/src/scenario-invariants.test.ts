import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRecordingMockOpServer,
  type RecordingMockOpServer,
} from "@osp/fixtures";
import type { WorkPackageStateSummary } from "@osp/fixtures/scenario-types";
import { parseIsoDuration } from "@osp/op-client";
import {
  addDays,
  getWorkPackageById,
  mockAdmin,
  opFilters,
  opGet,
  S3,
  S4,
  walkWorkPackages,
  type HalCollection,
  type HalTimeEntry,
  type MockAdmin,
} from "./scenario-helpers";

/**
 * SPEC_03 §9 — "časový model" + "scénářové invarianty", proven WITHOUT the app:
 * only the operator admin API (/__mock/*) and raw OP-consumer GETs (/api/v3/*).
 *
 *  - S3: remainingTime starts at 80h and strictly decreases as days advance;
 *    each day's time entries carry spentOn == the logical date; ONLY touched
 *    WPs get their updatedAt bumped.
 *  - S4: day 3 introduces 2–3 urgent WPs whose updatedAt is strictly newer than
 *    everything at day 2; an `updatedAt >=d` filter returns exactly the touched
 *    set (the incremental-sync contract); inject-urgent adds one more.
 *  - Clock: goto-day backward reloads + replays; reset returns fixture mode.
 */

/** State-summary fingerprint MINUS updated_at (to detect "was this WP touched?"). */
function fingerprint(wp: WorkPackageStateSummary): string {
  const { updated_at: _updatedAt, ...rest } = wp;
  return JSON.stringify(rest);
}

describe("scenario invariants — s3-epic-over-40h (clock + updatedAt semantics)", () => {
  let mock: RecordingMockOpServer;
  let admin: MockAdmin;

  beforeAll(async () => {
    mock = await createRecordingMockOpServer();
    admin = mockAdmin(mock.url);
    await admin.requireScenario(S3);
  }, 30_000);

  afterAll(async () => {
    await mock.close();
  });

  it("the PT80H epic strictly burns down day by day with correctly-dated time entries", async () => {
    const loaded = await admin.load(S3);
    expect(loaded.scenario).toBe(S3);
    expect(loaded.day).toBe(0);
    const startDate = loaded.date!;
    expect(startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Locate the epic as a raw OP consumer: the ~80h estimate WP.
    const day0 = await walkWorkPackages(mock.url);
    const epic = day0.elements.find(
      (w) => parseIsoDuration(w.estimatedTime ?? null) === 80,
    );
    expect(epic, "s3 must seed a WP with estimatedTime = PT80H").toBeDefined();
    // Clock contract: load() applies day-0 events immediately — so the seed's
    // 80h remaining may already have day 0's burn subtracted. It must still be
    // a parseable duration in (0, 80].
    const remaining0 = parseIsoDuration(epic!.remainingTime ?? null);
    expect(remaining0).not.toBeNull();
    expect(remaining0!).toBeGreaterThan(0);
    expect(remaining0!).toBeLessThanOrEqual(80);

    // Baselines for the "only touched WPs bump updatedAt" invariant.
    const updatedAt0 = new Map(day0.elements.map((w) => [w.id, w.updatedAt]));
    const state0 = await admin.state();
    const print0 = new Map(state0.work_packages.map((w) => [w.id, fingerprint(w)]));

    const daysToRun = Math.min(loaded.total_days, 4);
    expect(daysToRun, "s3 needs a multi-day timeline").toBeGreaterThanOrEqual(2);

    let previousRemaining = remaining0!;
    for (let n = 1; n <= daysToRun; n += 1) {
      const advanced = await admin.advanceDay();
      expect(advanced.day).toBe(n);
      const expectedDate = addDays(startDate, n);
      expect(advanced.date).toBe(expectedDate); // clock moved one calendar day

      if (advanced.applied_events > 0) {
        // remainingTime strictly decreases on every day the timeline works.
        const wp = await getWorkPackageById(mock.url, epic!.id);
        const remaining = parseIsoDuration(wp?.remainingTime ?? null);
        expect(remaining, `day ${n} remainingTime`).not.toBeNull();
        expect(remaining!).toBeLessThan(previousRemaining);
        previousRemaining = remaining!;

        // Day N's time entries are dated startDate+N — the logical date.
        // (Explicit pageSize: the mock's OP-compatible default is tiny.)
        const entries = await opGet<HalCollection<HalTimeEntry>>(
          mock.url,
          "/api/v3/time_entries",
          { pageSize: "500" },
        );
        const todays = entries._embedded.elements.filter(
          (te) => te.spentOn === expectedDate,
        );
        expect(
          todays.length,
          `day ${n} (${expectedDate}) must have logged time entries`,
        ).toBeGreaterThan(0);
        for (const te of todays) {
          expect(parseIsoDuration(te.hours)!).toBeGreaterThan(0);
        }
      }
    }
    expect(previousRemaining).toBeLessThan(remaining0!); // the burn actually happened

    // ── updatedAt bumps ONLY for touched WPs ─────────────────────────────────
    const stateN = await admin.state();
    const printN = new Map(stateN.work_packages.map((w) => [w.id, fingerprint(w)]));
    const dayN = await walkWorkPackages(mock.url);
    let touched = 0;
    for (const wp of dayN.elements) {
      const before = updatedAt0.get(wp.id);
      if (before === undefined) continue; // added mid-scenario (not s3's case)
      const wasTouched = print0.get(wp.id) !== printN.get(wp.id);
      if (wasTouched) {
        touched += 1;
        expect(
          Date.parse(wp.updatedAt),
          `touched WP ${wp.id} must bump updatedAt`,
        ).toBeGreaterThan(Date.parse(before));
      } else {
        expect(
          wp.updatedAt,
          `untouched WP ${wp.id} must keep its updatedAt`,
        ).toBe(before);
      }
    }
    expect(touched).toBeGreaterThan(0); // at least the epic
    const epicAfter = dayN.elements.find((w) => w.id === epic!.id)!;
    expect(Date.parse(epicAfter.updatedAt)).toBeGreaterThan(
      Date.parse(updatedAt0.get(epic!.id)!),
    );
  }, 60_000);
});

describe("scenario invariants — s4-volatile-sprint (scope churn + incremental filter)", () => {
  let mock: RecordingMockOpServer;
  let admin: MockAdmin;

  beforeAll(async () => {
    mock = await createRecordingMockOpServer();
    admin = mockAdmin(mock.url);
    await admin.requireScenario(S4);
  }, 30_000);

  afterAll(async () => {
    await mock.close();
  });

  it("day 3 adds 2-3 urgent WPs, strictly newer than everything at day 2; >=d returns exactly the touched set", async () => {
    await admin.load(S4);
    const day2State = await admin.gotoDay(2);
    expect(day2State.day).toBe(2);

    const day2 = await walkWorkPackages(mock.url);
    const idsDay2 = new Set(day2.elements.map((w) => w.id));
    const maxUpdatedDay2 = Math.max(
      ...day2.elements.map((w) => Date.parse(w.updatedAt)),
    );

    const advanced = await admin.advanceDay(); // → day 3, the churn day
    expect(advanced.day).toBe(3);
    expect(advanced.applied_events).toBeGreaterThan(0);

    const day3 = await walkWorkPackages(mock.url);
    const newWps = day3.elements.filter((w) => !idsDay2.has(w.id));

    // "state at day 2 has no URGENT WPs" — they only exist from day 3 on.
    expect(newWps.length).toBeGreaterThanOrEqual(2);
    expect(newWps.length).toBeLessThanOrEqual(3);
    for (const wp of newWps) {
      expect(
        Date.parse(wp.updatedAt),
        `new WP ${wp.id} must be newer than every day-2 timestamp`,
      ).toBeGreaterThan(maxUpdatedDay2);
    }

    // Incremental-sync contract: >=d with day-3 morning returns EXACTLY the
    // WPs touched on day 3 (the new/bumped set) — nothing more, nothing less.
    const cutoff = `${advanced.date}T00:00:00Z`;
    const expected = new Set(
      day3.elements
        .filter((w) => Date.parse(w.updatedAt) >= Date.parse(cutoff))
        .map((w) => w.id),
    );
    const filtered = await walkWorkPackages(mock.url, {
      filters: opFilters([["updatedAt", ">=d", [cutoff]]]),
    });
    expect(new Set(filtered.elements.map((w) => w.id))).toEqual(expected);
    for (const wp of newWps) {
      expect(expected.has(wp.id), `urgent WP ${wp.id} in the >=d set`).toBe(true);
    }
  }, 60_000);

  it("inject-urgent adds one more WP, visible in /__mock/state AND via /api/v3", async () => {
    const before = await admin.state();
    const injected = await admin.injectUrgent();
    const id = injected.work_package.id;
    expect(before.work_packages.some((w) => w.id === id)).toBe(false);

    const after = await admin.state();
    expect(after.work_packages.some((w) => w.id === id)).toBe(true);

    const viaOp = await getWorkPackageById(mock.url, id);
    expect(viaOp, `injected WP ${id} must be served on /api/v3`).toBeDefined();
    expect(viaOp!.subject).toBe(injected.work_package.subject);
  }, 30_000);

  it("goto-day BACKWARD reloads the scenario and replays to the target day", async () => {
    await admin.load(S4);
    const day1 = await admin.gotoDay(1);
    const day1Count = day1.work_packages.length;
    const day1Date = day1.date;

    const day5 = await admin.gotoDay(5);
    expect(day5.day).toBe(5);
    // Day 3's churn happened on the way — more WPs than at day 1.
    expect(day5.work_packages.length).toBeGreaterThan(day1Count);

    const back = await admin.gotoDay(1); // backward ⇒ reset + replay to day 1
    expect(back.day).toBe(1);
    expect(back.date).toBe(day1Date);
    expect(back.work_packages.length).toBe(day1Count); // urgent WPs are GONE again

    const raw = await walkWorkPackages(mock.url);
    expect(raw.total).toBe(day1Count);
  }, 60_000);

  it("reset returns the instance to fixture mode (the static 20-WP dataset reappears)", async () => {
    await admin.load(S4);
    await admin.gotoDay(3);
    const reset = await admin.reset();
    expect(reset.mode).toBe("fixtures");

    const state = await admin.state();
    expect(state.scenario).toBeNull();

    // Legacy static fixture data is served again (fixtures/data/work_packages.json).
    const raw = await walkWorkPackages(mock.url);
    expect(raw.total).toBe(20);
  }, 30_000);
});
