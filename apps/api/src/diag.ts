import { openDb } from "@osp/db";
import type {
  CapacityResponse,
  ClosureStatsResponse,
  DeveloperCapacityBreakdown,
} from "@osp/contracts";
import { buildApp } from "./app";
import { resolveDeps } from "./deps";
import { buildPersonResolver } from "./logic/personResolver";

/**
 * `pnpm diag -- --sprint <id>` — READ-ONLY cross-surface consistency report
 * (HANDOFF Fáze 3: "ať se příště neladí přes screenshoty").
 *
 * For one sprint it fetches `/api/sprints/:id/capacity` and `/closure-stats`
 * through the REAL routes (an in-process `app.inject` — no port, no server),
 * sums the raw `sprint_item.planned_hours` snapshots per person, and prints a
 * per-person comparison table plus identity diagnostics:
 *   • ⚠️ rows where /capacity and /closure-stats disagree on planned or where
 *     a person's logged hours have no closure row;
 *   • duplicate identities (the same name appearing more than once on either
 *     surface — the exact defect the identity golden tests pin);
 *   • people who logged time in the sprint but have NO per-developer row.
 *
 * READ-ONLY BY CONSTRUCTION: only `buildApp` (which performs no boot-time
 * writes — orphan-run recovery lives in `buildServer`, not here) and GET
 * routes are used; nothing is inserted, updated or deleted. Safe to point at
 * the production database for diagnostics — which is also why `DATABASE_URL`
 * must still be EXPLICIT: there is deliberately no default (the Increment-12
 * guardrail), so the operator always states which database they are reading.
 *
 * Usage:
 *   DATABASE_URL=postgres://user@localhost:5432/osp pnpm diag -- --sprint 4
 */

function argValue(name: string): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === `--${name}`) return argv[i + 1];
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return undefined;
}

const fmt = (n: number | null | undefined): string =>
  n == null ? "—" : `${Math.round(n * 10) / 10}h`;

