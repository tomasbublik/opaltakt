import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { VersionResponse } from "@osp/contracts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** OSP_GIT_SHA (container builds have no .git) or the local checkout's HEAD. */
function gitSha(): string | null {
  const fromEnv = process.env.OSP_GIT_SHA?.trim();
  if (fromEnv) return fromEnv;
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function latestMigration(): string | null {
  const journal = readJson(path.join(REPO_ROOT, "packages/db/drizzle/meta/_journal.json")) as {
    entries?: { tag?: string }[];
  } | null;
  return journal?.entries?.at(-1)?.tag ?? null;
}

let cached: VersionResponse | null = null;

/** Resolved once per process — the running build cannot change underneath it. */
export function versionInfo(): VersionResponse {
  if (cached) return cached;
  const pkg = readJson(path.join(REPO_ROOT, "package.json")) as { version?: string } | null;
  cached = {
    version: pkg?.version ?? "0.0.0",
    git_sha: gitSha(),
    schema_migration: latestMigration(),
  };
  return cached;
}
