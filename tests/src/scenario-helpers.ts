import type {
  AdvanceDayRequest,
  AdvanceDayResult,
  MockStateSummary,
  RenameProjectRequest,
  RenameProjectResult,
  ScenarioSummary,
  WorkPackageStateSummary,
} from "@osp/fixtures/scenario-types";

/**
 * Agent V (SPEC_03 §9) — shared plumbing for the scenario verification suites.
 *
 * Two STRICTLY separate clients live here:
 *
 *  1. `mockAdmin(url)` — the OPERATOR client for the mock's own admin namespace
 *     (`/__mock/*`). Only the test drives it, NEVER the app. Every admin request
 *     is tagged with `?operator=1` so the read-only-guard suites can prove that
 *     100% of the `/__mock/*` traffic seen by the recording server came from the
 *     test itself (the app never produces such a request).
 *
 *  2. `opGet()` / `walkWorkPackages()` — a RAW OpenProject v3 client (plain
 *     GETs), used to assert shape conformance of `/api/v3/*` exactly as a real
 *     OP consumer would see it.
 *
 * When the stateful mock (Agent M1) or the scenarios (Agent M2) have not landed
 * yet, every admin call fails with an explicit "BLOCKED ON AGENT M1/M2" error —
 * that IS the acceptance bar for these suites, not a silent skip.
 */

// ── Scenario names (frozen by SPEC_03 §7) ───────────────────────────────────
export const S1 = "s1-accountable-handoff";
export const S2 = "s2-status-spectrum";
export const S3 = "s3-epic-over-40h";
export const S4 = "s4-volatile-sprint";
export const S5 = "s5-burndown-happy";
export const S6 = "s6-carryover";

/** Query-string tag carried by every operator-made /__mock request. */
export const OPERATOR_MARK = "operator=1";

// ── Admin (operator) client ──────────────────────────────────────────────────

