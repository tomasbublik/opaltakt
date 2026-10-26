import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  S22_PROJECTS,
  S22_SERVER2_PROJECT,
  S22_WP,
  s22MultiProject,
  s22MultiProjectServer2,
} from "../scenarios/s22-multi-project";
import { createRecordingMockOpServer, type RecordingMockOpServer } from "./index";

/**
 * Increment 40 (INCREMENT_40_CONTRACTS §2 Agent D) — the mock's project
 * surface, in BOTH modes:
 *  - GET /api/v3/projects/{id}           (404 HAL error for unknown/hidden)
 *  - GET /api/v3/projects pagination     (pageSize/offset; unpaged = all)
 *  - ScenarioProject.hidden              (WPs visible, project not)
 *  - POST /__mock/rename-project/:id     (name + identifier, live everywhere)
 *  - fixture-mode membership title       (real project name, not "Project N")
 * plus the read-only rule: /api/v3/* stays GET-only.
 */

interface HalProject {
  _type: string;
  id: number;
  identifier: string;
  name: string;
  _links: { self: { href: string; title?: string } };
}
interface HalCollection<T> {
  _type: string;
  total: number;
  count: number;
  pageSize: number;
  offset: number;
  _embedded: { elements: T[] };
  _links: Record<string, { href: string } | undefined>;
}
interface HalWp {
  id: number;
  _links: { project: { href: string; title: string } };
}
interface HalError {
  _type: string;
  errorIdentifier: string;
}

let mock: RecordingMockOpServer;

beforeAll(async () => {
  mock = await createRecordingMockOpServer("127.0.0.1", {
    scenarios: [s22MultiProject, s22MultiProjectServer2],
  });
});
afterAll(async () => {
  await mock.close();
});
afterEach(async () => {
  await admin("POST", "/__mock/reset");
});

async function getJson<T>(path: string): Promise<{ status: number; json: T }> {
  const res = await fetch(`${mock.url}${path}`);
  return { status: res.status, json: (await res.json()) as T };
}

async function admin(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${mock.url}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json() };
}

async function allWps(): Promise<HalWp[]> {
  return (await getJson<HalCollection<HalWp>>("/api/v3/work_packages?pageSize=100")).json._embedded.elements;
}

describe("scenario mode — GET /api/v3/projects/{id} + hidden projects (S22)", () => {
  it("serves a visible project by id with identifier + name", async () => {
    await admin("POST", "/__mock/load/s22-multi-project");
    const { status, json } = await getJson<HalProject>(`/api/v3/projects/${S22_PROJECTS.harbor.id}`);
    expect(status).toBe(200);
    expect(json).toMatchObject({
      _type: "Project",
      id: S22_PROJECTS.harbor.id,
      identifier: "harbor-ops",
      name: "Harbor Ops",
    });
    expect(json._links.self.href).toBe(`/api/v3/projects/${S22_PROJECTS.harbor.id}`);
  });

  it("404s (HAL NotFound) an unknown id AND the hidden project — indistinguishable", async () => {
    await admin("POST", "/__mock/load/s22-multi-project");
    for (const id of [999999, S22_PROJECTS.hidden.id]) {
      const { status, json } = await getJson<HalError>(`/api/v3/projects/${id}`);
      expect(status, `project ${id}`).toBe(404);
      expect(json._type).toBe("Error");
      expect(json.errorIdentifier).toBe("urn:openproject-org:api:v3:errors:NotFound");
    }
  });

  it("omits the hidden project from the collection but keeps its WP visible, titled with the project name", async () => {
    await admin("POST", "/__mock/load/s22-multi-project");
    const list = await getJson<HalCollection<HalProject>>("/api/v3/projects");
    expect(list.json._embedded.elements.map((p) => p.identifier)).toEqual(["northwind", "harbor-ops"]);
    expect(list.json.total).toBe(2);

    const hiddenWp = (await allWps()).find((w) => w.id === S22_WP.hiddenAuthBump);
    expect(hiddenWp, "the hidden project's WP is still served").toBeDefined();
    expect(hiddenWp!._links.project).toEqual({
      href: `/api/v3/projects/${S22_PROJECTS.hidden.id}`,
      title: S22_PROJECTS.hidden.name,
    });
  });

  it("paginates the collection honouring pageSize/offset (offset = 1-based page)", async () => {
    await admin("POST", "/__mock/load/s22-multi-project");
    const p1 = await getJson<HalCollection<HalProject>>("/api/v3/projects?pageSize=1&offset=1");
    expect(p1.json.total).toBe(2);
    expect(p1.json.count).toBe(1);
    expect(p1.json.pageSize).toBe(1);
    expect(p1.json._embedded.elements[0]!.id).toBe(S22_PROJECTS.northwind.id);
    expect(p1.json._links["nextByOffset"]).toBeDefined();
    const p2 = await getJson<HalCollection<HalProject>>("/api/v3/projects?pageSize=1&offset=2");
    expect(p2.json._embedded.elements.map((p) => p.id)).toEqual([S22_PROJECTS.harbor.id]);
    expect(p2.json._links["nextByOffset"]).toBeUndefined();
    const past = await getJson<HalCollection<HalProject>>("/api/v3/projects?pageSize=1&offset=3");
    expect(past.json._embedded.elements).toEqual([]);
    // Unpaged ⇒ everything on one page (pre-Increment-40 client compatibility).
    const all = await getJson<HalCollection<HalProject>>("/api/v3/projects");
    expect(all.json.count).toBe(2);
  });

  it("server two's project 8700 is a DIFFERENT project from server one's 8700", async () => {
    const other = await createRecordingMockOpServer("127.0.0.1", {
      scenarios: [s22MultiProject, s22MultiProjectServer2],
    });
    try {
      await admin("POST", "/__mock/load/s22-multi-project");
      await fetch(`${other.url}/__mock/load/s22-multi-project-server2`, { method: "POST" });
      const one = await getJson<HalProject>(`/api/v3/projects/${S22_PROJECTS.northwind.id}`);
      const twoRes = await fetch(`${other.url}/api/v3/projects/${S22_SERVER2_PROJECT.id}`);
      const two = (await twoRes.json()) as HalProject;
      expect(one.json.id).toBe(two.id);
      expect(one.json.name).toBe("Northwind Payments");
      expect(two.name).toBe("Northwind Logistics");
      expect(two.identifier).toBe("nw-logistics");
    } finally {
      await other.close();
    }
  });
});

