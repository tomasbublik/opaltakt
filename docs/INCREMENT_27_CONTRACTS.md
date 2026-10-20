# Increment 27 — FROZEN CONTRACTS (Phase 0)

SQLite → PostgreSQL hard cut. **This document is frozen.** Every Phase-1 agent codes against it.
Anything not specified here that turns out to be ambiguous must be raised with the orchestrator,
not decided unilaterally — two agents guessing differently is how integration breaks.

Everything below marked **VERIFIED** was proven by a real smoke test against both engines during
Phase 0, not assumed.

---

## 1. Environment & connection

The reference local instance is a `postgres:17` container with
`POSTGRES_HOST_AUTH_METHOD: trust` (no password) on port 5432. `POSTGRES_DB` is **not** set,
so the server's default database is named after the OS user — and holds real data.

```
DATABASE_URL=postgres://dev@localhost:5432/osp
```

- `OSP_DB_PATH` is **deleted everywhere**. It is replaced by `DATABASE_URL`, which is likewise
  **required with no default** — `resolveDatabaseUrl()` throws if unset, exactly as
  `resolveDbPath()` did (`apps/api/src/server.ts`). Do not reintroduce a fallback.
- `PORT` stays required with no default (`apps/api/src/index.ts`). Unchanged.
- Database `osp` does not exist yet and must be created (`CREATE DATABASE osp`).

### ⛔ Databases that are OFF-LIMITS to every agent

The same Postgres instance already hosts **`atlas-core`**, belonging to an unrelated project.

| Database | Status |
|---|---|
| `atlas-core` | **NEVER touch.** Not read, not written, not dropped. Different project. |
| `osp` | The user's real data. Off-limits, same as `apps/api/osp.sqlite` always was. |
| `postgres`, `template0`, `template1` | Admin only — connect to `postgres` solely to `CREATE`/`DROP` a throwaway DB. |
| `osp_test_*`, `osp_smoke_*`, `osp_e2e_*` | Throwaway. Create and drop freely. |

Every agent run, test run and live-verify uses a throwaway database **and** a non-default `PORT`
(never 3001/8099/5173). This is the Increment-11 guardrail carried over — the failure mode is
identical, only the storage engine changed.

---

## 2. ORM decision

Drizzle, already at `drizzle-orm@0.38.4`, which **already ships both** `drizzle-orm/node-postgres`
and `drizzle-orm/pglite`. **No drizzle upgrade.** Changes:

- remove `better-sqlite3` + `@types/better-sqlite3`
- add `pg@^8.13` + `@types/pg` (app + e2e), `@electric-sql/pglite@^0.2.17` (unit tests, dev dep)
- `drizzle.config.ts`: `dialect: "postgresql"`, `dbCredentials: { url: process.env.DATABASE_URL }`

### Migrations: one fresh PG baseline, NOT a translation of the 20 SQLite migrations

Delete `packages/db/drizzle/*` and regenerate a single `0000_init_pg.sql` from the new schema.
Rationale: the 20 existing migrations encode SQLite-specific table rebuilds and backfills whose
*results* are already baked into the current schema; re-expressing them for PG buys nothing and
risks drift. Existing data arrives through the §5 data-migration script, not through migration
replay. Migration remains first-class: one `migrate` command builds the schema on an empty PG.

---

## 3. Type mapping (§2 of the spec) — FROZEN

Two shared custom column types carry the whole mapping. They exist so that **the TypeScript-facing
type of every column stays byte-identical to today** — which is what makes the repos conversion
(§4) a purely mechanical async change with no data-shape churn.

Both live in a new `packages/db/src/columnTypes.ts`, owned by Agent A.

### 3a. `isoTimestamp` — timestamptz that reads back as contract-valid ISO-8601

**VERIFIED — this is the single biggest trap in the increment.** Drizzle's
`timestamp({ withTimezone: true, mode: "string" })` returns Postgres's own rendering:

```
"2026-08-10 07:39:19.488+00"     ← space instead of 'T', offset "+00" not "+00:00"
```

