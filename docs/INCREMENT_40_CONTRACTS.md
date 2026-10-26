# Increment 40 — The OpenProject project of every ticket

Frozen contracts for the parallel agents. Research + option analysis:
`docs/INCREMENT_40_PROJECT_DRAFT.md`. **User decisions (2026-10-26):** D1 + D-freeze, I3, B1,
S1, C1 + R1, P1; off-sprint project **deferred** (not in this increment).

Goal: every ticket surface shows which OP project the ticket belongs to — today the user only
recognises it from the browser URL (`/projects/<identifier>/work_packages/<id>`).

Binding companion: `docs/CAPACITY_BAR_RULES.md`. This increment changes **no number** — the
project is a purely descriptive attribute. No per-project aggregation is added (C2/P2 were not
chosen), so no new Σ invariant; invariant 10 is **extended** (§1.4).

## §0 Pillars (verbatim in every agent prompt)

1. **OpenProject stays strictly READ-ONLY (GET only).** The one new OP call is
   `GET /api/v3/projects/{id}` plus pagination of the existing `GET /api/v3/projects`. Both go
   through `@osp/op-client`'s GET-only `request()`; the `read-only-guard` test must stay green.
   Never call `GET /api/v3/users` (admin-gated).
2. **`op_id` is the identity, `identifier`/`name` are display-only.** Never join, filter or
   dedup on a project name or identifier. A project `op_id` is unique only WITHIN one server —
   every lookup is keyed `${connection_id}:${project_op_id}` (`none:<id>` for legacy rows
   without a connection), exactly like `FilterOptionEntry.key` (Increment 23).
3. **Freeze is a snapshot** (Increment 31): a frozen sprint never reads the live cache —
   its project comes from `sprint_item.frozen_project_*` only.
4. **One resolver.** Every surface obtains the project through `resolveProjectRef` (§2.B1).
   No new ad-hoc `Map(op_id → name)` anywhere; the existing ones are deleted.
5. **No real names.** Fixtures and tests use fictional projects only (e.g. `northwind`,
   `harbor-ops`) — the public-release scrub rule.
6. **⛔ DB guardrail** (CLAUDE.md, unconditional): never boot `apps/api` without an explicit
   `DATABASE_URL` pointing at a throwaway DB you created (`osp_test_*` / `osp_e2e_*`) AND an
   explicit non-default `PORT` (never 3001/8099/5173). The `osp` database and every database
   listed in `OSP_FOREIGN_DATABASES` are OFF-LIMITS — never read, write or drop them. The
   legacy `apps/api/osp.sqlite` is never opened. Destructive features are tested only on your
   own throwaway DB. Unit tests run on PGlite (`openDb({ ephemeral: true })`) and need no
   server.

## §1 Decisions of record

### 1.1 Sources of truth
| Field | Source | Refreshed |
|---|---|---|
| `project_op_id` | WP `_links.project.href` (already stored, `toWorkPackageCacheRow`) | every WP fetch |
| `project_name` | connection-scoped `project.name` (refreshed every sync run touching the project), falling back to WP `_links.project.title` → **new** `work_package_cache.project_name` (hidden/404 projects) | every sync run / WP fetch |
| `project_identifier` | `project.identifier`, keyed `(connection_id, op_id)` | picker visit + every sync run that touches the project (§2.A3) |

`project_name` comes from the WP payload, never from the `project` table, so it is available
even for tickets whose project row is missing (add-by-id, 404 on `/projects/{id}`). The
`project` table only supplies the identifier (and its own `name` as a last-resort fallback).

### 1.2 Display (I3)
- **Web tables** (Backlog, Closure/Reports per-ticket): show the **name**; `title` tooltip =
  identifier. Name null → identifier; both null → `—`.
- **Sprint Board card + both PDFs**: show the **identifier** (short); tooltip/legend = name.
  Identifier null → name; both null → `—`.
