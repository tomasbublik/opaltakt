import { mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CapacityResponse,
  ClosureStatsResponse,
  GeneratePdfResult,
  Sprint,
  SprintItemsDetailedResponse,
} from "@osp/contracts";
import type { Repositories } from "@osp/db";
import { AppError } from "../errors";
import { computeClosureStats } from "./closureStats";
import { computeSprintCapacity, localOnlyCapacityDeps } from "./capacitySummary";
import { buildSprintItemsDetailed } from "./sprintItemsDetailed";
import { PDF_PROJECT_CSS, planPdfProjects, type PdfProjectLayout } from "./pdfProjects";
import { type GeneratePdfDeps, type PdfRenderer, chromiumPdfRenderer } from "./report";

/**
 * Increment 36 (docs/INCREMENT_36_CONTRACTS.md §2; CAPACITY_BAR_RULES §6
 * invariant 5) — the sprint STATUS PDF: unlike `report.ts` (closed sprints
 * only, from FROZEN/stored closure data), this renders for a sprint in ANY
 * state — planning, active, or closed/frozen — the whole point being "generate
 * at any moment and send it to delivery managers" (user request, 2026-08-27).
 *
 * ⛔ REUSE, never recompute (the binding rule this file exists to prove):
 *  - the summary stats come from `computeClosureStats` — the SAME function
 *    `GET /sprints/:id/closure-stats` and `report.ts` use;
 *  - the capacity table comes from `computeSprintCapacity` (extracted out of
 *    `routes/index.ts`'s `buildCapacityResponse` in this same increment) — the
 *    SAME computation `GET /sprints/:id/capacity` uses, byte-identical (the
 *    pre-existing route tests, left unedited, are the proof);
 *  - the ticket table comes from `buildSprintItemsDetailed` (likewise
 *    extracted) — the SAME assembly `GET /sprints/:id/items/detailed` serves,
 *    so frozen/dimming/origin logic is never reimplemented here.
 *
 * This increment needs NO live OpenProject call (§0 pillar 1) — the capacity
 * computation is given `localOnlyCapacityDeps` (tryOpClient → null,
 * buildClientForConnection → always rejects), the exact same degraded-but-safe
 * path the route itself already takes under a locked vault or disabled
 * connection. Numbers are unaffected for the overwhelming common case (local
 * names are always seeded first); only a name resolvable SOLELY via a live
 * `op.getUser` round-trip — already a rare corner even on the live route —
 * could differ, and even then degrades to `unknownUserLabel`, never a crash.
 */

// ── small HTML helpers, mirroring report.ts's (not exported there, so a
//    local copy — same posture as sprintExport.ts's own local `slugify`). ──

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
const h1 = (n: number | null): string => (n == null ? "—" : (Math.round(n * 10) / 10).toString());

/** British date format DD/MM/YYYY — see report.ts's `formatDateGb` for the
 * identical rationale (never round-trips through `Date`, avoids TZ drift). */
const formatDateGb = (iso: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d] = m;
  return `${d}/${mo}/${y}`;
};

/**
 * State badge (contract §1): Planning / Active / Finished / Finished &
 * frozen. "Finished" reads better on a delivery-manager-facing document than
 * the internal `status: "closed"` value; frozen (Increment 31) is called out
 * separately since a frozen sprint's numbers are immutable snapshots.
 */
function stateBadge(sprint: Sprint): string {
  if (sprint.status === "planning") return "Planning";
  if (sprint.status === "active") return "Active";
  return sprint.frozen_at != null ? "Finished & frozen" : "Finished";
}

function capacityTableHtml(capacity: CapacityResponse): string {
  if (capacity.lines.length === 0) return "<p>No capacity lines.</p>";
  return `<table><thead><tr><th>Name</th><th>Role</th><th>Available</th><th>Planned</th><th>Sprint work</th></tr></thead><tbody>
  ${capacity.lines
    .map(
      (l) => `<tr><td>${esc(l.name)}</td><td>${esc(l.role)}</td>
      <td>${l.member_id == null ? "—" : h1(l.available_hours) + " h"}</td>
      <td>${h1(l.planned_hours)} h</td>
      <td>${l.has_sprint_work ? "Yes" : "—"}</td></tr>`,
    )
    .join("")}
  </tbody></table>`;
}

/** Origin badge (contract §1d): "added" / "added (retro)" for the two
 * post-activation origins; a plain baseline (planned-before-activation) item
 * carries no badge at all. */
function originBadge(origin: SprintItemsDetailedResponse[number]["origin"]): string {
  if (origin === "added_mid_sprint") return `<span class="badge">added</span>`;
  if (origin === "added_retroactively") return `<span class="badge">added (retro)</span>`;
  return "";
}