That string **fails** `z.string().datetime({ offset: true })`, which is exactly what
`@osp/contracts` (`IsoDateTime`, `common.ts:17`) validates on. Using `mode: "string"` would break
contract validation across the API surface. `mode: "date"` returns a `Date`, changing every
consumer. The fix, verified to round-trip exactly and to keep SQL `ORDER BY` working:

```ts
export const isoTimestamp = customType<{ data: string; driverData: Date }>({
  dataType: () => "timestamp with time zone",
  fromDriver: (v) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString()),
  toDriver: (v) => new Date(v),
});
```

`"2026-08-10T07:39:19.488Z"` in → identical string out. Storage is a real `timestamptz` in UTC, so
comparisons, ordering and indexes behave natively.

### 3b. `jsonbText` — jsonb stored natively, exposed to TS as the JSON `string` it is today

Every `*_json` column is written and read as a serialized string by the app (`JSON.parse` at the
call sites). Spec §2 wants real `jsonb` storage. Both are satisfied by keeping the TS type `string`:

```ts
export const jsonbText = customType<{ data: string; driverData: unknown }>({
  dataType: () => "jsonb",
  fromDriver: (v) => JSON.stringify(v),
  toDriver: (v) => v,          // JSON string → jsonb, cast by PG on the parameter
});
```

⚠️ **Caveat, and it is stronger than it first appears — VERIFIED.** Postgres `jsonb` does not
merely normalise whitespace: it **reorders object keys** (by length, then bytewise) and drops
duplicate keys. `{"id":1,"subject":"x","nested":{…}}` reads back as
`{"id":1,"nested":{…},"subject":"x"}`. Therefore, for every `*_json` column:

- a raw string comparison is unsafe, **and**
- `JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b))` is **also** unsafe.

Only deep/structural equality holds. Sweep the tests for both patterns — assert on parsed objects
(`toEqual`), never on the serialized string.

### 3c. The rest

| Today (SQLite) | Postgres | Notes |
|---|---|---|
| `integer().primaryKey({ autoIncrement: true })` | `serial().primaryKey()` | 21 tables |
| `integer().primaryKey()` — explicit id | `integer().primaryKey()` | **`vault_meta.id`, `report_config.id` (singletons, always 1), `backlog_dismissal.wp_op_id`. NOT serial.** |
| `integer(…, { mode: "boolean" })` | `boolean` | **9** columns: `op_connection.is_current/enabled`, `work_package_cache.status_is_closed`, `work_package_cache_staging.status_is_closed`, `sprint.is_locked/is_retrospective`, `sync_run.cancel_requested`, `ticket_baseline.status_is_closed/reconstructed`. (`grep -c 'mode: "boolean"'` returns 10 — one hit is a doc comment, not a column.) |
| `integer()` | `integer` | op ids, counts |
| `real()` | **`double precision`** | ⚠️ **NOT `numeric`** — node-postgres returns `numeric` as a **string**, which would silently break every hours/points calculation. `double precision` preserves today's float semantics exactly. |
| `text()` holding ISO datetime | `isoTimestamp` (§3a) | see list below |
| `text()` holding `YYYY-MM-DD` | `date` (mode string) | **VERIFIED** returns plain `'2026-08-10'` |
| `text()` holding JSON | `jsonbText` (§3b) | see list below |
| `text()` holding ciphertext/salt | **`text` (unchanged)** | §3d |
| `text()` otherwise | `text` | |

**`isoTimestamp` columns:** `op_connection.created_at/last_activity_at/last_check_at`,
`vault_meta.created_at`, `project.last_synced_at`,
`work_package_cache.updated_at_op/cached_at`, `work_package_cache_staging.updated_at_op/cached_at`,
`estimate_override.updated_at`,
`sprint.created_at/closed_at/activated_at/locked_at/retro_replayed_at`,
`sprint_item.added_at/removed_at`, `capacity_edit_audit.edited_at`, `user_name_alias.created_at`,
`sync_run.started_at/finished_at/last_progress_at`, `sprint_closure_report.generated_at`,
`import_selection.created_at`, `backlog_dismissal.dismissed_at`, `ticket_baseline.captured_at`,
`sprint_update_run.started_at/finished_at`, `ticket_changelog_entry.occurred_at`.

