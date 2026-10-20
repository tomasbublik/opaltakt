import { describe, expect, it, vi } from "vitest";
import {
  fetchActivitiesByWpIds,
  fetchAllActivities,
  fetchAllUsers,
  fetchEarliestTimeEntryDate,
  fetchProjectMemberships,
  fetchWorkPackageById,
} from "./paginate";
import type {
  HalCollection,
  OpActivity,
  OpMembership,
  OpTimeEntry,
  OpUser,
  OpWorkPackage,
} from "./types";
import type {
  ActivitiesQuery,
  MembershipsQuery,
  OpClient,
  TimeEntriesQuery,
  UsersQuery,
} from "./client";

function activity(id: number): OpActivity {
  return {
    _type: "Activity",
    id,
    createdAt: "2026-07-10T10:00:00.000Z",
    details: [],
    comment: null,
    _links: {
      self: { href: `/api/v3/activities/${id}` },
      workPackage: { href: null },
      user: { href: null },
    },
  };
}

function collection(elements: OpActivity[]): HalCollection<OpActivity> {
  return {
    _type: "Collection",
    total: elements.length,
    count: elements.length,
    pageSize: elements.length,
    offset: 1,
    _embedded: { elements },
    _links: { self: { href: null } },
  };
}

function workPackage(id: number): OpWorkPackage {
  return {
    _type: "WorkPackage",
    id,
    subject: `WP ${id}`,
    estimatedTime: null,
    remainingTime: null,
    spentTime: null,
    updatedAt: "2026-07-10T00:00:00Z",
    _links: {
      self: { href: `/api/v3/work_packages/${id}` },
      status: { href: "/api/v3/statuses/1", title: "New" },
      type: { href: "/api/v3/types/1", title: "Task" },
      project: { href: "/api/v3/projects/100", title: "Project A" },
    },
  };
}

function wpCollection(elements: OpWorkPackage[]): HalCollection<OpWorkPackage> {
  return {
    _type: "Collection",
    total: elements.length,
    count: elements.length,
    pageSize: elements.length || 1,
    offset: 1,
    _embedded: { elements },
    _links: { self: { href: null } },
  };
}

/** Fake OpClient stub: only getWorkPackages is exercised. */
function fakeWpClient(elements: OpWorkPackage[]): {
  client: OpClient;
  getWorkPackages: ReturnType<typeof vi.fn>;
} {
  const getWorkPackages = vi.fn(async () => wpCollection(elements));
  const client = { getWorkPackages } as unknown as OpClient;
  return { client, getWorkPackages };
}

/** Fake OpClient stub: only getActivities is exercised, everything else would
 * throw if called (this helper must never touch it). */
function fakeClient(byWpId: Record<number, OpActivity[]>): {
  client: OpClient;
  getActivities: ReturnType<typeof vi.fn>;
} {
  const getActivities = vi.fn(async (wpId: number) => collection(byWpId[wpId] ?? []));
  const client = {
    getActivities,
  } as unknown as OpClient;
  return { client, getActivities };
}

describe("fetchActivitiesByWpIds", () => {
  it("empty input → empty map, no calls", async () => {
    const { client, getActivities } = fakeClient({});
    const map = await fetchActivitiesByWpIds(client, []);
    expect(map.size).toBe(0);
    expect(getActivities).not.toHaveBeenCalled();
  });

  it("fetches each id's activities exactly once and keys the map by wp id", async () => {
    const { client, getActivities } = fakeClient({
      101: [activity(1), activity(2)],
      102: [],
      103: [activity(3)],
    });
    const map = await fetchActivitiesByWpIds(client, [101, 102, 103]);

    expect(getActivities).toHaveBeenCalledTimes(3);
    // Now paginated: each id fetched via fetchAllActivities → page 1 request.
    expect(getActivities).toHaveBeenCalledWith(101, expect.objectContaining({ offset: 1 }));
    expect(getActivities).toHaveBeenCalledWith(102, expect.objectContaining({ offset: 1 }));
    expect(getActivities).toHaveBeenCalledWith(103, expect.objectContaining({ offset: 1 }));

    expect(map.size).toBe(3);
    expect(map.get(101)?.map((a) => a.id)).toEqual([1, 2]);
    expect(map.get(102)).toEqual([]);
    expect(map.get(103)?.map((a) => a.id)).toEqual([3]);
  });

  it("calls getActivities once per id, not per page or anything else", async () => {
    const { client, getActivities } = fakeClient({ 1: [activity(1)], 2: [activity(2)] });
    await fetchActivitiesByWpIds(client, [1, 2, 1]);
    // Duplicate ids in input still yield one call per occurrence — this helper
    // does not dedupe input, callers pass a scoped ticket id set that's
    // already unique.
    expect(getActivities).toHaveBeenCalledTimes(3);
  });
});

