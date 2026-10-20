import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { OpActivity, OpActivityDetail, OpStatus } from "./types";
import { deriveChangelogEvents, parseHoursLabel } from "./journal";

// SPEC_11 §5 — parser rewritten against the REAL OP activity shape:
// details are `{format, raw, html}` formatted TEXT, not `{property, old, new}`.

function status(id: number, name: string, isClosed: boolean): OpStatus {
  return { _type: "Status", id, name, isClosed };
}

const statusById = new Map<number, OpStatus>([
  [1, status(1, "New", false)],
  [2, status(2, "Developed", false)],
  [3, status(3, "Closed", true)],
]);

function activity(overrides: Partial<OpActivity> & { id: number }): OpActivity {
  return {
    _type: "Activity",
    createdAt: "2026-07-06T10:00:00Z",
    details: [],
    comment: null,
    _links: {
      self: { href: `/api/v3/activities/${overrides.id}` },
      workPackage: { href: "/api/v3/work_packages/1101" },
      // Real OP omits `title` here (SPEC_11 §4).
      user: { href: "/api/v3/users/2" },
    },
    ...overrides,
  };
}

/** Build a `{format,raw,html}` detail from field + from/to (mirrors real OP text). */
function changed(field: string, from: string, to: string): OpActivityDetail {
  return {
    format: "custom",
    raw: `${field} changed from ${from} to ${to}`,
    html: `<strong>${field}</strong> changed from <i>${from}</i> to <i>${to}</i>`,
  };
}
function setTo(field: string, to: string): OpActivityDetail {
  return {
    format: "custom",
    raw: `${field} set to ${to}`,
    html: `<strong>${field}</strong> set to <i>${to}</i>`,
  };
}