describe("POST /__mock/rename-project/:id", () => {
  it("scenario mode: renames name + identifier; project endpoints AND WP _links.project.title follow", async () => {
    await admin("POST", "/__mock/load/s22-multi-project");
    const id = S22_PROJECTS.northwind.id;
    const res = await admin("POST", `/__mock/rename-project/${id}`, {
      name: "Northwind Card Services",
      identifier: "nw-cards",
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      project: { id, identifier: "nw-cards", name: "Northwind Card Services", hidden: false },
    });

    expect((await getJson<HalProject>(`/api/v3/projects/${id}`)).json).toMatchObject({
      id,
      identifier: "nw-cards",
      name: "Northwind Card Services",
    });
    const listed = (await getJson<HalCollection<HalProject>>("/api/v3/projects")).json._embedded.elements;
    expect(listed.find((p) => p.id === id)?.identifier).toBe("nw-cards");

    const wps = await allWps();
    const nw = wps.filter((w) => w._links.project.href === `/api/v3/projects/${id}`);
    expect(nw.length).toBeGreaterThanOrEqual(2);
    for (const w of nw) expect(w._links.project.title).toBe("Northwind Card Services");
    // Other projects untouched.
    const hb = wps.find((w) => w.id === S22_WP.hbBerthImport)!;
    expect(hb._links.project.title).toBe("Harbor Ops");
  });

  it("scenario mode: a partial patch keeps the other field; a fresh load discards the rename", async () => {
    await admin("POST", "/__mock/load/s22-multi-project");
    const id = S22_PROJECTS.harbor.id;
    await admin("POST", `/__mock/rename-project/${id}`, { name: "Harbor Operations" });
    expect((await getJson<HalProject>(`/api/v3/projects/${id}`)).json).toMatchObject({
      identifier: "harbor-ops",
      name: "Harbor Operations",
    });
    await admin("POST", "/__mock/load/s22-multi-project");
    expect((await getJson<HalProject>(`/api/v3/projects/${id}`)).json.name).toBe("Harbor Ops");
  });

  it("scenario mode: renaming a HIDDEN project changes its WPs' title but it stays 404", async () => {
    await admin("POST", "/__mock/load/s22-multi-project");
    const id = S22_PROJECTS.hidden.id;
    const res = await admin("POST", `/__mock/rename-project/${id}`, { name: "Lighthouse Core" });
    expect(res.status).toBe(200);
    expect((res.json as { project: { hidden: boolean } }).project.hidden).toBe(true);
    expect((await getJson<HalError>(`/api/v3/projects/${id}`)).status).toBe(404);
    const wp = (await allWps()).find((w) => w.id === S22_WP.hiddenAuthBump)!;
    expect(wp._links.project.title).toBe("Lighthouse Core");
  });

  it("validates: unknown id → 404, empty patch / empty string → 400, GET → 405", async () => {
    await admin("POST", "/__mock/load/s22-multi-project");
    expect((await admin("POST", "/__mock/rename-project/424242", { name: "X" })).status).toBe(404);
    expect((await admin("POST", `/__mock/rename-project/${S22_PROJECTS.harbor.id}`, {})).status).toBe(400);
    expect(
      (await admin("POST", `/__mock/rename-project/${S22_PROJECTS.harbor.id}`, { identifier: "  " })).status,
    ).toBe(400);
    expect((await admin("POST", "/__mock/rename-project/abc", { name: "X" })).status).toBe(400);
    expect((await admin("GET", `/__mock/rename-project/${S22_PROJECTS.harbor.id}`)).status).toBe(405);
  });

  it("fixture mode: rename overlays data/projects.json, /projects/{id} and WP titles; reset restores", async () => {
    // Fixture mode (no scenario): project 7 = "Platform" in data/projects.json.
    const before = await getJson<HalWp[] | HalCollection<HalWp>>("/api/v3/work_packages?pageSize=100");
    const wpsBefore = (before.json as HalCollection<HalWp>)._embedded.elements;
    expect(wpsBefore.some((w) => w._links.project.title === "Platform")).toBe(true);

    const res = await admin("POST", "/__mock/rename-project/7", { name: "Platform Core", identifier: "platform-core" });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ project: { id: 7, identifier: "platform-core", name: "Platform Core", hidden: false } });

    expect((await getJson<HalProject>("/api/v3/projects/7")).json).toMatchObject({
      id: 7,
      identifier: "platform-core",
      name: "Platform Core",
    });
    const listed = (await getJson<HalCollection<HalProject>>("/api/v3/projects")).json._embedded.elements;
    expect(listed.map((p) => p.identifier)).toEqual(["demo-project", "platform-core"]);
    const wps = (await getJson<HalCollection<HalWp>>("/api/v3/work_packages?pageSize=100")).json._embedded.elements;
    const p7 = wps.filter((w) => w._links.project.href === "/api/v3/projects/7");
    expect(p7.length).toBeGreaterThan(0);
    for (const w of p7) expect(w._links.project.title).toBe("Platform Core");
    const scoped = (await getJson<HalCollection<HalWp>>("/api/v3/projects/7/work_packages?pageSize=100")).json;
    for (const w of scoped._embedded.elements) expect(w._links.project.title).toBe("Platform Core");

    await admin("POST", "/__mock/reset");
    expect((await getJson<HalProject>("/api/v3/projects/7")).json.name).toBe("Platform");
  });

  it("fixture mode: unknown project id → 404 for both the rename and GET /projects/{id}", async () => {
    expect((await admin("POST", "/__mock/rename-project/999", { name: "X" })).status).toBe(404);
    const r = await getJson<HalError>("/api/v3/projects/999");
    expect(r.status).toBe(404);
    expect(r.json.errorIdentifier).toBe("urn:openproject-org:api:v3:errors:NotFound");
  });
});