- `project_op_id` 0 / null never renders as "Project 0" — it renders `—`.

### 1.3 Frozen vs live
- Not frozen: live values (`work_package_cache` + `project` row), with the §2.B1 fallback chain.
- Frozen: `sprint_item.frozen_project_op_id/name/identifier`, captured by `freezeSprint`,
  nulled by `reactivate()` with the other `frozen_*` columns. A frozen sprint shows the name
  **as it was at freeze time**, even after a rename in OP.

### 1.4 Invariant 10 extension (CAPACITY_BAR_RULES §6)
Append to invariant 10: *"…and the project fields (`project_op_id`, `project_name`,
`project_identifier`) on every frozen-sprint surface are likewise identical before/after any
cache mutation, cache deletion, or `project` row change/deletion."* Edit the rules file in the
same change (CLAUDE.md: rules file first).

### 1.5 Out of scope
Per-project totals (C2/P2), board project filter / colours (S2), backlog grouping (B2),
off-sprint project, parent project / subproject hierarchy.

## §2 Work split

### Agent A — data layer. OWNS `packages/db/**`, `packages/sync/**`, `packages/op-client/**`.

**A1. Migration `0006_increment40_project.sql`** (hand-written, IDEMPOTENT — `IF NOT EXISTS`
on every `ADD COLUMN`, per the 0003/0005 convention; journal entry idx 6):
```sql
ALTER TABLE "work_package_cache"         ADD COLUMN IF NOT EXISTS "project_name" text;
ALTER TABLE "work_package_cache_staging" ADD COLUMN IF NOT EXISTS "project_name" text;
ALTER TABLE "sprint_item" ADD COLUMN IF NOT EXISTS "frozen_project_name" text;
ALTER TABLE "sprint_item" ADD COLUMN IF NOT EXISTS "frozen_project_identifier" text;
```
Backfill in the same file, pure SQL, zero OP calls, re-runnable (only `WHERE … IS NULL`):
1. `work_package_cache.project_name = raw_json #>> '{_links,project,title}'`.
2. For frozen sprints (`sprint.frozen_at IS NOT NULL`), non-removed items with
   `frozen_project_name IS NULL`:
   - `frozen_project_op_id`: when null, fill from the cache row's `project_op_id`, else from
     the `ticket_baseline.raw_json` `_links.project.href` (trailing integer).
   - `frozen_project_name`: cache `project_name`, else baseline `raw_json` title.
   - `frozen_project_identifier`: `project.identifier` matched on
     `(frozen_connection_id, frozen_project_op_id)`; when `frozen_connection_id` is null, only
     if exactly ONE `project` row has that `op_id` — otherwise leave null.
   Unresolvable stays null (renders `—`). Never touch non-frozen sprints' `frozen_*` columns.

**A2. Schema + mappers + repos.** `projectName` on both cache tables and the staging merge
(`commitStaging` must copy it — add it to the column list, or the merge silently drops it);
`frozenProjectName`, `frozenProjectIdentifier` on `sprint_item`; `writeFreezeSnapshot` and the
reactivate reset include them. `projects` repo: add
`getByConnectionAndOpIds(pairs)` and make `setLastSyncedAt` connection-scoped
(`setLastSyncedAt(connectionId, opId, at)`); `getByOpId` stays only for legacy callers that
truly have no connection and is documented as collision-unsafe.

**A3. Mapper + project refresh.**
- `toWorkPackageCacheRow`: `project_name: wp._links.project?.title ?? null`.
- `op-client`: `getProject(id): Promise<OpProject>` (GET `/api/v3/projects/{id}`), with the
  same `hardCancel`/`timeout`/`instrument` wrappers as every other method (remember the
  `this ?? wrapped` lesson, Increment 20). `getProjects()` gets pagination via a
  `fetchAllProjects` helper in `paginate.ts` (offset/pageSize loop, like memberships).
