# Increment 35 — Scope-origin split: planned before activation vs added mid-sprint

Frozen contracts for the parallel agents. User request (2026-08-26): management wants to
see, in Closure and in Reports, how much of a sprint was **planned, estimated and properly
committed before the Activate click** vs **added during the sprint** — as counts, hours and
a share ("developers logged X h on work that arrived mid-sprint, which was Y % of the
total"). Visual form (stat block + donut) left to us.

Binding companion: `docs/CAPACITY_BAR_RULES.md` §5c + invariant 13 (edited FIRST, same
change, per its §7).

## §0 Pillars (identical to Increments 32–34 — verbatim in every agent prompt)

1. **OpenProject stays strictly READ-ONLY (GET only).** This increment needs NO OP calls at
   all — every number derives from local tables (`sprint_item`, `ticket_changelog`).
   Never call `GET /api/v3/users` (admin-gated).
2. **Local data only, batched.** No N+1; everything this increment needs is already loaded
   by `computeClosureStats`.
3. **No backfill, no migration.** `sprint_item.origin` has existed since SPEC_05/SPEC_25;
   the block is derived at read time. **No schema change in this increment.**
4. **Separation invariant (13):** the block feeds NOTHING else. Planned / Baseline /
   ±Change / Delivered / Logged / burndown / velocity are byte-identical with or without it.
5. **⛔ DB guardrail** (CLAUDE.md, unconditional): never boot `apps/api` without explicit
   `DATABASE_URL` (throwaway `osp_test_*`/`osp_e2e_*` you created) AND explicit non-default
   `PORT` (never 3001/8099/5173). Databases `osp` and `atlas-core` are OFF-LIMITS. Unit tests
   run on PGlite (`openDb({ ephemeral: true })`) and need none of this.

## §1 Decisions of record (defaults chosen by the orchestrator, rationale inline)

- **`added_retroactively` counts as ADDED.** A retro add is by definition work nobody
  planned — exactly what management wants surfaced.
- **Group estimate = `sprint_item.planned_hours`** (frozen at plan/add time), NOT live
  `effectiveEstimate`. "What did we think when we committed it" is the honest planning
  figure; also freeze-proof (row-local) and retro-safe (retro keeps frozen snapshots,
  CAPACITY_BAR_RULES §5a exception 1). `null` planned_hours contributes 0 to hours but the
  ticket still counts in `ticket_count`.
- **Group dev-logged = the per-ticket calendar-window dev-logged** `computeClosureStats`
  already derives (`devLoggedByWp`) — same window, same effective-role rule (§5 "Logged").
  THIS sprint's window only (NOT Increment 34's cumulative figure — the question is "time
  spent in this sprint", not the ticket's lifetime).
- **Included items**: outcome ≠ `removed` (dropped in planning — never committed scope).
  `removed_mid_sprint` STAYS in its origin group (committed, worked, then descoped — its
  logged hours are real; SPEC_05 §1 posture).
- **Retro sprints**: replay already bakes origins (reconstructed baseline vs scope
  additions at their entry date) — the split works unchanged, no special-casing.
- **Integration amendment (from Agent A's correct STOP):** `per_ticket` lines have NEVER
  listed `removed_mid_sprint` rows (the long-standing shared in-scope filter), while the
  split deliberately keeps them — so Σ groups' dev-logged = Σ per_ticket dev-logged **plus
  exactly the removed_mid_sprint items' windowed hours**. The golden test pins both sides;
  the original cross-check (groups ≡ per_ticket sum) was a spec-test bug, not an
  implementation gap.

## §2 Contract additions (packages/contracts — LANDED BY THE ORCHESTRATOR in Phase 0)

```ts
// api.ts
export const ScopeOriginGroup = z.object({
  ticket_count: z.number(),
  /** Σ planned_hours over the group's items (null rows contribute 0). */
  estimate_hours: z.number(),
  /** Σ per-ticket calendar-window dev-logged hours (THIS sprint's window). */
  dev_logged_hours: z.number(),
});

// ClosureStatsResponse gains (required):
scope_origin: z.object({
  baseline: ScopeOriginGroup,   // origin === "baseline"
  added: ScopeOriginGroup,      // origin ∈ { added_mid_sprint, added_retroactively }
  /** added.dev_logged / (baseline.dev_logged + added.dev_logged) × 100; null when 0/0. */
  added_logged_share_pct: z.number().nullable(),
  /** added.estimate_hours / (Σ both estimates) × 100; null when 0/0. */
  added_estimate_share_pct: z.number().nullable(),
}),

// TicketEstimateLine gains (required):
origin: SprintItemOrigin,   // so the per-ticket table can badge added rows
```

Phase-0 stubs (already landed with the types): `closureStats.ts` emits a zeroed block +
`origin: it.origin` on per-ticket lines; `apps/web/src/test/fixtures.ts` defaults updated.
Golden tests are RED on the numbers, GREEN on shape.

## §3 Agent A — apps/api (logic + report/PDF). OWNS `apps/api/src/logic/**` ONLY.

1. **`closureStats.ts`** — replace the Phase-0 stub: partition the already-iterated items
   by origin per §1, summing `planned_hours` and `devLoggedByWp` per group; compute the two
   share percentages (null on 0 denominator). No new queries. Set `origin` on per-ticket
   lines (already stubbed — verify it's the row's origin, `it.origin`).
2. **`report.ts`** — new "Scope origin" section in the HTML the PDF renders: a headline
   line ("Added during sprint: N tickets, X h logged — Y % of developer time"), a small
   two-slice donut SVG (baseline green `--acme` green used by bars, added red — match
   the existing SVG helpers' style; label slices with %), and a compact two-row table
   (Planned before activation / Added during sprint × tickets / estimated / dev-logged).
   Handle the null-share case ("no developer time logged yet") gracefully.
3. **Unit tests** (`closureStats.test.ts`, `report.test.ts`): partition arithmetic incl.
   removed-exclusion + removed_mid_sprint retention + retro-add in added + null shares;
   report HTML contains the section and the donut for a mixed sprint, and degrades on the
   empty sprint.
4. Invariant 13 test: assert every pre-existing top-level figure of a mixed-sprint
   `computeClosureStats` result is unchanged vs the same seed evaluated before reading the
   block (in practice: assert block arithmetic AND that block values are derivable from
   `per_ticket` lines' own `origin`/`dev_logged_hours`/planned figures).

## §4 Agent B — apps/web. OWNS `apps/web/src/**` ONLY.

1. **`ClosureStats.tsx`** (shared by ClosureScreen AND ReportsScreen — one edit covers
   both): a "Scope origin" section, gated like the off-sprint section (render only when
   the sprint has any included item). Content:
   - Headline share, mirroring the off-sprint headline style: "**Y %** of developer time
     went to work added during the sprint" (em-dash fallback when null).
   - Inline SVG donut, two slices (baseline vs added dev-logged; when logged share is
     null fall back to the estimate split; both null → no donut). Colours: reuse the
     bar palette (green baseline / red added) via existing CSS variables.
   - Two-row breakdown table: group / tickets / estimated / dev logged / share.
2. **Per-ticket table**: an "added" badge (existing `.badge` style) next to the subject on
   rows with `origin !== "baseline"` — text `added` for `added_mid_sprint`, `added (retro)`
   for `added_retroactively`. Baseline rows render byte-identical to today.
3. **Fixtures**: extend `makeClosureStats` default (`scope_origin` zeroed/null) — the
   orchestrator already landed the type default; add a `makeScopeOrigin` helper if useful.
4. **Component tests** (`ClosureScreen.test.tsx`): section hidden on the zeroed default;
   mixed data → headline %, donut present, table rows, added/retro badges; null-share
   fallback. British English strings.

## §5 Golden tests (orchestrator, Phase 1 — RED first, `tests/src/scopeorigin-golden.test.ts`)

Seeded via repos on PGlite + the in-process HTTP app, one sprint:
- 2 × origin `baseline` (planned 10 + 20; windowed dev-logged 8 + 12; one of them also has
  an OUT-of-window `time_logged` row that must NOT count),
- 1 × `added_mid_sprint` (planned 5, logged 9),
- 1 × `added_retroactively` (planned 4, logged 6),
- 1 × `added_mid_sprint` with outcome `removed_mid_sprint` (planned 3, logged 2 — stays),
- 1 × `baseline` with outcome `removed` (planned 7 — excluded entirely).

Expect: baseline {2, 30, 20}; added {3, 12, 17}; added_logged_share = 17/37×100;
added_estimate_share = 12/42×100; per_ticket lines carry `origin`; and (invariant 13) the
response's `total_planned_hours`/`total_logged_hours`/`dev_logged_hours`/`per_developer`
match the same seed's values as computed today (pinned literals from a pre-change run).

## §6 Verification & ownership summary

| Who | Owns | Must not touch |
|---|---|---|
| A | `apps/api/src/logic/**` | routes, web, packages, docs |
| B | `apps/web/src/**` | apps/api, packages, docs |

Both: `pnpm --filter <pkg> typecheck` + package test suite green; goldens go green only via
the orchestrator's Phase-2 run. Orchestrator then: full `pnpm test`, full Playwright e2e,
live-verify on a throwaway DB, commit, memory.