**`date` columns (date-only, no time):** `sprint.start_date`, `sprint.end_date`,
`burndown_snapshot.snapshot_date`.

**`jsonbText` columns:** `vault_meta.kdf_params_json`, `work_package_cache.raw_json`,
`work_package_cache_staging.raw_json`, `capacity_edit_audit.changes_json`,
`sprint_closure_report.done_json/not_done_json/version_change_json`,
`ticket_baseline.raw_json/reconstruction_gaps_json`, `ticket_changelog_entry.detail_json`.

### 3d. Crypto columns stay `text`

`op_connection.token_ct/token_nonce/token_tag/token_encrypted`,
`vault_meta.kdf_salt/verifier_ct/verifier_nonce` remain **`text`, base64, content byte-identical**.
Spec §2 permits `bytea` or base64 text; text is chosen because it is a zero-risk no-op — the vault
crypto path is untouched and `packages/crypto` needs no changes to its encoding.
**VERIFIED** ciphertext survives a PG round-trip unchanged.

### 3e. Keys and indexes

Every `uniqueIndex` and `index` in today's `schema.ts` is preserved verbatim, same names.
Foreign keys (`references()`) are preserved — and unlike SQLite (where they needed
`PRAGMA foreign_keys = ON`) they are now enforced natively and unconditionally. Agent A must
watch for insert-order violations that SQLite tolerated in tests.

Added indexes where SQLite relied on scans: `sprint_item(sprint_id)` (exists),
`ticket_changelog_entry(sprint_id, wp_op_id)` (exists), plus new
`burndown_snapshot(sprint_id)`, `ticket_baseline(wp_op_id)`, `sprint_member_capacity(sprint_id)`.

---

## 4. The repository layer: sync → async

`better-sqlite3` is **synchronous**; `pg` and PGlite are not.

**The good news, already verified:** the repository *interface* (`repositories.ts`) is already
fully `Promise`-based — 108 `Promise<…>` signatures, 106 `async` implementations. The async
boundary is already in the right place, so **no route and no logic file changes its signature.**

The conversion is contained and mechanical:

| Site | Count |
|---|---|
| `packages/db/src/repos.ts` — `.get()` | 67 |
| `packages/db/src/repos.ts` — `.all()` | 26 |
| `packages/db/src/repos.ts` — `.run()` | 43 |
| `packages/db/src/repos.ts` — `db.transaction((tx) => …)` sync callbacks | 6 |

**Correction (verified during Phase 1):** an earlier draft of this table also listed
`closureStats.ts` (1), `vault/index.ts` (1) and `crypto/vault.ts` (4). Those were **false
positives from a naive `.get()` grep** — they are `Map.get()` calls and already-async repository
methods (`repos.reportConfig.get()`, `repos.vaultMeta.get()`, `store.get()`). None of those files
contains a Drizzle handle at all. The conversion is genuinely confined to `repos.ts`.

Rules — **VERIFIED** equivalents:

- `.get()` → `await …limit(1)` then destructure `const [row] = …`. (Drizzle PG has no `.get()`.)
- `.all()` → `await …` (the query itself resolves to the array).
- `.run()` → `await …`.
- `.insert(…).values(…).get()` → `.insert(…).values(…).returning()` then `const [row] = …`.
  **VERIFIED** `RETURNING` gives back the inserted row including server-side defaults.
- `db.transaction((tx) => {…})` → `await db.transaction(async (tx) => {…})`, and **every**
  statement inside must be awaited. **VERIFIED** commit and rollback both behave.
- `.onConflictDoUpdate({ target, set })` works unchanged. **VERIFIED**, including that columns
  absent from `set` keep their existing values (the `original_assignee_op_id` invariant in
  `schema.ts:485` and `sprintUpdate.ts:384` depends on this).

⚠️ **The dangerous failure mode:** a forgotten `await` does not fail the build — it yields a
`Promise` where a row was expected, and shows up much later as a wrong number on a bar.

**`@typescript-eslint/no-floating-promises` DOES NOT CATCH THIS. Do not use it as the check.**
Proven with controls during Phase 1: a bare `Promise.resolve(1)` statement is flagged, but a real
`db.delete(vaultMeta).where(…)` with the `await` removed is **not**. Drizzle's query builders
(`PgDelete`/`PgUpdate`/`PgInsert`) extend `QueryPromise`, which the rule does not treat as
promise-like. Running it and seeing green teaches you nothing.

