import pLimit from "p-limit";
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
import {
  ReadOnlyViolationError,
  type ActivitiesQuery,
  type MembershipsQuery,
  type OpClient,
  type OpClientConfig,
  type OpRequestOptions,
  type TimeEntriesQuery,
  type ProjectsQuery,
  type UsersQuery,
  type WorkPackagesQuery,
} from "./client";

/**
 * READ-ONLY OpenProject v3 client (SPEC §5).
 *
 * - Auth: HTTP Basic, user "apikey", password = token.
 * - GET-only: request() throws ReadOnlyViolationError for any non-GET method
 *   BEFORE any network I/O.
 * - Concurrency-limited (p-limit) with exponential backoff on 429/5xx
 *   (honours Retry-After).
 */

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_MAX_RETRIES = 3;
/** Base backoff in ms; grows exponentially per attempt. */
const BASE_BACKOFF_MS = 200;

/** Non-2xx HTTP error surfaced from OpenProject. */
export class OpHttpError extends Error {
  override readonly name = "OpHttpError";
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`OpenProject GET ${path} failed with HTTP ${status}: ${body.slice(0, 500)}`);
  }
}

function authHeader(token: string): string {
  // HTTP Basic: user "apikey", password = token (SPEC §5).
  const raw = `apikey:${token}`;
  const encoded =
    typeof Buffer !== "undefined"
      ? Buffer.from(raw, "utf8").toString("base64")
      : btoa(raw);
  return `Basic ${encoded}`;
}

/** Serialize a query record into a URLSearchParams-backed string. */
function buildQuery(
  query: Record<string, string | number | boolean | undefined> | undefined,
): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

