# Increment 30 — FROZEN CONTRACTS (Phase 0)

One canonical `Planned`, computed once, read by Capacity / Closure / Sprint detail / PDF.

**This document is frozen.** Phase-1 agents code against it. `packages/contracts` is written
in Phase 0 by the orchestrator; no agent edits it.

`docs/CAPACITY_BAR_RULES.md` is binding **and was edited in this same change** (its §7 requires
that) — §5 redefined, §6 invariants 7–9 added. Read it before this file.

---

## 0. What SPEC_30 got right, and what it got wrong — measured in Phase 0

### 0a. ❌ "Kořen A — the frontend duplicates the capacity computation" is FALSE

SPEC_30 §1 asserts the sprint board builds its bars client-side from `/items` + the paginated
backlog. It does not. `apps/web/src/lib/capacity.ts`'s live function is `applyAvailability`,
and its per-person number is taken **straight from the server**:

```ts
const planned = round1(l.planned_hours);   // l = a server CapacityLine
```

It overlays only *locally typed availability* (so a planner sees overload feedback before
saving) and re-sums the **server's own lines** for the aggregate. There is no aggregation from
backlog items anywhere in `apps/web`.

**Where the false lead came from — and the actual lesson.** That file's *header comment* still
describes the original design and is years stale:

> *"The frozen contract (SPEC §7) has no GET for a sprint's items or capacity, so the board
> derives per-assignee load directly from typed backlog data: `planned_hours` = Σ effective
> estimate-of-record of a member's sprint items"*

Both clauses are now false — `GET /sprints/:id/capacity` exists and is what the board reads.
A stale comment was read as if it were the code. **Deleting that comment is part of this
increment** (§4.3): it has now cost one full increment's worth of misdirection.

### 0b. ✅ The real mechanism — two endpoints, two different (both deliberate) concepts

The bar and the number come from different places, and for an ACTIVE sprint they answer
different questions:

| surface | source | what it sums |
|---|---|---|
| the per-person number in `/capacity` | `capacity.lines[].planned_hours` | Σ `effectiveEstimate` of the tickets **currently assigned** to that person |
| **the bar** | `/closure-stats` → `per_developer[].segments` | Σ `planned_delta_hours`, non-zero for **`baseline_worked` only** (`developerSegments.ts`, `SEGMENT_PLANNED_CONTRIBUTION`) |

`apps/web/src/components/SprintBoardScreen.tsx:1859-1860` picks the segment bar whenever the
developer has segments, and falls back to the aggregate `/capacity` rendering otherwise. So a
planning sprint agrees and an active sprint diverges the moment anything is added, removed or
handed off — exactly the reported 32-vs-10 and "Cameron 8 vs 16 (older state)".

Increment 28 already unified the **estimate of record** (both sides resolve a ticket through
`effectiveEstimate` — `closureStats.ts:327-330`). It did **not** unify **which tickets each
side sums**. That remainder is this increment.

### 0c. ⚠️ The "214.2 vs 181.2 = two definitions of Planned" comparison is not like-for-like

SPEC_30 §0 sums `planned_hours` over **every** `/capacity` line by hand (214.2, testers and
customers included) and compares it against `closure-stats.total_planned_hours` (developers
only, 181.2). `/capacity`'s **own** aggregate field is already developer-filtered
(`capacity.ts:454-455`: `is_developer || isUnassignedBucket`), so those two numbers were never
supposed to match: the 33 h gap is Increment 14/16's deliberate "capacity = developers only"
rule, not a second definition.

**What IS a genuine defect, and stays in scope:** the Capacity header shows the
developer-filtered total while the rows rendered beneath it include non-developers, so the
user cannot reproduce the header by adding up what they can see. That is now
`CAPACITY_BAR_RULES.md` §6 invariant 8.

---

## 1. Decisions taken by the product owner (Phase 0)

1. **`Planned` = current scope** — Σ `effectiveEstimate` of the tickets currently in the sprint
   and currently assigned to that developer. For the reported case Tobias Bubenik reads **32**,
   not 10. This **changed the binding contract**; `CAPACITY_BAR_RULES.md` §5 was rewritten in
   the same change, and invariants 7–9 added.
2. **The aggregate stays developers-only** — unchanged, already what `capacity.ts` does and what
   `CAPACITY_BAR_RULES.md` §0 requires. No contract change.