- `@osp/sync` exports `refreshProjects(op, repos, connectionId, projectOpIds)`: one
  `getProject` per distinct id, upsert `{connection_id, op_id, identifier, name}` (preserve
  `last_synced_at`). **Best-effort**: a 403/404/timeout for one project is logged and skipped,
  never fails the caller; respects cancellation. Called after the cache write in: `sync()`
  (after `commitStaging`), `importWorkPackage` (add by id), the sprint update/finish pass, and
  the retro-add path — i.e. every place that writes `work_package_cache`. With a null
  `connectionId` (connection-agnostic engine path) it is a no-op; the caller that stamps the
  connection post-hoc calls it instead.
- Mock (`fixtures/mock-op-server`, owned by Agent D) provides the endpoint; Agent A codes
  against the OP shape only.

**A4. Tests** (package-local): migration test incl. backfill of all three cases (cache row,
baseline-only, ambiguous connection-less identifier → null) and idempotent re-run; mapper
reads title; staging merge keeps `project_name`; `refreshProjects` skip-on-404; pagination.

### Agent B — API. OWNS `apps/api/src/**`.

**B1. `apps/api/src/logic/projectRef.ts`** — the one resolver:
```ts
export interface ProjectRef { op_id: number | null; name: string | null; identifier: string | null }
export function createProjectResolver(projects: Project[]): {
  resolve(input: {
    frozen?: { op_id: number | null; name: string | null; identifier: string | null } | null;
    wp?: { connection_id: number | null; project_op_id: number; project_name: string | null } | null;
    baselineRawJson?: string | null;
    connectionId?: number | null;
  }): ProjectRef;
};
```
Chain: **frozen snapshot** (when given — the caller passes it only for frozen sprints, and
then never passes `wp`) → **live cache row** (`op_id` = `project_op_id` (0 → null), name =
`project_name ?? projectRow.name`, identifier = `projectRow.identifier`, row looked up by
`${connection_id}:${op_id}`; bare-`op_id` fallback ONLY when the wp's `connection_id` is null
AND exactly one row has that op_id) → **baseline `raw_json`** `_links.project` (href → op_id,
title → name, identifier via the same keyed lookup with `connectionId`) → all null. Pure, no
I/O; callers load `projects.list()` once per request.

**B2. Wire every surface through it** and delete the old maps:
- `GET /backlog` (`routes/index.ts` ~1899) and `GET /backlog/out-of-selection` (~2151).
- `sprintItemsDetailed.ts` (~112/230) — frozen branch uses the snapshot (fixes today's
  "frozen ⇒ project_name always null").
- `computeClosureStatsWithInternals` → `TicketEstimateLine` fields (§3).
- Version export identifier (~3466): connection-scoped lookup instead of `getByOpId`.
- `freeze.ts`: capture `frozen_project_op_id/name/identifier` via the resolver (live row,
  baseline fallback) — `frozen_project_op_id` now also gets the baseline fallback it lacked.

**B3. Backlog filter (B1).** `BacklogQuery.projectKey` (connection-safe, precedence over
`projectId` exactly like `assigneeKey` over `assignee`; `projectId` stays, documented
`@deprecated` collision-unsafe). `GET /backlog/filter-options` → `projects` becomes
`FilterOptionEntry[]` (key `${connection_id}:${project_op_id}`, `name` = resolved name, falling
back to identifier, then `#<op_id>`), sorted by name; cascading semantics unchanged (the
project facet drops `projectId` AND `projectKey`).

**B4. PDFs (P1)** — both `report.ts` "Per ticket" and `statusReport.ts` `ticketTableHtml`:
- New column **"Project"** right after `#`, cell = identifier → name → `—`, wrapped in
  `<span class="proj">` with `display:inline-block;max-width:14ch;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom` (a bare `td` max-width does
  not truncate in auto table layout).
