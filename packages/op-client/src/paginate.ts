import type { OpClient, TimeEntriesQuery, WorkPackagesQuery } from "./client";
import type {
  OpActivity,
  OpMembership,
  OpTimeEntry,
  OpUser,
  OpWorkPackage,
} from "./types";

/**
 * "Fetch all" pagination helpers (SPEC §5): loop offset/pageSize until every
 * element is collected. OpenProject offsets are 1-based; page N covers
 * elements [(N-1)*pageSize, N*pageSize). We keep paging while
 * offset*pageSize < total (mirrors the spec's stop condition).
 */

const DEFAULT_PAGE_SIZE = 100;

export async function fetchAllWorkPackages(
  client: OpClient,
  query: Omit<WorkPackagesQuery, "offset"> = {},
): Promise<OpWorkPackage[]> {
  const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
  const out: OpWorkPackage[] = [];
  let offset = 1;
  for (;;) {
    const page = await client.getWorkPackages({ ...query, pageSize, offset });
    out.push(...page._embedded.elements);
    const total = page.total;
    // Stop once the pages fetched so far cover the whole collection.
    if (offset * pageSize >= total || page._embedded.elements.length === 0) break;
    offset += 1;
  }
  return out;
}

export async function fetchAllTimeEntries(
  client: OpClient,
  query: Omit<TimeEntriesQuery, "offset"> = {},
): Promise<OpTimeEntry[]> {
  const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
  const out: OpTimeEntry[] = [];
  let offset = 1;
  for (;;) {
    const page = await client.getTimeEntries({ ...query, pageSize, offset });
    out.push(...page._embedded.elements);
    const total = page.total;
    if (offset * pageSize >= total || page._embedded.elements.length === 0) break;
    offset += 1;
  }
  return out;
}

/**
 * Fetch the ENTIRE user directory: loop offset/pageSize until every user is
 * collected, exactly like fetchAllWorkPackages/fetchAllActivities. A real OP
 * instance can have hundreds of users, so `GET /api/v3/users` is paged.
 *
 * NOTE (SPEC_13 §1a, REVISED): this is NO LONGER part of the identity path. The
 * `GET /api/v3/users` collection is admin-gated on real OpenProject instances —
 * a normal token gets an empty/denied result — so building the identity index
 * from it was exactly the production bug this increment fixes. Identity now sources
 * (name → id) from non-admin places (`_links.assignee`/`accountable`,
 * `fetchProjectMemberships`). This helper stays as a legitimate GET-only read
 * primitive for an admin-token deployment that legitimately wants the full
 * directory; it must NOT be load-bearing for identity resolution.
 */
export async function fetchAllUsers(
  client: OpClient,
  pageSize: number = DEFAULT_PAGE_SIZE,
): Promise<OpUser[]> {
  const out: OpUser[] = [];
  let offset = 1;
  for (;;) {
    const page = await client.getUsers({ offset, pageSize });
    out.push(...page._embedded.elements);
    if (offset * pageSize >= page.total || page._embedded.elements.length === 0) break;
    offset += 1;
  }
  return out;
}

/**
 * Fetch a project's ENTIRE member roster (SPEC_13 §1a): loop offset/pageSize
 * over `GET /api/v3/memberships` filtered to one project, exactly like
 * fetchAllWorkPackages. Each membership's `_links.principal` (title = display
 * name, href = /api/v3/users/:id) is a NON-admin source of (name → id) identity
 * enrichment — unlike the admin-gated `GET /api/v3/users` collection, this works
 * for a normal API token, which is the whole point of SPEC_13's revised identity
 * model. The project filter uses a STRING `values` array, matching how OP ids are
 * serialized everywhere else in this client (fetchWorkPackageById, sync). A small
 * roster fits one page and makes exactly one call.
 */
export async function fetchProjectMemberships(
  client: OpClient,
  projectOpId: number,
  pageSize: number = DEFAULT_PAGE_SIZE,
): Promise<OpMembership[]> {
  const out: OpMembership[] = [];
  let offset = 1;
  for (;;) {
    const page = await client.getMemberships({
      filters: [{ project: { operator: "=", values: [String(projectOpId)] } }],
      pageSize,
      offset,
    });
    out.push(...page._embedded.elements);
    if (offset * pageSize >= page.total || page._embedded.elements.length === 0) break;
    offset += 1;
  }
  return out;
}

