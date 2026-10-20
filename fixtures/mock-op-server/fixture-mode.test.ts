import { readFileSync } from "node:fs";
import { Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRecordingMockOpServer,
  mockOpServer,
  SECOND_MOCK_OP_PORT,
  startMockOpServer,
  UNREACHABLE_OP_URL,
  type RecordingMockOpServer,
} from "../mock-op-server";

/**
 * FIXTURE-MODE regression suite: with no scenario loaded the refactored server
 * must behave exactly like the legacy static mock (pagination defaults,
 * filters, 405 on non-GET, fresh re-reads of data/*.json) and the package
 * entry must keep every legacy export.
 */

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

interface HalCollection {
  _type: string;
  total: number;
  count: number;
  pageSize: number;
  offset: number;
  _embedded: { elements: Array<Record<string, unknown>> };
  _links: Record<string, { href: string }>;
}

let mock: RecordingMockOpServer;

beforeAll(async () => {
  mock = await createRecordingMockOpServer();
});
afterAll(async () => {
  await mock.close();
});

async function getJson<T>(path: string): Promise<{ status: number; json: T }> {
  const res = await fetch(`${mock.url}${path}`);
  return { status: res.status, json: (await res.json()) as T };
}

describe("legacy exports stay available from the package entry", () => {
  it("keeps the module-level server + constants", () => {
    expect(mockOpServer).toBeInstanceOf(Server);
    expect(typeof startMockOpServer).toBe("function");
    expect(SECOND_MOCK_OP_PORT).toBe(8098);
    expect(UNREACHABLE_OP_URL).toBe("http://127.0.0.1:9");
  });

  it("recording server exposes methods/requests/methodSet/reset/close/url/port", () => {
    expect(Array.isArray(mock.methods)).toBe(true);
    expect(Array.isArray(mock.requests)).toBe(true);
    expect(mock.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(mock.port).toBeGreaterThan(0);
    expect(mock.methodSet()).toBeInstanceOf(Set);
  });
});

describe("work packages listing (legacy pagination + filters)", () => {
  it("defaults to pageSize 2 / offset 1 with a nextByOffset link", async () => {
    const all = JSON.parse(
      readFileSync(join(DATA_DIR, "work_packages.json"), "utf8"),
    ) as unknown[];
    const { status, json } = await getJson<HalCollection>("/api/v3/work_packages");
    expect(status).toBe(200);
    expect(json._type).toBe("WorkPackageCollection");
    expect(json.pageSize).toBe(2);
    expect(json.offset).toBe(1);
    expect(json.total).toBe(all.length);
    expect(json.count).toBe(2);
    expect(json._links["nextByOffset"]?.href).toBe(
      "/api/v3/work_packages?offset=2&pageSize=2",
    );
    expect(json._links["previousByOffset"]).toBeUndefined();
  });

  it("offset 2 carries a previousByOffset link", async () => {
    const { json } = await getJson<HalCollection>("/api/v3/work_packages?offset=2");
    expect(json.offset).toBe(2);
    expect(json._links["previousByOffset"]?.href).toBe(
      "/api/v3/work_packages?offset=1&pageSize=2",
    );
  });

  it("honors the project filter", async () => {
    const filters = encodeURIComponent(
      JSON.stringify([{ project: { operator: "=", values: ["3"] } }]),
    );
    const { json } = await getJson<HalCollection>(
      `/api/v3/work_packages?filters=${filters}&pageSize=100`,
    );
    expect(json.total).toBeGreaterThan(0);
    for (const wp of json._embedded.elements) {
      const links = wp["_links"] as { project: { href: string } };
      expect(links.project.href).toBe("/api/v3/projects/3");
    }
  });

  it("honors the id filter (single-WP import path)", async () => {
    const filters = encodeURIComponent(
      JSON.stringify([{ id: { operator: "=", values: ["1003"] } }]),
    );
    const { json } = await getJson<HalCollection>(`/api/v3/work_packages?filters=${filters}`);
    expect(json.total).toBe(1);
    expect(json._embedded.elements[0]?.["id"]).toBe(1003);
  });

  it("matches ANY value of a multi-value id filter (Increment 29 bulk fetch)", async () => {
    // Real OP has always accepted `id` with several values; the mock used to
    // keep only the FIRST, so a 100-id `syncByOpIds` batch would have matched
    // exactly ONE work package and made a correct client look broken.
    const wanted = ["1002", "1005", "1011", "999999"]; // last one does not exist
    const filters = encodeURIComponent(
      JSON.stringify([{ id: { operator: "=", values: wanted } }]),
    );
    const { json } = await getJson<HalCollection>(
      `/api/v3/work_packages?filters=${filters}&pageSize=100`,
    );
    expect(json.total).toBe(3);
    expect(json._embedded.elements.map((wp) => wp["id"]).sort()).toEqual([1002, 1005, 1011]);
  });

  it("multi-value id filter also works on the project-scoped listing", async () => {
    const filters = encodeURIComponent(
      JSON.stringify([{ id: { operator: "=", values: ["1001", "1002"] } }]),
    );
    const { json } = await getJson<HalCollection>(
      `/api/v3/projects/3/work_packages?filters=${filters}&pageSize=100`,
    );
    expect(json._embedded.elements.map((wp) => wp["id"]).sort()).toEqual([1001, 1002]);
  });
});

describe("static endpoints (unchanged shapes)", () => {
  it("serves users/me, projects, statuses, versions, schema from data/", async () => {
    const me = await getJson<{ id: number }>("/api/v3/users/me");
    expect(me.json.id).toBe(1);
    const statuses = await getJson<HalCollection>("/api/v3/statuses");
    expect(statuses.json.total).toBe(10);
    const projects = await getJson<HalCollection>("/api/v3/projects");
    expect(projects.json.total).toBe(2);
    const versions = await getJson<HalCollection>("/api/v3/versions");
    expect(versions.json.total).toBe(4);
    const schema = await getJson<{ _type: string }>("/api/v3/work_packages/schema");
    expect(schema.status).toBe(200);
  });

  it("serves the /api/v3/users COLLECTION (SPEC_13 §1) — the 'me' user as a HAL element", async () => {
    const { status, json } = await getJson<HalCollection>("/api/v3/users");
    expect(status).toBe(200);
    expect(json._type).toBe("Collection");
    expect(json.total).toBe(1);
    expect(json._embedded.elements[0]?.["id"]).toBe(1);
    expect(json._embedded.elements[0]?.["name"]).toBe("Ada Lovelace");
  });

  it("serves time entries verbatim from data/time_entries.json (fresh read)", async () => {
    const disk = JSON.parse(readFileSync(join(DATA_DIR, "time_entries.json"), "utf8"));
    const { json } = await getJson<unknown>("/api/v3/time_entries");
    expect(json).toEqual(disk);
  });

  it("filters project-scoped versions by definingProject", async () => {
    const { json } = await getJson<HalCollection>("/api/v3/projects/3/versions");
    expect(json.total).toBe(2);
    for (const v of json._embedded.elements) {
      const links = v["_links"] as { definingProject: { href: string } };
      expect(links.definingProject.href).toBe("/api/v3/projects/3");
    }
  });

  it("404s unknown /api/v3 paths", async () => {
    const { status } = await getJson<unknown>("/api/v3/nonexistent");
    expect(status).toBe(404);
  });
});

describe("read-only guard on /api/v3/* (both modes)", () => {
  it("405s every non-GET method with the OP-style error envelope", async () => {
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      const res = await fetch(`${mock.url}/api/v3/work_packages`, { method });
      expect(res.status).toBe(405);
      const body = (await res.json()) as { _type: string; message: string };
      expect(body._type).toBe("Error");
      expect(body.message).toMatch(/read-only/);
    }
  });

  it("records every request it received, including the mutations", () => {
    expect(mock.requests.length).toBeGreaterThan(0);
    expect(mock.methodSet().has("POST")).toBe(true); // from the 405 test above
  });
});

describe("admin surface in fixture mode", () => {
  it("GET /__mock/state reports fixture mode", async () => {
    const { status, json } = await getJson<Record<string, unknown>>("/__mock/state");
    expect(status).toBe(200);
    expect(json).toMatchObject({
      scenario: null,
      day: 0,
      date: null,
      total_days: 0,
      pending_days: 0,
      work_packages: [],
    });
  });

  it("GET /__mock/scenarios answers with an array (registry may be empty)", async () => {
    const { status, json } = await getJson<unknown>("/__mock/scenarios");
    expect(status).toBe(200);
    expect(Array.isArray(json)).toBe(true);
  });

  it("POST /__mock/advance-day without a scenario is a clear 400", async () => {
    const res = await fetch(`${mock.url}/__mock/advance-day`, { method: "POST" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/No scenario loaded/);
  });
});
