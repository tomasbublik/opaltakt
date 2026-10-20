# Increment 36 — Sprint status PDF (any state, for delivery managers)

Frozen contracts for the parallel agents. User request (2026-08-27): from the sprint page,
in ANY sprint state, generate a PDF showing (a) total planned hours, (b) each person's
capacity, (c) the sprint's tickets with estimates, (d) each ticket's status and priority —
so it can be generated at any moment and sent to delivery managers.

Binding companion: `docs/CAPACITY_BAR_RULES.md` §6 invariant 5 (extended in this change):
the status PDF is one more surface of the SAME numbers — it must REUSE the existing
computations, never recompute its own.

## §0 Pillars (identical to Increments 32–35 — verbatim in every agent prompt)

1. **OpenProject stays strictly READ-ONLY (GET only).** This increment needs NO OP calls —
   everything renders from local data. Never call `GET /api/v3/users` (admin-gated).
2. **Reuse, don't recompute** (invariant 5/8): total planned + per-developer figures come
   from `computeClosureStats`; the capacity table from the SAME computation the
   `GET /sprints/:id/capacity` route uses; the ticket table from the SAME detailed-items
   data `GET /sprints/:id/items/detailed` serves (frozen sprints therefore keep reading
   their snapshot — invariant 10 — for free).
3. **No schema change, no migration.** One new route, one new logic module, one button.
4. **⛔ DB guardrail** (CLAUDE.md, unconditional): never boot `apps/api` without explicit
   `DATABASE_URL` (throwaway `osp_test_*`/`osp_e2e_*` you created) AND explicit non-default
   `PORT` (never 3001/8099/5173). Databases `osp` and `atlas-core` are OFF-LIMITS. Unit tests
   run on PGlite (`openDb({ ephemeral: true })`) and need no server at all.

## §1 Decisions of record

- **Route: `POST /sprints/:id/status-pdf`** — mirrors `POST /reports/:id/pdf` exactly:
  streams `application/pdf` AND writes `exports/sprint-status-<slug>-<stamp>.pdf`
  (same `GeneratePdfDeps` injection pattern — `renderPdf` injectable so unit tests never
  launch Chromium; the route default stays `chromiumPdfRenderer`). Works for EVERY sprint
  status (planning | active | closed, frozen or not) — the only 404 is an unknown sprint.
- **Content** (British English, print-friendly, matching report.ts's visual language):
  1. Header: sprint name, window (start → end), state badge (Planning / Active /
     Finished / Finished & frozen), generated-at timestamp.
  2. Summary stats: Planned (total_planned_hours), Baseline, Delivered, Logged (all) —
     straight from `computeClosureStats` (planning-state sprints simply show what those
     figures are today; no special-casing).
  3. Capacity table: one row per person from the capacity computation — name, role,
     available hours, planned hours (and the has_sprint_work distinction the panel makes,
     if cheaply available). Unassigned bucket included the way the panel shows it.
  4. Ticket table: one row per non-removed sprint item — #id, subject, assignee,
     **status**, **priority** (em dash when null — e.g. a frozen sprint whose cache row
     is gone: the snapshot carries no priority, that is expected), estimate of record,
     origin badge (added / added (retro)), multi-sprint badge where present.
- **Priority source**: the live `work_package_cache.priority` via the detailed-items
  data. NOT part of the freeze snapshot — no schema change; a frozen sprint renders "—".
- **No new zod contract needed** (binary response); the web client adds a download
  helper mirroring `downloadReportPdf`.

## §2 Agent A — apps/api. OWNS `apps/api/src/**`.

1. New `apps/api/src/logic/statusReport.ts`:
   - `buildSprintStatusHtml(repos, sprintId, generatedAt)` — assembles §1's four blocks.
     REUSE: `computeClosureStats` for the stats row; the capacity route's computation for
     the capacity table (extract the route handler's inline assembly into a shared,
     exported function if needed — the exact pattern Increment 34 used for
     `addSprintItem`; behaviour of GET /capacity must stay byte-identical, existing route
     tests prove it); the detailed-items assembly for the ticket table (same rule —
     extract/reuse, do not reimplement frozen/dimming/origin logic).
   - `generateSprintStatusPdf(repos, sprintId, deps: GeneratePdfDeps)` — clone of
     `generateReportPdf`'s file-write+stream shape with the `sprint-status-` filename.
2. Route `POST /sprints/:id/status-pdf` in routes/index.ts next to the reports PDF route,
   same headers/stream pattern, `getSprintOrThrow` only (NO closed/locked gate).
3. Unit tests (statusReport.test.ts + a route test): HTML contains all four blocks with
   values equal to the underlying computations' outputs; status badge per state incl.
   frozen; priority em-dash on frozen-with-deleted-cache; injected renderPdf (no browser).

## §3 Agent B — apps/web. OWNS `apps/web/src/**`.

1. api-client: `downloadSprintStatusPdf(sprintId)` mirroring `downloadReportPdf`
   (blob download, Content-Disposition filename fallback).
2. Sprint board page: an "Export status PDF" button visible for EVERY sprint state,
   placed with the sprint header controls (near SprintControls — match existing button
   styles), disabled+spinner while generating, error surfaced like other actions there.
3. Component tests: button present in planning/active/locked states, click calls the
   download helper, busy state, error path. All pre-existing tests stay green unedited.

## §4 Golden/integration test (orchestrator, Phase 1 — RED first)

`tests/src/statuspdf-golden.test.ts`: seeded sprints in planning/active/closed states via
repos on PGlite + in-process app; `POST /sprints/:id/status-pdf` → today 404; after
Agent A: 200, `content-type: application/pdf`, body starts `%PDF`, plausible size. (The
HTML-level number equality lives in Agent A's unit tests where the renderer is injected.)

## §5 Verification & ownership

| Who | Owns | Must not touch |
|---|---|---|
| A | `apps/api/src/**` | web, packages, docs, tests/ workspace |
| B | `apps/web/src/**` | apps/api, packages, docs, tests/ workspace |

Both: package typecheck + package tests green; the golden goes green in the
orchestrator's integration run, which also adds the e2e coverage, runs the full suites,
live-generates a PDF on a throwaway DB and visually inspects it.
