# Increment 28 — FROZEN CONTRACTS (Phase 0)

Estimate-change recalculation (§1) + double-counting marking and one-click fix (§2).
**This document is frozen.** Every Phase-1 agent codes against it.

`docs/CAPACITY_BAR_RULES.md` is binding and **this increment does not change a single colour rule**.
It changes *when things are recomputed* and *what is shown about parent/child*, not how bars are painted.

---

## 0. Evidence — measured in Phase 0, not assumed

The spec states its root cause as a hypothesis. It was tested against a running stack
(mock OP + API, isolated port 3399 / throwaway database). Results:

### 0a. ⚠️ CORRECTED — this section was WRONG. §1 is NOT frontend-only.

**The original §0a below measured the wrong number and drew the wrong conclusion.** It is kept
verbatim because the measurement itself is real and still true — it just does not say what it was
claimed to say. Corrected finding first:

`capacity.lines[].planned_hours` (what Phase 0 measured) is computed by `computeCapacity` from the
**live** `effectiveEstimate(work, remaining, override)` — so it does update immediately. But three
other numbers, including **the one the user actually complained about**, come from a different
estimate of record entirely. `computeClosureStats` (`apps/api/src/logic/closureStats.ts:290-291`):

```ts
// Estimate-of-record for this ticket = the item's frozen planned snapshot.
const estimate = it.planned_hours;
```

`sprint_item.planned_hours` is the snapshot frozen when the item was **added to the sprint**. It
feeds:

- `scope_planned_hours` — the Capacity panel's **"Planned"** headline (`routes/index.ts:1025`:
  `scope_planned_hours: stats.total_planned_hours`),
- Closure's `total_planned_hours` and every `per_developer[].planned_hours`,
- `segments[].estimate_hours` — **the green bar's LENGTH** (`SprintBoardScreen.tsx:1500`/`1541`:
  `const base = seg.estimate_hours ?? 0`).

Measured: override 5 h → 40 h leaves `lines[].planned_hours` at 40 but the **Planned headline and
the bar at 5**. That is precisely the reported symptom — "the number appears in the list but the
green bar stays old" — and **no amount of frontend refetching can fix it.**

