import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  stateAtDate,
  versionScopeEvents,
  type ReconstructFallback,
} from "./reconstruct";
import type { OpActivity, OpActivityDetail, OpStatus } from "./types";

// ── Test builders (mirror journal.test.ts's real-OP detail shapes) ───────────
function status(id: number, name: string, isClosed: boolean): OpStatus {
  return { _type: "Status", id, name, isClosed };
}
// Canonical OP spelling (as GET /api/v3/statuses returns it) for every status
// the fixtures below transition through — Increment 21 reconstruction resolves
// the LITERAL lower-case journal text ("in progress") against this catalog and
// stores the canonical name ("In progress").
const statusById = new Map<number, OpStatus>([
  [1, status(1, "New", false)],
  [2, status(2, "In progress", false)],
  [3, status(3, "Developed", false)],
  [4, status(4, "Merge pending", false)],
  [5, status(5, "Tested", false)],
]);

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
function activity(
  id: number,
  createdAt: string,
  details: OpActivityDetail[],
): OpActivity {
  return {
    _type: "Activity",
    id,
    createdAt,
    details,
    comment: null,
    _links: {
      self: { href: `/api/v3/activities/${id}` },
      workPackage: { href: "/api/v3/work_packages/1" },
      user: { href: "/api/v3/users/2" },
    },
  };
}

// A fallback whose values are DISTINCT from anything the journals produce, so a
// test can prove a value came from reconstruction vs. from fallback.
const FALLBACK: ReconstructFallback = {
  status_name: "FALLBACK_STATUS",
  assignee_name: "FALLBACK_ASSIGNEE",
  assignee_op_id: 9999,
  estimated_hours: -1,
  remaining_hours: -2,
  version_name: "FALLBACK_VERSION",
};

