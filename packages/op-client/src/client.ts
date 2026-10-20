import type {
  HalCollection,
  OpActivity,
  OpMembership,
  OpProject,
  OpStatus,
  OpTimeEntry,
  OpUser,
  OpVersion,
  OpWorkPackage,
  OpWorkPackageSchema,
} from "./types";

/**
 * READ-ONLY OpenProject client contract (SPEC §5).
 * Only HTTP GET is ever performed. The implementation (Agent A) MUST enforce
 * this in `request()` and cover it with a test.
 *
 * Auth: HTTP Basic, user "apikey", password = token →
 *   Authorization: Basic base64("apikey:" + token)
 */

/** The only HTTP method this client permits. */
export type ReadOnlyMethod = "GET";

export interface OpClientConfig {
  baseUrl: string;
  token: string;
  /** Max concurrent requests (SPEC §5 concurrency limit). */
  concurrency?: number;
  /** Retries on 429/5xx with backoff. */
  maxRetries?: number;
}

/** Options for the low-level request primitive. */
export interface OpRequestOptions {
  /** Path under baseUrl, e.g. "/api/v3/work_packages". */
  path: string;
  /** Query params; arrays/objects are serialized (OP `filters` is JSON). */
  query?: Record<string, string | number | boolean | undefined>;
  /**
   * Method is fixed to GET. It is accepted for symmetry, but any non-GET value
   * MUST throw READ_ONLY_VIOLATION before any network call.
   */
  method?: ReadOnlyMethod;
  signal?: AbortSignal;
}

/** Query params for the work_packages listing (one page). */
export interface WorkPackagesQuery {
  /** OP filters JSON array (stringified by impl). */
  filters?: unknown[];
  pageSize?: number;
  offset?: number;
  sortBy?: unknown[];
}

/** Query params for time_entries listing. */
export interface TimeEntriesQuery {
  filters?: unknown[];
  pageSize?: number;
  offset?: number;
}

/**
 * Pagination params for one page of a ticket's activities (SPEC_12 §4). Real
 * OP returns activities as a HAL Collection with `total`/`nextByOffset`, so a
 * long history spans multiple pages; the `fetchAllActivities` helper loops
 * these. Optional — omitting them requests OP's default (single) page, which
 * is all the historical callers ever needed.
 */
export interface ActivitiesQuery {
  pageSize?: number;
  offset?: number;
}

/**
 * Pagination params for one page of the users COLLECTION (SPEC_13 §1). A real
 * OP instance can have hundreds of users, so `GET /api/v3/users` is paged like
 * every other collection; the `fetchAllUsers` helper loops offset/pageSize.
 * Optional — omitting them requests OP's default (single) page.
 */
export interface UsersQuery {
  pageSize?: number;
  offset?: number;
}

/**
 * Query params for the memberships listing (SPEC_13 §1a). `filters` is the OP
 * filters value (JSON, stringified by the impl exactly like `getWorkPackages` /
 * `getTimeEntries`) — typically a single project clause,
 * `[{ project: { operator: "=", values: ["<id>"] } }]`. Use `fetchProjectMemberships`
 * (paginate.ts) to loop pages for one project.
 */
export interface MembershipsQuery {
  filters?: unknown;
  pageSize?: number;
  offset?: number;
}

/**
 * The GET-only request contract. Implementations MUST reject any method other
 * than "GET" (thrown, before the network call).
 */
export type OpRequest = <T>(options: OpRequestOptions) => Promise<T>;

export interface OpClient {
  /** Low-level GET-only primitive (Agent A implements the guard + retries). */
  request: OpRequest;

  /** GET /api/v3/users/me — validate token. */
  getCurrentUser(): Promise<OpUser>;

  /**
   * GET /api/v3/users — the user COLLECTION (SPEC_13 §1), distinct from the
   * singular `getUser(id)` and from `getCurrentUser()`. Returns one page (id +
   * name per element); callers wanting the WHOLE directory use `fetchAllUsers`
   * (paginate.ts), which loops offset/pageSize until every user is collected —
   * a real OP instance can have many users. Read-only, like every other method.
   * The result feeds the exact-match identity index (SPEC_13 §1 → identity.ts).
   */
  getUsers(query?: UsersQuery): Promise<HalCollection<OpUser>>;

  /**
   * GET /api/v3/users/:id — resolve a single user's name (SPEC_11 §4). Returns
   * `null` on 404 (a deactivated/locked/invisible OP user is NORMAL — never
   * throw for "not found"). Any other non-2xx still throws (OpHttpError).
   */
  getUser(id: number): Promise<OpUser | null>;

  /**
   * GET /api/v3/memberships — a project's member roster (SPEC_13 §1a). Readable
   * by any token that can see the project (NOT admin-gated like the `getUsers`
   * collection), so its `_links.principal` (title = name, href = id) is a valid
   * non-admin source for (name → id) identity enrichment. Returns one page;
   * `fetchProjectMemberships` (paginate.ts) loops offset/pageSize for a project.
   * Read-only, like every other method.
   */
  getMemberships(query?: MembershipsQuery): Promise<HalCollection<OpMembership>>;

  /** GET /api/v3/projects. */
  getProjects(): Promise<HalCollection<OpProject>>;

  /** GET /api/v3/work_packages — a single page (caller loops offset/pageSize). */
  getWorkPackages(
    query: WorkPackagesQuery,
  ): Promise<HalCollection<OpWorkPackage>>;

  /** GET /api/v3/time_entries. */
  getTimeEntries(query: TimeEntriesQuery): Promise<HalCollection<OpTimeEntry>>;

  /** GET /api/v3/versions (optionally scoped to a project). */
  getVersions(projectOpId?: number): Promise<HalCollection<OpVersion>>;

  /** GET /api/v3/statuses. */
  getStatuses(): Promise<HalCollection<OpStatus>>;

  /** GET /api/v3/work_packages/schema — for resolving customFieldN names. */
  getWorkPackageSchema(): Promise<OpWorkPackageSchema>;

  /**
   * GET /api/v3/work_packages/:id/activities (SPEC_04 §3) — one page of a
   * ticket's journal (who changed what, and comments). Pass `query`
   * (offset/pageSize) to page through a long history; omit it for OP's default
   * page. Callers wanting the WHOLE history use `fetchAllActivities`
   * (paginate.ts), which loops this until every activity is collected
   * (SPEC_12 §4).
   */
  getActivities(
    wpId: number,
    query?: ActivitiesQuery,
  ): Promise<HalCollection<OpActivity>>;
}

/** Thrown by the client guard when a non-GET method is attempted (SPEC §2). */
export class ReadOnlyViolationError extends Error {
  override readonly name = "ReadOnlyViolationError";
  readonly code = "READ_ONLY_VIOLATION" as const;
  constructor(attemptedMethod: string) {
    super(
      `OpenProject client is read-only; refused non-GET method "${attemptedMethod}".`,
    );
  }
}