async function adminFetch(
  baseUrl: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${baseUrl}${path}${sep}${OPERATOR_MARK}`;
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (res.status === 404 || res.status === 405 || res.status === 501) {
    throw new Error(
      `BLOCKED ON AGENT M1/M2: ${method} ${path} → HTTP ${res.status}. ` +
        `The stateful scenario mock (admin /__mock/* routes per ` +
        `fixtures/scenario-types.ts, SPEC_03 §5) is not available on this mock ` +
        `instance yet. Body: ${text.slice(0, 300)}`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `Mock admin ${method} ${path} failed: HTTP ${res.status} ${text.slice(0, 300)}`,
    );
  }
  try {
    return text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    throw new Error(
      `Mock admin ${method} ${path} returned non-JSON: ${text.slice(0, 300)}`,
    );
  }
}

export interface MockAdmin {
  url: string;
  scenarios(): Promise<ScenarioSummary[]>;
  load(name: string): Promise<MockStateSummary>;
  advanceDay(body?: AdvanceDayRequest): Promise<AdvanceDayResult>;
  gotoDay(n: number): Promise<MockStateSummary>;
  injectUrgent(): Promise<{ work_package: WorkPackageStateSummary }>;
  state(): Promise<MockStateSummary>;
  reset(): Promise<{ mode: "fixtures" }>;
  /** Increment 40: rename a project (name and/or identifier; op_id unchanged). */
  renameProject(id: number, patch: RenameProjectRequest): Promise<RenameProjectResult>;
  /** Throws a clear "BLOCKED ON AGENT M2" error when `name` isn't registered. */
  requireScenario(name: string): Promise<ScenarioSummary>;
}

export function mockAdmin(baseUrl: string): MockAdmin {
  const admin: MockAdmin = {
    url: baseUrl,
    scenarios: () =>
      adminFetch(baseUrl, "GET", "/__mock/scenarios") as Promise<ScenarioSummary[]>,
    load: (name) =>
      adminFetch(baseUrl, "POST", `/__mock/load/${name}`) as Promise<MockStateSummary>,
    advanceDay: (body) =>
      adminFetch(
        baseUrl,
        "POST",
        "/__mock/advance-day",
        body ?? {},
      ) as Promise<AdvanceDayResult>,
    gotoDay: (n) =>
      adminFetch(baseUrl, "POST", `/__mock/goto-day/${n}`) as Promise<MockStateSummary>,
    injectUrgent: () =>
      adminFetch(baseUrl, "POST", "/__mock/inject-urgent") as Promise<{
        work_package: WorkPackageStateSummary;
      }>,
    state: () =>
      adminFetch(baseUrl, "GET", "/__mock/state") as Promise<MockStateSummary>,
    reset: () =>
      adminFetch(baseUrl, "POST", "/__mock/reset") as Promise<{ mode: "fixtures" }>,
    renameProject: (id, patch) =>
      adminFetch(baseUrl, "POST", `/__mock/rename-project/${id}`, patch) as Promise<RenameProjectResult>,
    requireScenario: async (name) => {
      const list = await admin.scenarios();
      const found = list.find((s) => s.name === name);
      if (!found) {
        throw new Error(
          `BLOCKED ON AGENT M2: scenario "${name}" is not registered on the mock ` +
            `(GET /__mock/scenarios returned: ${list.map((s) => s.name).join(", ") || "<empty>"}).`,
        );
      }
      return found;
    },
  };
  return admin;
}

// ── Raw OpenProject v3 client (GET only — we ARE a real OP consumer here) ───

export interface HalLink {
  href: string | null;
  title?: string;
}

export interface HalWorkPackage {
  id: number;
  subject: string;
  estimatedTime?: string | null;
  remainingTime?: string | null;
  spentTime?: string | null;
  percentageDone?: number | null;
  updatedAt: string;
  _links: Record<string, HalLink | undefined>;
}

export interface HalTimeEntry {
  id: number;
  hours: string;
  spentOn: string;
  _links: Record<string, HalLink | undefined>;
}

export interface HalStatus {
  id: number;
  name: string;
  isClosed: boolean;
}

export interface HalUser {
  id: number;
  name: string;
}

export interface HalCollection<T> {
  _type: string;
  total: number;
  count: number;
  pageSize?: number;
  offset?: number;
  _embedded: { elements: T[] };
  _links: Record<string, HalLink | undefined>;
}

/** Raw GET against the mock's OpenProject namespace. Throws on non-2xx. */
export async function opGet<T>(
  baseUrl: string,
  path: string,
  params: Record<string, string> = {},
): Promise<T> {
  const url = new URL(`${baseUrl}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { method: "GET" });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `GET ${path} failed: HTTP ${res.status} ${text.slice(0, 300)}`,
    );
  }
  return JSON.parse(text) as T;
}

/** Build OP's `filters` query param from [attribute, operator, values] triples. */
export function opFilters(
  clauses: Array<[attribute: string, operator: string, values: string[]]>,
): string {
  return JSON.stringify(
    clauses.map(([attribute, operator, values]) => ({
      [attribute]: { operator, values },
    })),
  );
}

/** Walk /api/v3/work_packages page by page; returns ALL elements. */
export async function walkWorkPackages(
  baseUrl: string,
  options: { filters?: string; pageSize?: number } = {},
): Promise<{ elements: HalWorkPackage[]; total: number; pages: HalCollection<HalWorkPackage>[] }> {
  const pageSize = options.pageSize ?? 25;
  const elements: HalWorkPackage[] = [];
  const pages: HalCollection<HalWorkPackage>[] = [];
  let offset = 1;
  let total = 0;
  for (let i = 0; i < 200; i += 1) {
    const page = await opGet<HalCollection<HalWorkPackage>>(
      baseUrl,
      "/api/v3/work_packages",
      {
        offset: String(offset),
        pageSize: String(pageSize),
        ...(options.filters ? { filters: options.filters } : {}),
      },
    );
    pages.push(page);
    total = page.total;
    elements.push(...page._embedded.elements);
    if (elements.length >= total || page._embedded.elements.length === 0) break;
    offset += 1;
  }
  return { elements, total, pages };
}

/** Fetch ONE work package via the id filter (how the app itself does add-by-id). */
export async function getWorkPackageById(
  baseUrl: string,
  id: number,
): Promise<HalWorkPackage | undefined> {
  const { elements } = await walkWorkPackages(baseUrl, {
    filters: opFilters([["id", "=", [String(id)]]]),
  });
  return elements.find((e) => e.id === id);
}

// ── Small pure helpers ───────────────────────────────────────────────────────

/** startDate + n calendar days (UTC), YYYY-MM-DD. */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Trailing numeric id of a HAL href ("/api/v3/users/12" → 12), or null. */
export function hrefId(link: HalLink | undefined): number | null {
  const href = link?.href ?? null;
  if (!href) return null;
  const m = /\/(\d+)$/.exec(href);
  return m ? Number(m[1]) : null;
}