// ── SPEC_12 §11 acceptance: reconstruction against the REAL #11762 fixture ────
describe("stateAtDate — SPEC_12 §11 acceptance (real fixture 11762)", () => {
  const fixture = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../../fixtures/samples/op_activities_11762.json", import.meta.url)),
      "utf8",
    ),
  ) as { _embedded: { elements: OpActivity[] } };
  const activities = fixture._embedded.elements;

  it("early morning 2026-07-10 (after v7 status→in progress @07:59, before v8 assignee change @10:53)", () => {
    // The SPEC_12 §11 case, now CANONICALIZED (Increment 21 / SPEC_21): the
    // journal renders "in progress" (lower-case), but reconstruction resolves it
    // against the status catalog and stores OP's own spelling "In progress" —
    // matching what live sync writes, so the Status filter shows ONE entry.
    const s = stateAtDate(activities, statusById, "2026-07-10T09:00:00Z", FALLBACK);
    expect(s.status_name).toBe("In progress");
    expect(s.assignee_name).toBe("Cameron Dalby");
    // v2 set Version to 3.5.038 (2026-07-07); v4 set Work/Remaining to 12h.
    expect(s.version_name).toBe("3.5.038");
    expect(s.estimated_hours).toBe(12);
    expect(s.remaining_hours).toBe(12);
    // Every field had journal coverage → nothing fell back. (op_id is never in
    // journals, but it's not flagged when the assignee concept had coverage.)
    expect(s.gaps).toEqual([]);
    // op_id is not journal-derivable — it always comes from fallback.
    expect(s.assignee_op_id).toBe(9999);
  });

  it("immediately after v8 (2026-07-10T11:00:00Z, before v9 @11:09) → assignee flips to Tobias Bubenik", () => {
    // SPEC_12 §11: "po v8: Tobias Bubenik". Status is still `in progress` here
    // (v9's merge-pending change is at 11:09, after this target).
    const s = stateAtDate(activities, statusById, "2026-07-10T11:00:00Z", FALLBACK);
    expect(s.assignee_name).toBe("Tobias Bubenik");
    expect(s.status_name).toBe("In progress");
  });

  it("end of 2026-07-10 (after v10 @18:38) → the fold keeps going: developed / Daniel Brabec", () => {
    // NB: by 23:59 the chain has moved PAST Tobias Bubenik — v10 (18:38) set
    // status→developed and assignee→Daniel Brabec. Reconstruction is a full fold,
    // not "snap to the nearest interesting event". Status canonicalized to
    // "Developed" (Increment 21).
    const s = stateAtDate(activities, statusById, "2026-07-10T23:59:59Z", FALLBACK);
    expect(s.status_name).toBe("Developed");
    expect(s.assignee_name).toBe("Daniel Brabec");
  });

  it("inclusive boundary: target EXACTLY at v8's createdAt includes v8", () => {
    const s = stateAtDate(activities, statusById, "2026-07-10T10:53:07.410Z", FALLBACK);
    expect(s.assignee_name).toBe("Tobias Bubenik");
  });

  it("target BEFORE v1 creation → every field is a gap, falls back entirely, and not_yet_created", () => {
    const s = stateAtDate(activities, statusById, "2026-07-06T00:00:00Z", FALLBACK);
    expect(s).toEqual({
      status_name: "FALLBACK_STATUS",
      assignee_name: "FALLBACK_ASSIGNEE",
      assignee_op_id: 9999,
      estimated_hours: -1,
      remaining_hours: -2,
      version_name: "FALLBACK_VERSION",
      gaps: [
        "status_name",
        "assignee_name",
        "assignee_op_id",
        "estimated_hours",
        "remaining_hours",
        "version_name",
      ],
      // #11762's v1 (creation) is 2026-07-07T03:41 — the target is a day earlier,
      // so the ticket did not exist yet (SPEC_13 §2). created_at is the v1 moment.
      not_yet_created: true,
      created_at: "2026-07-07T03:41:21.757Z",
    });
  });

  // ── SPEC_13 §2 acceptance: "vznikl až D+n" vs. fully-reconstructed ──────────
  it("SPEC_13 §2: 'as of 2026-07-06' → not_yet_created (NOT tested/Jan Bily)", () => {
    // The exact bug: preview 'as of 2026-07-06' showed #11762 as tested/Jan Bily
    // (TODAY's live state) stamped "partially reconstructed", when the true
    // answer is "this ticket did not exist yet on 2026-07-06".
    const s = stateAtDate(activities, statusById, "2026-07-06T23:59:59Z", FALLBACK);
    expect(s.not_yet_created).toBe(true);
    expect(s.created_at).toBe("2026-07-07T03:41:21.757Z");
    // It must NOT be presented as a real (even partially-gapped) baseline.
    expect(s.status_name).not.toBe("tested");
    expect(s.assignee_name).not.toBe("Jan Bily");
  });

  it("SPEC_13 §2 inverse: a date inside the activity window → FULLY reconstructed, not_yet_created:false, no gaps", () => {
    // 2026-07-10T11:00:00Z (after the v8 assignee handoff to Tobias Bubenik) — the
    // ticket exists and every field is journal-covered, so "partially
    // reconstructed" must be the exception, not a stamp on everything.
    const s = stateAtDate(activities, statusById, "2026-07-10T11:00:00Z", FALLBACK);
    expect(s.not_yet_created).toBe(false);
    expect(s.created_at).toBe("2026-07-07T03:41:21.757Z");
    expect(s.gaps).toEqual([]);
    expect(s.assignee_name).toBe("Tobias Bubenik");
    expect(s.status_name).toBe("In progress");
  });

  it("empty activities → created_at null, not_yet_created false (nothing to derive)", () => {
    const s = stateAtDate([], statusById, "2026-07-10T00:00:00Z", FALLBACK);
    expect(s.created_at).toBeNull();
    expect(s.not_yet_created).toBe(false);
  });

  it("latest state (well after v15) reflects the final tested / Jan Bily", () => {
    const s = stateAtDate(activities, statusById, "2026-07-20T00:00:00Z", FALLBACK);
    // Canonicalized to "Tested" (Increment 21).
    expect(s.status_name).toBe("Tested");
    expect(s.assignee_name).toBe("Jan Bily");
  });
});