3. **Sprint 4 is reproduced as a fixture**, not read from the user's live database. `osp` is
   off-limits to every agent (§6). Agent D builds the reproduction and **measures** it; nobody
   asserts a production number they have not observed.

## 2. The canonical computation — one function, one DTO

- **`Planned` is computed exactly once**, in one exported helper, and consumed by `/capacity`,
  `/closure-stats`, sprint detail and the PDF. `CAPACITY_BAR_RULES.md` §0 already demanded
  this ("never a second computation"); today two computations exist, which is the whole bug.
- The canonical rule, per developer: **Σ `effectiveEstimate` over sprint items currently in
  scope whose current assignee is that developer.** This is what `computeCapacity` already
  does — so the canonical implementation is *that* one, and `computeClosureStats` adopts it
  rather than deriving Planned from segment sums.
- The aggregate is Σ of the per-developer values **that are displayed**, developers only.
- Parent/child double-count suppression keeps working exactly as `CAPACITY_BAR_RULES.md` §5a
  specifies: the parent's hours are suppressed from the sum, **but the parent's holder keeps a
  capacity line at 0 h and `has_sprint_work` stays true.** A developer must never vanish.

### 2a. Segments: colours unchanged, `planned_delta` realigned

Colours, kinds, and per-segment `estimate_hours` (bar lengths) are **untouched** — §1–§4 of the
bar rules do not move. What changes is which kinds contribute to *Planned*:

| kind | currently in scope & assigned to this dev? | contributes to Planned |
|---|---|---|
| `baseline_worked` | yes | **1** (unchanged) |
| `acquired` | yes — added after activation, held and worked | **1** (NEW) |
| `idle` | yes — added after activation, held, not yet worked | **1** (NEW) |
| `handoff` | no — moved to another developer | 0 (unchanged) |
| `removed` | no — out of scope | 0 (unchanged) |
| `churned` | no — added, then left | 0 (unchanged) |

`counts_to_planned` / `planned_delta_hours` follow this table. `counts_to_change` /
`change_delta_hours` are **not** touched — ±Change keeps its Increment-17 semantics, including
`handoff` deliberately contributing 0 at the sender.

⚠️ **A known residual to MEASURE, not to paper over.** `DeveloperTicketSegment.estimate_hours`
for an `acquired` segment is documented as *the estimate at the moment of acquisition*
(reconstructed), whereas the canonical Planned uses the **live** `effectiveEstimate`. Where an
acquired ticket's estimate changed after acquisition, `Σ planned_delta_hours` may therefore not
equal the canonical per-developer Planned. **The canonical value always wins for anything
displayed as "Planned".** Agent D measures whether a residual exists on the reproduction
fixture; if it does, it is a Phase-2 finding to be resolved deliberately — not something to
silently coerce in either direction.

## 2b. Phase-1 adjudications (orchestrator)

**(i) `packages/contracts/src/common.ts` — Agent B's edit is ACCEPTED; it was a Phase-0 gap.**
Phase 0 amended `api.ts` but left `SEGMENT_PLANNED_CONTRIBUTION` at its old values, while §2a
above instructs exactly that map to change. It is code, its sole production consumer is
`developerSegments.ts`, and leaving it stale would have made `counts_to_planned` contradict its
own doc-comment. `SEGMENT_CHANGE_SIGN` remains untouched.

**(ii) Closure now applies leaf (parent/child) filtering — this SUPERSEDES an Increment 28
statement.** `docs/INCREMENT_28_CONTRACTS.md` recorded "Closure has no leaf filtering by
design". That is precisely what let `cap.total_planned_hours` (8) and `cap.scope_planned_hours`
(12) disagree **within one response** — §0c's "the user cannot reproduce the header from the
rows", now invariant 8. `CAPACITY_BAR_RULES.md` §5a is binding and says the parent's hours are
suppressed from the sum, so the canonical answer is the leaf-filtered one. Both now read 8.
B5 is NOT regressed: the parent's holder keeps a `per_developer` row (with `baseline_hours`
intact) and a 0 h capacity line with `has_sprint_work` true.

**(iii) A SECOND residual exists that §2a did not predict — and it is the stronger argument.**
Beyond the acquisition-time-estimate gap, a ticket passing A(baseline) → B → C gives **both**
B and C an `acquired` segment, so `Σ planned_delta_hours` annotates 12 h twice for one 12 h
ticket. Canonical Planned correctly gives A 0, B 0, C 12. This is an independent, structural
reason `Σ planned_delta_hours` can never be the source of Planned — which is why §2 makes the
canonical computation authoritative and the segment field purely presentational. Measured, not
assumed.

