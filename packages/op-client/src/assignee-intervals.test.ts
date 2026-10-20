import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PersonRole } from "@osp/contracts";
import { describe, expect, it } from "vitest";
import {
  acquiredMidSprint,
  assigneeChangeEvents,
  assigneeIntervals,
  creationInstant,
  holderAtInstant,
  isHolderAtInstant,
  type AssigneeChangeEvent,
} from "./assignee-intervals";
import type { OpActivity, OpActivityDetail } from "./types";

// A convenient view of an interval for assertions (drops enrichment/wp fields).
function shape(ivs: ReturnType<typeof assigneeIntervals>) {
  return ivs.map((iv) => ({ holder: iv.holder_name, from: iv.from, to: iv.to }));
}

function ev(occurred_at: string, from: string | null, to: string | null): AssigneeChangeEvent {
  return { occurred_at, from, to };
}

const ANCHOR = "2026-07-06T00:00:00.000Z";

describe("assigneeIntervals — SPEC_15 §5 folding", () => {
  it("no events → a single open interval held by the fallback baseline holder", () => {
    const ivs = assigneeIntervals({
      wp_op_id: 1,
      events: [],
      baseline_anchor: ANCHOR,
      baseline_holder_fallback: "Zbynek Trnka",
    });
    expect(shape(ivs)).toEqual([{ holder: "Zbynek Trnka", from: ANCHOR, to: null }]);
    // "in baseline" holds; nobody acquired it mid-sprint.
    expect(isHolderAtInstant(ivs, "Zbynek Trnka", ANCHOR)).toBe(true);
    expect(acquiredMidSprint(ivs, "Zbynek Trnka", ANCHOR)).toBe(false);
  });

  it("no events, no fallback → a single open UNASSIGNED interval (null holder, not a gap)", () => {
    const ivs = assigneeIntervals({ wp_op_id: 1, events: [], baseline_anchor: ANCHOR });
    expect(shape(ivs)).toEqual([{ holder: null, from: ANCHOR, to: null }]);
  });

  it("single reassignment after the anchor → baseline interval closes, new opens", () => {
    const ivs = assigneeIntervals({
      wp_op_id: 42,
      events: [ev("2026-07-08T09:00:00.000Z", "Milan Cerny", "Ota Horak")],
      baseline_anchor: ANCHOR,
      baseline_holder_fallback: "Milan Cerny",
    });
    expect(shape(ivs)).toEqual([
      { holder: "Milan Cerny", from: ANCHOR, to: "2026-07-08T09:00:00.000Z" },
      { holder: "Ota Horak", from: "2026-07-08T09:00:00.000Z", to: null },
    ]);
    expect(isHolderAtInstant(ivs, "Milan Cerny", ANCHOR)).toBe(true);
    expect(isHolderAtInstant(ivs, "Ota Horak", ANCHOR)).toBe(false);
    // Ota acquired it mid-sprint; Milan did not.
    expect(acquiredMidSprint(ivs, "Ota Horak", ANCHOR)).toBe(true);
    expect(acquiredMidSprint(ivs, "Milan Cerny", ANCHOR)).toBe(false);
    expect(holderAtInstant(ivs, "2026-07-09T00:00:00.000Z")?.holder_name).toBe("Ota Horak");
  });

  it("a change BEFORE the anchor folds into the baseline holder (no interval before the anchor)", () => {
    const ivs = assigneeIntervals({
      wp_op_id: 7,
      events: [
        ev("2026-07-04T10:00:00.000Z", "Alice", "Bob"), // pre-anchor: sets baseline to Bob
        ev("2026-07-09T10:00:00.000Z", "Bob", "Carol"), // post-anchor: real transition
      ],
      baseline_anchor: ANCHOR,
      baseline_holder_fallback: "IGNORED_FALLBACK",
    });
    // The pre-anchor event determines the baseline holder (Bob), overriding the
    // fallback; the first interval opens at the anchor, not at the 07-04 event.
    expect(shape(ivs)).toEqual([
      { holder: "Bob", from: ANCHOR, to: "2026-07-09T10:00:00.000Z" },
      { holder: "Carol", from: "2026-07-09T10:00:00.000Z", to: null },
    ]);
  });

  it("change exactly AT the anchor is inclusive (folds into baseline)", () => {
    const ivs = assigneeIntervals({
      wp_op_id: 7,
      events: [ev(ANCHOR, "Alice", "Bob")],
      baseline_anchor: ANCHOR,
    });
    expect(shape(ivs)).toEqual([{ holder: "Bob", from: ANCHOR, to: null }]);
  });

  it("unassign-then-reassign → the cleared interval has holder_name null (a real state)", () => {
    const ivs = assigneeIntervals({
      wp_op_id: 9,
      events: [
        ev("2026-07-07T09:00:00.000Z", "Dev", null), // cleared
        ev("2026-07-09T09:00:00.000Z", null, "Dev2"), // reassigned
      ],
      baseline_anchor: ANCHOR,
      baseline_holder_fallback: "Dev",
    });
    expect(shape(ivs)).toEqual([
      { holder: "Dev", from: ANCHOR, to: "2026-07-07T09:00:00.000Z" },
      { holder: null, from: "2026-07-07T09:00:00.000Z", to: "2026-07-09T09:00:00.000Z" },
      { holder: "Dev2", from: "2026-07-09T09:00:00.000Z", to: null },
    ]);
    // The unassigned window is a queryable state, not a hole.
    expect(holderAtInstant(ivs, "2026-07-08T00:00:00.000Z")?.holder_name).toBeNull();
  });

  it("ticket created AFTER the anchor (not_yet_created) → first interval opens at creation", () => {
    const created = "2026-07-08T08:00:00.000Z";
    const ivs = assigneeIntervals({
      wp_op_id: 500,
      // The creation "Assignee set to Jan Belka" is journaled at the creation
      // instant; it must NOT produce a zero-length interval.
      events: [ev(created, null, "Jan Belka")],
      baseline_anchor: ANCHOR,
      created_at: created,
      baseline_holder_fallback: "SHOULD_NOT_BE_USED",
    });
    expect(shape(ivs)).toEqual([{ holder: "Jan Belka", from: created, to: null }]);
    // There is no baseline interval → the anchor precedes every interval.
    expect(holderAtInstant(ivs, ANCHOR)).toBeNull();
    expect(isHolderAtInstant(ivs, "Jan Belka", ANCHOR)).toBe(false);
    // Jan acquired it mid-sprint.
    expect(acquiredMidSprint(ivs, "Jan Belka", ANCHOR)).toBe(true);
  });

  it("created after anchor with a LATER reassignment too", () => {
    const created = "2026-07-08T08:00:00.000Z";
    const ivs = assigneeIntervals({
      wp_op_id: 501,
      events: [
        ev(created, null, "Jan Belka"),
        ev("2026-07-10T08:00:00.000Z", "Jan Belka", "Arend Kuiper"),
      ],
      baseline_anchor: ANCHOR,
      created_at: created,
    });
    expect(shape(ivs)).toEqual([
      { holder: "Jan Belka", from: created, to: "2026-07-10T08:00:00.000Z" },
      { holder: "Arend Kuiper", from: "2026-07-10T08:00:00.000Z", to: null },
    ]);
  });

  it("multiple reassignments in ONE day → one interval per hop, chronological", () => {
    const ivs = assigneeIntervals({
      wp_op_id: 12,
      // Deliberately shuffled input — sorted internally.
      events: [
        ev("2026-07-08T15:00:00.000Z", "B", "C"),
        ev("2026-07-08T09:00:00.000Z", "A", "B"),
        ev("2026-07-08T12:00:00.000Z", "B", "B"), // no-op hand-back to same name still emits
      ],
      baseline_anchor: ANCHOR,
      baseline_holder_fallback: "A",
    });
    expect(shape(ivs)).toEqual([
      { holder: "A", from: ANCHOR, to: "2026-07-08T09:00:00.000Z" },
      { holder: "B", from: "2026-07-08T09:00:00.000Z", to: "2026-07-08T12:00:00.000Z" },
      { holder: "B", from: "2026-07-08T12:00:00.000Z", to: "2026-07-08T15:00:00.000Z" },
      { holder: "C", from: "2026-07-08T15:00:00.000Z", to: null },
    ]);
  });

  it("BUG 1 (SPEC_17 §3, #11762 shape) — a middle holder who re-appears NON-CONTIGUOUSLY keeps BOTH intervals", () => {
    // The real #11762 chain shape: baseline C(hristopher) → A(Tobias) → B(Daniel)
    // → A again → B again → third holder. Tobias holds the ticket TWICE, in two
    // separate, non-contiguous windows, and is neither the baseline nor the
    // final holder. This asserts the fold NEVER dedups/collapses a holder that
    // displaced-then-returned — so the "Tobias gets nothing" symptom in SPEC_17
    // §3 cannot originate in op-client's interval folding (it must be a
    // DOWNSTREAM classification bug in apps/api's developerSegments, which only
    // detected the RED `acquired` case for the sprint-add path, not dev→dev).
    const C = "Cameron Dalby";
    const A = "Tobias Bubenik";
    const B = "Daniel Brabec";
    const F = "Jan Bily";
    const e1 = "2026-07-07T09:00:00.000Z"; // C → A  (Tobias acquires, hold #1)
    const e2 = "2026-07-08T09:00:00.000Z"; // A → B
    const e3 = "2026-07-09T09:00:00.000Z"; // B → A  (Tobias returns, hold #2)
    const e4 = "2026-07-10T09:00:00.000Z"; // A → B
    const e5 = "2026-07-11T09:00:00.000Z"; // B → F  (final holder)
    const ivs = assigneeIntervals({
      wp_op_id: 11762,
      // shuffled input — sorted internally
      events: [ev(e4, A, B), ev(e1, C, A), ev(e5, B, F), ev(e2, A, B), ev(e3, B, A)],
      baseline_anchor: ANCHOR,
      baseline_holder_fallback: C,
    });
    expect(shape(ivs)).toEqual([
      { holder: C, from: ANCHOR, to: e1 },
      { holder: A, from: e1, to: e2 }, // Tobias hold #1
      { holder: B, from: e2, to: e3 },
      { holder: A, from: e3, to: e4 }, // Tobias hold #2 — must NOT be dropped
      { holder: B, from: e4, to: e5 },
      { holder: F, from: e5, to: null },
    ]);
    // BOTH of Tobias's intervals survive, correctly bounded and non-contiguous.
    const tobiasIvs = ivs.filter((iv) => iv.holder_name === A);
    expect(tobiasIvs).toHaveLength(2);
    expect(tobiasIvs.map((iv) => [iv.from, iv.to])).toEqual([
      [e1, e2],
      [e3, e4],
    ]);
    // Tobias is NOT the baseline holder (Cameron is) but DID acquire mid-sprint.
    expect(isHolderAtInstant(ivs, A, ANCHOR)).toBe(false);
    expect(isHolderAtInstant(ivs, C, ANCHOR)).toBe(true);
    expect(acquiredMidSprint(ivs, A, ANCHOR)).toBe(true);
    // `acquiredMidSprint` reports his EARLIEST acquisition (hold #1's start).
    expect(holderAtInstant(ivs, e1)?.holder_name).toBe(A);
    expect(holderAtInstant(ivs, e3)?.holder_name).toBe(A);
  });

  it("normalizes a bare YYYY-MM-DD anchor to a valid datetime `from`", () => {
    const ivs = assigneeIntervals({
      wp_op_id: 1,
      events: [],
      baseline_anchor: "2026-07-06",
      baseline_holder_fallback: "Dev",
    });
    expect(ivs[0]!.from).toBe("2026-07-06T00:00:00.000Z");
  });

  it("resolveHolder enriches op_user_id/role; a null holder stays null-role", () => {
    const roleByName: Record<string, { op_user_id: number | null; role: PersonRole | null }> = {
      "Jan Belka": { op_user_id: 110, role: "developer" },
    };
    const ivs = assigneeIntervals({
      wp_op_id: 1,
      events: [ev("2026-07-08T09:00:00.000Z", "Jan Belka", null)],
      baseline_anchor: ANCHOR,
      baseline_holder_fallback: "Jan Belka",
      resolveHolder: (name) =>
        (name !== null && roleByName[name]) || { op_user_id: null, role: null },
    });
    expect(ivs[0]).toMatchObject({ holder_name: "Jan Belka", holder_op_user_id: 110, holder_role: "developer" });
    expect(ivs[1]).toMatchObject({ holder_name: null, holder_op_user_id: null, holder_role: null });
  });
});

