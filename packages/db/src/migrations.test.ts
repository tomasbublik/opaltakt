import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getTableName } from "drizzle-orm";
import {
  DEFAULT_DONE_RULES,
  DEFAULT_OVERSHOOT_THRESHOLD_PCT,
} from "@osp/contracts";
import { MIGRATIONS_FOLDER, openDb, type DbHandle } from "./factory";
import { schema } from "./schema";

/**
 * Raw SQL through the driver. `pg.Pool#query` and `PGlite#query` both resolve
 * to `{ rows }`, but their overload sets don't unify for TypeScript, so the
 * shared shape is asserted in exactly one place.
 */
async function rawQuery<T>(
  raw: DbHandle["raw"],
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const driver = raw as { query: (sql: string, params?: unknown[]) => Promise<{ rows: T[] }> };
  return (await driver.query(sql, params)).rows;
}

/**
 * Migration baseline — Increment 27 (CONTRACTS §2).
 *
 * ── WHAT THIS FILE USED TO BE, AND WHY IT ISN'T ANY MORE ────────────────────
 * Until Increment 27 this file proved one specific SQLite migration
 * (`0017_renormalize_status_names.sql`) by re-running its raw SQL against
 * seeded rows. That test is GONE, and deliberately so: the Postgres cut
 * deletes all 20 SQLite migrations and replaces them with a single generated
 * baseline, `0000_init_pg.sql`. Those migrations encoded SQLite-specific table
 * rebuilds and backfills whose *results* are already baked into the current
 * schema, so there is no 0017 left to re-run and nothing for such a test to
 * assert. (Status-name normalisation itself is unaffected — it lives at WRITE
 * time in `normalizeStatusName` (@osp/op-client) and is covered there; the
 * migration was only ever a one-off backfill of pre-existing rows.)
 *
 * ── WHAT REPLACES IT ────────────────────────────────────────────────────────
 * The invariant that actually matters for a single-baseline setup is
 * MIGRATION/SCHEMA DRIFT: `openDb()` runs the checked-in migration, and the
 * database it produces must match `schema.ts` — the thing every repository is
 * typed against. If someone edits `schema.ts` without regenerating, or hand-
 * edits the SQL, the two silently diverge and the failure surfaces much later
 * as a runtime "column does not exist". So:
 *
 *   1. exactly one baseline migration exists (the §2 decision, mechanically);
 *   2. every table in `schema.ts` exists in a freshly-migrated database, and
 *      the database has no extra tables;
 *   3. the CONTRACTS §3 type mapping really landed — `jsonb`, `timestamptz`,
 *      `double precision` (NOT `numeric`), `boolean`, `date`;
 *   4. foreign keys are enforced natively, which SQLite only did under a
 *      pragma — the behaviour change most likely to bite existing fixtures.
 */