**(iv) 🔴 DEFERRED, NOT FIXED — `scope_change_hours` double-counts on a multi-hop handoff.**
The same A → B → C shape credits `+12` to B *and* `+12` to C for one 12 h ticket, so a
sprint's Σ ±Change overstates. This is **pre-existing Increment-17 behaviour**, outside this
increment's frozen scope (§2a explicitly forbids touching `SEGMENT_CHANGE_SIGN`), and Agent B
correctly reported it instead of unilaterally changing ±Change semantics. Fixing it means
re-opening Increment 17's rule that a handoff is "neither a gain nor a loss for the sender" —
a product decision, not a refactor. **Recorded here so it is not rediscovered as new.**

## 3. Contracts (written in Phase 0 — nobody else edits `packages/contracts`)

Added to `packages/contracts/src/api.ts` — see §8 of this file for the applied definitions:

- `DeveloperCapacityBreakdown.baseline_hours` — Σ green (baseline), the number Planned used to
  be, now separately labelled (`CAPACITY_BAR_RULES.md` §5).
- `ClosureStatsResponse.total_baseline_hours` — its aggregate.
- Doc-comment amendments on `planned_delta_hours` / `counts_to_planned` recording the new kind
  set, and on `total_planned_hours` recording "current scope, developers only".

No endpoint is added or removed. No response field is deleted.

## 4. Work split

### 4.1 Agent B — `apps/api`, `packages/db`
One canonical Planned shared by `/capacity` and `/closure-stats`; `SEGMENT_PLANNED_CONTRIBUTION`
per §2a; `baseline_hours` / `total_baseline_hours` populated; aggregate = Σ displayed developer
rows; PDF and sprint detail read the same DTO. Every existing test that encodes
"Planned = Σ baseline" is **updated deliberately, with its expectation recomputed by hand** —
never mass-renamed (Increment 17's lesson: a spec hardcoding old kind names needs real
reconciliation, not a rename).

### 4.2 Agent C — `apps/web`
Bars, per-person numbers and the header read the canonical DTO fields. Header must equal the
sum of the rows displayed beneath it (invariant 8). Show `Baseline` as its own labelled figure
where ±Change is shown, and never render `Planned + ±Change` as a composition (invariant 9).
Keep the refresh behaviour Increment 29 established (`syncPollKey` vs `refreshKey`) — do not
reintroduce a mid-sync data refetch.

### 4.3 Also Agent C — delete the stale comment that caused this
Rewrite the header comment of `apps/web/src/lib/capacity.ts` so it describes what the file
actually does (availability overlay + roll-up of server lines). Leaving a comment that says the
board computes capacity from backlog data is what sent this increment chasing a bug that does
not exist.

### 4.4 Agent D — `tests/**`, `fixtures/scenarios/**`
The sprint-4-shaped reproduction (baseline + added + reassigned + a tester + a non-developer),
the measurement, and invariant tests for `CAPACITY_BAR_RULES.md` §6.7–9 — including the
cross-surface identity check (Capacity == Closure == detail == PDF) that §6.5 has always
required.

## 5. Definition of Done

- Every displayed `Planned` is the canonical current-scope number, identical across Capacity,
  Closure, Sprint detail and PDF.
- The Capacity header equals the sum of the developer rows displayed beneath it.
- `Baseline` is available and labelled; `Planned + ±Change` is never presented as a composition.
- No client-side recomputation of hours is introduced; the stale comment in
  `apps/web/src/lib/capacity.ts` is gone.