- **Legend** under the table: `Projects: northwind — Northwind Payments · harbor-ops — Harbor
  Ops`, distinct non-null projects of the rows shown, sorted by identifier; omitted when no row
  has a project.
- **Single-project rule:** when every row resolves to the SAME non-null project key (and no
  row is `—`), omit the column AND the legend and add `Project: <name> (<identifier>)` to the
  sub-header line instead. Zero rows → no project line.
- HTML is escaped via the existing `esc()`.

**B5. Tests:** resolver unit table (every chain step, 0 → null, cross-server same op_id gives
two different names, connection-less ambiguity → null identifier); backlog `projectKey`
precedence + filter-options entries; items/detailed + closure stats on a FROZEN sprint return
the snapshot before AND after deleting the cache row and the `project` row (invariant 10
extension); PDF HTML: column + legend for 2 projects, single-project header variant, `—` row,
escaping. `route-access.test.ts` needs no change (no new route) — if you add one, it MUST get
an entry.

### Agent C — web. OWNS `apps/web/src/**`.

- **Backlog (B1):** sortable "Project" header (`SortKey` += `"project"`, sort by displayed
  name, case-insensitive, nulls last); filter `<select>` options from the keyed facet, the
  stored filter value is the `key` and is sent as `projectKey` (delete `projectIdByName`);
  cell shows name with `title={identifier}`.
- **Sprint Board (S1):** in `WpCard`'s `card-meta`, before the status badge, a neutral
  `<span className="badge project" title={name}>` with the identifier (fallback name); nothing
  rendered when both are null. No colour coding (must not collide with capacity-bar colours).
  `WpCard` is shared with backlog candidates — the badge appears in both columns by design.
- **Closure + Reports (C1/R1):** `ClosureStatsView` per-ticket table gets a "Project" column
  after "Ticket" (name, tooltip identifier); Reports reuses `ClosureStatsView`, so it is
  covered. The Reports "Estimate vs. actual" chart tooltip label becomes `#<id> · <identifier>`
  when known.
- `api-client`: `projectKey` param; types follow `@osp/contracts`.
- Component tests: sort, keyed filter round-trip, badge present/absent, closure column. All
  pre-existing tests stay green; update only those that assert the old `projects: string[]`
  facet shape.

### Agent D — fixtures + tests workspace. OWNS `fixtures/**`, `tests/**`.

- Mock: `GET /api/v3/projects/{id}` (404 for unknown/hidden), pagination of
  `GET /api/v3/projects` (honour `pageSize`/`offset`), a per-scenario "hidden project" switch
  (WP visible, `/projects/{id}` → 404), and a `/__mock` admin action to **rename** a project
  (name and identifier) so later fetches return the new values in both the project and the
  WPs' `_links.project.title`. Legacy membership title `Project N` → real fixture name.
- New scenario **S22 `s22-multi-project`** (fictional): one sprint spanning two projects
  (`northwind`, `harbor-ops`), a third hidden project, and a second-server scenario reusing the
  SAME project op_id with a different name.
- `tests/src/increment40-golden.test.ts` — written FIRST, RED before A/B land: backlog,
  items/detailed, closure stats expose correct `project_*` per ticket on S22; cross-server
  same id ⇒ different names; frozen sprint keeps pre-rename name after rename + cache delete;
  hidden project ⇒ name from payload, identifier null.
- e2e (`tests/e2e`, ports per `osp-e2e-tests` memory): backlog sort + filter by project,
  board badge, closure column, status PDF downloaded contains the legend.

## §3 Contract changes (`@osp/contracts`) — Phase 0, orchestrator lands these first

