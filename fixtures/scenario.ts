/**
 * fixtures/scenario.ts — operator CLI for the stateful scenario mock
 * (SPEC_03 §6). Talks ONLY to the mock's admin API under /__mock/* — never to
 * the OP namespace, so the app's GET-only guarantee towards /api/v3/* is
 * untouched (this is operator tooling, not OpenProject).
 *
 * Usage (via pnpm --filter @osp/fixtures …):
 *   scenario list                                        # available scenarios
 *   scenario load <name>                                 # reset to day 0 of <name>
 *   scenario state                                       # current day + WP table
 *   scenario day [--app <url>] [--no-sync] [--no-snapshot]
 *                                                        # advance one day; with --app the
 *                                                        # mock also calls the Sprint
 *                                                        # Planner's sync/snapshot
 *   scenario goto <n>                                    # fast-forward to day n
 *   scenario urgent                                      # inject the urgent WP template
 *   scenario reset                                       # back to legacy fixture mode
 *
 * Env: MOCK_OP_URL (default http://127.0.0.1:8099)
 *
 * Dependency-free (Node built-ins + global fetch), run via tsx. The command
 * implementations are exported so tests can drive them in-process; the argv
 * entry point only fires when the file is executed directly.
 */
import { pathToFileURL } from "node:url";
import type {
  AdvanceDayRequest,
  AdvanceDayResult,
  AppHelperResult,
  MockStateSummary,
  ScenarioSummary,
  WorkPackageStateSummary,
} from "./scenario-types";

export const DEFAULT_MOCK_URL = "http://127.0.0.1:8099";

/** Output sink — console in real runs, capture arrays in tests. */
export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

/** A user-facing failure (HTTP error, bad args, unreachable mock). */
export class CliError extends Error {}

// ── HTTP helper ──────────────────────────────────────────────────────────────