describe("fixture mode — project collection paging + membership title", () => {
  it("unpaged /projects is the static file byte-for-byte; paged honours pageSize/offset", async () => {
    const all = await getJson<HalCollection<HalProject>>("/api/v3/projects");
    expect(all.json.total).toBe(2);
    expect(all.json._links["self"]).toEqual({ href: "/api/v3/projects" });
    const p2 = await getJson<HalCollection<HalProject>>("/api/v3/projects?pageSize=1&offset=2");
    expect(p2.json.total).toBe(2);
    expect(p2.json._embedded.elements.map((p) => p.id)).toEqual([7]);
    expect(p2.json._links["previousByOffset"]).toBeDefined();
  });

  it("GET /projects/{id} serves the fixture project", async () => {
    const { status, json } = await getJson<HalProject>("/api/v3/projects/3");
    expect(status).toBe(200);
    expect(json).toMatchObject({ id: 3, identifier: "demo-project", name: "Demo Project" });
  });

  it("membership _links.project.title is the REAL project name (was 'Project N')", async () => {
    const filters = encodeURIComponent(JSON.stringify([{ project: { operator: "=", values: ["7"] } }]));
    const { json } = await getJson<HalCollection<{ _links: { project: { title?: string } } }>>(
      `/api/v3/memberships?filters=${filters}`,
    );
    expect(json._embedded.elements[0]!._links.project.title).toBe("Platform");
  });
});

describe("read-only: project endpoints refuse non-GET", () => {
  it("POST/PATCH/DELETE on /api/v3/projects[/id] → 405", async () => {
    for (const method of ["POST", "PATCH", "DELETE"]) {
      for (const path of ["/api/v3/projects", "/api/v3/projects/3"]) {
        const res = await fetch(`${mock.url}${path}`, { method });
        expect(res.status, `${method} ${path}`).toBe(405);
      }
    }
  });
});