// ── OpActivity adapter, against the REAL #11762 fixture ──────────────────────
describe("assigneeChangeEvents / creationInstant — real fixture 11762", () => {
  const fixture = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../../fixtures/samples/op_activities_11762.json", import.meta.url)),
      "utf8",
    ),
  ) as { _embedded: { elements: OpActivity[] } };
  const activities = fixture._embedded.elements;

  it("folds #11762's assignee journal into the documented handoff chain", () => {
    const events = assigneeChangeEvents(activities);
    const created = creationInstant(activities);
    expect(created).toBe("2026-07-07T03:41:21.757Z");
    const ivs = assigneeIntervals({
      wp_op_id: 11762,
      events,
      baseline_anchor: "2026-07-10T09:00:00.000Z", // matches reconstruct.test's §11 case
      created_at: created,
    });
    // At 09:00 on 07-10 the holder is Cameron Dalby (reconstruct.test.ts §11).
    expect(holderAtInstant(ivs, "2026-07-10T09:00:00.000Z")?.holder_name).toBe("Cameron Dalby");
    // Later that day it moves to Tobias Bubenik, then Daniel Brabec; ends on Jan Bily.
    expect(holderAtInstant(ivs, "2026-07-10T11:00:00.000Z")?.holder_name).toBe("Tobias Bubenik");
    expect(holderAtInstant(ivs, "2026-07-20T00:00:00.000Z")?.holder_name).toBe("Jan Bily");
    // The open interval is the final holder.
    expect(ivs.at(-1)?.to).toBeNull();
    expect(ivs.at(-1)?.holder_name).toBe("Jan Bily");
    // BUG 1 (SPEC_17 §3): Tobias Bubenik held #11762 in TWO separate windows and
    // is neither baseline nor final — the fold keeps BOTH, so op-client is not
    // the source of the missing-red symptom.
    const tobiasIvs = ivs.filter((iv) => iv.holder_name === "Tobias Bubenik");
    expect(tobiasIvs).toHaveLength(2);
    expect(isHolderAtInstant(ivs, "Tobias Bubenik", "2026-07-10T09:00:00.000Z")).toBe(false);
    expect(acquiredMidSprint(ivs, "Tobias Bubenik", "2026-07-10T09:00:00.000Z")).toBe(true);
  });

  it("an observed cleared assignee becomes a null-holder interval, not a gap", () => {
    function detail(html: string, raw: string): OpActivityDetail {
      return { format: "custom", raw, html };
    }
    const acts: OpActivity[] = [
      {
        _type: "Activity",
        id: 1,
        createdAt: "2026-07-07T00:00:00.000Z",
        comment: null,
        details: [detail("<strong>Assignee</strong> set to <i>Dalby</i>", "Assignee set to Dalby")],
        _links: { self: { href: "/a/1" }, workPackage: { href: "/wp/1" }, user: { href: "/u/1" } },
      },
      {
        _type: "Activity",
        id: 2,
        createdAt: "2026-07-09T00:00:00.000Z",
        comment: null,
        details: [detail("<strong>Assignee</strong> deleted", "Assignee deleted")],
        _links: { self: { href: "/a/2" }, workPackage: { href: "/wp/1" }, user: { href: "/u/1" } },
      },
    ];
    const ivs = assigneeIntervals({
      wp_op_id: 1,
      events: assigneeChangeEvents(acts),
      baseline_anchor: "2026-07-08T00:00:00.000Z",
    });
    expect(ivs.at(-1)?.holder_name).toBeNull();
  });
});
