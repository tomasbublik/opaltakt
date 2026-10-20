/**
 * fixtures/sim.ts — a tiny CLI to *simulate* changes inside the mock
 * OpenProject instance by editing its own JSON data files (SPEC bod 3).
 *
 * This does NOT violate the app's read-only guarantee: the app itself still
 * only ever GETs OpenProject. Here we (the "OP admin") edit the mock's backing
 * fixtures directly. Because the mock server re-reads work_packages.json and
 * time_entries.json fresh on every request, the change shows up on the next
 * "Sync now" (POST /api/sync) without restarting the mock.
 *
 * Dependency-free: Node built-ins only, run via tsx (already available).
 *
 * Usage:
 *   pnpm --filter @osp/fixtures sim log-time  --wp 1008 --hours 3 [--on 2026-07-02] [--user 2] [--comment "text"]
 *   pnpm --filter @osp/fixtures sim set-status --wp 1008 --status "Merge pending"
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseIsoDuration } from "@osp/op-client";
import { hoursToIsoDuration } from "./mock-op-server/hal";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "data");

// ── JSON helpers (preserve 2-space indent + trailing newline) ────────────────

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(join(DATA_DIR, file), "utf8")) as T;
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(join(DATA_DIR, file), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** ISO timestamp without milliseconds, matching the fixture style. */
function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Extract the numeric id from a HAL href like "/api/v3/work_packages/1008". */
function hrefId(href: string | null | undefined): number | null {
  const m = href ? /\/(\d+)(?:\?.*)?$/.exec(href) : null;
  return m ? Number(m[1]) : null;
}

// ── Minimal typed shapes for the bits we touch ──────────────────────────────

interface WorkPackage {
  id: number;
  subject?: string;
  spentTime?: string | null;
  updatedAt?: string;
  _links: {
    self?: { href?: string; title?: string };
    status?: { href?: string; title?: string };
    project?: { href?: string | null; title?: string };
  };
}

interface TimeEntry {
  _type: string;
  id: number;
  hours: string;
  spentOn: string;
  comment: { format: string; raw: string; html: string };
  createdAt: string;
  updatedAt: string;
  _links: Record<string, { href: string; title?: string }>;
}

interface Collection<T> {
  _type: string;
  total: number;
  count: number;
  pageSize: number;
  offset: number;
  _embedded: { elements: T[] };
  _links: Record<string, unknown>;
}

interface Status {
  id: number;
  name: string;
  isClosed: boolean;
}

// ── Arg parsing ─────────────────────────────────────────────────────────────

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a?.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out[key] = "true";
      } else {
        out[key] = next;
        i += 1;
      }
    }
  }
  return out;
}

function fail(msg: string): never {
  console.error(`sim: ${msg}`);
  process.exit(1);
}

function findWorkPackage(wps: WorkPackage[], wpId: number): WorkPackage {
  const wp = wps.find((w) => w.id === wpId);
  if (!wp) fail(`work package ${wpId} not found in work_packages.json`);
  return wp;
}

// ── Subcommand: log-time ─────────────────────────────────────────────────────

function logTime(flags: Record<string, string>): void {
  const wpId = Number(flags["wp"]);
  const hours = Number(flags["hours"]);
  if (!Number.isFinite(wpId)) fail("log-time requires --wp <id>");
  if (!Number.isFinite(hours) || hours <= 0) fail("log-time requires --hours <positive number>");
  const spentOn = flags["on"] ?? nowIso().slice(0, 10);
  const userId = Number(flags["user"] ?? "1");
  const commentText = flags["comment"] ?? "";

  const wps = readJson<WorkPackage[]>("work_packages.json");
  const wp = findWorkPackage(wps, wpId);
  const wpTitle = wp._links.self?.title ?? wp.subject ?? `WP ${wpId}`;
  const projectHref = wp._links.project?.href ?? null;
  const projectTitle = wp._links.project?.title;

  const teCol = readJson<Collection<TimeEntry>>("time_entries.json");
  const entries = teCol._embedded.elements;
  const nextId = entries.reduce((max, e) => Math.max(max, e.id), 5000) + 1;
  const ts = nowIso();

  const newEntry: TimeEntry = {
    _type: "TimeEntry",
    id: nextId,
    hours: hoursToIsoDuration(hours) ?? "PT0H",
    spentOn,
    comment: {
      format: "plain",
      raw: commentText,
      html: commentText ? `<p>${commentText}</p>` : "",
    },
    createdAt: ts,
    updatedAt: ts,
    _links: {
      self: { href: `/api/v3/time_entries/${nextId}` },
      workPackage: { href: `/api/v3/work_packages/${wpId}`, title: wpTitle },
      user: { href: `/api/v3/users/${userId}` },
      ...(projectHref ? { project: { href: projectHref, title: projectTitle } } : {}),
    },
  };
  entries.push(newEntry);
  teCol.total = entries.length;
  teCol.count = entries.length;
  writeJson("time_entries.json", teCol);

  // Recompute the WP's spentTime to the cumulative logged hours for this WP.
  const cumulative = entries
    .filter((e) => hrefId(e._links["workPackage"]?.href) === wpId)
    .reduce((sum, e) => sum + (parseIsoDuration(e.hours) ?? 0), 0);
  const cumulativeIso = hoursToIsoDuration(cumulative) ?? "PT0H";
  wp.spentTime = cumulativeIso;
  wp.updatedAt = ts;
  writeJson("work_packages.json", wps);

  console.log(
    `logged ${hours}h on WP ${wpId} ("${wpTitle}") on ${spentOn}; ` +
      `time entry #${nextId}; WP spentTime now ${cumulativeIso}. ` +
      `Run a sync (click "Sync now" or POST /api/sync) to pull it in.`,
  );
}

// ── Subcommand: set-status ───────────────────────────────────────────────────

function setStatus(flags: Record<string, string>): void {
  const wpId = Number(flags["wp"]);
  const statusName = flags["status"];
  if (!Number.isFinite(wpId)) fail("set-status requires --wp <id>");
  if (!statusName || statusName === "true") fail("set-status requires --status <name>");

  const statusCol = readJson<Collection<Status>>("statuses.json");
  const statuses = statusCol._embedded.elements;
  const status = statuses.find(
    (s) => s.name.toLowerCase() === statusName.toLowerCase(),
  );
  if (!status) {
    fail(
      `unknown status "${statusName}". Available: ${statuses.map((s) => s.name).join(", ")}`,
    );
  }

  const wps = readJson<WorkPackage[]>("work_packages.json");
  const wp = findWorkPackage(wps, wpId);
  wp._links.status = {
    href: `/api/v3/statuses/${status.id}`,
    title: status.name,
  };
  wp.updatedAt = nowIso();
  writeJson("work_packages.json", wps);

  console.log(
    `set WP ${wpId} status → "${status.name}" (id ${status.id}, isClosed=${status.isClosed}). ` +
      `Run a sync (click "Sync now" or POST /api/sync) to pull it in.`,
  );
}

// ── Entry point ──────────────────────────────────────────────────────────────

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  switch (cmd) {
    case "log-time":
      logTime(flags);
      break;
    case "set-status":
      setStatus(flags);
      break;
    default:
      console.error(
        "Usage:\n" +
          '  sim log-time  --wp <id> --hours <h> [--on YYYY-MM-DD] [--user <opUserId>] [--comment "text"]\n' +
          '  sim set-status --wp <id> --status <name>',
      );
      process.exit(cmd ? 1 : 0);
  }
}

main();