function multiSprintBadgeHtml(multiSprint: SprintItemsDetailedResponse[number]["multi_sprint"]): string {
  return multiSprint == null
    ? ""
    : `<span class="badge">sprint ${multiSprint.sequence}/${multiSprint.total}</span>`;
}

/** Contract §1d: one row per NON-REMOVED item — `removed_mid_sprint` items
 * stay (their already-logged hours are real, SPEC_05 §1); only `removed`
 * (dropped before activation, never committed) drops out. Same filter as
 * `computeSprintCapacity`'s `allItems`. */
function ticketRows(items: SprintItemsDetailedResponse): SprintItemsDetailedResponse {
  return items.filter((it) => it.outcome !== "removed");
}

type ItemRow = SprintItemsDetailedResponse[number];

/** Increment 40 (§2.B4): connection-scoped project key of a ticket row. */
function projectRowOf(it: ItemRow): { key: string | null; name: string | null; identifier: string | null } {
  return {
    key: it.project_op_id > 0 ? `${it.connection_id ?? "none"}:${it.project_op_id}` : null,
    name: it.project_name,
    identifier: it.project_identifier,
  };
}

function ticketTableHtml(items: SprintItemsDetailedResponse, projects: PdfProjectLayout): string {
  const rows = ticketRows(items);
  if (rows.length === 0) return "<p>No tickets.</p>";
  return `<table><thead><tr><th>#</th>${projects.thHtml}<th>Subject</th><th>Assignee</th><th>Status</th><th>Priority</th><th>Estimate</th><th>Origin</th></tr></thead><tbody>
  ${rows
    .map(
      (it) => `<tr><td>${it.op_id}</td>${projects.tdHtml(projectRowOf(it))}<td>${esc(it.subject)}</td>
      <td>${it.assignee_name ? esc(it.assignee_name) : "—"}</td>
      <td>${esc(it.status_name)}</td>
      <td>${it.priority ? esc(it.priority) : "—"}</td>
      <td>${it.effective_hours == null ? "—" : h1(it.effective_hours) + " h"}</td>
      <td>${originBadge(it.origin)} ${multiSprintBadgeHtml(it.multi_sprint)}</td></tr>`,
    )
    .join("")}
  </tbody></table>
  ${projects.legendHtml}`;
}

interface SprintStatusData {
  sprint: Sprint;
  stats: ClosureStatsResponse;
  capacity: CapacityResponse;
  items: SprintItemsDetailedResponse;
}

/**
 * Fetch the sprint row + the three REUSED computations (never a second
 * implementation) for a sprint in ANY state. `generatedAt` is threaded into
 * every sub-computation that takes one (`computeClosureStats`,
 * `computeSprintCapacity`), so the whole document is internally consistent to
 * a single instant. Shared by `buildSprintStatusHtml` and
 * `generateSprintStatusPdf` so the PDF path fetches the sprint exactly once.
 */
async function loadSprintStatusData(
  repos: Repositories,
  sprintId: number,
  generatedAt: string,
): Promise<SprintStatusData> {
  const sprint = await repos.sprints.getById(sprintId);
  if (!sprint) throw new AppError("SPRINT_NOT_FOUND", `Sprint ${sprintId} not found`);

  const [stats, capacity, items] = await Promise.all([
    computeClosureStats(repos, sprintId, generatedAt),
    computeSprintCapacity(localOnlyCapacityDeps(repos), sprintId, generatedAt),
    buildSprintItemsDetailed(repos, sprintId),
  ]);

  return { sprint, stats, capacity, items };
}

/** Build the status HTML for a sprint in ANY state (contract §1). */
export async function buildSprintStatusHtml(
  repos: Repositories,
  sprintId: number,
  generatedAt: string,
): Promise<string> {
  const { sprint, stats, capacity, items } = await loadSprintStatusData(repos, sprintId, generatedAt);
  return renderSprintStatusHtml(sprint, stats, capacity, items, generatedAt);
}

/** Pure renderer — split out from `buildSprintStatusHtml` (mirroring
 * report.ts's `renderReportHtml`/`buildReportDetail` split) so a unit test can
 * hand it already-fetched data without re-deriving it. */
