import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import {
  E2E_DATABASE_URL,
  E2E_DB_NAME,
  readForbiddenActivitySnapshot,
  snapshotForbiddenActivity,
} from "../global-db";
import {
  FOREIGN_DATABASES,
  FORBIDDEN_DATABASES,
  judgeDatabaseUrl,
} from "../../src/db-isolation";

const exec = promisify(execFile);

/**
 * ⛔ §0 — THE POSTGRES-ERA ISOLATION TRIPWIRE (Increment 27).
 *
 * Named `tz-…` so Playwright (which runs spec files in filename order) runs it
 * LAST, after every other spec has driven the full stack. It is the e2e
 * counterpart of tests/src/env-isolation-guard.test.ts.
 *
 * THE INCIDENT IT GUARDS AGAINST. In Increment 11 a background agent booted
 * this app without an explicit DB target, silently reached the user's real
 * database, and while live-testing "Delete sprint" permanently destroyed every
 * sprint they had. No undo. The pre-Postgres tripwires (still present in the
 * other spec files) fingerprint `apps/api/osp.sqlite` and fail if it moved.
 * After the Postgres cut, the equivalent question is: "did anything in this run
 * write to a database that isn't ours?"
 *
 * HOW IT ANSWERS THAT WITHOUT COMMITTING THE VERY SIN IT POLICES. It never
 * connects to `osp` or to another project's database. It reads `pg_stat_database` from the
 * `postgres` admin database — server-side metadata — and compares the
 * transaction/tuple counters against the baseline globalSetup captured before
 * anything booted. A misdirected run moves those counters; a correct run does
 * not.
 */

const PG_HOST = process.env.OSP_E2E_PG_HOST ?? "127.0.0.1";
const PG_PORT = process.env.OSP_E2E_PG_PORT ?? "5432";
const PG_USER = process.env.OSP_E2E_PG_USER ?? os.userInfo().username;

test.describe("§0 database isolation (Postgres era)", () => {
  test("the run targeted a generated THROWAWAY database, never a real one", () => {
    const verdict = judgeDatabaseUrl(E2E_DATABASE_URL);
    expect(
      verdict.ok,
      `the e2e DATABASE_URL is not throwaway-shaped: ${verdict.reason}`,
    ).toBe(true);
    expect(verdict.database).toBe(E2E_DB_NAME);
    expect(E2E_DB_NAME).toMatch(/^osp_e2e_\d+$/);
    // Belt and braces: never a name that would be catastrophic.
    expect(FORBIDDEN_DATABASES).not.toContain(E2E_DB_NAME);
  });

  test("the API really did write into the throwaway database (the tripwire isn't vacuous)", async () => {
    // If this fails, the whole suite ran against something else — and every
    // "nothing changed" assertion below would be meaninglessly green.
    const { stdout } = await exec(
      "psql",
      [
        E2E_DATABASE_URL,
        "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1",
        "-c",
        "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'",
      ],
      { env: { ...process.env, PGCONNECT_TIMEOUT: "5" } },
    );
    expect(
      Number(stdout.trim()),
      `${E2E_DB_NAME} has no application tables — the API did not use it`,
    ).toBeGreaterThan(10);
  });

  test("no forbidden database saw ANY write activity during this run", async () => {
    const before = readForbiddenActivitySnapshot();
    test.skip(
      before === null,
      "no pre-run activity snapshot — globalSetup did not run (e.g. a single-spec invocation)",
    );
    const after = await snapshotForbiddenActivity();

    // Compare only the MONOTONIC WRITE counters (tup_inserted / tup_updated /
    // tup_deleted). `numbackends` is a live gauge and `xact_commit` moves for
    // read-only sessions too — either would make this tripwire flaky, and a
    // flaky guardrail is one that eventually gets deleted.
    const writeCounters = (raw: string | undefined): string => {
      const parts = (raw ?? "").split("|"); // numbackends|xact_commit|ins|upd|del
      return parts.slice(2).join("|");
    };

    const drifted: string[] = [];
    for (const db of Object.keys(before!)) {
      const b = writeCounters(before![db]);
      const a = writeCounters(after[db]);
      if (a !== b) drifted.push(`${db}: ${b} → ${a}`);
    }

    // OSP_FOREIGN_DATABASES belong to entirely different projects whose own
    // services may be running and writing on this machine right now. Drift
    // there is not evidence that THIS suite misbehaved — our proof for them is
    // the generated-name guarantee above (nothing in this repo can produce
    // those names). So it is reported loudly, not failed on.
    const isForeign = (d: string) => FOREIGN_DATABASES.some((f) => d.startsWith(`${f}:`));
    const foreign = drifted.filter(isForeign);
    const ours = drifted.filter((d) => !isForeign(d));
    if (foreign.length > 0) {
      console.warn(
        `[§0] write activity observed on another project's database during this run: ${foreign.join(", ")}. ` +
          "Expected if that project's service is running locally; this suite never connects to it.",
      );
    }

    expect(
      ours,
      "⛔ A DATABASE THAT MUST NEVER BE TOUCHED SAW WRITE ACTIVITY DURING THE E2E RUN.\n" +
        "This is the exact failure that destroyed the user's data in Increment 11.\n" +
        `Counters are tup_inserted|tup_updated|tup_deleted, read from ` +
        `${PG_USER}@${PG_HOST}:${PG_PORT} via pg_stat_database (metadata only — ` +
        "this check never opens a session on the databases it is protecting).\n" +
        ours.join("\n"),
    ).toEqual([]);
  });
});