**The sanctioned check is a syntactic AST sweep** (TypeScript compiler API): find every expression
chain rooted at `db` or `tx`, ascend to the outermost expression, and classify how the value is
consumed — flagging any chain left as a bare expression statement. It is purely syntactic, so it
works even while types elsewhere are in flux. Validate it with a negative control (delete one
`await` and confirm it reports exactly that line) before trusting a green run.
Result at hand-off: **144 `db`/`tx` chains, 144 awaited, 0 floating.**

### Two cross-driver hazards `tsc` cannot see

1. **`.changes` does not exist on either PG driver.** node-postgres exposes `rowCount`, PGlite
   exposes `affectedRows` — so code written against one silently breaks on the other. Three sites
   depended on it (`syncRuns.recoverOrphaned`, `sprintUpdateRuns.recoverOrphaned`,
   `userNameAliases.delete`). The portable replacement is `.returning({ id }).length`. Note that
   two of those three are the **crash-recovery** paths from Increment 22 — this would have broken
   recovery on one engine only.
2. **Raw `sql<…>` aggregates BYPASS the custom type's `fromDriver`.** This is a second instance of
   the §3a trap, and the one `tsc` actively lies about: `max(${workPackageCache.updatedAtOp})`
   returns a **`Date`** while the declared type still says `string`. That value feeds OP's
   `updatedAt >d` incremental-sync filter, so it would have silently corrupted incremental sync
   with no type error. Any raw aggregate over an `isoTimestamp` or `date` column must normalise
   explicitly. **Audited across the whole repo: the only other raw `sql<…>` is a
   `cast(count(*) as int)` in the export service — not a temporal column, so this trap is confined
   to the one site, now fixed.**

### `OspDatabase` must span both drivers

`NodePgDatabase<S>` and `PgliteDatabase<S>` are different types (different `PgQueryResultHKT`), so
no driver-specific alias works. Declared in `repos.ts` as:

```ts
export type OspDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;
```

Verified directly assignable from both drivers with no cast, and deliberately not widened to `any`.

### New races created by the async conversion (found and fixed, not theoretical)

Turning adjacent synchronous statements into `await` points opens gaps that did not exist under
better-sqlite3:

- `reportConfig.ensure()` — the select→insert gap became real, so two concurrent first-callers
  would both insert `id=1` and one would take a PK violation. Now `onConflictDoNothing` + re-read.
- `connections.setCurrent()` — "clear all current flags" and "set the new one" were adjacent; a
  concurrent `getCurrent()` could observe **zero** current rows. Now wrapped in a transaction.

Any further sync→async conversion in this codebase should be read with the same suspicion.

### Behavioural change to accept: text ordering

SQLite sorted text `BINARY`; Postgres uses the database collation. `projects.list()` and
`teamMembers.list()` (`ORDER BY name`) will order mixed-case and **diacritic** names differently —
directly visible given Czech team-member names. This is a deliberate, accepted change, not a bug.

`openDb()` also becomes **async** (`Promise<DbHandle>`) — opening a pool/PGlite instance is
asynchronous. 41 call sites need `await`. `DbHandle.sqlite` is replaced by
`DbHandle.raw` (the `pg.Pool` or `PGlite` client) for the handful of tests that issue raw SQL
(`tests/src/vault-security.test.ts`, `apps/api/src/test-utils.ts`,
`apps/api/src/routes/retro-add.test.ts`, `tests/src/harness.ts`).

---

## 5. One-off data migration SQLite → Postgres

**Non-destructive. The real `apps/api/osp.sqlite` is read-only input and is never modified.**

⚠️ **A plain `cp osp.sqlite osp.sqlite.bak` CORRUPTS THE MIGRATION — but not in the way this
document originally claimed.** The live database is 1.9 MB and carries a **5.1 MB WAL**
(`osp.sqlite-wal`) plus `-shm`.