/** A paginated activities fake: serves `all` sliced into pages of `pageSize`,
 * setting `total` and `count` like real OP so the fetch-all loop terminates on
 * `offset*pageSize >= total`. Records every (wpId, query) it was called with. */
function paginatedActivitiesClient(
  all: OpActivity[],
): { client: OpClient; getActivities: ReturnType<typeof vi.fn> } {
  const getActivities = vi.fn(
    async (_wpId: number, query?: ActivitiesQuery): Promise<HalCollection<OpActivity>> => {
      const pageSize = query?.pageSize ?? 100;
      const offset = query?.offset ?? 1;
      const start = (offset - 1) * pageSize;
      const elements = all.slice(start, start + pageSize);
      return {
        _type: "Collection",
        total: all.length,
        count: elements.length,
        pageSize,
        offset,
        _embedded: { elements },
        _links: { self: { href: null } },
      };
    },
  );
  const client = { getActivities } as unknown as OpClient;
  return { client, getActivities };
}

describe("fetchAllActivities (SPEC_12 §4 — multi-page history)", () => {
  it("collects every activity across 2+ pages, in order", async () => {
    const all = [activity(1), activity(2), activity(3), activity(4), activity(5)];
    const { client, getActivities } = paginatedActivitiesClient(all);

    // pageSize 2 → pages [1,2] [3,4] [5] → 3 requests, all 5 collected.
    const collected = await fetchAllActivities(client, 777, 2);

    expect(collected.map((a) => a.id)).toEqual([1, 2, 3, 4, 5]);
    expect(getActivities).toHaveBeenCalledTimes(3);
    expect(getActivities).toHaveBeenNthCalledWith(1, 777, { offset: 1, pageSize: 2 });
    expect(getActivities).toHaveBeenNthCalledWith(2, 777, { offset: 2, pageSize: 2 });
    expect(getActivities).toHaveBeenNthCalledWith(3, 777, { offset: 3, pageSize: 2 });
  });

  it("single page when total fits — exactly one request", async () => {
    const { client, getActivities } = paginatedActivitiesClient([activity(1), activity(2)]);
    const collected = await fetchAllActivities(client, 5, 100);
    expect(collected.map((a) => a.id)).toEqual([1, 2]);
    expect(getActivities).toHaveBeenCalledTimes(1);
  });

  it("fetchActivitiesByWpIds gathers ALL pages before returning (no truncation)", async () => {
    // A long history that would be silently truncated by a single-page fetch.
    const all = Array.from({ length: 7 }, (_v, i) => activity(i + 1));
    const getActivities = vi.fn(
      async (_wpId: number, query?: ActivitiesQuery): Promise<HalCollection<OpActivity>> => {
        const pageSize = query?.pageSize ?? 100;
        const offset = query?.offset ?? 1;
        const start = (offset - 1) * pageSize;
        const elements = all.slice(start, start + pageSize);
        return {
          _type: "Collection",
          total: all.length,
          count: elements.length,
          pageSize,
          offset,
          _embedded: { elements },
          _links: { self: { href: null } },
        };
      },
    );
    const client = { getActivities } as unknown as OpClient;
    const map = await fetchActivitiesByWpIds(client, [42]);
    // default pageSize 100 → all 7 in one page here, but the loop is exercised
    // by fetchAllActivities' own multi-page test above.
    expect(map.get(42)?.length).toBe(7);
  });
});

/** A paginated users fake: serves `all` sliced into pages of `pageSize`, with
 * real OP `total`/`count` so fetchAllUsers's loop terminates correctly. */
function paginatedUsersClient(
  all: OpUser[],
): { client: OpClient; getUsers: ReturnType<typeof vi.fn> } {
  const getUsers = vi.fn(
    async (query?: UsersQuery): Promise<HalCollection<OpUser>> => {
      const pageSize = query?.pageSize ?? 100;
      const offset = query?.offset ?? 1;
      const start = (offset - 1) * pageSize;
      const elements = all.slice(start, start + pageSize);
      return {
        _type: "Collection",
        total: all.length,
        count: elements.length,
        pageSize,
        offset,
        _embedded: { elements },
        _links: { self: { href: null } },
      };
    },
  );
  const client = { getUsers } as unknown as OpClient;
  return { client, getUsers };
}