describe("migrations — the single Postgres baseline (CONTRACTS §2)", () => {
  it("ships the generated PG baseline plus the hand-written seed, and nothing else", () => {
    const sqlFiles = readdirSync(MIGRATIONS_FOLDER)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(
      sqlFiles,
      "CONTRACTS §2 (Increment 27): the 20 SQLite migrations are replaced by ONE " +
        "generated baseline, plus 0001_seed_defaults.sql. The seed is deliberately a " +
        "SEPARATE file: drizzle-kit only emits DDL and OVERWRITES the baseline on " +
        "regeneration, so seeds living in 0000 would be silently destroyed (which is " +
        "exactly how the done-rule matrix went missing during Increment 27).\n" +
        "Increment 29 (INCREMENT_29_CONTRACTS §3) adds 0002_sync_watermark.sql — an " +
        "ADDITIVE table on top of the baseline, which is the correct shape for a new " +
        "table (regenerating the baseline instead would destroy the seed again). " +
        "Increment 31 (INCREMENT_31_CONTRACTS §1) adds 0003_increment31_freeze.sql — " +
        "ADDITIVE columns (sprint.frozen_at, sprint_item.frozen_*, " +
        "report_config.freeze_grace_days) on existing tables, same shape as before. " +
        "Increment 32 (INCREMENT_32_CONTRACTS §2) adds 0004_off_sprint_time.sql — a new " +
        "ADDITIVE table (off_sprint_time_entry), same shape as 0002's new table. " +
        "Increment 34 (INCREMENT_34_CONTRACTS §4) adds 0005_increment34_multisprint.sql — " +
        "one ADDITIVE column (sprint_item.frozen_remaining_hours), same shape as 0003's " +
        "columns. Increment 40 (INCREMENT_40_CONTRACTS §2.A1) adds " +
        "0006_increment40_project.sql — ADDITIVE nullable columns (cache project_name, " +
        "sprint_item.frozen_project_name/identifier) plus a pure-SQL, NULL-only backfill. This " +
        "list is therefore an explicit allow-list, not a 'never more than two' rule: a " +
        "file NOT listed here means a migration landed without a contract update.",
    ).toEqual([
      "0000_init_pg.sql",
      "0001_seed_defaults.sql",
      "0002_sync_watermark.sql",
      "0003_increment31_freeze.sql",
      "0004_off_sprint_time.sql",
      "0005_increment34_multisprint.sql",
      "0006_increment40_project.sql",
    ]);
  });

  it("seeds the done-rule matrix and the report_config singleton", async () => {
    // Regression guard for a real Increment 27 defect: collapsing the SQLite
    // migration chain into a generated baseline dropped the seed INSERTs that
    // used to live in 0014_young_scorpion.sql. A fresh deployment then came up
    // with an EMPTY done matrix, so every ticket classified as not-done and
    // Closure/Capacity/sprint-list dimming all silently reported zero —
    // violating CONTRACTS §9 ("changes storage, not one number").
    const handle = await openDb({ ephemeral: true });
    try {
      const rules = await rawQuery<{ status_name: string; kind: string }>(
        handle.raw,
        `SELECT status_name, kind FROM done_rule ORDER BY status_name`,
      );
      expect(
        rules.map((r) => `${r.status_name}:${r.kind}`),
        "done_rule must be seeded from DEFAULT_DONE_RULES (packages/contracts/src/common.ts)",
      ).toEqual(
        [...DEFAULT_DONE_RULES]
          .map((r) => `${r.status_name}:${r.kind}`)
          .sort(),
      );

      const cfg = await rawQuery<{ overshoot_threshold_pct: number }>(
        handle.raw,
        `SELECT overshoot_threshold_pct FROM report_config WHERE id = 1`,
      );
      expect(cfg).toHaveLength(1);
      expect(Number(cfg[0]?.overshoot_threshold_pct)).toBe(
        DEFAULT_OVERSHOOT_THRESHOLD_PCT,
      );
    } finally {
      await handle.close();
    }
  });

  it("a freshly-migrated database contains exactly the tables declared in schema.ts", async () => {
    const handle = await openDb({ ephemeral: true });
    try {
      const expected = Object.values(schema)
        .map((t) => getTableName(t))
        .sort();
      const rows = await rawQuery<{ table_name: string }>(
        handle.raw,
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
          ORDER BY table_name`,
      );
      const actual = rows
        .map((r) => r.table_name)
        // Drizzle's own bookkeeping table is not part of the app schema.
        .filter((n) => n !== "__drizzle_migrations")
        .sort();
      expect(
        actual,
        "migration/schema drift — regenerate with `pnpm --filter @osp/db db:generate`",
      ).toEqual(expected);
    } finally {
      await handle.close();
    }
  });

  it("applies the CONTRACTS §3 type mapping (jsonb / timestamptz / double precision / boolean / date)", async () => {
    const handle = await openDb({ ephemeral: true });
    try {
      const typeOf = async (table: string, column: string): Promise<string> => {
        const rows = await rawQuery<{ data_type: string }>(
          handle.raw,
          `SELECT data_type FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
          [table, column],
        );
        return rows[0]?.data_type ?? "<missing>";
      };

      // §3b — every *_json column is REAL jsonb, not text.
      expect(await typeOf("work_package_cache", "raw_json")).toBe("jsonb");
      expect(await typeOf("ticket_changelog_entry", "detail_json")).toBe("jsonb");
      expect(await typeOf("capacity_edit_audit", "changes_json")).toBe("jsonb");
      expect(await typeOf("vault_meta", "kdf_params_json")).toBe("jsonb");

      // §3a — ISO datetime columns are timestamptz, so ordering/indexes are native.
      expect(await typeOf("sprint", "created_at")).toBe("timestamp with time zone");
      expect(await typeOf("ticket_changelog_entry", "occurred_at")).toBe(
        "timestamp with time zone",
      );

      // §3c — date-only columns are `date`, not timestamps.
      expect(await typeOf("sprint", "start_date")).toBe("date");
      expect(await typeOf("burndown_snapshot", "snapshot_date")).toBe("date");

      // §3c — hours/points are `double precision`. NOT `numeric`: node-postgres
      // returns numeric as a STRING, which would silently break every hours
      // calculation in the capacity/closure model.
      expect(await typeOf("work_package_cache", "estimated_hours")).toBe("double precision");
      expect(await typeOf("sprint_item", "planned_hours")).toBe("double precision");

      // §3c — SQLite's integer-as-boolean columns are real booleans.
      expect(await typeOf("sprint", "is_locked")).toBe("boolean");
      expect(await typeOf("op_connection", "is_current")).toBe("boolean");

      // §3d — crypto columns stay text (base64), byte-identical to before.
      expect(await typeOf("op_connection", "token_ct")).toBe("text");
      expect(await typeOf("vault_meta", "kdf_salt")).toBe("text");
    } finally {
      await handle.close();
    }
  });

  it("enforces foreign keys natively — a child row without its parent is REJECTED", async () => {
    // Under SQLite this only held with `PRAGMA foreign_keys = ON`, so fixtures
    // could (and did) get away with inserting children first. Postgres refuses
    // unconditionally; this test pins that difference so nobody is surprised.
    const handle = await openDb({ ephemeral: true });
    try {
      await expect(
        rawQuery(
          handle.raw,
          `INSERT INTO sprint_item (sprint_id, wp_op_id, added_at, outcome, origin)
           VALUES (999999, 1, now(), 'planned', 'baseline')`,
        ),
      ).rejects.toThrow(/foreign key|violates/i);
    } finally {
      await handle.close();
    }
  });
});