/** Parse Retry-After header (delta-seconds or HTTP-date) into ms. */
function retryAfterMs(header: string | null): number | null {
  if (header === null) return null;
  const asNumber = Number(header);
  if (Number.isFinite(asNumber)) return Math.max(0, asNumber * 1000);
  const asDate = Date.parse(header);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function createOpClient(config: OpClientConfig): OpClient {
  const concurrency = config.concurrency ?? DEFAULT_CONCURRENCY;
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const limit = pLimit(concurrency);
  const authorization = authHeader(config.token);

  async function doFetch<T>(options: OpRequestOptions): Promise<T> {
    const url = joinUrl(config.baseUrl, options.path) + buildQuery(options.query);

    let attempt = 0;
    // Retry loop for 429/5xx with exponential backoff (SPEC §5).
    for (;;) {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: authorization,
            Accept: "application/json",
          },
          signal: options.signal,
        });
      } catch (err) {
        // An aborted request (caller signal OR a wrapper's per-call timeout,
        // e.g. withHardCancel/withTimeout) must fail FAST: retrying reuses the
        // same already-aborted signal, so every retry rejects instantly and the
        // backoff sleeps between them are pure dead time — and, worse, delay a
        // user-requested cancellation. Propagate immediately; the wrapping layer
        // owns the "should this be retried with a fresh timeout?" decision.
        if (options.signal?.aborted) throw err;
        // Network error — retry a few times before giving up.
        if (attempt < maxRetries) {
          await sleep(BASE_BACKOFF_MS * 2 ** attempt);
          attempt += 1;
          continue;
        }
        throw err;
      }

      if (response.ok) {
        return (await response.json()) as T;
      }

      const retriable = response.status === 429 || response.status >= 500;
      if (retriable && attempt < maxRetries) {
        const headerDelay = retryAfterMs(response.headers.get("retry-after"));
        const backoff = headerDelay ?? BASE_BACKOFF_MS * 2 ** attempt;
        await sleep(backoff);
        attempt += 1;
        continue;
      }

      const body = await response.text().catch(() => "");
      throw new OpHttpError(response.status, options.path, body);
    }
  }

  const client: OpClient = {
    request<T>(options: OpRequestOptions): Promise<T> {
      const method = options.method ?? "GET";
      if (method !== "GET") {
        // Enforced BEFORE any network call (SPEC §2). Throw synchronously.
        throw new ReadOnlyViolationError(method);
      }
      return limit(() => doFetch<T>(options));
    },

    getCurrentUser(): Promise<OpUser> {
      return this.request<OpUser>({ path: "/api/v3/users/me" });
    },

    getUsers(query?: UsersQuery): Promise<HalCollection<OpUser>> {
      const q: Record<string, number | undefined> = {};
      if (query?.pageSize !== undefined) q["pageSize"] = query.pageSize;
      if (query?.offset !== undefined) q["offset"] = query.offset;
      return this.request<HalCollection<OpUser>>({
        path: "/api/v3/users",
        query: q,
      });
    },

    async getUser(id: number): Promise<OpUser | null> {
      // 404 = user not found (deactivated/locked/invisible) — normal, not an
      // error (SPEC_11 §4). Every other non-2xx propagates as OpHttpError.
      try {
        return await this.request<OpUser>({ path: `/api/v3/users/${id}` });
      } catch (err) {
        if (err instanceof OpHttpError && err.status === 404) return null;
        throw err;
      }
    },

    getMemberships(
      query?: MembershipsQuery,
    ): Promise<HalCollection<OpMembership>> {
      // Same filter-encoding as getWorkPackages/getTimeEntries: `filters` is
      // JSON-stringified (SPEC_13 §1a — typically one project clause).
      const q: Record<string, string | number | undefined> = {};
      if (query?.filters !== undefined) q["filters"] = JSON.stringify(query.filters);
      if (query?.pageSize !== undefined) q["pageSize"] = query.pageSize;
      if (query?.offset !== undefined) q["offset"] = query.offset;
      return this.request<HalCollection<OpMembership>>({
        path: "/api/v3/memberships",
        query: q,
      });
    },

    getProjects(query?: ProjectsQuery): Promise<HalCollection<OpProject>> {
      const q: Record<string, number | undefined> = {};
      if (query?.pageSize !== undefined) q["pageSize"] = query.pageSize;
      if (query?.offset !== undefined) q["offset"] = query.offset;
      return this.request<HalCollection<OpProject>>({
        path: "/api/v3/projects",
        query: q,
      });
    },

    getProject(id: number): Promise<OpProject> {
      return this.request<OpProject>({ path: `/api/v3/projects/${id}` });
    },

    getWorkPackages(
      query: WorkPackagesQuery,
    ): Promise<HalCollection<OpWorkPackage>> {
      const q: Record<string, string | number | undefined> = {};
      if (query.filters !== undefined) q["filters"] = JSON.stringify(query.filters);
      if (query.sortBy !== undefined) q["sortBy"] = JSON.stringify(query.sortBy);
      if (query.pageSize !== undefined) q["pageSize"] = query.pageSize;
      if (query.offset !== undefined) q["offset"] = query.offset;
      return this.request<HalCollection<OpWorkPackage>>({
        path: "/api/v3/work_packages",
        query: q,
      });
    },

    getTimeEntries(query: TimeEntriesQuery): Promise<HalCollection<OpTimeEntry>> {
      const q: Record<string, string | number | undefined> = {};
      if (query.filters !== undefined) q["filters"] = JSON.stringify(query.filters);
      if (query.pageSize !== undefined) q["pageSize"] = query.pageSize;
      if (query.offset !== undefined) q["offset"] = query.offset;
      return this.request<HalCollection<OpTimeEntry>>({
        path: "/api/v3/time_entries",
        query: q,
      });
    },

    getVersions(projectOpId?: number): Promise<HalCollection<OpVersion>> {
      const path =
        projectOpId === undefined
          ? "/api/v3/versions"
          : `/api/v3/projects/${projectOpId}/versions`;
      return this.request<HalCollection<OpVersion>>({ path });
    },

    getStatuses(): Promise<HalCollection<OpStatus>> {
      return this.request<HalCollection<OpStatus>>({ path: "/api/v3/statuses" });
    },

    getWorkPackageSchema(): Promise<OpWorkPackageSchema> {
      return this.request<OpWorkPackageSchema>({
        path: "/api/v3/work_packages/schema",
      });
    },

    getActivities(
      wpId: number,
      query?: ActivitiesQuery,
    ): Promise<HalCollection<OpActivity>> {
      const q: Record<string, number | undefined> = {};
      if (query?.pageSize !== undefined) q["pageSize"] = query.pageSize;
      if (query?.offset !== undefined) q["offset"] = query.offset;
      return this.request<HalCollection<OpActivity>>({
        path: `/api/v3/work_packages/${wpId}/activities`,
        query: q,
      });
    },
  };

  return client;
}