```ts
// entities.ts — WorkPackageCache
project_name: z.string().nullable(),            // raw _links.project.title at last fetch

// api.ts — BacklogItem (and therefore SprintItemDetail, which extends it)
project_name: z.string().nullable(),            // RESOLVED (§2.B1), unchanged field
project_identifier: z.string().nullable(),      // NEW

// api.ts — TicketEstimateLine
project_op_id: OpId.nullable(),                 // NEW
project_name: z.string().nullable(),            // NEW
project_identifier: z.string().nullable(),      // NEW

// api.ts — BacklogQuery
projectKey: z.string().optional(),              // NEW, precedence over projectId

// api.ts — BacklogFilterOptionsResponse
projects: z.array(FilterOptionEntry),           // CHANGED from z.array(z.string())
```
`SprintItemDetail.project_op_id` (inherited `OpId`) is unchanged in type and keeps its current
derivation (`frozen_project_op_id` for frozen sprints, else the cache row); only
`project_name`/`project_identifier` come from the resolver.

## §4 Phases & verification

1. **Phase 0 (orchestrator):** §3 contracts, CAPACITY_BAR_RULES invariant 10 text, golden test
   skeleton (RED).
2. **Phase 1 (parallel A/B/C/D, disjoint dirs as above).** B and C code against §3 types;
   B may stub `project_name` reads until A's schema lands (integration fixes it).
3. **Phase 2 (orchestrator):** merge, `pnpm test` (NOT `pnpm -r test`), typecheck, e2e with
   `PLAYWRIGHT_JSON_OUTPUT_NAME` (rtk truncates output), read-only guard. **Live-verify** on a
   throwaway DB + mock, e.g.:
   ```bash
   psql postgres://localhost:5432/postgres -c 'CREATE DATABASE "osp_test_inc40_lv"'
   DATABASE_URL=postgres://localhost:5432/osp_test_inc40_lv PORT=3540 OSP_AUTH=none \
     pnpm --filter @osp/api start
   ```
   Import S22, plan + activate + finish + freeze a sprint, rename a project in the mock, sync,
   and check backlog/board/closure/both PDFs (open the PDFs and look). DROP the DB afterwards.
   Migration run against a `pg_dump` copy restored into an `osp_test_*` DB is allowed only with
   the user's fresh OK — never against `osp` itself.

| Who | Owns | Must not touch |
|---|---|---|
| A | `packages/db/**`, `packages/sync/**`, `packages/op-client/**` | apps, contracts, fixtures, tests, docs |
| B | `apps/api/src/**` | web, packages, fixtures, tests workspace, docs |
| C | `apps/web/src/**` | api, packages, fixtures, tests workspace, docs |
| D | `fixtures/**`, `tests/**` | apps, packages, docs |

Version bump at commit: **v0.40.0** (minor — new feature, additive schema).

## §5 Integration amendments (Phase 2, recorded in place)

1. **Name precedence flipped** (found by Agent D): a project rename does NOT bump any WP's
   `updatedAt`, so incremental syncs never re-read the cached `_links.project.title`. The
   resolver now prefers the connection-scoped `project.name` (refreshed on every sync run that
   touches the project) and falls back to the cached WP title only when no row exists
   (hidden/404 project). §1.1 updated accordingly.
2. **Cross-server cache re-stamp fixed** (caught by the S22 golden): `setConnectionIdForProject`
   re-stamped EVERY cache row with that project op_id — importing project 8700 from server 2
   stole server 1's tickets. It now only stamps rows whose `connection_id` is NULL or already
   this connection. Side effect: the e2e `tn §7` facet assertion grouped by bare id and broke
   once tickets stayed on their own connection; it now groups by the connection-safe `key`.
3. **Coverage pass** (`POST /sync` refresh-all, out-of-selection tickets) calls
   `refreshProjectsBestEffort` after stamping the connection — the engine path can't.
4. Known, out of scope: a frozen sprint flags every card "no longer in backlog"
   (`no_longer_in_backlog: !wp`, wp map cleared by invariant 10 — pre-existing since Inc. 31);
   `getActivities` wrappers drop their `query` arg (Agent A); `OutOfSelectionEntry` has no
   `project_identifier`.
