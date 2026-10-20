import { mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BurndownResponse,
  ClosedSprintSummary,
  ClosureStatsResponse,
  GeneratePdfResult,
  ReportDetailResponse,
  ReportsListResponse,
  Sprint,
} from "@osp/contracts";
import type { Repositories } from "@osp/db";
import { buildBurndown } from "./burndown";
import { computeClosureStats } from "./closureStats";

/**
 * Increment 14 (SPEC_14 §4) — Reports (closed sprints) + management PDF.
 *
 * ⛔ Every function here is READ-ONLY w.r.t. sprint state (same "View ≠ lock"
 * principle as SPEC_11 §8a) — none touches sprint.status/is_locked/locked_at/
 * lock_reason. The detail + PDF work BACKWARDS from stored data alone (baseline,
 * changelog, snapshots, closure) — NO live OP call — so an old closed sprint
 * still renders. The route streams `application/pdf` bytes; GeneratePdfResult is
 * the on-disk companion (exports/report-<sprint>-<timestamp>.pdf).
 */

function toClosedSprintSummary(s: Sprint): ClosedSprintSummary {
  return {
    sprint_id: s.id,
    name: s.name,
    start_date: s.start_date,
    end_date: s.end_date,
    closed_at: s.closed_at,
  };
}

/** GET /api/reports — closed sprints only, newest-closed first. */
export async function buildReportsList(repos: Repositories): Promise<ReportsListResponse> {
  const closed = await repos.sprints.listByStatus("closed");
  return closed
    .map(toClosedSprintSummary)
    .sort((a, b) => {
      // Newest closed_at first; nulls (shouldn't happen for closed) sort last.
      const at = a.closed_at ?? "";
      const bt = b.closed_at ?? "";
      if (at === bt) return b.sprint_id - a.sprint_id;
      return at < bt ? 1 : -1;
    });
}

async function burndownFor(repos: Repositories, sprint: Sprint): Promise<BurndownResponse> {
  // Same anchor as GET /sprints/:id/burndown: the frozen baseline total once
  // activated, else a live leaf-planned recompute. A closed sprint always has
  // baseline_total_hours; the fallback keeps this safe for any edge row.
  let totalPlanned = sprint.baseline_total_hours;
  if (totalPlanned == null) {
    const items = (await repos.sprintItems.listBySprint(sprint.id)).filter(
      (i) => i.outcome !== "removed" && i.outcome !== "removed_mid_sprint",
    );
    totalPlanned = items.reduce((s, i) => s + (i.planned_hours ?? 0), 0);
  }
  const snapshots = await repos.burndown.listBySprint(sprint.id);
  return buildBurndown(sprint, totalPlanned, snapshots);
}

/** GET /api/reports/:id — {sprint, stats, burndown}, all from stored data. */
export async function buildReportDetail(
  repos: Repositories,
  sprintId: number,
  generatedAt: string,
): Promise<ReportDetailResponse> {
  const sprint = await repos.sprints.getById(sprintId);
  if (!sprint) throw new Error(`Sprint ${sprintId} not found`);
  const [stats, burndown] = await Promise.all([
    computeClosureStats(repos, sprintId, generatedAt),
    burndownFor(repos, sprint),
  ]);
  return { sprint: toClosedSprintSummary(sprint), stats, burndown };
}

// ── HTML report (server-rendered, self-contained, inline SVG charts) ─────────

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
const h1 = (n: number): string => (Math.round(n * 10) / 10).toString();
const pct = (n: number | null): string => (n == null ? "—" : `${Math.round(n)} %`);

/**
 * Increment 16 (SPEC_16 §4) — British date format DD/MM/YYYY, from an ISO
 * date (`YYYY-MM-DD`) or ISO datetime string. A LOCAL copy of the same
 * formatting rule as `apps/web/src/lib/format.ts`'s `formatDate` — this
 * server-side template has no shared module with the client, so it's
 * deliberately re-implemented here rather than imported. Parses the leading
 * YYYY-MM-DD digits directly (never round-trips through `Date`, which would
 * apply the server process's local-timezone offset to a date-only value).
 */
const formatDateGb = (iso: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d] = m;
  return `${d}/${mo}/${y}`;
};