**Corrected failure mode (measured against the real file):** a plain `cp` does *not* produce
missing rows. Row counts come out **identical for every table** and `PRAGMA integrity_check`
returns `ok`. What it actually yields is **stale contents**: sprint #4 reads back as
`status='planning'`, `is_locked=0`, `completed_hours=NULL` when it is really `closed`, locked and
84.0 h — plus 63 phantom `work_package_cache_staging` rows. This is strictly worse than data loss,
because **a count-only parity check passes a silently corrupt migration.** It is the reason §5's
verification compares *values*, not just counts.

The copy step is therefore, mandatorily:

```bash
sqlite3 "apps/api/osp.sqlite" ".backup '/tmp/osp-migrate-$$.sqlite'"
```

which checkpoints the WAL into a single consistent snapshot. (Equivalent: copy all three files
together.) The script then opens **only that copy**, read-only.

Requirements: idempotent / re-runnable (truncate-and-reload the target, never append); applies the
§3 mapping (`0/1`→`boolean`, text→`timestamptz`, text→`jsonb`, ciphertext unchanged); and reports
per-table row counts SQLite vs PG with an explicit **parity OK/FAIL** verdict plus spot-checks of
sprints, baseline, changelog and capacity. It reuses the §6 export/import logic rather than
duplicating it.

---

## 6. JSON export / import format

`schema_version: 1`. Top level:

```jsonc
{
  "schema_version": 1,
  "exported_at": "2026-08-10T07:39:19.488Z",
  "source": { "app": "op-sprint-planner", "increment": 27 },
  "includes_credentials": false,
  "tables": { "<table_name>": [ { …row, snake_case column names… } ] }
}
```

Rows use the **database column names** (snake_case) and the §3 TS-facing value shapes: booleans as
`true`/`false`, timestamps as ISO-8601 strings, `*_json` columns as **parsed JSON values** (not
double-encoded strings). Order tables so that foreign keys resolve on insert.

**Included** (local, unrecoverable): `sprint`, `sprint_item`, `ticket_baseline`,
`ticket_changelog_entry`, `sprint_update_run`, `burndown_snapshot`, `sprint_closure_report`,
`sprint_member_capacity`, `capacity_edit_audit`, `team_member`, `user_name_alias`,
`estimate_override`, `done_status_rule`, `done_rule`, `remaining_status_rule`, `report_config`,
`import_selection`, `backlog_dismissal`, `project`, `op_connection` (metadata).

**Excluded** (re-syncable from OP — confirmed decision §9.1): `work_package_cache`,
`work_package_cache_staging`, `sync_run`. After import the UI tells the user to run "Sync now".

**Credentials (confirmed decision §9.2):** excluded by default. `op_connection.token_ct`,
`token_nonce`, `token_tag`, `token_encrypted` are emitted as `null`, and `vault_meta` is omitted
entirely, unless the export is requested with `include_credentials=true` — which then carries
`vault_meta` (kdf salt/params/verifier) and the token ciphertext verbatim, and requires the
passphrase at import time. The default export is safe to hand around; the credentialed one is not,
and the UI must say so.

**Import mode (confirmed decision §9.3): `replace` only.** Wipe the included tables and load, in
one transaction, behind an explicit confirmation. No merge mode in this increment.

### Four things the first draft of §6 got wrong (all found by implementing it)

1. **Replace-import cannot wipe only the included tables.** Clearing `op_connection` violates
   foreign keys from `work_package_cache.connection_id` and
   `work_package_cache_staging.connection_id / sync_run_id` — tables §6 deliberately *excludes*.
   Import must therefore also clear those three. This is semantically right, not a workaround: a
   cache keyed to connection ids that no longer exist is meaningless, and it is re-syncable. The
   import response carries `requires_resync: true` and the UI says so.
2. **Identity sequences must be advanced after loading explicit ids.** Inserting explicit primary
   keys into a `serial` column does **not** move the sequence, so the app's very next INSERT dies
   on a duplicate key. SQLite's `AUTOINCREMENT` derived its next id from `MAX(rowid)` and had no
   such failure mode, which is exactly why this is easy to miss in a port. Every imported table's
   sequence must be reset with `setval(pg_get_serial_sequence(...), MAX(id))`.
