# FOLLOWUPS — out-of-scope findings, parked deliberately

> Scope discipline (HANDOFF "Jedna identita osoby"): bugs and improvement
> opportunities noticed during the identity-unification run that were NOT
> fixed there, because they are outside its one goal (one person = one row).
> Each entry says where it lives and why it was parked.

## 1. Root `pnpm dev` defaults `DATABASE_URL` to the real `osp` database

`package.json` root script: `DATABASE_URL=${DATABASE_URL:-postgres://…/osp}`.
CLAUDE.md's guardrail promises "there is no default", but that only holds for
a direct `apps/api` boot (`server.ts` throws) — the root script *injects* the
real-DB default before the check ever runs. An agent told to "run `pnpm dev`"
would silently sit on live data (the Increment-11 incident mechanism, still
reachable). Known since the Increment-30 run; **flagged, not changed
unilaterally** — it is also the user's own documented dev entrypoint, so
removing the default is a workflow decision for the user.

## 2. `identityResolver.ts` (SPEC_13) vs `personResolver.ts` — two layers, one name

`apps/api/src/logic/identityResolver.ts` (SPEC_13 §1a: journal-name → OP id
enrichment from WP links + project memberships, used by retro/people routes)
is a *name-to-id index builder*, not a person-key definition — so it was NOT
part of the HANDOFF's "delete other definitions" mandate. But its output feeds
identity, and it now coexists with `logic/personResolver.ts` (the canonical
resolver assembly). A future consolidation could have `createIdentityResolver`
feed its learned (name ↔ id) pairs straight into `createPersonResolver`
instead of the routes threading them separately. No known bug today; pure
architecture debt.

## 3. Purged-cache tickets count their Planned as Unassigned

`computeClosureStats` §2c (Increment 30) resolves a ticket's *Planned* holder
from the LIVE cache row only ("assigned to nobody means assigned to nobody").
For a ticket whose cache row was purged by an import removal, this files the
hours under Unassigned even though the frozen baseline knows the assignee —
`/capacity` behaves identically (consistent, invariant 5 holds), but on old
sprints both surfaces may under-report a person's Planned. Changing it means
revisiting the §2c decision for the no-live-row case specifically (fall back
to `ticket_baseline` when the cache row is GONE, as classification already
does — distinct from "live row exists with null assignee"). Product decision;
parked. (The identity golden tests deliberately assert `baseline_hours`, not
`planned_hours`, for the purged-row fixtures.)

## 4. `tu-sync-coverage` §C2 / §B5a / §B5b fail on the PRE-change build too

Verified by `git stash` + running the spec file alone against the pre-identity
HEAD: the same 3 tests fail identically (§C2 "capacity moved MID-RUN
[8,…,8,23]", §B5a "#85010 must be listed. Listed: [85020]", §B5b bulk-delete
set mismatch). Not an identity regression — a pre-existing SPEC_29-area defect
(or stale test expectation) that the full suite masked until now. Needs its
own investigation; per this run's scope discipline it was not touched.

## 5. A mid-sprint scope removal is visible (blue) but not in per-developer ±Change

`computeClosureStats` filters `removed_mid_sprint` items out entirely, so the
engine's `removed` kind only ever fires for reassigned-away tickets — a scope
REMOVAL therefore never contributes −estimate to `scope_change_hours`, while
CAPACITY_BAR_RULES §5 defines ±Change as "… − Σ blue (removed)". Pre-existing
since Increment 15/17 for every explicit developer; the identity run only made
it broadly visible (per-developer rows now exist for everyone) and restored
the §2 blue VISUAL via an aggregate removed-from-sprint span on the segment
bar (`SprintBoardScreen`, `line.removed_hours`). The accounting side —
feeding scope-removed tickets into the engine as `removed` segments — is a
separate change with product implications (Planned/±Change/burndown), parked.

## 6. ✅ RESOLVED (2026-08-19, variant A) — invariant 8 broken by retroactively-added finished tickets