describe("deriveChangelogEvents (SPEC_11 §5, real activity shape)", () => {
  it("maps a single assignee change to exactly one assignee_changed draft", () => {
    const act = activity({ id: 1, details: [changed("Assignee", "Dev Dvořák", "Tereza Testerová")] });
    expect(deriveChangelogEvents(act, statusById)).toEqual([
      {
        kind: "assignee_changed",
        detail: { kind: "assignee_changed", from: "Dev Dvořák", to: "Tereza Testerová" },
        dedupSuffix: "assignee_changed",
      },
    ]);
  });

  it("assignee 'set to' (no previous) yields from:null", () => {
    const act = activity({ id: 1, details: [setTo("Assignee", "Cameron Dalby")] });
    expect(deriveChangelogEvents(act, statusById)[0]?.detail).toEqual({
      kind: "assignee_changed",
      from: null,
      to: "Cameron Dalby",
    });
  });

  it("a status transition into a closed status emits BOTH status_changed and a closed companion", () => {
    const act = activity({ id: 2, details: [changed("Status", "Developed", "Closed")] });
    expect(deriveChangelogEvents(act, statusById)).toEqual([
      { kind: "status_changed", detail: { kind: "status_changed", from: "Developed", to: "Closed" }, dedupSuffix: "status_changed" },
      { kind: "closed", detail: { kind: "closed", status: "Closed" }, dedupSuffix: "closed" },
    ]);
  });

  it("closed-status match is case/space-insensitive on the display NAME", () => {
    // Fixture-style lowercased status names still resolve against the id-keyed map.
    const byId = new Map<number, OpStatus>([[9, status(9, "Done", true)]]);
    const act = activity({ id: 2, details: [changed("Status", "in progress", "done")] });
    const kinds = deriveChangelogEvents(act, byId).map((e) => e.kind);
    expect(kinds).toEqual(["status_changed", "closed"]);
  });

  it("a status transition NOT into a closed status emits only status_changed", () => {
    const act = activity({ id: 3, details: [changed("Status", "New", "Developed")] });
    expect(deriveChangelogEvents(act, statusById)).toEqual([
      { kind: "status_changed", detail: { kind: "status_changed", from: "New", to: "Developed" }, dedupSuffix: "status_changed" },
    ]);
  });

  it("an unknown TO status name never throws and emits no closed companion", () => {
    const act = activity({ id: 3, details: [changed("Status", "New", "Some Custom State")] });
    expect(deriveChangelogEvents(act, statusById).map((e) => e.kind)).toEqual(["status_changed"]);
  });

  it("THE BUG FIX: multiple details on ONE activity all get their own draft, not just details[0]", () => {
    const act = activity({
      id: 4,
      details: [changed("Status", "developed", "tested"), changed("Assignee", "Daniel Brabec", "Jan Bily")],
    });
    const events = deriveChangelogEvents(act, statusById);
    expect(events.map((e) => e.kind)).toEqual(["status_changed", "assignee_changed"]);
  });

  it("a non-empty comment produces a content-free comment_added draft", () => {
    const act = activity({ id: 5, comment: { raw: "Looks good, merging." } });
    expect(deriveChangelogEvents(act, statusById)).toEqual([
      { kind: "comment_added", detail: { kind: "comment_added" }, dedupSuffix: "comment" },
    ]);
  });

  it("a blank/whitespace/empty comment (real field-change activity) is treated as no comment", () => {
    expect(deriveChangelogEvents(activity({ id: 6, comment: { raw: "   " } }), statusById)).toEqual([]);
    expect(deriveChangelogEvents(activity({ id: 6, comment: { raw: "" } }), statusById)).toEqual([]);
  });

  it("field change + comment in the SAME activity yields both drafts, field change first", () => {
    const act = activity({
      id: 7,
      _type: "Activity::Comment",
      details: [changed("Assignee", "Daniel Brabec", "Jan Bily")],
      comment: { raw: "Handing this back." },
    });
    expect(deriveChangelogEvents(act, statusById).map((e) => e.kind)).toEqual([
      "assignee_changed",
      "comment_added",
    ]);
  });

  it("an activity with NO details and NO comment yields nothing", () => {
    expect(deriveChangelogEvents(activity({ id: 8 }), statusById)).toEqual([]);
  });

  it("POLICY REVERSAL: an unrecognized field now yields a generic 'other' row with readable text", () => {
    const act = activity({ id: 9, details: [changed("Found In Release", "3.5.040", "3.5.038")] });
    expect(deriveChangelogEvents(act, statusById)).toEqual([
      {
        kind: "other",
        detail: { kind: "other", note: "Found In Release changed from 3.5.040 to 3.5.038" },
        dedupSuffix: "other:found_in_release",
      },
    ]);
  });

  it("an unrecognized field ALONGSIDE a recognized one: BOTH surface (the exact #11762 bug)", () => {
    const act = activity({
      id: 10,
      details: [changed("Priority", "Normal", "High"), changed("Assignee", "Daniel Brabec", "Jan Bily")],
    });
    const events = deriveChangelogEvents(act, statusById);
    expect(events.map((e) => e.kind)).toEqual(["other", "assignee_changed"]);
    expect(events[0]?.detail).toEqual({ kind: "other", note: "Priority changed from Normal to High" });
  });

  it("Work / Remaining work parse effort LABELS (not ISO durations); Version + Accountable typed", () => {
    const act = activity({
      id: 11,
      details: [
        setTo("Work", "12h"),
        changed("Remaining work", "12h", "1.5h"),
        changed("Version", "R1", "R2"),
        changed("Accountable", "Ann", "Bob"),
      ],
    });
    const events = deriveChangelogEvents(act, statusById);
    expect(events.map((e) => e.kind)).toEqual([
      "estimate_changed",
      "remaining_changed",
      "version_changed",
      "accountable_changed",
    ]);
    expect(events[0]?.detail).toEqual({ kind: "estimate_changed", from: null, to: 12 });
    expect(events[1]?.detail).toEqual({ kind: "remaining_changed", from: 12, to: 1.5 });
  });

  it("html WITHOUT <i> tags around the value still parses ('Scheduling mode set to Manual')", () => {
    const act = activity({
      id: 12,
      details: [{ format: "custom", raw: "Scheduling mode set to Manual", html: "<strong>Scheduling mode</strong> set to Manual" }],
    });
    expect(deriveChangelogEvents(act, statusById)).toEqual([
      { kind: "other", detail: { kind: "other", note: "Scheduling mode set to Manual" }, dedupSuffix: "other:scheduling_mode" },
    ]);
  });

  it("the 'Description set (Details link)' case becomes a clean 'Description updated' note", () => {
    const act = activity({
      id: 13,
      details: [
        {
          format: "custom",
          raw: "Description set (/journals/162436/diff/description)",
          html: '<strong>Description</strong> set (<a class="diff-details" href="/journals/162436/diff/description">Details</a>)',
        },
      ],
    });
    expect(deriveChangelogEvents(act, statusById)).toEqual([
      { kind: "other", detail: { kind: "other", note: "Description updated" }, dedupSuffix: "other:description" },
    ]);
  });
});