async function request<T>(
  baseUrl: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const url = new URL(path, baseUrl);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      ...(body !== undefined
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    });
  } catch (e) {
    const detail = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e);
    throw new CliError(`cannot reach mock at ${baseUrl} (${detail}) — is it running?`);
  }
  const text = await res.text();
  if (!res.ok) {
    const detail = text.trim().slice(0, 300);
    throw new CliError(`HTTP ${res.status} ${method} ${path}${detail ? `: ${detail}` : ""}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderTable(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const line = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)];
}

function hours(value: number | null): string {
  return value === null ? "-" : `${value}h`;
}

function wpRow(wp: WorkPackageStateSummary): string[] {
  const subject = wp.subject.length > 44 ? `${wp.subject.slice(0, 43)}…` : wp.subject;
  return [
    String(wp.id),
    subject,
    wp.status,
    wp.assignee ?? "-",
    wp.accountable ?? "-",
    hours(wp.estimated_hours),
    hours(wp.remaining_hours),
    `${wp.spent_hours}h`,
    wp.version ?? "-",
    wp.updated_at,
  ];
}

function renderState(state: MockStateSummary, io: CliIo): void {
  if (state.scenario === null) {
    io.out("mode: fixtures (no scenario loaded — legacy static mock)");
    return;
  }
  io.out(`scenario: ${state.scenario}`);
  io.out(
    `day: ${state.day}/${state.total_days}  date: ${state.date ?? "-"}  ` +
      `pending days: ${state.pending_days}`,
  );
  const headers = ["id", "subject", "status", "assignee", "accountable", "est", "rem", "spent", "version", "updated"];
  for (const line of renderTable(headers, state.work_packages.map(wpRow))) io.out(line);
}

function renderHelper(kind: "sync" | "snapshot", result: AppHelperResult | undefined, io: CliIo): void {
  if (!result) return;
  if (result.ok) io.out(`  ${kind}: OK${result.detail ? ` (${result.detail})` : ""}`);
  else io.err(`  ${kind}: FAILED — ${result.detail ?? "unknown error"}`);
}

// ── Commands (exported for in-process tests) ─────────────────────────────────

export async function cmdList(baseUrl: string, io: CliIo): Promise<void> {
  const list = await request<ScenarioSummary[]>(baseUrl, "GET", "/__mock/scenarios");
  const rows = list.map((s) => [s.name, s.start_date, String(s.total_days), s.description]);
  for (const line of renderTable(["name", "start", "days", "description"], rows)) io.out(line);
}

export async function cmdLoad(baseUrl: string, name: string, io: CliIo): Promise<void> {
  const state = await request<MockStateSummary>(baseUrl, "POST", `/__mock/load/${encodeURIComponent(name)}`);
  io.out(`loaded "${name}" at day 0`);
  renderState(state, io);
}

export async function cmdState(baseUrl: string, io: CliIo): Promise<void> {
  renderState(await request<MockStateSummary>(baseUrl, "GET", "/__mock/state"), io);
}

export interface DayOptions {
  app?: string;
  sync: boolean;
  snapshot: boolean;
}

export async function cmdDay(baseUrl: string, opts: DayOptions, io: CliIo): Promise<void> {
  const body: AdvanceDayRequest = opts.app
    ? { app_url: opts.app, sync: opts.sync, snapshot: opts.snapshot }
    : {};
  const result = await request<AdvanceDayResult>(baseUrl, "POST", "/__mock/advance-day", body);
  io.out(`advanced to day ${result.day} (${result.date}), applied ${result.applied_events} event(s)`);
  renderHelper("sync", result.app?.sync, io);
  renderHelper("snapshot", result.app?.snapshot, io);
}

export async function cmdGoto(baseUrl: string, day: number, io: CliIo): Promise<void> {
  const state = await request<MockStateSummary>(baseUrl, "POST", `/__mock/goto-day/${day}`);
  renderState(state, io);
}

export async function cmdUrgent(baseUrl: string, io: CliIo): Promise<void> {
  const result = await request<{ work_package: WorkPackageStateSummary }>(
    baseUrl,
    "POST",
    "/__mock/inject-urgent",
  );
  const wp = result.work_package;
  io.out(`injected urgent WP #${wp.id} "${wp.subject}" (status ${wp.status}, assignee ${wp.assignee ?? "-"})`);
}

export async function cmdReset(baseUrl: string, io: CliIo): Promise<void> {
  await request<{ mode: string }>(baseUrl, "POST", "/__mock/reset");
  io.out("mock reset to fixture mode (legacy static data)");
}

// ── Argv entry ───────────────────────────────────────────────────────────────

const USAGE = [
  "Usage:",
  "  scenario list",
  "  scenario load <name>",
  "  scenario state",
  "  scenario day [--app <url>] [--no-sync] [--no-snapshot]",
  "  scenario goto <n>",
  "  scenario urgent",
  "  scenario reset",
  "Env: MOCK_OP_URL (default http://127.0.0.1:8099)",
].join("\n");

/** Runs one CLI invocation; returns the process exit code. */
export async function run(argv: string[], baseUrl: string, io: CliIo): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "list":
        await cmdList(baseUrl, io);
        return 0;
      case "load": {
        const name = rest[0];
        if (!name) throw new CliError("load requires a scenario name (see: scenario list)");
        await cmdLoad(baseUrl, name, io);
        return 0;
      }
      case "state":
        await cmdState(baseUrl, io);
        return 0;
      case "day": {
        const opts: DayOptions = { sync: true, snapshot: true };
        for (let i = 0; i < rest.length; i += 1) {
          const flag = rest[i];
          if (flag === "--app") {
            const value = rest[i + 1];
            if (!value || value.startsWith("--")) throw new CliError("--app requires a URL");
            opts.app = value;
            i += 1;
          } else if (flag === "--no-sync") opts.sync = false;
          else if (flag === "--no-snapshot") opts.snapshot = false;
          else throw new CliError(`unknown flag "${flag}" for day`);
        }
        await cmdDay(baseUrl, opts, io);
        return 0;
      }
      case "goto": {
        const day = Number(rest[0]);
        if (!Number.isInteger(day) || day < 0) throw new CliError("goto requires a non-negative day number");
        await cmdGoto(baseUrl, day, io);
        return 0;
      }
      case "urgent":
        await cmdUrgent(baseUrl, io);
        return 0;
      case "reset":
        await cmdReset(baseUrl, io);
        return 0;
      case undefined:
      case "help":
      case "--help":
        io.out(USAGE);
        return cmd ? 0 : 1;
      default:
        io.err(`scenario: unknown command "${cmd}"`);
        io.err(USAGE);
        return 1;
    }
  } catch (e) {
    if (e instanceof CliError) {
      io.err(`scenario: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

// Entry-point guard: only run when executed directly (tsx scenario.ts …),
// never when imported by tests.
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const baseUrl = process.env["MOCK_OP_URL"] ?? DEFAULT_MOCK_URL;
  run(process.argv.slice(2), baseUrl, { out: console.log, err: console.error })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      console.error(`scenario: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    });
}