Found by `pnpm diag -- --sprint 2` on the user's real data (sprint "3.5.041",
closed): header 88 h ≠ Σ developer lines 80 h — exactly Cameron Dalby's
8 h. His #11882 is `origin=added_retroactively`, `outcome=done`, status
`closed`: `buildCapacityResponse`'s item filter keeps only FROZEN BASELINE
items unconditionally, and #11882 (not baseline) is dropped by the
`HIDDEN_BACKLOG_STATUSES` check (SPEC_07 §5) — so he gets NO capacity line,
while `computeClosureStats` (which only filters removed outcomes) counts his
8 h into the header both endpoints share. Increment 25 (retroactive add, which
BACKDATES done/tested tickets by design — they are *always* in a finished
status) collides with the SPEC_07 visibility filter. Fix direction: treat
`added_retroactively` like frozen baseline in the capacity item filter (its
whole point is to be a done ticket that belongs to the sprint's history), but
that moves visible lines/totals on closed sprints — product-check first.

**Resolution (variant A, user-approved):** `added_retroactively` bypasses the
hidden-status drop exactly like frozen baseline (`buildCapacityResponse` item
filter; regression test in retro-add.test.ts). Verified on the real sprint:
Dalby's line appears at 8 h and `pnpm diag -- --sprint 2` reports
"no inconsistencies found".

## 7. ✅ RESOLVED (2026-08-19, by the #8 window unification) — sprint 3.5.041: local changelog held 8 h of Tobias's time; the HANDOFF (from OP) says 12 h

The identity fix made `logged` internally consistent (closure 8 h == raw
changelog 8 h — before, the same 8 h *displayed* fragmented). But the HANDOFF's
production verification against OP time entries (#11904–#11907 = 6+3+2+1)
states 12 h, so the LOCAL `time_logged` changelog for this closed sprint is
likely missing ~4 h — a closed sprint never runs another update, so entries
logged (or re-dated) after closure are never pulled. Needs a read-only
verification against OP (`GET /api/v3/time_entries`) and, if confirmed, a
decision on backfilling closed-sprint time entries. Not an identity issue.

**Resolution:** grace-period updates (Increment 31) + the calendar-window
derivation (#8) re-pulled everything with `spent_on` inside
[start_date, end_date]. Tobias now shows a consistent 16 h across every
surface (12 h on #11904–#11907 plus in-window work elsewhere).

## 8. ✅ RESOLVED (2026-08-19) — Closure's Logged window starts at ACTIVATION; the burnup's at start_date

Found investigating "burnup 36.5h vs Closure per-developer Σ 31h" on the real
sprint Atlas.Core 3.6.001 (2026-08-19). Fully reconciled: 31 (developer rows)
+ 1 (explicit tester — in total_logged, not in the per-developer table, by
design) + **4.5 (work logged on Monday 17. 8., BEFORE the Tuesday-10:43
activation)** = 36.5. The 4.5h exists only in the burnup because Closure reads
the local `time_logged` changelog, whose derivation anchors at `activated_at`
(Increment 4) — pre-activation entries never became changelog rows — while the
burnup (fixed 2026-08-19) counts the sprint's CALENDAR window from
`start_date`. Anyone who worked between start_date and activation has their
personal Closure Logged undercounted by exactly those hours.

Unification direction: derive `time_logged` changelog rows for time entries
with `spentOn >= start_date` even when created pre-activation. That touches
the changelog windowing (Increment-4 load-bearing: dedup keys, backdated
entries, replay) — do it as its own careful change with tests, not as a drive-by.

**Resolution (user decision: the calendar window is authoritative):** Logged
now means `start_date <= spent_on <= end_date`, applied at DERIVATION
(sprintUpdate step D — the upper bound matters too: without it a grace update
vacuumed the successor sprint's work on shared tickets, measured +12.1 h) and
at READ time in computeClosureStats (rows written under the older windows stay
stored but never count). The reconstructed rebuild path and `pnpm diag`'s raw
column use the same bounds. CAPACITY_BAR_RULES §5 documents the window.

## 9. Pre-existing deferred items from Increment 30 (still open)

Recorded in `docs/INCREMENT_30_CONTRACTS.md`: (a) multi-hop dev→dev→dev
handoff still double-counts `scope_change_hours` (Increment-17 semantics —
product decision); (b) on a LIVE sprint a dev→dev handoff is attributed to the
receiver at the baseline anchor; (c) `closure-stats` on a retrospective sprint
still in planning has no test coverage. None of these are identity bugs; all
survive the unification unchanged.
