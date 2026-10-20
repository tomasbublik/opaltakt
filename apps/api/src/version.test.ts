import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VersionResponse } from "@osp/contracts";
import { buildTestApp } from "./test-utils";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("GET /api/version", () => {
  it("reports the root package.json version and the newest shipped migration", async () => {
    const t = await buildTestApp();
    const res = await t.app.inject({ method: "GET", url: "/api/version" });
    expect(res.statusCode).toBe(200);
    const body = VersionResponse.parse(res.json());

    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
    expect(body.version).toBe(pkg.version);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);

    const journal = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "packages/db/drizzle/meta/_journal.json"), "utf8"),
    );
    expect(body.schema_migration).toBe(journal.entries.at(-1).tag);
    await t.close();
  });
});