// ── Reconstruction unit behavior (synthetic, isolated) ───────────────────────
describe("stateAtDate — behavior", () => {
  it("Work/Remaining '12h'-style labels reconstruct to numeric hours", () => {
    const acts = [
      activity(1, "2026-07-08T07:00:00Z", [setTo("Work", "12h"), setTo("Remaining work", "12h")]),
      activity(2, "2026-07-09T07:00:00Z", [changed("Remaining work", "12h", "4h 30m")]),
    ];
    const at8 = stateAtDate(acts, statusById, "2026-07-08T08:00:00Z", FALLBACK);
    expect(at8.estimated_hours).toBe(12);
    expect(at8.remaining_hours).toBe(12);
    const at9 = stateAtDate(acts, statusById, "2026-07-09T08:00:00Z", FALLBACK);
    expect(at9.estimated_hours).toBe(12);
    expect(at9.remaining_hours).toBe(4.5);
  });

  it("accepts activities in ANY order (sorts internally)", () => {
    const acts = [
      activity(3, "2026-07-10T00:00:00Z", [changed("Status", "new", "in progress")]),
      activity(1, "2026-07-07T00:00:00Z", [setTo("Status", "new")]),
    ];
    // Reversed input still reconstructs "In progress" (canonicalized) at a late target.
    expect(stateAtDate(acts, statusById, "2026-07-11T00:00:00Z", FALLBACK).status_name).toBe(
      "In progress",
    );
    // And "New" (canonicalized) at a target before the change.
    expect(stateAtDate(acts, statusById, "2026-07-08T00:00:00Z", FALLBACK).status_name).toBe("New");
  });

  it("an observed 'unassigned' (Assignee cleared to null) is a real value, not a gap", () => {
    // A cleared assignee renders with no <i> target → parseDetail gives to=null.
    const cleared: OpActivityDetail = {
      format: "custom",
      raw: "Assignee deleted",
      html: "<strong>Assignee</strong> deleted",
    };
    const acts = [
      activity(1, "2026-07-07T00:00:00Z", [setTo("Assignee", "Cameron Dalby")]),
      activity(2, "2026-07-08T00:00:00Z", [cleared]),
    ];
    const s = stateAtDate(acts, statusById, "2026-07-09T00:00:00Z", FALLBACK);
    expect(s.assignee_name).toBeNull();
    // Assignee concept HAD coverage → assignee_name/op_id not gapped.
    expect(s.gaps).not.toContain("assignee_name");
    expect(s.gaps).not.toContain("assignee_op_id");
  });
});