/**
 * Increment 40 (docs/INCREMENT_40_CONTRACTS.md §2.A1/A4) — 0006's backfill.
 *
 * `openDb()` applies 0006 to an EMPTY database, where the backfill is a no-op.
 * To exercise it, the test seeds pre-Increment-40 state (NULL project_name /
 * frozen_project_*) AFTER migration and then re-executes 0006 exactly as the
 * migrator would (split on `--> statement-breakpoint`). Executing it a SECOND
 * time proves the file is idempotent — the standing convention for a
 * migration a watching dev server might re-run. Fictional projects only.
 */
describe("0006_increment40_project — project_name / frozen project backfill", () => {
  const MIGRATION_0006 = join(MIGRATIONS_FOLDER, "0006_increment40_project.sql");

  async function run0006(raw: DbHandle["raw"]): Promise<void> {
    const statements = readFileSync(MIGRATION_0006, "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) await rawQuery(raw, stmt);
  }

  const wpJson = (projectId: number | null, title: string | null): string =>
    JSON.stringify({
      _type: "WorkPackage",
      _links: projectId === null ? {} : { project: { href: `/api/v3/projects/${projectId}`, title } },
    });

  interface ItemRow {
    sprint_id: number;
    wp_op_id: number;
    frozen_project_op_id: number | null;
    frozen_project_name: string | null;
    frozen_project_identifier: string | null;
  }

  it("adds the four columns (nullable text)", async () => {
    const handle = await openDb({ ephemeral: true });
    try {
      const cols = await rawQuery<{ table_name: string; column_name: string; data_type: string; is_nullable: string }>(
        handle.raw,
        `SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
          WHERE table_schema = 'public'
            AND column_name IN ('project_name', 'frozen_project_name', 'frozen_project_identifier')
            AND table_name IN ('work_package_cache', 'work_package_cache_staging', 'sprint_item')
          ORDER BY table_name, column_name`,
      );
      expect(cols.map((c) => `${c.table_name}.${c.column_name}:${c.data_type}:${c.is_nullable}`)).toEqual([
        "sprint_item.frozen_project_identifier:text:YES",
        "sprint_item.frozen_project_name:text:YES",
        "work_package_cache.project_name:text:YES",
        "work_package_cache_staging.project_name:text:YES",
      ]);
    } finally {
      await handle.close();
    }
  });

  it("backfills cache names and frozen snapshots (cache / baseline-only / ambiguous), and re-runs as a no-op", async () => {
    const handle = await openDb({ ephemeral: true });
    const { raw, repositories: r } = handle;
    try {
      const connA = await r.connections.create({
        base_url: "https://op-a.example.test",
        label: "A",
        token_ct: null,
        token_nonce: null,
        token_tag: null,
        default_project_op_id: null,
      });
      const connB = await r.connections.create({
        base_url: "https://op-b.example.test",
        label: "B",
        token_ct: null,
        token_nonce: null,
        token_tag: null,
        default_project_op_id: null,
      });
      // op_id 11 exists on BOTH servers (different projects) → ambiguous
      // without a connection; op_id 12 exists once → unambiguous.
      await r.projects.upsertMany([
        { connection_id: connA.id, op_id: 11, identifier: "northwind", name: "Northwind Payments", last_synced_at: null },
        { connection_id: connB.id, op_id: 11, identifier: "lighthouse", name: "Lighthouse" , last_synced_at: null },
        { connection_id: connA.id, op_id: 12, identifier: "harbor-ops", name: "Harbor Ops", last_synced_at: null },
      ]);

      const cache = async (opId: number, projectOpId: number, json: string) =>
        rawQuery(
          raw,
          `INSERT INTO work_package_cache (op_id, project_op_id, subject, type_name, status_name,
             status_is_closed, updated_at_op, raw_json, project_name)
           VALUES ($1, $2, 'S', 'Task', 'New', false, now(), $3::jsonb, NULL)`,
          [opId, projectOpId, json],
        );
      await cache(1001, 11, wpJson(11, "Northwind Payments"));
      await cache(1003, 11, wpJson(11, "Northwind Payments"));
      // Moved to project 11 AFTER the freeze recorded project 12.
      await cache(1005, 11, wpJson(11, "Northwind Payments"));
      // No project link at all → stays NULL.
      await cache(1008, 0, wpJson(null, null));

      const [frozen] = await rawQuery<{ id: number }>(
        raw,
        `INSERT INTO sprint (name, start_date, end_date, status, frozen_at)
         VALUES ('Frozen', '2026-06-01', '2026-06-14', 'closed', now()) RETURNING id`,
      );
      const [live] = await rawQuery<{ id: number }>(
        raw,
        `INSERT INTO sprint (name, start_date, end_date, status)
         VALUES ('Live', '2026-06-15', '2026-06-28', 'active') RETURNING id`,
      );
      const item = async (
        sprintId: number,
        wpOpId: number,
        opts: { outcome?: string; conn?: number | null; pid?: number | null; name?: string | null } = {},
      ) =>
        rawQuery(
          raw,
          `INSERT INTO sprint_item (sprint_id, wp_op_id, outcome, origin, frozen_connection_id,
             frozen_project_op_id, frozen_project_name)
           VALUES ($1, $2, $3, 'baseline', $4, $5, $6)`,
          [sprintId, wpOpId, opts.outcome ?? "done", opts.conn ?? null, opts.pid ?? null, opts.name ?? null],
        );
      const baseline = async (sprintId: number, wpOpId: number, json: string) =>
        rawQuery(
          raw,
          `INSERT INTO ticket_baseline (sprint_id, wp_op_id, subject, status_name, status_is_closed, raw_json)
           VALUES ($1, $2, 'S', 'New', false, $3::jsonb)`,
          [sprintId, wpOpId, json],
        );

      // (a) cache row, connection known.
      await item(frozen!.id, 1001, { conn: connA.id });
      // (b) baseline-only (no cache row), connection-less, op_id 12 unique.
      await item(frozen!.id, 1002, { conn: null });
      await baseline(frozen!.id, 1002, wpJson(12, "Harbor Ops"));
      // (c) cache row, connection-less, op_id 11 ambiguous → identifier NULL.
      await item(frozen!.id, 1003, { conn: null });
      // (d) removed → never touched.
      await item(frozen!.id, 1004, { outcome: "removed", conn: connA.id });
      await baseline(frozen!.id, 1004, wpJson(12, "Harbor Ops"));
      // (e) frozen op_id 12 already recorded, cache moved to 11 → name from
      //     the baseline (matching op_id), never the cache's new project.
      await item(frozen!.id, 1005, { conn: connA.id, pid: 12 });
      await baseline(frozen!.id, 1005, wpJson(12, "Harbor Ops"));
      // (f) nothing to resolve from → all NULL.
      await item(frozen!.id, 1006, { conn: connA.id });
      // (g) already snapshotted → untouched.
      await item(frozen!.id, 1007, { conn: connA.id, pid: 99, name: "Keep Me" });
      // Not frozen → frozen_* columns never touched.
      await item(live!.id, 1001, { conn: connA.id });

      await run0006(raw);

      const cacheRows = await rawQuery<{ op_id: number; project_name: string | null }>(
        raw,
        `SELECT op_id, project_name FROM work_package_cache ORDER BY op_id`,
      );
      expect(cacheRows).toEqual([
        { op_id: 1001, project_name: "Northwind Payments" },
        { op_id: 1003, project_name: "Northwind Payments" },
        { op_id: 1005, project_name: "Northwind Payments" },
        { op_id: 1008, project_name: null },
      ]);

      const readItems = () =>
        rawQuery<ItemRow>(
          raw,
          `SELECT sprint_id, wp_op_id, frozen_project_op_id, frozen_project_name, frozen_project_identifier
             FROM sprint_item ORDER BY sprint_id, wp_op_id`,
        );
      const items = await readItems();
      const byKey = (sprintId: number, wpOpId: number) =>
        items.find((i) => i.sprint_id === sprintId && i.wp_op_id === wpOpId);
      const f = frozen!.id;
      expect(byKey(f, 1001)).toMatchObject({
        frozen_project_op_id: 11,
        frozen_project_name: "Northwind Payments",
        frozen_project_identifier: "northwind",
      });
      expect(byKey(f, 1002)).toMatchObject({
        frozen_project_op_id: 12,
        frozen_project_name: "Harbor Ops",
        frozen_project_identifier: "harbor-ops",
      });
      expect(byKey(f, 1003)).toMatchObject({
        frozen_project_op_id: 11,
        frozen_project_name: "Northwind Payments",
        frozen_project_identifier: null,
      });
      expect(byKey(f, 1004)).toMatchObject({
        frozen_project_op_id: null,
        frozen_project_name: null,
        frozen_project_identifier: null,
      });
      expect(byKey(f, 1005)).toMatchObject({
        frozen_project_op_id: 12,
        frozen_project_name: "Harbor Ops",
        frozen_project_identifier: "harbor-ops",
      });
      expect(byKey(f, 1006)).toMatchObject({
        frozen_project_op_id: null,
        frozen_project_name: null,
        frozen_project_identifier: null,
      });
      expect(byKey(f, 1007)).toMatchObject({
        frozen_project_op_id: 99,
        frozen_project_name: "Keep Me",
        frozen_project_identifier: null,
      });
      expect(byKey(live!.id, 1001)).toMatchObject({
        frozen_project_op_id: null,
        frozen_project_name: null,
        frozen_project_identifier: null,
      });

      // Idempotent re-run: byte-identical results.
      await run0006(raw);
      expect(await readItems()).toEqual(items);
      expect(
        await rawQuery(raw, `SELECT op_id, project_name FROM work_package_cache ORDER BY op_id`),
      ).toEqual(cacheRows);
    } finally {
      await handle.close();
    }
  });
});