describe("parseHoursLabel", () => {
  it("parses labels and bare numbers, null on garbage", () => {
    expect(parseHoursLabel("12h")).toBe(12);
    expect(parseHoursLabel("1.5h")).toBe(1.5);
    expect(parseHoursLabel("0.7h")).toBeCloseTo(0.7);
    expect(parseHoursLabel("2h 30m")).toBeCloseTo(2.5);
    expect(parseHoursLabel("8")).toBe(8);
    expect(parseHoursLabel(null)).toBeNull();
    expect(parseHoursLabel("none")).toBeNull();
    expect(parseHoursLabel("")).toBeNull();
  });
});

// ── SPEC_11 §5 point 7: parse the REAL production fixture end-to-end ──────────
describe("real fixture: GET /api/v3/work_packages/11762/activities", () => {
  const fixture = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../../fixtures/samples/op_activities_11762.json", import.meta.url)),
      "utf8",
    ),
  ) as { _embedded: { elements: OpActivity[] } };

  // No status in this ticket's history is a closed status → empty map is fine
  // (unknown names simply skip the "closed" companion, never throw).
  const emptyStatuses = new Map<number, OpStatus>();

  function allEvents() {
    return fixture._embedded.elements.flatMap((act) => deriveChangelogEvents(act, emptyStatuses));
  }

  it("never throws and never produces the literal string 'undefined'", () => {
    const events = allEvents();
    expect(events.length).toBeGreaterThan(0);
    for (const ev of events) {
      expect(JSON.stringify(ev.detail)).not.toContain("undefined");
    }
  });

  it("reduces the assignee chain to Cameron Dalby → … → Jan Bily", () => {
    const chain = allEvents()
      .filter((e) => e.kind === "assignee_changed")
      .map((e) => (e.detail as { to: string | null }).to);
    expect(chain).toEqual([
      "Cameron Dalby",
      "Tobias Bubenik",
      "Daniel Brabec",
      "Tobias Bubenik",
      "Daniel Brabec",
      "Jan Bily",
    ]);
  });

  it("progresses status through to developed → tested", () => {
    const statuses = allEvents()
      .filter((e) => e.kind === "status_changed")
      .map((e) => {
        const d = e.detail as { from: string; to: string };
        return { from: d.from, to: d.to };
      });
    expect(statuses[statuses.length - 1]).toEqual({ from: "developed", to: "tested" });
    expect(statuses).toContainEqual({ from: "merge pending", to: "developed" });
  });

  it("produces at least one comment_added draft", () => {
    expect(allEvents().filter((e) => e.kind === "comment_added").length).toBeGreaterThanOrEqual(1);
  });

  it("keeps unknown custom fields as generic 'other' rows (nothing dropped)", () => {
    const notes = allEvents()
      .filter((e) => e.kind === "other")
      .map((e) => (e.detail as { note: string }).note);
    expect(notes).toContain("Found In Release changed from 3.5.040 to 3.5.038");
    // The Description-diff detail never leaks its ugly diff URL.
    expect(notes).toContain("Description updated");
  });

  it("parses the 'Work set to 12h' / 'Remaining work set to 12h' effort labels", () => {
    const events = allEvents();
    expect(events.find((e) => e.kind === "estimate_changed")?.detail).toEqual({
      kind: "estimate_changed",
      from: null,
      to: 12,
    });
    expect(events.find((e) => e.kind === "remaining_changed")?.detail).toEqual({
      kind: "remaining_changed",
      from: null,
      to: 12,
    });
  });
});