- Numbers do not move during a running sync (Increment 29's `syncPollKey` split holds).
- `CAPACITY_BAR_RULES.md` §6 invariants 1–9 all have tests, and they fail if violated.
- Full unit + Playwright suites green.

## 6. Guardrails — restated; every agent carries them

1. **Environment isolation.** Explicit `DATABASE_URL` **and** `PORT` on every run, always a
   throwaway `osp_test_*` / `osp_e2e_*` database. Neither variable has a default — never add
   one. **Off-limits for any reason, including read-only: `osp` (the user's real planning
   data — this increment's evidence lives there and is STILL off-limits), `atlas-core`, and the
   legacy `apps/api/osp.sqlite`.** Unit tests run on PGlite and need none of this.
2. **OpenProject is read-only** — `GET /api/v3/*` only, **never `GET /api/v3/users`**; the token
   never reaches a log, a response or an error.
3. **Identity is `(connection_id, name)`** — never a bare `op_id` across servers.
4. The column is **`connection_id`**, never `source_connection_id`.
5. `docs/CAPACITY_BAR_RULES.md` is binding. It was changed in Phase 0 of this increment;
   **no further change to it is authorised** without stopping and reporting.

---

## 2c. Phase-1 adjudication #2 — §2a's kind-based table was WRONG; derive from the CURRENT HOLDER

Agent D measured two shapes that §2a cannot express, and they are the same defect twice:

- **Baseline ticket reassigned to a NON-developer.** `handoff` is defined (`CAPACITY_BAR_RULES.md`
  §2) as "reassigned to ANOTHER **developer**", so a ticket handed to a tester stays
  `baseline_worked` → `counts_to_planned: true` → the bar reports 30 h while canonical Planned
  reports 0. *The bar says 30, the number says 0, for one person, on screen, at once.*
- **Multi-hop A → B → C** (§2b(iii)): both B and C get `acquired`, so the kind-based sum
  annotates one 12 h ticket twice.

**Root cause of both:** segment *kinds* encode "who held it at the baseline anchor, and did they
log on it". Canonical Planned asks "who holds it **now**". No kind-based sum can reproduce that,
so §2a's table was an approximation that fails exactly where this increment is measured.

### Frozen correction (this is NOT a new product decision)

`CAPACITY_BAR_RULES.md` §5 — already rewritten and binding — says Planned is the tickets
"currently in the sprint and **currently assigned to that developer**". Both fixes below are
that sentence applied consistently; §2a is superseded.

1. **`counts_to_planned` / `planned_delta_hours` derive from CURRENT HOLDER, not from kind.**
   A segment contributes its estimate iff the ticket is in scope **and its current holder is
   the developer this segment belongs to** — whatever colour the segment is. Colours, kinds and
   `estimate_hours` (bar lengths) remain untouched; only the two annotation fields change.
   This makes `Σ planned_delta_hours == canonical planned_hours` in every case except the
   acquisition-estimate residual, which dissolves §2b(iii) as a side effect.
2. **One holder resolution.** `closureStats` currently resolves a holder as
   `wp?.assignee_op_id ?? b?.assignee_op_id`, so an in-scope ticket with **no** current assignee
   is attributed to its frozen baseline assignee, while `computeCapacity` files it under the
   Unassigned bucket (Dostál: 6 h in Closure, 0 h in Capacity). An unassigned ticket is assigned
   to nobody: **`closureStats` adopts `computeCapacity`'s resolution — the Unassigned bucket,
   never the ex-holder.**

Without both, invariant 8 (header reproducible from the visible rows) and invariant 5
(per-developer table identical across surfaces) fail — the two invariants this increment exists
to establish.

## 2d. 🔴 DEFERRED — pre-existing: live-sprint handoff is attributed to the RECEIVER

On a **live** sprint a dev→dev handoff gives the *receiver* a green `baseline_worked` with
`in_baseline: true` and the *sender* no segment at all, contradicting the frozen
`ticket_baseline.original_assignee_op_id`. Cause: `closureStats.ts` passes
`baseline_holder_fallback: baseHolder.name` where the fallback resolves to the **current** cache
assignee, and it is used whenever no `assignee_changed` event exists at-or-before the anchor —
which on a live sprint is always, because the changelog keeps `createdAt >= activated_at` while
the interval fold absorbs only `<= anchor`.

It survived this long because `handoff` had only ever been exercised end-to-end on
**retrospective** sprints (where `retro.ts` writes `assignee_name_raw`) or against the pure
engine. **Planned is unaffected** (it follows the current holder); `baseline_hours`,
`scope_change_hours` and the segment colour are wrong. **Not caused by Increment 30** — recorded
so it is not rediscovered as new. Fixing it is its own increment.

## 2e. Phase-2 correction — "one holder resolution" means WHATEVER `computeCapacity` USES, per sprint mode

§2c told Agent B to make `closureStats` "adopt `computeCapacity`'s resolution" and, in the same
breath, that an unassigned in-scope ticket must go to the Unassigned bucket "never to its
ex-holder". He implemented `wp?.assignee_op_id ?? null` — the **live cache row only**. That is
correct for a live sprint and **wrong for a retrospective one**, and §2c is why: it described
the resolution by its *effect on one case* instead of naming its *source*.

Measured in Phase 2 — `apps/api/src/routes/index.ts:1006-1010`:

```ts
const capItemsFinal: CapacityItemInput[] = retroPlanning
  ? await buildRetroPlanningCapItems(baselines, allItems, wpById, makeConnectionResolvers(wps))
  : capItems;
```

with the surrounding comment stating outright that a retrospective sprint's roster identity
"must come from the reconstructed start_date assignee (`ticket_baseline.assignee_name_raw`) …
**NOT the live/current assignee**". `computeCapacity` therefore has *two* holder sources
selected by sprint mode, and the non-retro one is `SprintItemDetail.assignee_op_id` =
`wp?.assignee_op_id ?? baseline?.assignee_op_id ?? null` (`routes/index.ts:774`) — which does
keep a baseline fallback.

**Frozen correction.** The canonical holder for Planned is **whatever `computeCapacity` uses for
that sprint's mode** — the reconstructed assignee for a retrospective sprint, the sprint item's
assignee otherwise. Not "the live cache row", and not a second reimplementation of either.
`CAPACITY_BAR_RULES.md` §5a already carves retrospective sprints out for the *estimate* ("a
retro sprint is about the past"); the identical reasoning governs the *holder*, and §2c simply
failed to say so.

Consequence for the four Phase-2 e2e failures: two are stale expectations written against §2a
(`th-` Zbynek's `counts_to_planned`, `tj-` §4's kind-based signature table, both superseded by
§2c), and **two are this regression** (`tj-` §1 BUG 1's handoff receiver, `ti-` Dostál) — they
must be fixed in code, not in the assertions.

### 2e-RETRACTED — the §2e diagnosis above was WRONG; verified in Phase 2

§2e claimed two of the four e2e failures were a §2c regression on retrospective sprints. Agent B
disputed it with evidence and re-measured before changing anything; every one of his three points
checks out, and I verified each independently:

1. **`routes/index.ts:774` is `buildSprintItemsDetailed`** (the item-list / dimming endpoint), not
   the capacity builder. `computeCapacity`'s non-retro holder is **line 933**,
   `wp?.assignee_op_id ?? null` — **no baseline fallback**. §2c already matched it exactly.
2. **`retroPlanning = sprint.is_retrospective && sprint.status === "planning"`** (line 850). Both
   failing specs build a retro sprint and then **activate and finish** it, so at `closed` the
   reconstruction path never runs and capacity reads the live cache row. Keying closure off
   `is_retrospective` alone — what §2e effectively asked for — would have *created* an
   invariant-5 break on exactly these sprints.
3. **`tj-`:582's "receiver" is a MID-CHAIN holder.** `fixtures/scenarios/s12-handoff-attribution.ts:228-273`,
   ticket `t_handoff`: `dalby` → `bubenik` (8 h) → `benes` → `bubenik` (4 h) → **`benes` on day 4,
   final**. Bubenik is the `acquired`/red segment the spec picks up; **Beneš holds it at the end**.
   `counts_to_planned: false` on Bubenik is §2c working as designed — it is the §2b(iii) multi-hop
   shape dissolving, exactly the "side effect worth having".

**And `ti-`:702's Dostál 6 → 0 is the fix landing, not a regression.** The assertion's own text
says "falls back to the frozen baseline holder **(measured)**" — it is Agent D's recorded
measurement of the pre-§2c defect, the very one §2c was written to fix. My first instinct (stale
expectation) was right and my §2e second-guess was wrong.

**So all four Phase-2 e2e failures are stale §2a expectations.** Nothing needed fixing in code.

**One thing survives from §2e, and it is genuinely useful:** Agent B implemented the mode-aware
branch anyway, correctly conditioned on retro **planning** (reconstructed
`ticket_baseline.assignee_name_raw`, resolved by name per Increment 13) rather than on
`is_retrospective`. It aligns closure with capacity in the one place they really can differ.
⚠️ **Open item, stated honestly: no test exercises `closure-stats` on a retro sprint still in
planning**, so that branch is aligned by construction, not by measurement. It needs a fixture.