function burndownSvg(bd: BurndownResponse): string {
  const w = 640;
  const hgt = 220;
  const pad = 32;
  const pts = bd.points;
  if (pts.length === 0) return "";
  const maxY = Math.max(bd.total_planned_hours, 1);
  const x = (i: number): number => pad + (i * (w - 2 * pad)) / Math.max(pts.length - 1, 1);
  const y = (v: number): number => hgt - pad - (v / maxY) * (hgt - 2 * pad);
  const ideal = pts.map((p, i) => `${x(i)},${y(p.ideal_hours)}`).join(" ");
  const remaining = pts
    .filter((p) => p.remaining_hours != null)
    .map((p) => `${x(pts.indexOf(p))},${y(p.remaining_hours ?? 0)}`)
    .join(" ");
  return `<svg viewBox="0 0 ${w} ${hgt}" role="img" aria-label="Burndown">
    <line x1="${pad}" y1="${hgt - pad}" x2="${w - pad}" y2="${hgt - pad}" stroke="#cbd5e1"/>
    <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${hgt - pad}" stroke="#cbd5e1"/>
    <polyline fill="none" stroke="#94a3b8" stroke-dasharray="4 4" stroke-width="2" points="${ideal}"/>
    <polyline fill="none" stroke="#2563eb" stroke-width="2.5" points="${remaining}"/>
  </svg>`;
}

function devBarSvg(stats: ClosureStatsResponse): string {
  const rows = stats.per_developer;
  if (rows.length === 0) return "<p>No developers.</p>";
  const maxV = Math.max(1, ...rows.map((r) => Math.max(r.planned_hours, r.logged_hours)));
  const barW = 300;
  // Increment 30 — `Planned` is CURRENT SCOPE and `Baseline` is the retained
  // baseline it used to mean (`CAPACITY_BAR_RULES.md` §5). Both are shown, both
  // read straight off the shared DTO, and the Planned column sums to the
  // "Planned" KPI above it (invariant 8).
  return `<table class="bars"><thead><tr><th>Developer</th><th>Planned</th><th>Baseline</th><th>Logged</th><th>Effectivity</th></tr></thead><tbody>${rows
    .map(
      (r) => `<tr><td>${esc(r.name)}</td>
      <td><span class="bar plan" style="width:${(r.planned_hours / maxV) * barW}px"></span>${h1(r.planned_hours)} h</td>
      <td>${h1(r.baseline_hours)} h</td>
      <td><span class="bar log" style="width:${(r.logged_hours / maxV) * barW}px"></span>${h1(r.logged_hours)} h</td>
      <td>${pct(r.accuracy_pct)}</td></tr>`,
    )
    .join("")}</tbody></table>`;
}

/**
 * Increment 33 (INCREMENT_33_CONTRACTS.md §2) — "Outside the sprint": the
 * off_sprint block folded into ClosureStatsResponse by computeClosureStats.
 * Read-only render of already-aggregated data (no re-aggregation here, per
 * §2 — "keep shapes mirroring §1"). Renders nothing when there is no
 * off-sprint time at all, same empty-state rule as the Capacity panel's
 * Increment-32 section (INCREMENT_32_CONTRACTS.md §5).
 */
function offSprintSection(stats: ClosureStatsResponse): string {
  const off = stats.off_sprint;
  if (off.total_hours === 0) return "";
  const sharePctStr = off.share_pct == null ? "—" : `${Math.round(off.share_pct)} %`;
  return `<h2>Outside the sprint</h2>
  <p>${sharePctStr} of developer time in the sprint's calendar window went to tickets
  outside the sprint — ${h1(off.total_hours)} h of ${h1(off.total_hours + off.sprint_logged_hours)} h total.</p>
  <table><thead><tr><th>Developer</th><th>Hours</th><th>Share</th><th>Tickets</th></tr></thead><tbody>
  ${off.per_person
    .map(
      (p) => `<tr><td>${esc(p.name)}</td><td>${h1(p.total_hours)} h</td>
      <td>${p.share_pct == null ? "—" : `${Math.round(p.share_pct)} %`}</td>
      <td>${p.tickets
        .map((t) => `#${t.wp_op_id} ${esc(t.subject ?? "")} — ${h1(t.hours)} h`)
        .join(", ")}</td></tr>`,
    )
    .join("")}
  </tbody></table>`;
}