It also puts the code in direct violation of `docs/CAPACITY_BAR_RULES.md` §3 ("Bar length =
`effectiveEstimate`") and §5 invariant 5. The binding document already says which estimate wins;
`closureStats` diverges from it.

**Therefore §1 requires a BACKEND fix as well as the frontend one.** The frontend invalidation gap
in the original §0a is real and must still be fixed — it is necessary but not sufficient.

---

### 0a (original, superseded) — the measurement that was misread

Planning sprint, WP 1401 (OP estimate 12 h), one developer:

```
BEFORE override :  capacity.lines = [("Dev Dvořák", planned=12)]
POST /api/estimate-override {wp_op_id:1401, planning_hours:40}
AFTER override  :  capacity.lines = [("Dev Dvořák", planned=40)]      ← fresh GET, correct
```

`GET /sprints/:id/capacity` reflects the new `effectiveEstimate` **immediately**. So the spec's
fix item §1.1 ("kapacita se nepřepočítá") needs **no backend work at all** — the server never
serves a stale number. What is broken is purely client-side invalidation.

**The exact gap:** `BacklogScreen.tsx:518` — `<BacklogRow … onSaved={() => state.reload()} />`
reloads only the backlog's own `useAsync`. `SprintBoardScreen`'s three states
(`sprintItemsDetailedState`, `capacityState`, `closureStatsState`) are keyed on the App-level
`refreshKey` (`App.tsx:61`), which **no estimate mutation ever bumps**.

### 0b. Double-count detection already exists — twice, inconsistently

- Backend `leafEffort()` (`apps/api/src/logic/doubleCounting.ts`) already returns
  `warnings: [{ parent_op_id, child_op_ids }]` — the grouped data §2.2 asks for. It is **never
  exposed over the API**.
- The frontend independently recomputes a *count* at `SprintBoardScreen.tsx:402`
  (`inSprint.filter(i => i.parent_op_id != null && idsInSprint.has(i.parent_op_id))`) and renders
  only "Double counting: N item(s)…" (`SprintBoardScreen.tsx:1771`).

Two implementations of one rule. This increment collapses them to one (backend).

### 0c. CONFIRMED DEFECT — a developer VANISHES from Capacity (Increment-26 class, worse than recorded)

Project memory recorded this as needing an "unrelated sibling mid-sprint-removed" to trigger.
**It does not.** Parent + child both in a plain PLANNING sprint is enough:

```
sprint = { WP 1002 "Fix login redirect bug"  (Grace Hopper, 4 h, child of 1001),
           WP 1001 "Implement login"         (Ada Lovelace, 4 h, parent) }

GET /sprints/1/capacity  →  lines = [ ("Grace Hopper", planned=4) ]
                            Ada Lovelace: ABSENT ENTIRELY — no line at all.
```

⚠️ **Struck during Phase 2:** an earlier version of this block also claimed "after Activate,
`baseline_total_hours = 4`, the parent frozen out of baseline too". That is **not** evidence of
leaf suppression — the fixture-mode mock honours only the FIRST value of an `id` filter
(`filterValueFrom`, `fixtures/mock-op-server/index.ts`), so activation fetches exactly ONE ticket
in fixture mode, and both tickets are 4 h, making the two explanations indistinguishable. Use
scenario mode, which implements the filter correctly, for anything involving activation. The
vanishing-developer finding itself stands — it was observed directly, before activation.

**Cause:** `computeCapacity` (`apps/api/src/logic/capacity.ts:193`) filters items down to
`leafEffort().leaves`, so a parent holding a present child is removed from the input set — and a
developer whose only ticket is that parent produces no line. `apps/api/src/logic/closureStats.ts`
contains **no** `leafEffort` / `parent_op_id` handling at all, so Closure does not filter.

That is a direct violation of `CAPACITY_BAR_RULES.md` §5 invariant 5 ("Planned / Delivered and the
per-developer table are **identical** across Capacity panel, Closure, Sprint detail, PDF").

**User decision: fix it in this increment** — see §2b. It is not optional scope creep: §2 puts a
"Parent" badge on exactly this ticket in the sprint list, so leaving it would ship a UI that
badges a ticket while its assignee is missing from the panel directly below.

---

## 1. §1 — recalculation contract (backend AND frontend)

### 1a. Backend — one estimate of record (added after §0a was corrected)

`computeClosureStats` must resolve a ticket's estimate through the **same `effectiveEstimate`**
the rest of the app uses (`override` > `remaining ≠ 0 ∧ ≠ work` ? `remaining` : `work`, day = 24 h),
not through the frozen `sprint_item.planned_hours` snapshot. `docs/CAPACITY_BAR_RULES.md` §3 already
mandates this and is binding; the code diverged from it.

This moves real numbers — Planned, Delivered, estimate accuracy, bar lengths — in exactly the cases
where they were **wrong** (an estimate changed after the ticket was added). That is the point of the
increment, so it is expected; but every change must be shown to be a case of "the estimate really
did change", never a silent shift on untouched data.

#### Resolved during Phase 2 — three carve-outs and one rejected requirement

1. **Retrospective sprints keep the frozen `sprint_item.planned_hours`.** `retro.ts` writes a
   *reconstructed historical* estimate into that column; a retro sprint is by definition about the
   past, so today's live estimate is the wrong number for it. Not negotiable — switching retro
   Planned and bar lengths to current estimates would silently rewrite history.
2. **No live source at all** (no cache row *and* no baseline row — e.g. after an import-removal
   cascade) also falls back to the snapshot, rather than collapsing the estimate to `null`.
3. **REJECTED: "an explicitly-passed `AddSprintItemBody.planned_hours` must still win."** This
   requirement, written into §1a before implementation, is **not implementable and has been
   dropped.** The database stores `body.planned_hours ?? effectiveEstimate(...)` in one nullable
   column, so an explicit value is indistinguishable from a snapshot. Honouring it needs a new
   `planned_hours_explicit` column → a third migration file, which collides head-on with the
   Increment-27 single-baseline migration contract (`migrations.test.ts` asserts on exactly two
   files) and would mean migrating the user's already-migrated real `osp` database again. **No
   caller passes the field** (grepped `apps/web`: zero). Revisit only if a real caller appears.

**Two other readers of the frozen snapshot are deliberately left frozen**, and this is a real
semantic boundary worth stating: `apps/api/src/logic/closure.ts` (`completed_hours` → the velocity
series) and the burndown anchor (`sprint.baseline_total_hours`, with `Σ planned_hours` as fallback
in `report.ts:61`). SPEC_05's "the frozen baseline never shrinks" requires them to stay put.
Consequence: **after an estimate change, Closure's "Planned" and the burndown's starting height can
legitimately differ.** That is by design, not drift.

### 1b. Frontend — one invalidation

**One rule: any mutation that can change an `effectiveEstimate`, or change which tickets are in the
sprint, must invalidate the WHOLE sprint DTO set — never a subset.**

Mechanically: such a mutation calls a single shared callback that bumps the App-level `refreshKey`
(`App.tsx`), which already re-keys every dependent `useAsync`. Do not add per-panel reload calls;
that is precisely the pattern that produced this bug and the Increment-24 one before it.

Mutations in scope (all of them, no exceptions):

| Path | Where today | Today's behaviour |
|---|---|---|
| Estimate override saved | `BacklogScreen.tsx:518` `onSaved` | reloads backlog only — **the bug** |
| Item added to sprint | `SprintBoardScreen` `move()` / `AddTicketByIdForm` | already calls `refresh()` |
| Item removed from sprint | `SprintBoardScreen` `move()` | already calls `refresh()` |
| Estimate changed in OP, pulled by sync | sync completion | must bump `refreshKey` |
| §2.3 bulk remove parents/children | new | must bump `refreshKey` |

`refresh()` in `SprintBoardScreen.tsx:363` already reloads all three states and is correct — the
problem is the callers that bypass it. Prefer routing everything through the App-level key so a
future panel added to the screen cannot be forgotten.

**Bar length** stays `effectiveEstimate` exactly as `CAPACITY_BAR_RULES.md` §3 defines it
(`override` > `remaining ≠ 0 ∧ ≠ work` ? `remaining` : `work`; day = 24 h). Nothing here changes it.

**Invariant to test:** after any of the above, Capacity bar, Planned, the sprint item list, Closure
and the PDF all show the **same** numbers — no panel may render from a stale copy.

---

## 2. §2 — double counting: mark, explain, offer a one-click fix

### 2a. Detection — ONE implementation, backend, ancestor-aware (DISPLAY)

Delete the frontend recomputation (`SprintBoardScreen.tsx:402`). The backend becomes the only
source and exposes groups, not a count.

Detection walks **ancestors**, not just the direct parent (spec §2.4): a ticket is flagged as a
*child* when **any** ancestor via the `parent_op_id` chain is also in the sprint, even if the
intermediate ticket is not. Handles many children per parent, several independent groups, and
chains deeper than two.

Two fields on `SprintItemDetail` (`packages/contracts/src/api.ts:701`), both always present:

```ts
/** wp_op_ids of items in THIS sprint that descend from this one (direct or deeper). */
double_count_children: z.array(OpId),
/** wp_op_id of the NEAREST ancestor of this item that is also in this sprint, else null. */
double_count_parent_of: OpId.nullable(),
```

A ticket with a non-empty `double_count_children` renders the **"Parent"** badge; a ticket with a
non-null `double_count_parent_of` renders **"Child of #<id>"**. Both carry the tooltip from §2.1.
Cache rows already hold `parent_op_id` (from `_links.parent`) — no new OP calls, ever.

⚠️ Ancestor-aware detection must be built as a **new, separate** function. Do **not** change
`leafEffort()`'s own traversal — see §2b for why.

### 2b. Accounting — numbers do NOT move, but the parent stops disappearing

The spec is explicit: *"čísla zůstávají tak jak jsou (žádné automatické vyřazování rodičů z
Planned)"*. Read together with §0c, that resolves to exactly two rules:

1. **The leaf-sum semantics stay as they are today: DIRECT parent/child only.** `leafEffort()` keeps
   its current traversal, so every existing total is unchanged. Ancestor-level detection is for
   **display only**. A grandparent + grandchild pair (middle ticket absent) therefore still
   double-counts in the sum — and that is *deliberate*: this increment's philosophy is to **mark
   the problem and let the user fix it in one click**, not to silently re-do the arithmetic. The
   new warning makes that case visible for the first time.
2. **A suppressed parent must remain VISIBLE.** `computeCapacity` must stop dropping the parent's
   row from its input. The parent contributes **0 hours** to the roll-up (unchanged totals) but its
   developer keeps a line, correctly named and role-coloured, so nobody vanishes from the panel.

Net effect: **no total anywhere changes.** `total_planned_hours`, `scope_planned_hours`,
`baseline_total_hours`, Closure's `total_planned_hours` and every per-developer number stay
byte-identical to today, except that a previously-missing developer line appears with 0 planned
hours. Agent D must prove this with a before/after comparison, not assert it.

`CAPACITY_BAR_RULES.md` needs **no edit** — §5's roll-up definitions already describe this; the
code was diverging from them, not the other way round.

### 2c. Actions — one click, confirmed, state-aware

Two bulk endpoints, both removing items from the sprint through the **existing** removal path
(`DELETE /sprints/:id/items/:wpId` semantics — `removed_mid_sprint` on an active sprint keeps the
row and its logged hours, per SPEC_05; never a hard delete that would lose history):

```
POST /api/sprints/:id/double-count/remove-parents    → removes every flagged parent
POST /api/sprints/:id/double-count/remove-children   → removes every flagged child
```

Both return the updated sprint items so the client can re-render, and both **409 on a locked
sprint** (`SPRINT_LOCKED`, Increment 4 immutability). Allowed in `planning` and `active`.

**UI (confirmed decision §5): "Remove parent(s) from sprint" is the PRIMARY, recommended action**
(plan at leaf level); "Remove children from sprint" is secondary. Both require confirmation naming
exactly which tickets will be removed — follow the `DeleteSprintButton` modal pattern, not
`window.confirm`. On a locked sprint: badges and the warning still render, **no action buttons**.

After either action: bump `refreshKey` (§1) so capacity, Planned, the list and Closure all
recompute together, and the warning disappears if the collision is gone.

### 2d. Warning text

Replace "Double counting: N item(s) have a parent also in the sprint." with the concrete groups:

```
#11165 (parent) → #11810, #11811
```

Each id is a control that scrolls its card into view and highlights it. Multiple groups list
separately. British English, matching Increment 16's convention.

---

## 3. Guardrails — unchanged, and one correction to the spec

The spec's §4 says *"žádný běh bez `OSP_DB_PATH` / test DB (Inc 27 §6)"*. **`OSP_DB_PATH` no longer
exists** — Increment 27 replaced it with `DATABASE_URL`. The rule itself stands, in its current form:

- `DATABASE_URL` and `PORT` are required, with no defaults.
- **`osp` (the user's real data — it now EXISTS, the migration has been run) and `atlas-core` (an
  unrelated project on the same Postgres server) are off-limits to every agent.**
- Agent runs use a throwaway `osp_test_*` database and an ephemeral port; unit tests use in-process
  PGlite and need neither.
- Everything toward OpenProject stays **GET-only**; no `GET /api/v3/users`; connection-scoping and
  person-identity-by-name rules from earlier increments are untouched.