function user(id: number): OpUser {
  return { _type: "User", id, name: `User ${id}` };
}

describe("fetchAllUsers (SPEC_13 §1 — multi-page directory)", () => {
  it("collects every user across 2+ pages, in order", async () => {
    const all = [user(1), user(2), user(3), user(4), user(5)];
    const { client, getUsers } = paginatedUsersClient(all);

    // pageSize 2 → pages [1,2] [3,4] [5] → 3 requests, all 5 collected.
    const collected = await fetchAllUsers(client, 2);

    expect(collected.map((u) => u.id)).toEqual([1, 2, 3, 4, 5]);
    expect(getUsers).toHaveBeenCalledTimes(3);
    expect(getUsers).toHaveBeenNthCalledWith(1, { offset: 1, pageSize: 2 });
    expect(getUsers).toHaveBeenNthCalledWith(2, { offset: 2, pageSize: 2 });
    expect(getUsers).toHaveBeenNthCalledWith(3, { offset: 3, pageSize: 2 });
  });

  it("single page when the directory fits — exactly one request", async () => {
    const { client, getUsers } = paginatedUsersClient([user(1), user(2)]);
    const collected = await fetchAllUsers(client, 100);
    expect(collected.map((u) => u.id)).toEqual([1, 2]);
    expect(getUsers).toHaveBeenCalledTimes(1);
  });

  it("empty directory → empty array, no infinite loop", async () => {
    const { client } = paginatedUsersClient([]);
    expect(await fetchAllUsers(client)).toEqual([]);
  });
});

/** A paginated memberships fake: serves `all` sliced into pages, echoing the
 * requested filters so we can assert the project filter shape. */
function paginatedMembershipsClient(
  all: OpMembership[],
): { client: OpClient; getMemberships: ReturnType<typeof vi.fn> } {
  const getMemberships = vi.fn(
    async (query?: MembershipsQuery): Promise<HalCollection<OpMembership>> => {
      const pageSize = query?.pageSize ?? 100;
      const offset = query?.offset ?? 1;
      const start = (offset - 1) * pageSize;
      const elements = all.slice(start, start + pageSize);
      return {
        _type: "Collection",
        total: all.length,
        count: elements.length,
        pageSize,
        offset,
        _embedded: { elements },
        _links: { self: { href: null } },
      };
    },
  );
  const client = { getMemberships } as unknown as OpClient;
  return { client, getMemberships };
}

function membership(id: number, userId: number): OpMembership {
  return {
    _type: "Membership",
    id,
    _links: {
      principal: { href: `/api/v3/users/${userId}`, title: `User ${userId}` },
      project: { href: "/api/v3/projects/3", title: "Demo" },
    },
  };
}

describe("fetchProjectMemberships (SPEC_13 §1a — non-admin identity source)", () => {
  it("collects every membership across 2+ pages, in order", async () => {
    const all = [membership(91, 1), membership(92, 2), membership(93, 3)];
    const { client, getMemberships } = paginatedMembershipsClient(all);

    // pageSize 2 → pages [91,92] [93] → 2 requests, all 3 collected.
    const collected = await fetchProjectMemberships(client, 3, 2);

    expect(collected.map((m) => m.id)).toEqual([91, 92, 93]);
    expect(getMemberships).toHaveBeenCalledTimes(2);
  });

  it("filters by project with a STRING values array (OP id serialization)", async () => {
    const { client, getMemberships } = paginatedMembershipsClient([membership(91, 1)]);

    await fetchProjectMemberships(client, 3);

    expect(getMemberships).toHaveBeenCalledWith({
      filters: [{ project: { operator: "=", values: ["3"] } }],
      pageSize: 100,
      offset: 1,
    });
  });

  it("empty roster → empty array, no infinite loop", async () => {
    const { client } = paginatedMembershipsClient([]);
    expect(await fetchProjectMemberships(client, 3)).toEqual([]);
  });
});

/** A paginated time_entries fake: serves `all` sliced into pages of `pageSize`,
 * echoing the requested filters (so we can assert the entity_type/entity_id
 * shape) and setting real OP `total`/`count` so fetchAllTimeEntries's loop
 * terminates on `offset*pageSize >= total`. */
