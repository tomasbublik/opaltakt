/**
 * Tests for the mock-simulation CLI (fixtures/sim.ts).
 *
 * `sim.ts` has no exported functions — it only runs `main()` on import and
 * mutates the real JSON files under `fixtures/data/`. So we drive it as a
 * subprocess (via `pnpm --filter @osp/fixtures sim ...`, i.e. `tsx sim.ts`)
 * and assert on the resulting file contents.
 *
 * CRITICAL: these tests edit committed fixtures. We snapshot the two mutated
 * files' raw bytes before the suite and restore them after every test (and
 * again after all), so the committed fixtures are byte-identical afterwards.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(FIXTURES_DIR, "data");

// The two files sim.ts may mutate. statuses.json is only read, never written.
const MUTABLE_FILES = ["work_packages.json", "time_entries.json"] as const;

const backups = new Map<string, string>();

function readData(file: string): string {
  return readFileSync(join(DATA_DIR, file), "utf8");
}

function readJson<T>(file: string): T {
  return JSON.parse(readData(file)) as T;
}

function restoreAll(): void {
  for (const [file, contents] of backups) {
    writeFileSync(join(DATA_DIR, file), contents, "utf8");
  }
}

/** Run the sim CLI as `tsx sim.ts <args...>` and capture its result. */
function runSim(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync("pnpm", ["--filter", "@osp/fixtures", "sim", ...args], {
    cwd: FIXTURES_DIR,
    encoding: "utf8",
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

interface WorkPackage {
  id: number;
  spentTime?: string | null;
  updatedAt?: string;
  _links: { status?: { href?: string; title?: string } };
}

interface Status {
  id: number;
  name: string;
}

interface TimeEntry {
  hours: string;
  spentOn: string;
  _links: Record<string, { href: string; title?: string }>;
}

interface Collection<T> {
  total: number;
  count: number;
  _embedded: { elements: T[] };
}

function findWp(id: number): WorkPackage {
  const wp = readJson<WorkPackage[]>("work_packages.json").find((w) => w.id === id);
  if (!wp) throw new Error(`WP ${id} missing from fixture`);
  return wp;
}

beforeAll(() => {
  for (const file of MUTABLE_FILES) backups.set(file, readData(file));
});

afterEach(() => {
  // Restore committed contents so every test starts from pristine data and the
  // repo is left untouched between tests.
  restoreAll();
});

afterAll(() => {
  restoreAll();
});

describe("sim set-status", () => {
  it("sets a WP's status href + title to the matching status and bumps updatedAt", () => {
    const before = findWp(1001);
    const beforeStatus = before._links.status?.title;
    expect(beforeStatus).not.toBe("Merge pending"); // sanity: it's a real change

    const res = runSim("set-status", "--wp", "1001", "--status", "Merge pending");
    expect(res.status).toBe(0);

    const statuses = readJson<Collection<Status>>("statuses.json")._embedded.elements;
    const mergePending = statuses.find((s) => s.name === "Merge pending");
    expect(mergePending).toBeDefined();

    const after = findWp(1001);
    expect(after._links.status?.title).toBe("Merge pending");
    expect(after._links.status?.href).toBe(`/api/v3/statuses/${mergePending!.id}`);
    expect(after.updatedAt).toBeDefined();
    expect(after.updatedAt).not.toBe(before.updatedAt);
  });

  it("matches the status name case-insensitively", () => {
    const res = runSim("set-status", "--wp", "1001", "--status", "mErGe PeNdInG");
    expect(res.status).toBe(0);

    const after = findWp(1001);
    // Canonical casing from statuses.json is used, not the argument's casing.
    expect(after._links.status?.title).toBe("Merge pending");
    expect(after._links.status?.href).toBe("/api/v3/statuses/4");
  });

  it("rejects an unknown status and leaves the file uncorrupted", () => {
    const wpFileBefore = readData("work_packages.json");

    const res = runSim("set-status", "--wp", "1001", "--status", "Totally Bogus Status");
    expect(res.status).not.toBe(0);

    // No-op: the fixture must be byte-identical (not corrupted / partially written).
    expect(readData("work_packages.json")).toBe(wpFileBefore);
    // And it must still be valid JSON with the untouched status.
    expect(findWp(1001)._links.status?.title).not.toBe("Totally Bogus Status");
  });
});

describe("sim log-time", () => {
  it("appends a time entry for the WP and recomputes its cumulative spentTime", () => {
    const beforeWp = findWp(1003);
    const beforeTe = readJson<Collection<TimeEntry>>("time_entries.json");
    const beforeCount = beforeTe._embedded.elements.length;

    // WP 1003 already has one PT2H entry in the committed fixture, so logging
    // 3h more must yield a cumulative spentTime of PT5H.
    const priorHours = beforeTe._embedded.elements
      .filter((e) => e._links["workPackage"]?.href === "/api/v3/work_packages/1003")
      .reduce((sum, e) => sum + parseHours(e.hours), 0);
    expect(priorHours).toBe(2);

    const res = runSim("log-time", "--wp", "1003", "--hours", "3", "--on", "2026-07-10");
    expect(res.status).toBe(0);

    const afterTe = readJson<Collection<TimeEntry>>("time_entries.json");
    expect(afterTe._embedded.elements.length).toBe(beforeCount + 1);
    // Collection totals kept in sync.
    expect(afterTe.total).toBe(beforeCount + 1);
    expect(afterTe.count).toBe(beforeCount + 1);

    const added = afterTe._embedded.elements.at(-1)!;
    expect(added.spentOn).toBe("2026-07-10");
    expect(added.hours).toBe("PT3H");
    expect(added._links["workPackage"]?.href).toBe("/api/v3/work_packages/1003");

    // Shape matches existing entries.
    const sample = beforeTe._embedded.elements[0]!;
    for (const key of Object.keys(sample)) {
      expect(added).toHaveProperty(key);
    }

    // Cumulative recompute: 2h prior + 3h new = 5h.
    const afterWp = findWp(1003);
    expect(afterWp.spentTime).toBe("PT5H");
    expect(afterWp.updatedAt).not.toBe(beforeWp.updatedAt);
  });
});

/** Minimal ISO-8601 duration → hours parser for assertions (handles PT<n>H). */
function parseHours(iso: string): number {
  const m = /PT(?:(\d+(?:\.\d+)?)H)?/.exec(iso);
  return m?.[1] ? Number(m[1]) : 0;
}