export function renderSprintStatusHtml(
  sprint: Sprint,
  stats: ClosureStatsResponse,
  capacity: CapacityResponse,
  items: SprintItemsDetailedResponse,
  generatedAt: string,
): string {
  const projects = planPdfProjects(ticketRows(items).map(projectRowOf), esc);
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"/>
<title>OpalTakt — Sprint status — ${esc(sprint.name)}</title>
<style>
  body{font:14px/1.5 -apple-system,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;margin:32px;}
  .brand{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#475569;margin:0 0 14px;padding-bottom:8px;border-bottom:2px solid #0f172a;}
  .foot{margin-top:32px;padding-top:8px;border-top:1px solid #e2e8f0;color:#64748b;font-size:11px;}
  h1{font-size:22px;margin:0 0 4px;} h2{font-size:16px;margin:24px 0 8px;border-bottom:1px solid #e2e8f0;padding-bottom:4px;}
  .sub{color:#64748b;margin:0 0 4px;}
  .badge-state{display:inline-block;background:#f1f5f9;color:#334155;border-radius:12px;padding:2px 10px;font-size:12px;font-weight:600;margin-left:8px;}
  .kpis{display:flex;gap:16px;flex-wrap:wrap;margin:8px 0;}
  .kpi{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px;min-width:120px;}
  .kpi .v{font-size:20px;font-weight:600;} .kpi .l{color:#64748b;font-size:12px;}
  table{border-collapse:collapse;width:100%;font-size:13px;} th,td{text-align:left;padding:4px 8px;border-bottom:1px solid #eef2f7;}
  .badge{display:inline-block;background:#fef3c7;color:#92400e;border-radius:10px;padding:1px 8px;font-size:11px;margin-right:4px;}
  ${PDF_PROJECT_CSS}
</style></head><body>
  <p class="brand">OpalTakt · Sprint status</p>
  <h1>${esc(sprint.name)}<span class="badge-state">${esc(stateBadge(sprint))}</span></h1>
  <p class="sub">${formatDateGb(sprint.start_date)} – ${formatDateGb(sprint.end_date)}${
    projects.headerHtml ? ` · ${projects.headerHtml}` : ""
  }</p>
  <p class="sub">Generated ${esc(generatedAt)}</p>
  <h2>Summary</h2>
  <div class="kpis">
    <div class="kpi"><div class="v">${h1(stats.total_planned_hours)} h</div><div class="l">Planned</div></div>
    <div class="kpi"><div class="v">${h1(stats.total_baseline_hours)} h</div><div class="l">Baseline</div></div>
    <div class="kpi"><div class="v">${h1(stats.total_delivered_hours)} h</div><div class="l">Delivered</div></div>
    <div class="kpi"><div class="v">${h1(stats.total_logged_hours)} h</div><div class="l">Logged (all)</div></div>
  </div>
  <h2>Capacity</h2>
  ${capacityTableHtml(capacity)}
  <h2>Tickets</h2>
  ${ticketTableHtml(items, projects)}
  <p class="foot">Generated by OpalTakt · ${esc(generatedAt)}</p>
</body></html>`;
}

// ── PDF generation — clones generateReportPdf's write+stream shape ─────────

const slug = (s: string): string =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "sprint";

/** Repo root, resolved from THIS file's location (independent of cwd) —
 * matches report.ts/sprintExport.ts so status PDFs land in the SAME
 * repo-root/exports (.gitignored). */
function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

/**
 * Build the status PDF for a sprint in ANY state, write it to
 * exports/sprint-status-<slug>-<ts>.pdf AND return the bytes so the route can
 * stream the very same content. READ-ONLY: touches no sprint state, makes no
 * OpenProject call.
 */
export async function generateSprintStatusPdf(
  repos: Repositories,
  sprintId: number,
  deps: GeneratePdfDeps,
): Promise<GeneratePdfResult & { bytes: Buffer }> {
  const { sprint, stats, capacity, items } = await loadSprintStatusData(repos, sprintId, deps.generatedAt);
  const html = renderSprintStatusHtml(sprint, stats, capacity, items, deps.generatedAt);
  const render = deps.renderPdf ?? chromiumPdfRenderer;
  const bytes = await render(html);

  const stamp = (deps.stamp ?? deps.generatedAt).replace(/[:.]/g, "-");
  const exportsDir = deps.exportsDir ?? join(repoRoot(), "exports");
  const filePath = join(exportsDir, `sprint-status-${slug(sprint.name)}-${stamp}.pdf`);
  const mkdir = deps.mkdir ?? ((dir: string) => fsMkdir(dir, { recursive: true }).then(() => {}));
  const writeFile = deps.writeFile ?? ((p: string, d: Buffer) => fsWriteFile(p, d));
  await mkdir(dirname(filePath));
  await writeFile(filePath, bytes);

  return { file_path: filePath, generated_at: deps.generatedAt, bytes };
}

// Re-exported so callers (routes/index.ts) can type their own deps bag
// without importing report.ts directly for this one type.
export type { PdfRenderer };
