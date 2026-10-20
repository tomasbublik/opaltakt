import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRecordingMockOpServer,
  type RecordingMockOpServer,
} from "@osp/fixtures";
import { CANONICAL_STATUSES } from "@osp/fixtures/scenario-types";
import { parseIsoDuration } from "@osp/op-client";
import {
  getWorkPackageById,
  hrefId,
  mockAdmin,
  opFilters,
  opGet,
  S1,
  S2,
  S3,
  walkWorkPackages,
  type HalCollection,
  type HalStatus,
  type HalTimeEntry,
  type HalUser,
  type HalWorkPackage,
  type MockAdmin,
} from "./scenario-helpers";

/**
 * SPEC_03 §9 — "tvarová shoda s OP v3": every field the app reads from the
 * scenario mock must be shaped exactly like real OpenProject v3 (HAL _links,
 * ISO-8601 durations, ISO datetimes, collection pagination, filters).
 *
 * We act as a RAW OP consumer here (plain GET /api/v3/*): no @osp/op-client
 * request layer, no app — only its pure `parseIsoDuration` to prove the mock's
 * durations are the exact dialect the client parses.
 *
 * Blocked-on note: these tests FAIL with an explicit "BLOCKED ON AGENT M1/M2"
 * error while the stateful mock / scenarios have not landed.
 */

/** The link keys every scenario work package must expose (SPEC_03 §3). */
const WP_LINK_KEYS = [
  "self",
  "status",
  "type",
  "project",
  "assignee",
  "accountable",
  "version",
  "priority",
  "parent",
] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

