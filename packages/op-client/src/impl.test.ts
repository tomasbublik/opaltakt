import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mockOpServer } from "@osp/fixtures";
import { createOpClient, OpHttpError } from "./impl";
import { fetchAllWorkPackages } from "./paginate";
import { ReadOnlyViolationError } from "./client";
import type { AddressInfo } from "node:net";

let baseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    mockOpServer.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = mockOpServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    mockOpServer.close(() => resolve());
  });
});

function makeClient() {
  return createOpClient({ baseUrl, token: "secret-token" });
}

describe("read-only guard (SPEC §2)", () => {
  it("throws ReadOnlyViolationError for any non-GET method and never hits the network", () => {
    const c = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const method of ["POST", "PATCH", "PUT", "DELETE"] as const) {
      expect(() =>
        c.request({ path: "/api/v3/work_packages", method: method as never }),
      ).toThrow(ReadOnlyViolationError);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("allows GET", async () => {
    const c = makeClient();
    const me = await c.getCurrentUser();
    expect(me.id).toBe(1);
  });
});

describe("auth header", () => {
  it("sends HTTP Basic base64('apikey:'+token)", async () => {
    const c = makeClient();
    let seen: string | null = null;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_url, init) => {
        seen =
          (init?.headers as Record<string, string> | undefined)?.[
            "Authorization"
          ] ?? null;
        return new Response(JSON.stringify({ _type: "User", id: 1, name: "x" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
    await c.getCurrentUser();
    fetchSpy.mockRestore();
    const expected = `Basic ${Buffer.from("apikey:secret-token").toString("base64")}`;
    expect(seen).toBe(expected);
  });
});

describe("pagination", () => {
  it("walks every work_packages page with a small pageSize and returns all, unique, in order", async () => {
    const c = makeClient();
    // Discover the true total from the server rather than hard-coding it, so the
    // test stays green as the fixture set grows.
    const first = await c.getWorkPackages({ pageSize: 1000, offset: 1 });
    const total = first.total;
    expect(total).toBeGreaterThanOrEqual(20);

    const all = await fetchAllWorkPackages(c, { pageSize: 2 });
    expect(all).toHaveLength(total);
    const ids = all.map((w) => w.id);
    expect(new Set(ids).size).toBe(total); // no dupes across pages
    expect(ids).toEqual([...ids].sort((a, b) => a - b)); // returned in id order
    expect(ids).toEqual(expect.arrayContaining([1001, 1002, 1003]));
  });

  it("single-page getWorkPackages honours offset/pageSize", async () => {
    const c = makeClient();
    const page1 = await c.getWorkPackages({ pageSize: 2, offset: 1 });
    expect(page1.offset).toBe(1);
    expect(page1.pageSize).toBe(2);
    expect(page1._embedded.elements).toHaveLength(2);

    const page2 = await c.getWorkPackages({ pageSize: 2, offset: 2 });
    expect(page2._embedded.elements).toHaveLength(2);
    expect(page2.total).toBe(page1.total);
    // Second page starts after the first (no overlap).
    const p1 = page1._embedded.elements.map((w) => w.id);
    const p2 = page2._embedded.elements.map((w) => w.id);
    expect(p1.some((id) => p2.includes(id))).toBe(false);
  });

  it("scopes work_packages to a project when a project filter is supplied", async () => {
    const c = makeClient();
    // Project 3 holds exactly the three demo WPs (1001–1003).
    const demo = await c.getWorkPackages({
      filters: [{ project: { operator: "=", values: ["3"] } }],
      pageSize: 100,
    });
    expect(demo._embedded.elements.map((w) => w.id).sort((a, b) => a - b)).toEqual([
      1001, 1002, 1003,
    ]);
  });
});

describe("other endpoints", () => {
  it("reads statuses, versions, time entries, schema", async () => {
    const c = makeClient();
    const [statuses, versions, entries, schema] = await Promise.all([
      c.getStatuses(),
      c.getVersions(),
      c.getTimeEntries({}),
      c.getWorkPackageSchema(),
    ]);
    expect(statuses._embedded.elements.length).toBe(10);
    expect(versions._embedded.elements.length).toBeGreaterThan(0);
    expect(entries._embedded.elements.length).toBe(3);
    expect(schema.estimatedTime).toBeDefined();
  });

  it("getUsers returns the user COLLECTION (SPEC_13 §1), distinct from getUser/getCurrentUser", async () => {
    const c = makeClient();
    const users = await c.getUsers();
    expect(users._type).toBe("Collection");
    // Fixture mode's directory is exactly the "me" user (id 1) — a HAL element,
    // not the bare /users/me object.
    expect(users._embedded.elements.map((u) => u.id)).toContain(1);
  });

  it("getMemberships returns the project roster with principal id+name (SPEC_13 §1a)", async () => {
    const c = makeClient();
    const page = await c.getMemberships({
      filters: [{ project: { operator: "=", values: ["3"] } }],
    });
    expect(page._type).toBe("Collection");
    // Fixture mode's roster is the "me" user (id 1) as a membership; the load-
    // bearing bit is _links.principal carrying the id (href) + name (title).
    const first = page._embedded.elements[0];
    expect(first?._type).toBe("Membership");
    expect(first?._links.principal.href).toContain("/api/v3/users/1");
    expect(typeof first?._links.principal.title).toBe("string");
  });

  it("getUser resolves a known user and returns null (not throw) on 404 (SPEC_11 §4)", async () => {
    const c = makeClient();
    const known = await c.getUser(1);
    expect(known?.id).toBe(1);
    // A deactivated/locked/unknown id is a normal 404 → null, never an error.
    await expect(c.getUser(999_999)).resolves.toBeNull();
  });
});

describe("retry/backoff", () => {
  it("retries on 429 (honouring Retry-After) then succeeds", async () => {
    const c = createOpClient({ baseUrl, token: "t", maxRetries: 2 });
    let calls = 0;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
        calls += 1;
        if (calls === 1) {
          return new Response("rate limited", {
            status: 429,
            headers: { "retry-after": "0" },
          });
        }
        return new Response(JSON.stringify({ _type: "User", id: 1, name: "x" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
    const me = await c.getCurrentUser();
    fetchSpy.mockRestore();
    expect(calls).toBe(2);
    expect(me.id).toBe(1);
  });

  it("throws OpHttpError after exhausting retries on 5xx", async () => {
    const c = createOpClient({ baseUrl, token: "t", maxRetries: 1 });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("boom", { status: 503 }));
    await expect(c.getCurrentUser()).rejects.toBeInstanceOf(OpHttpError);
    fetchSpy.mockRestore();
  });
});