// ── Increment 21 (SPEC_21): status-name canonicalization ─────────────────────
describe("stateAtDate — status canonicalization (SPEC_21)", () => {
  it("resolves lower-case journal casing to the catalog's canonical spelling", () => {
    // Journal text is verbatim OP activity casing; catalog has the canonical
    // "In progress". Reconstruction must return the canonical value so it
    // matches what live sync writes (no duplicate Status filter entries).
    const acts = [
      activity(1, "2026-07-07T00:00:00Z", [setTo("Status", "new")]),
      activity(2, "2026-07-08T00:00:00Z", [changed("Status", "new", "in progress")]),
    ];
    expect(stateAtDate(acts, statusById, "2026-07-09T00:00:00Z", FALLBACK).status_name).toBe(
      "In progress",
    );
  });

  it("matches case-insensitively regardless of the journal's own casing", () => {
    const acts = [activity(1, "2026-07-07T00:00:00Z", [setTo("Status", "IN PROGRESS")])];
    expect(stateAtDate(acts, statusById, "2026-07-08T00:00:00Z", FALLBACK).status_name).toBe(
      "In progress",
    );
  });

  it("an UNRECOGNIZED status is kept verbatim and marked via console.warn (never dropped)", () => {
    // SPEC_21 §7 decision 2: a status the catalog doesn't know is preserved
    // exactly, not blanked — but a warning surfaces it for discoverability.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const acts = [activity(1, "2026-07-07T00:00:00Z", [setTo("Status", "quantum-limbo")])];
    const s = stateAtDate(acts, statusById, "2026-07-08T00:00:00Z", FALLBACK);
    expect(s.status_name).toBe("quantum-limbo");
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain("quantum-limbo");
    warn.mockRestore();
  });

  it("a recognized status does NOT warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const acts = [activity(1, "2026-07-07T00:00:00Z", [setTo("Status", "developed")])];
    stateAtDate(acts, statusById, "2026-07-08T00:00:00Z", FALLBACK);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ── SPEC_12 §3 version-based scope-churn detection ───────────────────────────
describe("versionScopeEvents — SPEC_12 §3", () => {
  it("initial 'set to target' at v1 is baseline, NOT churn → []", () => {
    const acts = [activity(1, "2026-07-07T00:00:00Z", [setTo("Version", "3.5.039")])];
    expect(versionScopeEvents(acts, "3.5.039")).toEqual([]);
  });

  it("changed INTO the target version → one 'entered' at the change date", () => {
    const acts = [
      activity(1, "2026-07-07T00:00:00Z", [setTo("Version", "3.5.038")]),
      activity(2, "2026-07-09T12:00:00Z", [changed("Version", "3.5.038", "3.5.039")]),
    ];
    expect(versionScopeEvents(acts, "3.5.039")).toEqual([
      { occurred_at: "2026-07-09T12:00:00Z", direction: "entered" },
    ]);
  });

  it("changed AWAY from the target version → one 'left' at the change date", () => {
    const acts = [
      activity(1, "2026-07-07T00:00:00Z", [setTo("Version", "3.5.039")]),
      activity(2, "2026-07-11T09:00:00Z", [changed("Version", "3.5.039", "3.5.040")]),
    ];
    expect(versionScopeEvents(acts, "3.5.039")).toEqual([
      { occurred_at: "2026-07-11T09:00:00Z", direction: "left" },
    ]);
  });

  it("enter then leave → both events, chronological", () => {
    const acts = [
      activity(1, "2026-07-07T00:00:00Z", [setTo("Version", "3.5.038")]),
      activity(3, "2026-07-12T00:00:00Z", [changed("Version", "3.5.039", "3.5.040")]),
      activity(2, "2026-07-09T00:00:00Z", [changed("Version", "3.5.038", "3.5.039")]),
    ];
    expect(versionScopeEvents(acts, "3.5.039")).toEqual([
      { occurred_at: "2026-07-09T00:00:00Z", direction: "entered" },
      { occurred_at: "2026-07-12T00:00:00Z", direction: "left" },
    ]);
  });

  it("version never touches the target → []", () => {
    const acts = [
      activity(1, "2026-07-07T00:00:00Z", [setTo("Version", "3.5.038")]),
      activity(2, "2026-07-09T00:00:00Z", [changed("Version", "3.5.038", "3.5.040")]),
    ];
    expect(versionScopeEvents(acts, "3.5.039")).toEqual([]);
  });

  it("real fixture 11762: only 'Version set to 3.5.038' (baseline) → no churn for either version", () => {
    const fixture = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../../fixtures/samples/op_activities_11762.json", import.meta.url)),
        "utf8",
      ),
    ) as { _embedded: { elements: OpActivity[] } };
    const acts = fixture._embedded.elements;
    // #11762's only Version detail is v2's "set to 3.5.038" (from null) — a
    // baseline, so it's churn for neither its own version nor the sprint's.
    expect(versionScopeEvents(acts, "3.5.038")).toEqual([]);
    expect(versionScopeEvents(acts, "3.5.039")).toEqual([]);
  });
});