3. **`vault_meta` must be preserved on a credential-free import.** Wiping it destroys the KDF salt
   and verifier, locking the user out of a vault whose passphrase they still know — for no benefit.
   Replace `vault_meta` only when the payload actually carries one.
4. **Timestamps are re-rendered with explicit milliseconds.** `Date#toISOString()` always emits
   three digits, so a stored `"2026-07-06T23:59:59Z"` returns as `"2026-07-06T23:59:59.000Z"` —
   the same instant and still a valid `IsoDateTime`, but not byte-identical. Real data is full of
   these (retro-reconstructed `activated_at` / `captured_at` end-of-day markers). §3a's
   "round-trips exactly" holds only for input that already carries milliseconds. Dedup keys are
   built from OP journal/time-entry ids, so idempotence is unaffected.

### And one genuine timezone bug the mapping would have introduced

Rows written by SQLite's `CURRENT_TIMESTAMP` default are stored as `"2026-07-15 19:49:46"` — UTC,
but with **no zone marker**. Passed unchanged to `isoTimestamp.toDriver`, `new Date(…)` parses it
as **local** time, silently shifting it by two hours under CEST. The user's `user_name_alias` rows
are exactly this shape. Any code path that feeds legacy SQLite timestamp text into the new column
types must normalise the missing `Z` first.

The format is deliberately logical (entities), not a SQL dump — so it doubles as the SQLite→PG
migration payload (§5) and as local→server transfer.

---

## 7. Test strategy (confirmed decision §9.4)

Postgres has no `:memory:`. Today 41 `openDb()` call sites default to it.

- **Unit / integration (vitest): PGlite**, one fresh in-process instance per test — a direct
  structural replacement for `:memory:`, so `tests/src/harness.ts` and
  `apps/api/src/test-utils.ts` keep their present shape. No server, no ports, no cleanup, and
  workers stay parallel.
  **VERIFIED cost:** ~236 ms for a fresh instance with 24 tables + 30 indexes. Acceptable across
  vitest's parallel workers. If the suite does get slow, the sanctioned optimisation is PGlite's
  `dumpDataDir`/`loadDataDir` — migrate once, then restore that snapshot per test.
  **Note:** PGlite is PostgreSQL **16.4**; the server is **17.10**. Nothing in this schema is
  16-vs-17 sensitive, but it is why e2e runs on the real thing.
- **e2e (Playwright) and every live-verify: the real Docker PG 17**, against a throwaway database
  `osp_e2e_<pid>`, created before the run and dropped after.
- **Guard test** (rewrite of `tests/src/env-isolation-guard.test.ts`): fails if the target
  `DATABASE_URL` database name is not throwaway-shaped (`osp_test_*` / `osp_e2e_*` / PGlite), and
  fails hard on `osp` or `atlas-core`.

**VERIFIED PGlite quirk:** it rejects multiple SQL commands in one prepared statement
(`cannot insert multiple commands into a prepared statement`, SQLSTATE 42601). Drizzle's own
migrator is fine (it splits on `--> statement-breakpoint`), but any hand-written multi-statement
SQL — in seeds, fixtures or the migration script — must be issued one statement at a time.

---

## 8. Ops backup

`scripts/backup.sh` (`pg_dump -Fc` → timestamped file) and `scripts/restore.sh` (`pg_restore`),
both parameterised by `DATABASE_URL`, both refusing to run against a database they were not told
about explicitly. Documented in `README.md`: how to back up, how to restore, and how to stand up a
server with the same data (JSON import **or** `pg_restore`). A cron/systemd example is optional.

---

## 9. Invariants that do not change

- **The app remains strictly GET-only against OpenProject.** Nothing in this increment writes to OP.
- `docs/CAPACITY_BAR_RULES.md` remains the single source of truth for capacity/segment/closure/
  burndown/bar behaviour. This increment changes storage, **not one number**. Any diff in a
  capacity or closure figure after the cut is a migration bug, not a new rule.
- The known open bug from Increment 26 (`leafEffort`'s double-counting guard can drop a
  developer's own active ticket from Capacity's `lines`) is **out of scope** and must not be
  "fixed" opportunistically here — it would confound the before/after parity check.
