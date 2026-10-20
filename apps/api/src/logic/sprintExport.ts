import { fileURLToPath } from "node:url";
import { mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CapacityResponse, ClosureReportResponse } from "@osp/contracts";
import type { Repositories } from "@osp/db";
import { readStoredClosureReport } from "./closure";

/**
 * SPEC_12 §6 — pre-delete export. BEFORE a sprint is cascade-deleted (an
 * irreversible, destructive operation — the exact category that caused the
 * Increment-11 data-loss incident, SPEC_12 §0), serialize a full JSON snapshot
 * of it to `exports/sprint-<name-slug>-<timestamp>.json`. The delete route
 * refuses to proceed if this write fails, so there is always a recovery artifact.
 */

export interface SprintExportBundle {
  sprint: Awaited<ReturnType<Repositories["sprints"]["getById"]>>;
  items: Awaited<ReturnType<Repositories["sprintItems"]["listBySprint"]>>;
  baselines: Awaited<ReturnType<Repositories["ticketBaselines"]["listBySprint"]>>;
  changelog: Awaited<ReturnType<Repositories["ticketChangelog"]["listBySprint"]>>;
  burndown: Awaited<ReturnType<Repositories["burndown"]["listBySprint"]>>;
  capacity: CapacityResponse;
  closure: ClosureReportResponse | null;
  exported_at: string;
}

export interface SprintExportDeps {
  repos: Repositories;
  /** Reuse the route's capacity builder so the export matches the live screen. */
  buildCapacity: (sprintId: number) => Promise<CapacityResponse>;
  now: () => Date;
  /** The exports/ directory (default: repo-root/exports). Injectable for tests. */
  exportsDir?: string;
  /** Injectable fs primitives (default node:fs/promises) so a test can force a
   * write failure and assert the delete aborts. */
  writeFile?: (path: string, data: string) => Promise<void>;
  mkdir?: (dir: string) => Promise<void>;
}

/** Repo root, resolved from THIS file's location (independent of cwd):
 * apps/api/src/logic/sprintExport.ts → up 4 dirs. */
function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..", "..");
}

/** Slugify a sprint name for a filesystem-safe filename. */
function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "sprint"
  );
}

/**
 * Write the pre-delete JSON snapshot; returns the path RELATIVE to the repo
 * root (e.g. `exports/sprint-3-5-039-2026-07-15T10-00-00-000Z.json`). Throws if
 * the write fails — the caller must NOT delete when this throws.
 */
export async function writeSprintExport(
  deps: SprintExportDeps,
  sprintId: number,
): Promise<string> {
  const { repos } = deps;
  const writeFile = deps.writeFile ?? fsWriteFile;
  const mkdir = deps.mkdir ?? ((dir: string) => fsMkdir(dir, { recursive: true }).then(() => {}));
  const exportsDir = deps.exportsDir ?? join(repoRoot(), "exports");

  const sprint = await repos.sprints.getById(sprintId);
  const nowIso = deps.now().toISOString();
  const [items, baselines, changelog, burndown, capacity, storedClosure] = await Promise.all([
    repos.sprintItems.listBySprint(sprintId),
    repos.ticketBaselines.listBySprint(sprintId),
    repos.ticketChangelog.listBySprint(sprintId),
    repos.burndown.listBySprint(sprintId),
    deps.buildCapacity(sprintId),
    repos.closureReports.getBySprint(sprintId),
  ]);
  const closure = storedClosure ? await readStoredClosureReport(repos, sprintId, nowIso) : null;

  const bundle: SprintExportBundle = {
    sprint,
    items,
    baselines,
    changelog,
    burndown,
    capacity,
    closure,
    exported_at: nowIso,
  };

  const name = sprint?.name ?? `sprint-${sprintId}`;
  // Colons are invalid in filenames on some platforms — swap them out of the ISO stamp.
  const stamp = nowIso.replace(/[:.]/g, "-");
  const fileName = `sprint-${slugify(name)}-${stamp}.json`;
  await mkdir(exportsDir);
  await writeFile(join(exportsDir, fileName), JSON.stringify(bundle, null, 2));
  return join("exports", fileName);
}