const eq = (a: number | null | undefined, b: number | null | undefined): boolean =>
  Math.abs((a ?? 0) - (b ?? 0)) < 0.05;

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(
      "DATABASE_URL is required (no default, by design — the Increment-12 guardrail).\n" +
        "Example: DATABASE_URL=postgres://user@localhost:5432/osp pnpm diag -- --sprint 4",
    );
    process.exit(2);
  }
  const sprintArg = argValue("sprint");
  const sprintId = sprintArg == null ? Number.NaN : Number(sprintArg);
  if (!Number.isInteger(sprintId)) {
    console.error("Usage: pnpm diag -- --sprint <id>");
    process.exit(2);
  }

  // Keep the report readable — the app's request logging is noise here.
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "silent";
  const handle = await openDb({ url: databaseUrl });
  const repos = handle.repositories;
  const deps = resolveDeps({ repos, db: handle.db });
  // In-process, local CLI — no HTTP surface, so no sign-in (Increment 39).
  const app = await buildApp(deps, { auth: { config: { mode: "none" } } });
  await app.ready();

  try {
    const sprint = await repos.sprints.getById(sprintId);
    if (!sprint) {
      console.error(`Sprint ${sprintId} not found.`);
      process.exit(2);
    }
    console.log(`\n=== diag — sprint ${sprintId} "${sprint.name}" (${sprint.status}) ===\n`);

    const capRes = await app.inject({ method: "GET", url: `/api/sprints/${sprintId}/capacity` });
    const cloRes = await app.inject({
      method: "GET",
      url: `/api/sprints/${sprintId}/closure-stats`,
    });
    if (capRes.statusCode !== 200 || cloRes.statusCode !== 200) {
      console.error(
        `Route error: capacity ${capRes.statusCode}, closure-stats ${cloRes.statusCode}`,
      );
      process.exit(2);
    }
    const cap = capRes.json() as CapacityResponse;
    const closure = cloRes.json() as ClosureStatsResponse;

    // Σ raw sprint_item.planned_hours snapshots, folded per canonical person.
    // NOTE: this is the ADD-TIME snapshot — it legitimately differs from the
    // live `effectiveEstimate` the two surfaces use (Increment 28), so it is
    // a third reference column, not a must-match figure.
    const items = (await repos.sprintItems.listBySprint(sprintId)).filter(
      (i) => i.outcome !== "removed" && i.outcome !== "removed_mid_sprint",
    );
    const wps = await repos.workPackages.getManyByOpIds(items.map((i) => i.wp_op_id));
    const wpById = new Map(wps.map((w) => [w.op_id, w]));
    const resolver = await buildPersonResolver(repos, { wps });
    const snapshotByName = new Map<string, number>();
    for (const it of items) {
      const wp = wpById.get(it.wp_op_id);
      const person = resolver.resolve(
        wp?.connection_id ?? null,
        wp?.assignee_op_id ?? null,
        wp?.assignee_name ?? null,
      );
      const label = person?.name ?? "(unassigned)";
      snapshotByName.set(label, (snapshotByName.get(label) ?? 0) + (it.planned_hours ?? 0));
    }

    // People who logged time in this sprint (canonical fold), for the
    // "logged but missing" check — role-aware: an EXPLICIT tester/customer/
    // other correctly has no per-developer row, so only an (effective)
    // developer without one is an inconsistency.
    const changelog = await repos.ticketChangelog.listBySprint(sprintId);
    const loggedByName = new Map<string, number>();
    const roleByName = new Map<string, string>();
    for (const e of changelog) {
      if (e.kind !== "time_logged") continue;
      const detail = JSON.parse(e.detail_json) as {
        kind?: string;
        hours?: number | null;
        spent_on?: string | null;
      };
      if (detail.kind !== "time_logged") continue;
      // FOLLOWUPS #8: the raw column applies the SAME calendar window
      // [start_date, end_date] closure-stats reads by — otherwise rows stored
      // under the older, wider windows (pre-start replay rows, next-sprint
      // work vacuumed by a pre-fix grace update) show as phantom mismatches.
      const spentOn = detail.spent_on ?? null;
      if (spentOn != null && (spentOn < sprint.start_date || spentOn > sprint.end_date)) continue;
      const hours = detail.hours ?? 0;
      if (hours === 0) continue;
      const person = resolver.resolve(
        wpById.get(e.wp_op_id)?.connection_id ?? null,
        e.actor_op_id,
        e.actor_name,
      );
      const label = person?.name ?? e.actor_name ?? "(unknown)";
      loggedByName.set(label, (loggedByName.get(label) ?? 0) + hours);
      if (person) roleByName.set(label, person.role);
    }
    for (const line of cap.lines) roleByName.set(line.name, line.role);

    const perDevByName = new Map<string, DeveloperCapacityBreakdown[]>();
    for (const d of closure.per_developer) {
      const arr = perDevByName.get(d.name) ?? [];
      arr.push(d);
      perDevByName.set(d.name, arr);
    }

    let warnings = 0;
    const warn = (msg: string): void => {
      warnings += 1;
      console.log(`  ⚠️  ${msg}`);
    };

    // ── Per-person comparison table ──────────────────────────────────────────
    console.log("person                                 | /capacity | Σ item snapshot | /closure-stats | logged (closure / raw)");
    console.log("---------------------------------------+-----------+-----------------+----------------+-----------------------");
    const names = new Set<string>([
      ...cap.lines.filter((l) => l.op_user_id != null || l.member_id != null).map((l) => l.name),
      ...closure.per_developer.map((d) => d.name),
      ...loggedByName.keys(),
    ]);
    for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
      const line = cap.lines.find((l) => l.name === name);
      const rows = perDevByName.get(name) ?? [];
      const row = rows[0];
      const rawLogged = loggedByName.get(name);
      const mismatch =
        (line != null && row != null && !eq(line.planned_hours, row.planned_hours)) ||
        (row != null && rawLogged != null && !eq(row.logged_hours, rawLogged));
      const role = roleByName.get(name);
      const roleTag = role != null && role !== "developer" ? ` (${role})` : "";
      console.log(
        `${(mismatch ? "⚠️ " : "   ") + `${name}${roleTag}`.padEnd(36)}| ${fmt(line?.planned_hours).padStart(9)} | ${fmt(
          snapshotByName.get(name),
        ).padStart(15)} | ${fmt(row?.planned_hours).padStart(14)} | ${fmt(row?.logged_hours)} / ${fmt(rawLogged)}`,
      );
      if (mismatch) warnings += 1;
    }
    console.log("");

    // ── Identity diagnostics ─────────────────────────────────────────────────
    for (const [name, rows] of perDevByName) {
      if (rows.length > 1) {
        warn(`duplicate identity in /closure-stats per_developer: "${name}" appears ${rows.length}×`);
      }
    }
    const lineNames = cap.lines.map((l) => l.name);
    for (const name of new Set(lineNames)) {
      const count = lineNames.filter((n) => n === name).length;
      if (count > 1) warn(`duplicate identity in /capacity lines: "${name}" appears ${count}×`);
    }
    for (const [name, hours] of loggedByName) {
      if (perDevByName.has(name)) continue;
      const role = roleByName.get(name);
      if (role != null && role !== "developer" && role !== "unset") {
        // Explicit tester/customer/other — correctly not a per-developer row;
        // their time is still in total_logged. Informational only.
        console.log(`  ℹ️  "${name}" (${role}) logged ${fmt(hours)} — non-developer, not a per-developer row by design`);
        continue;
      }
      warn(`"${name}" logged ${fmt(hours)} in this sprint but has NO per-developer row`);
    }

    // ── Header cross-check (CAPACITY_BAR_RULES §6 invariants 5 + 8) ──────────
    if (!eq(cap.scope_planned_hours, closure.total_planned_hours)) {
      warn(
        `header mismatch: capacity.scope_planned_hours ${fmt(cap.scope_planned_hours)} ≠ closure.total_planned_hours ${fmt(closure.total_planned_hours)}`,
      );
    }
    const devLineSum = cap.lines
      .filter((l) => l.is_developer)
      .reduce((s, l) => s + l.planned_hours, 0);
    if (!eq(cap.scope_planned_hours, devLineSum)) {
      warn(
        `invariant 8: header ${fmt(cap.scope_planned_hours)} ≠ Σ developer lines ${fmt(devLineSum)}`,
      );
    }

    console.log(
      warnings === 0
        ? "✅ no inconsistencies found — every surface agrees.\n"
        : `\n${warnings} warning(s) — see ⚠️ lines above.\n`,
    );
  } finally {
    await app.close();
    await handle.close();
  }
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(2);
});