/**
 * Increment 35 (docs/INCREMENT_35_CONTRACTS.md §3; CAPACITY_BAR_RULES §5c) —
 * a small two-slice donut of the scope-origin split (baseline green / added
 * red, matching `doneRatioSvg`'s palette). Prefers the DEV-LOGGED split (the
 * "reality" axis); falls back to the ESTIMATE split only when no developer
 * time has been logged on either side yet (0/0); renders nothing when BOTH
 * axes are empty (a sprint with no included items at all).
 */
function scopeOriginDonutSvg(so: ClosureStatsResponse["scope_origin"]): string {
  const loggedTotal = so.baseline.dev_logged_hours + so.added.dev_logged_hours;
  const estTotal = so.baseline.estimate_hours + so.added.estimate_hours;
  let addedPct: number;
  if (loggedTotal > 0) addedPct = (so.added.dev_logged_hours / loggedTotal) * 100;
  else if (estTotal > 0) addedPct = (so.added.estimate_hours / estTotal) * 100;
  else return "";
  const r = 40;
  const circumference = 2 * Math.PI * r;
  const addedLen = (addedPct / 100) * circumference;
  const baselineLen = circumference - addedLen;
  return `<svg viewBox="0 0 120 120" width="120" height="120" role="img" aria-label="Scope origin split">
    <circle cx="60" cy="60" r="${r}" fill="none" stroke="#16a34a" stroke-width="16"
      stroke-dasharray="${baselineLen} ${circumference}" transform="rotate(-90 60 60)"/>
    <circle cx="60" cy="60" r="${r}" fill="none" stroke="#dc2626" stroke-width="16"
      stroke-dasharray="${addedLen} ${circumference}" stroke-dashoffset="${-baselineLen}" transform="rotate(-90 60 60)"/>
    <text x="60" y="65" text-anchor="middle" font-size="16" fill="#0f172a">${Math.round(addedPct)}%</text>
  </svg>`;
}

/**
 * Increment 35 (docs/INCREMENT_35_CONTRACTS.md §3; CAPACITY_BAR_RULES §5c) —
 * "Scope origin": planned-before-activation (`baseline`) vs added-during-the-
 * sprint (`added_mid_sprint` | `added_retroactively`), read straight off the
 * already-computed `stats.scope_origin` block (no re-aggregation here, same
 * posture as `offSprintSection`). Renders nothing when the sprint has no
 * included item at all (mirrors the off-sprint section's empty-state rule).
 */
function scopeOriginSection(stats: ClosureStatsResponse): string {
  const so = stats.scope_origin;
  const totalTickets = so.baseline.ticket_count + so.added.ticket_count;
  if (totalTickets === 0) return "";
  const headlineTail =
    so.added_logged_share_pct == null
      ? "no developer time logged yet"
      : `${Math.round(so.added_logged_share_pct)} % of developer time`;
  const baselineSharePctStr =
    so.added_logged_share_pct == null ? "—" : `${Math.round(100 - so.added_logged_share_pct)} %`;
  const donut = scopeOriginDonutSvg(so);
  return `<h2>Scope origin</h2>
  <p>Added during sprint: ${so.added.ticket_count} ticket${so.added.ticket_count === 1 ? "" : "s"}, ${h1(so.added.dev_logged_hours)} h logged — ${headlineTail}.</p>
  ${donut}
  <table><thead><tr><th></th><th>Tickets</th><th>Estimated</th><th>Dev logged</th><th>Share</th></tr></thead><tbody>
  <tr><td>Planned before activation</td><td>${so.baseline.ticket_count}</td>
  <td>${h1(so.baseline.estimate_hours)} h</td><td>${h1(so.baseline.dev_logged_hours)} h</td>
  <td>${baselineSharePctStr}</td></tr>
  <tr><td>Added during sprint</td><td>${so.added.ticket_count}</td>
  <td>${h1(so.added.estimate_hours)} h</td><td>${h1(so.added.dev_logged_hours)} h</td>
  <td>${pct(so.added_logged_share_pct)}</td></tr>
  </tbody></table>`;
}