/**
 * Fetch exactly one work package by id (SPEC_05 §4 mid-sprint add): the
 * ticket may not be in the local work_package_cache yet, so the caller needs
 * a fresh single-WP read straight from OP. Uses the SAME id-filter shape as
 * every other id lookup in this app (sprintUpdate.ts's baseline refetch,
 * @osp/sync's importWorkPackage) — `values` is a STRING array, matching how
 * OP ids are serialized everywhere else, not a number array. The id filter
 * narrows to at most one result, so no pagination loop is needed.
 * Returns null on an empty collection (no such ticket in OP) — the caller
 * maps that to WORK_PACKAGE_NOT_FOUND, mirroring the existing "add ticket by
 * id" cache-miss path.
 */
export async function fetchWorkPackageById(
  client: OpClient,
  wpId: number,
): Promise<OpWorkPackage | null> {
  const page = await client.getWorkPackages({
    filters: [{ id: { operator: "=", values: [String(wpId)] } }],
    pageSize: 1,
  });
  return page._embedded.elements[0] ?? null;
}

/**
 * Increment 25 (SPEC_25 §4) — the calendar day this ticket's time entries
 * BEGAN, for backdating a retroactive sprint-add ("added_at"). Returns the
 * EARLIEST `spentOn` (an ISO date string, e.g. "2026-07-06") across ALL of this
 * ticket's time entries — the collection is paged fully (fetchAllTimeEntries),
 * because even a single ticket could in principle have more than one page of
 * entries, and the minimum must be the TRUE minimum across every page, not just
 * the first. Returns null when the ticket has no logged time at all; the caller
 * (apps/api, Agent B) maps that to the `createdAt` fallback (SPEC_25 §4 / §8.1).
 *
 * The filter is the Increment-7 CORRECT time-entries scoping shape
 * (entity_type = "WorkPackage" + entity_id = the wp id) — the deprecated
 * `workPackage` attribute real OpenProject 400s on. `values` is a STRING array,
 * matching how OP ids are serialized everywhere else in this client.
 */
export async function fetchEarliestTimeEntryDate(
  client: OpClient,
  wpId: number,
): Promise<string | null> {
  const entries = await fetchAllTimeEntries(client, {
    filters: [
      { entity_type: { operator: "=", values: ["WorkPackage"] } },
      { entity_id: { operator: "=", values: [String(wpId)] } },
    ],
  });
  let earliest: string | null = null;
  for (const te of entries) {
    // spentOn is "YYYY-MM-DD", so lexicographic order == chronological order.
    if (earliest === null || te.spentOn < earliest) earliest = te.spentOn;
  }
  return earliest;
}

/**
 * Fetch a ticket's ENTIRE activity history (SPEC_12 §4): loop offset/pageSize
 * until every journal entry is collected, exactly like fetchAllWorkPackages.
 * Real OP returns activities as a paged HAL collection, so a long history
 * (dozens of status/assignee/version changes) spans multiple pages — a
 * retrospective replay MUST see all of them before `stateAtDate` /
 * `deriveChangelogEvents` fold over them, or reconstructed state would be
 * silently truncated. A short history (the common case, e.g. the 15-activity
 * #11762 fixture) fits in a single page and makes exactly one call.
 */
export async function fetchAllActivities(
  client: OpClient,
  wpId: number,
  pageSize: number = DEFAULT_PAGE_SIZE,
): Promise<OpActivity[]> {
  const out: OpActivity[] = [];
  let offset = 1;
  for (;;) {
    const page = await client.getActivities(wpId, { offset, pageSize });
    out.push(...page._embedded.elements);
    if (offset * pageSize >= page.total || page._embedded.elements.length === 0) break;
    offset += 1;
  }
  return out;
}

/**
 * Bulk activity fetch for a sprint's scoped ticket set (SPEC_04 §3 / SPEC_12
 * §4): each id gets its OWN paginated fetch (fetchAllActivities — collects
 * every page, not just the first), run concurrently via Promise.all; the
 * client's own concurrency limit throttles the actual wire traffic. Empty
 * input short-circuits to an empty map with zero calls.
 */
export async function fetchActivitiesByWpIds(
  client: OpClient,
  wpIds: number[],
): Promise<Map<number, OpActivity[]>> {
  const out = new Map<number, OpActivity[]>();
  if (wpIds.length === 0) return out;
  const entries = await Promise.all(
    wpIds.map(async (id): Promise<[number, OpActivity[]]> => {
      const activities = await fetchAllActivities(client, id);
      return [id, activities];
    }),
  );
  for (const [id, activities] of entries) out.set(id, activities);
  return out;
}
