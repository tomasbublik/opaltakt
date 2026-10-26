import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpClient, OpRequestOptions, ProjectsQuery } from "./client";
import { withHardCancel } from "./hardCancel";
import { createOpClient, OpHttpError } from "./impl";
import { instrumentOpClient } from "./instrument";
import { fetchAllProjects } from "./paginate";
import { withTimeout } from "./timeout";
import type { HalCollection, OpProject } from "./types";

/**
 * Increment 40 (INCREMENT_40_CONTRACTS §2.A3/A4) — `getProject(id)` and the
 * paginated projects collection. A tiny local HTTP server records the method +
 * URL of every request, so these tests prove the new calls are GET-only and
 * hit exactly the documented OP paths, independently of the shared mock.
 * Fictional projects only (northwind, harbor-ops).
 */

interface Seen {
  method: string;
  url: string;
}

const seen: Seen[] = [];
let server: Server;
let baseUrl: string;

const PROJECTS: OpProject[] = [
  { _type: "Project", id: 11, identifier: "northwind", name: "Northwind Payments" },
  { _type: "Project", id: 12, identifier: "harbor-ops", name: "Harbor Ops" },
  { _type: "Project", id: 13, identifier: "lighthouse", name: "Lighthouse" },
];

function handle(req: IncomingMessage, res: ServerResponse): void {
  seen.push({ method: req.method ?? "", url: req.url ?? "" });
  const url = new URL(req.url ?? "/", "http://x");
  res.setHeader("content-type", "application/hal+json");
  const single = /^\/api\/v3\/projects\/(\d+)$/.exec(url.pathname);
  if (single) {
    const p = PROJECTS.find((x) => x.id === Number(single[1]));
    if (!p) {
      res.statusCode = 404;
      res.end(JSON.stringify({ _type: "Error", message: "not found" }));
      return;
    }
    res.end(JSON.stringify(p));
    return;
  }
  if (url.pathname === "/api/v3/projects") {
    const pageSize = Number(url.searchParams.get("pageSize") ?? 100);
    const offset = Number(url.searchParams.get("offset") ?? 1);
    const start = (offset - 1) * pageSize;
    const elements = PROJECTS.slice(start, start + pageSize);
    res.end(
      JSON.stringify({
        _type: "Collection",
        total: PROJECTS.length,
        count: elements.length,
        pageSize,
        offset,
        _embedded: { elements },
        _links: { self: { href: url.pathname } },
      }),
    );
    return;
  }
  res.statusCode = 404;
  res.end("{}");
}

beforeAll(async () => {
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeClient(): OpClient {
  return createOpClient({ baseUrl, token: "t", maxRetries: 0 });
}

describe("getProject (GET /api/v3/projects/:id)", () => {
  it("returns the project and issues exactly one GET to the documented path", async () => {
    seen.length = 0;
    const p = await makeClient().getProject(12);
    expect(p).toMatchObject({ id: 12, identifier: "harbor-ops", name: "Harbor Ops" });
    expect(seen).toEqual([{ method: "GET", url: "/api/v3/projects/12" }]);
  });

  it("throws OpHttpError(404) for a hidden/unknown project (caller decides to skip)", async () => {
    const err = await makeClient().getProject(999).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OpHttpError);
    expect((err as OpHttpError).status).toBe(404);
  });

  it("is GET-only through every wrapper (instrument → timeout → hardCancel)", async () => {
    seen.length = 0;
    const wrapped = withHardCancel(
      withTimeout(instrumentOpClient(makeClient(), () => {}), 5_000),
      { timeoutMs: 5_000 },
    );
    const p = await wrapped.getProject(11);
    expect(p.identifier).toBe("northwind");
    // Detached call still routes (the `this ?? wrapped` pattern).
    const { getProject } = wrapped;
    await getProject(13);
    expect(seen.map((s) => s.method)).toEqual(["GET", "GET"]);
    expect(seen.map((s) => s.url)).toEqual(["/api/v3/projects/11", "/api/v3/projects/13"]);
  });

  it("an outer wrapper's request() is the one getProject goes through (composition)", async () => {
    const calls: OpRequestOptions[] = [];
    const raw = makeClient();
    const outerRequest = vi.fn(<T>(options: OpRequestOptions): Promise<T> => {
      calls.push(options);
      return raw.request<T>(options);
    });
    const instrumented = instrumentOpClient(raw, () => {});
    // Call the instrumented method with an outer `this` — it must use THAT
    // request (a fixed arrow-closure would bypass it: Increment 20 lesson).
    await instrumented.getProject.call({ ...instrumented, request: outerRequest }, 11);
    expect(outerRequest).toHaveBeenCalledTimes(1);
    expect(calls[0]?.path).toBe("/api/v3/projects/11");
  });
});

describe("getProjects pagination", () => {
  it("passes pageSize/offset through as query params", async () => {
    seen.length = 0;
    const page = await makeClient().getProjects({ pageSize: 2, offset: 2 });
    expect(page._embedded.elements.map((p) => p.id)).toEqual([13]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("GET");
    const u = new URL(seen[0]!.url, "http://x");
    expect(u.pathname).toBe("/api/v3/projects");
    expect(u.searchParams.get("pageSize")).toBe("2");
    expect(u.searchParams.get("offset")).toBe("2");
  });

  it("fetchAllProjects collects every page over the real client (GET only)", async () => {
    seen.length = 0;
    const all = await fetchAllProjects(makeClient(), 2);
    expect(all.map((p) => p.identifier)).toEqual(["northwind", "harbor-ops", "lighthouse"]);
    expect(seen).toHaveLength(2);
    expect(seen.every((s) => s.method === "GET")).toBe(true);
  });

  it("fetchAllProjects: single page → one call; empty → no infinite loop", async () => {
    const page = (all: OpProject[]) =>
      vi.fn(async (q?: ProjectsQuery): Promise<HalCollection<OpProject>> => {
        const pageSize = q?.pageSize ?? 100;
        const offset = q?.offset ?? 1;
        const elements = all.slice((offset - 1) * pageSize, offset * pageSize);
        return {
          _type: "Collection",
          total: all.length,
          count: elements.length,
          pageSize,
          offset,
          _embedded: { elements },
          _links: { self: { href: null } },
        };
      });
    const one = page(PROJECTS);
    expect(await fetchAllProjects({ getProjects: one } as unknown as OpClient)).toHaveLength(3);
    expect(one).toHaveBeenCalledTimes(1);
    expect(one).toHaveBeenCalledWith({ offset: 1, pageSize: 100 });

    const none = page([]);
    expect(await fetchAllProjects({ getProjects: none } as unknown as OpClient)).toEqual([]);
    expect(none).toHaveBeenCalledTimes(1);
  });
});