describe("mock OP v3 shape conformance (SPEC_03 §9 — s2-status-spectrum)", () => {
  let mock: RecordingMockOpServer;
  let admin: MockAdmin;
  let all: HalWorkPackage[];

  beforeAll(async () => {
    mock = await createRecordingMockOpServer();
    admin = mockAdmin(mock.url);
    await admin.requireScenario(S2);
    const state = await admin.load(S2);
    expect(state.scenario).toBe(S2);
    all = (await walkWorkPackages(mock.url)).elements;
    expect(all.length).toBeGreaterThanOrEqual(10); // one WP per status, minimum
  }, 30_000);

  afterAll(async () => {
    await mock.close();
  });

  it("every work package carries the full HAL _links contract ({href:null} for absent)", () => {
    for (const wp of all) {
      expect(wp._links, `WP ${wp.id} has no _links`).toBeDefined();
      for (const key of WP_LINK_KEYS) {
        const link = wp._links[key];
        // The key must EXIST (absent links are {href:null}, not missing keys).
        expect(link, `WP ${wp.id} _links.${key} missing`).toBeDefined();
        expect(
          link!.href === null || typeof link!.href === "string",
          `WP ${wp.id} _links.${key}.href must be string|null`,
        ).toBe(true);
      }
      // Required links are always present with the OP href conventions.
      expect(wp._links["self"]!.href).toContain(`/api/v3/work_packages/${wp.id}`);
      expect(wp._links["status"]!.href).toMatch(/\/api\/v3\/statuses\/\d+$/);
      expect(typeof wp._links["status"]!.title).toBe("string");
      expect(wp._links["type"]!.href).toMatch(/\/api\/v3\/types\/\d+$/);
      expect(typeof wp._links["type"]!.title).toBe("string");
      expect(wp._links["project"]!.href).toMatch(/\/api\/v3\/projects\/\d+$/);
      expect(typeof wp._links["project"]!.title).toBe("string");
      // Optional links: when present they follow the OP href + title convention.
      for (const key of ["assignee", "accountable"] as const) {
        const link = wp._links[key]!;
        if (link.href !== null) {
          expect(link.href, `WP ${wp.id} ${key}`).toMatch(/\/api\/v3\/users\/\d+$/);
          expect(typeof link.title, `WP ${wp.id} ${key}.title`).toBe("string");
        }
      }
      const version = wp._links["version"]!;
      if (version.href !== null) {
        expect(version.href).toMatch(/\/api\/v3\/versions\/\d+$/);
      }
      const parent = wp._links["parent"]!;
      if (parent.href !== null) {
        expect(parent.href).toMatch(/\/api\/v3\/work_packages\/\d+$/);
      }
      // Priority always resolves (default "Normal").
      expect(wp._links["priority"]!.href).toMatch(/\/api\/v3\/priorities\/\d+$/);
      expect(typeof wp._links["priority"]!.title).toBe("string");
    }
  });

  it("estimatedTime/remainingTime are op-client-parseable ISO durations; spentTime null; updatedAt ISO datetime", () => {
    let sawDuration = 0;
    for (const wp of all) {
      for (const field of ["estimatedTime", "remainingTime"] as const) {
        const v = wp[field] ?? null;
        if (v !== null) {
          sawDuration += 1;
          expect(
            parseIsoDuration(v),
            `WP ${wp.id} ${field}="${v}" must parse as ISO-8601 duration`,
          ).not.toBeNull();
        }
      }
      // Scenario mode: spentTime is null (no-permission OP path, SPEC_03 contract).
      expect(wp.spentTime ?? null, `WP ${wp.id} spentTime`).toBeNull();
      expect(wp.updatedAt, `WP ${wp.id} updatedAt`).toMatch(ISO_DATETIME);
      expect(Number.isNaN(Date.parse(wp.updatedAt))).toBe(false);
    }
    // The spectrum scenario must actually exercise durations somewhere.
    expect(sawDuration).toBeGreaterThan(0);
  });

  it("/api/v3/statuses lists the 10 canonical statuses with isClosed exactly {Rejected,Resolved,Closed}", async () => {
    const coll = await opGet<HalCollection<HalStatus>>(mock.url, "/api/v3/statuses");
    const byName = new Map(coll._embedded.elements.map((s) => [s.name, s]));
    expect(new Set(byName.keys())).toEqual(
      new Set(CANONICAL_STATUSES.map((s) => s.name)),
    );
    const closed = coll._embedded.elements
      .filter((s) => s.isClosed)
      .map((s) => s.name)
      .sort();
    expect(closed).toEqual(["Closed", "Rejected", "Resolved"]);
    for (const s of CANONICAL_STATUSES) {
      expect(byName.get(s.name)?.isClosed, s.name).toBe(s.isClosed);
    }
  });

  it("/api/v3/users lists the 3-person cast and /users/me is one of them", async () => {
    const users = await opGet<HalCollection<HalUser>>(mock.url, "/api/v3/users");
    expect(users.total).toBe(3);
    expect(users._embedded.elements).toHaveLength(3);
    const me = await opGet<HalUser>(mock.url, "/api/v3/users/me");
    expect(typeof me.id).toBe("number");
    expect(users._embedded.elements.map((u) => u.id)).toContain(me.id);
  });

  it("paginates with the OP collection contract (pageSize/offset/total/nextByOffset), pageSize=3", async () => {
    const { elements, total, pages } = await walkWorkPackages(mock.url, {
      pageSize: 3,
    });
    expect(total).toBe(all.length);
    expect(pages.length).toBe(Math.ceil(total / 3));
    pages.forEach((page, i) => {
      expect(page.pageSize).toBe(3);
      expect(page.offset).toBe(i + 1);
      expect(page.total).toBe(total);
      expect(page.count).toBe(page._embedded.elements.length);
      const isLast = i === pages.length - 1;
      if (isLast) {
        expect(page._links["nextByOffset"]).toBeUndefined();
      } else {
        expect(page.count).toBe(3);
        expect(page._links["nextByOffset"]?.href).toBeTruthy();
      }
    });
    // No duplicates, nothing lost across the walk.
    const ids = elements.map((e) => e.id);
    expect(new Set(ids).size).toBe(total);
  });

  it("filter: status by name narrows to exactly the matching WPs", async () => {
    const name = "In progress";
    const expected = all.filter((w) => w._links["status"]?.title === name);
    expect(expected.length).toBeGreaterThan(0); // the spectrum has one per status
    const { elements, total } = await walkWorkPackages(mock.url, {
      filters: opFilters([["status", "=", [name]]]),
    });
    expect(total).toBe(expected.length);
    expect(total).toBeLessThan(all.length); // it actually NARROWED
    for (const wp of elements) {
      expect(wp._links["status"]?.title).toBe(name);
    }
    expect(new Set(elements.map((e) => e.id))).toEqual(
      new Set(expected.map((e) => e.id)),
    );
  });

  it("filter: assignee narrows to that user's WPs", async () => {
    const withAssignee = all.find((w) => (w._links["assignee"]?.href ?? null) !== null);
    expect(withAssignee, "s2 must seed at least one assigned WP").toBeDefined();
    const userId = hrefId(withAssignee!._links["assignee"])!;
    const expected = all.filter(
      (w) => hrefId(w._links["assignee"]) === userId,
    );
    const { elements, total } = await walkWorkPackages(mock.url, {
      filters: opFilters([["assignee", "=", [String(userId)]]]),
    });
    expect(total).toBe(expected.length);
    for (const wp of elements) {
      expect(hrefId(wp._links["assignee"])).toBe(userId);
    }
  });

  it("filter: id returns exactly the one WP (the add-ticket-by-id path)", async () => {
    const target = all[0]!;
    const { elements, total } = await walkWorkPackages(mock.url, {
      filters: opFilters([["id", "=", [String(target.id)]]]),
    });
    expect(total).toBe(1);
    expect(elements[0]!.id).toBe(target.id);
    expect(elements[0]!.subject).toBe(target.subject);
  });

  it("filter: project narrows (project 3 = everything, bogus project = nothing)", async () => {
    const demo = await walkWorkPackages(mock.url, {
      filters: opFilters([["project", "=", ["3"]]]),
    });
    const inDemo = all.filter((w) => hrefId(w._links["project"]) === 3);
    expect(demo.total).toBe(inDemo.length);
    expect(demo.total).toBeGreaterThan(0);

    const none = await walkWorkPackages(mock.url, {
      filters: opFilters([["project", "=", ["999999"]]]),
    });
    expect(none.total).toBe(0);
    expect(none.elements).toEqual([]);
  });

  it("filter: updatedAt >=d narrows by timestamp (past = all, future = none)", async () => {
    const past = await walkWorkPackages(mock.url, {
      filters: opFilters([["updatedAt", ">=d", ["1990-01-01T00:00:00Z"]]]),
    });
    expect(past.total).toBe(all.length);

    const future = await walkWorkPackages(mock.url, {
      filters: opFilters([["updatedAt", ">=d", ["2100-01-01T00:00:00Z"]]]),
    });
    expect(future.total).toBe(0);
  });

  it("time_entries elements have an ISO-duration hours, spentOn and workPackage/user links (s3, day 2)", async () => {
    await admin.load(S3);
    await admin.gotoDay(2); // the epic logs time daily → entries exist by day 2
    const coll = await opGet<HalCollection<HalTimeEntry>>(
      mock.url,
      "/api/v3/time_entries",
      { pageSize: "500" }, // the mock's default pageSize mirrors OP (small)
    );
    expect(coll.total).toBeGreaterThan(0);
    expect(coll._embedded.elements.length).toBeGreaterThan(0);
    for (const te of coll._embedded.elements) {
      const hours = parseIsoDuration(te.hours);
      expect(hours, `time entry ${te.id} hours="${te.hours}"`).not.toBeNull();
      expect(hours!).toBeGreaterThan(0);
      expect(te.spentOn).toMatch(ISO_DATE);
      expect(te._links["workPackage"]?.href).toMatch(/\/api\/v3\/work_packages\/\d+$/);
      expect(te._links["user"]?.href).toMatch(/\/api\/v3\/users\/\d+$/);
    }
    // Filterable by entity_type+entity_id (burndown depends on this, SPEC_03
    // §3) — `workPackage` is a DEPRECATED filter real OP 400s on (SPEC_07 §3).
    const wpId = hrefId(coll._embedded.elements[0]!._links["workPackage"])!;
    const filtered = await opGet<HalCollection<HalTimeEntry>>(
      mock.url,
      "/api/v3/time_entries",
      {
        pageSize: "500",
        filters: opFilters([
          ["entity_type", "=", ["WorkPackage"]],
          ["entity_id", "=", [String(wpId)]],
        ]),
      },
    );
    expect(filtered.total).toBeGreaterThan(0);
    for (const te of filtered._embedded.elements) {
      expect(hrefId(te._links["workPackage"])).toBe(wpId);
    }
  });

  it("s1 handoff: assignee flips dev→tester while accountable stays customer; 'Developed' is open", async () => {
    const loaded = await admin.load(S1);
    // Day 0 picture, per WP: who is assignee/accountable before the handoff.
    const day0 = new Map(
      (await walkWorkPackages(mock.url)).elements.map((w) => [
        w.id,
        {
          assignee: w._links["assignee"]?.href ?? null,
          accountable: w._links["accountable"]?.href ?? null,
        },
      ]),
    );

    // Advance day by day until THE handoff day: some WP turns "Developed" with a
    // CHANGED assignee (dev→tester) while its accountable link stayed put.
    let handed: HalWorkPackage | undefined;
    for (let n = 1; n <= loaded.total_days && !handed; n += 1) {
      await admin.advanceDay();
      const wps = (await walkWorkPackages(mock.url)).elements;
      handed = wps.find((w) => {
        const before = day0.get(w.id);
        const assignee = w._links["assignee"]?.href ?? null;
        const accountable = w._links["accountable"]?.href ?? null;
        return (
          before !== undefined &&
          w._links["status"]?.title === "Developed" &&
          assignee !== null &&
          accountable !== null &&
          assignee !== before.assignee && // the assignee HOPPED…
          accountable === before.accountable && // …the accountable did NOT
          assignee !== accountable
        );
      });
    }
    expect(
      handed,
      "s1 must reach a handoff day: a 'Developed' WP whose assignee changed while accountable stayed",
    ).toBeDefined();

    const before = day0.get(handed!.id)!;
    const me = await opGet<HalUser>(mock.url, "/api/v3/users/me");

    // accountable (customer) never moved; assignee DID move, away from the dev.
    expect(handed!._links["accountable"]!.href).toBe(before.accountable);
    expect(handed!._links["assignee"]!.href).not.toBe(before.assignee);
    expect(hrefId({ href: before.assignee })).toBe(me.id); // dev ("me") held it
    expect(hrefId(handed!._links["assignee"])).not.toBe(me.id); // now the tester
    expect(hrefId(handed!._links["accountable"])).not.toBe(me.id); // customer ≠ dev

    // Status is the dev-done "Developed" — and it is NOT closed.
    expect(handed!._links["status"]?.title).toBe("Developed");
    const statuses = await opGet<HalCollection<HalStatus>>(
      mock.url,
      "/api/v3/statuses",
    );
    const developed = statuses._embedded.elements.find((s) => s.name === "Developed");
    expect(developed?.isClosed).toBe(false);

    // Fetchable through the id filter as one WP, links intact.
    const single = await getWorkPackageById(mock.url, handed!.id);
    expect(single?._links["assignee"]?.href).toBe(handed!._links["assignee"]!.href);
    expect(single?._links["accountable"]?.href).toBe(
      handed!._links["accountable"]!.href,
    );
  }, 30_000);
});