function paginatedTimeEntriesClient(
  all: OpTimeEntry[],
): { client: OpClient; getTimeEntries: ReturnType<typeof vi.fn> } {
  const getTimeEntries = vi.fn(
    async (query?: TimeEntriesQuery): Promise<HalCollection<OpTimeEntry>> => {
      const pageSize = query?.pageSize ?? 100;
      const offset = query?.offset ?? 1;
      const start = (offset - 1) * pageSize;
      const elements = all.slice(start, start + pageSize);
      return {
        _type: "Collection",
        total: all.length,
        count: elements.length,
        pageSize,
        offset,
        _embedded: { elements },
        _links: { self: { href: null } },
      };
    },
  );
  const client = { getTimeEntries } as unknown as OpClient;
  return { client, getTimeEntries };
}

function timeEntry(id: number, spentOn: string): OpTimeEntry {
  return {
    _type: "TimeEntry",
    id,
    hours: "PT1H",
    spentOn,
    _links: {
      self: { href: `/api/v3/time_entries/${id}` },
      workPackage: { href: "/api/v3/work_packages/25025" },
      user: { href: "/api/v3/users/1", title: "Dev Dvořák" },
    },
  };
}

describe("fetchEarliestTimeEntryDate (SPEC_25 §4 — retroactive backdating)", () => {
  it("returns the EARLIEST spentOn across multiple entries (any input order)", async () => {
    const { client } = paginatedTimeEntriesClient([
      timeEntry(1, "2026-07-08"),
      timeEntry(2, "2026-07-06"),
      timeEntry(3, "2026-07-07"),
    ]);
    expect(await fetchEarliestTimeEntryDate(client, 25025)).toBe("2026-07-06");
  });

  it("returns null when the ticket has no logged time at all", async () => {
    const { client } = paginatedTimeEntriesClient([]);
    expect(await fetchEarliestTimeEntryDate(client, 25025)).toBeNull();
  });

  it("finds the TRUE minimum across ALL pages, not just the first", async () => {
    // 150 entries → 2 pages at the default pageSize (100). Every entry is dated
    // 2026-07-20 EXCEPT one on the SECOND page dated 2026-07-05 — a single-page
    // fetch would miss it and backdate to the wrong day.
    const all: OpTimeEntry[] = Array.from({ length: 150 }, (_v, i) =>
      timeEntry(i + 1, "2026-07-20"),
    );
    all[120] = timeEntry(121, "2026-07-05"); // earliest, lives on page 2
    const { client, getTimeEntries } = paginatedTimeEntriesClient(all);

    expect(await fetchEarliestTimeEntryDate(client, 25025)).toBe("2026-07-05");
    // The loop actually fetched both pages.
    expect(getTimeEntries).toHaveBeenCalledTimes(2);
  });

  it("scopes the query with the Increment-7 entity_type/entity_id filter (STRING values)", async () => {
    const { client, getTimeEntries } = paginatedTimeEntriesClient([
      timeEntry(1, "2026-07-06"),
    ]);
    await fetchEarliestTimeEntryDate(client, 25025);
    expect(getTimeEntries).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [
          { entity_type: { operator: "=", values: ["WorkPackage"] } },
          { entity_id: { operator: "=", values: ["25025"] } },
        ],
      }),
    );
  });
});

describe("fetchWorkPackageById", () => {
  it("returns the single element when OP has it", async () => {
    const wp = workPackage(1001);
    const { client, getWorkPackages } = fakeWpClient([wp]);

    const result = await fetchWorkPackageById(client, 1001);

    expect(result).toEqual(wp);
    expect(getWorkPackages).toHaveBeenCalledTimes(1);
  });

  it("returns null on an empty collection (no such ticket in OP)", async () => {
    const { client } = fakeWpClient([]);

    const result = await fetchWorkPackageById(client, 999999);

    expect(result).toBeNull();
  });

  it("calls getWorkPackages with the id-filter shape (values as a STRING array)", async () => {
    const { client, getWorkPackages } = fakeWpClient([workPackage(42)]);

    await fetchWorkPackageById(client, 42);

    expect(getWorkPackages).toHaveBeenCalledWith({
      filters: [{ id: { operator: "=", values: ["42"] } }],
      pageSize: 1,
    });
  });
});