function doneRatioSvg(stats: ClosureStatsResponse): string {
  const d = stats.done.count;
  const nd = stats.not_done.count;
  const rj = stats.rejected.count;
  const am = stats.ambiguous.count;
  const total = Math.max(1, d + nd + rj + am);
  const w = 480;
  const seg = (n: number, color: string, x: number): string =>
    n === 0 ? "" : `<rect x="${x}" y="0" width="${(n / total) * w}" height="24" fill="${color}"/>`;
  let acc = 0;
  const parts: string[] = [];
  for (const [n, c] of [
    [d, "#16a34a"],
    [nd, "#dc2626"],
    [rj, "#6b7280"],
    [am, "#f59e0b"],
  ] as const) {
    parts.push(seg(n, c, acc));
    acc += (n / total) * w;
  }
  return `<svg viewBox="0 0 ${w} 24" width="${w}" height="24" role="img" aria-label="Done ratio">${parts.join("")}</svg>
    <p class="legend"><span style="color:#16a34a">■</span> Done ${d}
    <span style="color:#dc2626">■</span> Not done ${nd}
    <span style="color:#6b7280">■</span> Rejected ${rj}
    <span style="color:#f59e0b">■</span> Ambiguous ${am}</p>`;
}

export function renderReportHtml(detail: ReportDetailResponse): string {
  const { sprint, stats, burndown } = detail;
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"/>
<title>OpalTakt — Report — ${esc(sprint.name)}</title>
<style>
  body{font:14px/1.5 -apple-system,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;margin:32px;}
  .brand{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#475569;margin:0 0 14px;padding-bottom:8px;border-bottom:2px solid #0f172a;}
  .foot{margin-top:32px;padding-top:8px;border-top:1px solid #e2e8f0;color:#64748b;font-size:11px;}
  h1{font-size:22px;margin:0 0 4px;} h2{font-size:16px;margin:24px 0 8px;border-bottom:1px solid #e2e8f0;padding-bottom:4px;}
  .sub{color:#64748b;margin:0 0 16px;}
  .kpis{display:flex;gap:16px;flex-wrap:wrap;margin:8px 0;}
  .kpi{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px;min-width:120px;}
  .kpi .v{font-size:20px;font-weight:600;} .kpi .l{color:#64748b;font-size:12px;}
  table{border-collapse:collapse;width:100%;font-size:13px;} th,td{text-align:left;padding:4px 8px;border-bottom:1px solid #eef2f7;}
  .bar{display:inline-block;height:10px;border-radius:3px;margin-right:6px;vertical-align:middle;}
  .bar.plan{background:#94a3b8;} .bar.log{background:#2563eb;}
  .legend span{margin-right:4px;} .flag{color:#dc2626;font-weight:600;}
</style></head><body>
  <p class="brand">OpalTakt · Sprint report</p>
  <h1>${esc(sprint.name)}</h1>
  <p class="sub">${formatDateGb(sprint.start_date)} – ${formatDateGb(sprint.end_date)}${
    sprint.closed_at ? ` · closed ${formatDateGb(sprint.closed_at)}` : ""
  }</p>
  <div class="kpis">
    <div class="kpi"><div class="v">${h1(stats.total_planned_hours)} h</div><div class="l">Planned</div></div>
    <div class="kpi"><div class="v">${h1(stats.total_baseline_hours)} h</div><div class="l">Baseline</div></div>
    <div class="kpi"><div class="v">${h1(stats.total_delivered_hours)} h</div><div class="l">Delivered</div></div>
    <div class="kpi"><div class="v">${h1(stats.total_logged_hours)} h</div><div class="l">Logged</div></div>
    <div class="kpi"><div class="v">${h1(stats.dev_logged_hours)} h</div><div class="l">Logged (Developers)</div></div>
    <div class="kpi"><div class="v">${pct(stats.estimate_accuracy_pct)}</div><div class="l">Estimate effectivity</div></div>
    <div class="kpi"><div class="v">${h1(stats.overshoot_hours)} h</div><div class="l">Overshoot</div></div>
  </div>
  <h2>Done / not done / rejected</h2>
  ${doneRatioSvg(stats)}
  <h2>Burndown</h2>
  ${burndownSvg(burndown)}
  <h2>Breakdown per developer</h2>
  ${devBarSvg(stats)}
  <h2>Per ticket</h2>
  <table><thead><tr><th>#</th><th>Subject</th><th>Sprint</th><th>Bucket</th><th>Estimate</th><th>Dev logged</th><th>Total logged</th><th>Delta</th></tr></thead><tbody>
  ${stats.per_ticket
    .map(
      (t) => `<tr><td>${t.wp_op_id}</td><td>${esc(t.subject)}</td><td>${
        // Increment 34 (docs/INCREMENT_34_CONTRACTS.md §3) — the "sprint 2/3"
        // multi-sprint badge; single-sprint tickets (the vast majority) show
        // an em dash, unchanged from before this increment.
        t.multi_sprint == null ? "—" : `sprint ${t.multi_sprint.sequence}/${t.multi_sprint.total}`
      }</td><td>${t.bucket}</td>
      <td>${t.estimate_hours == null ? "—" : h1(t.estimate_hours) + " h"}</td>
      <td>${h1(t.dev_logged_hours)} h</td><td>${h1(t.total_logged_hours)} h</td>
      <td class="${t.overshoot_flag ? "flag" : ""}">${
        t.delta_hours == null ? "—" : (t.delta_hours >= 0 ? "+" : "") + h1(t.delta_hours) + " h"
      }${t.overshoot_flag ? " ⚑" : ""}</td></tr>`,
    )
    .join("")}
  </tbody></table>
  ${
    stats.anomalies.length > 0
      ? `<h2>Anomalies</h2><ul>${stats.anomalies
          .map((a) => `<li>#${a.wp_op_id} ${esc(a.subject)} — ${a.anomaly}</li>`)
          .join("")}</ul>`
      : ""
  }
  ${scopeOriginSection(stats)}
  ${offSprintSection(stats)}
  <p class="foot">Generated by OpalTakt</p>
</body></html>`;
}

// ── PDF generation ───────────────────────────────────────────────────────────

/** Injectable so unit tests never launch a real browser; the route uses the
 * default (headless Chromium via Playwright — already a repo dependency). */
export type PdfRenderer = (html: string) => Promise<Buffer>;

export const chromiumPdfRenderer: PdfRenderer = async (html) => {
  // Dynamic import so a machine without the browser binary only fails when a PDF
  // is actually requested, not at module load / for every other route.
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });
    return await page.pdf({ format: "A4", printBackground: true, margin: { top: "16mm", bottom: "16mm" } });
  } finally {
    await browser.close();
  }
};

export interface GeneratePdfDeps {
  generatedAt: string;
  /** Timestamp for the filename (safe chars only). Defaults from generatedAt. */
  stamp?: string;
  exportsDir?: string;
  renderPdf?: PdfRenderer;
  writeFile?: (path: string, data: Buffer) => Promise<void>;
  mkdir?: (dir: string) => Promise<void>;
}

const slug = (s: string): string =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "sprint";

/** Repo root, resolved from THIS file's location (independent of cwd) — matches
 * sprintExport.ts so both the pre-delete JSON and report PDFs land in the SAME
 * repo-root/exports (which is .gitignored). */
function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

/**
 * Build the report PDF for a sprint, write it to exports/report-<sprint>-<ts>.pdf
 * AND return the bytes so the route can stream the very same content. READ-ONLY:
 * touches no sprint state.
 */
export async function generateReportPdf(
  repos: Repositories,
  sprintId: number,
  deps: GeneratePdfDeps,
): Promise<GeneratePdfResult & { bytes: Buffer }> {
  const detail = await buildReportDetail(repos, sprintId, deps.generatedAt);
  const html = renderReportHtml(detail);
  const render = deps.renderPdf ?? chromiumPdfRenderer;
  const bytes = await render(html);

  const stamp = (deps.stamp ?? deps.generatedAt).replace(/[:.]/g, "-");
  const exportsDir = deps.exportsDir ?? join(repoRoot(), "exports");
  const filePath = join(exportsDir, `report-${slug(detail.sprint.name)}-${stamp}.pdf`);
  const mkdir = deps.mkdir ?? ((dir: string) => fsMkdir(dir, { recursive: true }).then(() => {}));
  const writeFile = deps.writeFile ?? ((p: string, d: Buffer) => fsWriteFile(p, d));
  await mkdir(dirname(filePath));
  await writeFile(filePath, bytes);

  return { file_path: filePath, generated_at: deps.generatedAt, bytes };
}
