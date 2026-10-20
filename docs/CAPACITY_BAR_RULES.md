# Capacity Bar Rules — CANONICAL CONTRACT (MANDATORY)

> **This document is the single source of truth for capacity / progress bar colours and their accounting in
> OP Sprint Planner.** Every agent touching `developerSegments`, capacity, closure, burndown, or any bar rendering
> MUST read and honour it. **Changing these rules means editing THIS file first**, in the same change, and updating
> the invariant tests. No code may diverge from this document.

---

## 0. Core principles
- **One function** (`developerSegments`) computes all bars. **Capacity panel, Closure, Sprint detail and PDF all read
  from the same single DTO** — never a second computation.
- Bars are **per person**. Colours are **semantic** (data), independent of Acme brand colours; keep them distinguishable.
- Only **role = developer** gets green / red / blue / hatched. **Non-developers** (tester / customer / other) always
  render as **solid grey** (role-based) and are **not** plannable capacity.

## 1. Baseline (the key concept)
- **Baseline = the set of tickets in the sprint at the moment of the MOST RECENT Activate.**
- **Re-captured on every activation.** Back to planning → Activate again → baseline = whatever is in the sprint then.
- A baseline ticket is baseline for whoever it is assigned to at that activation moment.
- *(Increment 38)* "Whoever it is assigned to at that moment" is read from the **activation
  snapshot only** (`ticket_baseline`: id + the name in its frozen OP payload, or the
  reconstructed `assignee_name_raw` for a retro sprint) — **never** from the live assignee.
  Pairing the snapshot's id with the live holder's name resolved to the CURRENT holder (identity
  is the name), so every ticket reassigned after activation lost its handoff and appeared as the
  new holder's baseline (the Cameron Dalby case: 87 h signed up, shown as 4 h).

## 2. Sprint state

### PLANNING
| Bar | When |
|---|---|
| 🟩 **Green** | **Developer** — all assigned / planned work (length = `effectiveEstimate`) |
| ⬜ **Solid grey** | **Non-developer** (tester / customer / other) — role |
| — | Developer with no assigned work → empty |

**No hatched / red / blue in planning.**

### ACTIVE / CLOSED — per developer × ticket
| Colour | Situation | Counts toward |
|---|---|---|
| 🟩 **Green** (+ logged marker) | **Baseline** ticket assigned to a developer — **ALWAYS green, whether time was logged or not** | Planned (+ Delivered if done) |
| 🟥 **Red** (+ logged marker) | Added **after** activation, developer logged time | ±Change (+ Delivered if done) |
| 🟦 **Blue** | Baseline ticket **removed** from scope after activation | − from Planned |
| ▧ **Blue-hatched** (`handoff`) | Baseline ticket **reassigned to ANOTHER developer** (redistribution; credit → finisher) — deliberately kept from Increment 17 (SPEC_17 §7): replaces Increment 15's plain-grey `redistributed` so a handoff reads as visually distinct from the "non-developer role" grey below. Do **not** repaint this to solid grey. | − (moves to other dev) |
| ▧ **Orange-hatched** | Added after activation, assigned but **not worked**, still held (idle) | informational only |
| 🟦 **Blue (churn)** | Added after activation, not worked, then **left** | informational only |
| ⬜ **Solid grey** | **Non-developer** (tester / customer) — role | not dev capacity |

> **ABOLISHED — do NOT reintroduce:** baseline tickets are **never hatched** for "not yet logged". The old grey-hatched
> *baseline-idle* state is removed. **Baseline = green regardless of logged time.**

## 3. Bar length — `effectiveEstimate`
`override` > (`remaining ≠ 0 AND remaining ≠ work` ? `remaining` : `work`). Durations parsed with **day = 24 h** (`P1DT5H` = 29 h).

## 4. Logged marker (kept — Inc 16)
On worked segments (green baseline / red added), a thin marker shows **actual logged hours** vs the estimate segment,
so overshoot is visible. **Bar length = estimate; marker = reality.**

A segment whose ticket has **no estimate at all** paints its entire logged time as the trailing
span (base = 0) — that is "never estimated", not a genuine estimate overrun, so it renders in a
distinct muted hatch (`.bar-overshoot-noestimate`) with tooltip "No estimate — Xh logged", never
the orange overshoot style/wording. Closure's OVERSHOOT figures (summary stat + per-developer
column) count **completed tickets only** and say so via tooltip — the bar's live per-segment span
and Closure's accounting metric are different numbers by design, and the UI must never let them
read as a contradiction. *(Increment 34 follow-up — the Jan Belka #11166 confusion.)*

## 5. Accounting roll-ups (identical in header, per-developer table, closure, PDF)

> **CHANGED in Increment 30 — `Planned` is now CURRENT SCOPE, not baseline.** Decided by the
> product owner against the evidence in SPEC_30 §0. Until Increment 30 this read
> *"Planned = Σ green (baseline) per developer"*, which made a developer's Planned answer
> "what were they signed up for at activation?" The number people actually read it as — and
> the one the Capacity panel's own per-person lines had always shown — is "what are they on
> the hook for **right now**?" Those diverge the moment anything is added, removed or
> reassigned after activation (the reported case: 32 h currently assigned vs 10 h still
> baseline-green). One of the two had to become *the* Planned; current scope won.
>
> **Colours are NOT affected.** §1–§4 are untouched: the same segments, the same colours, the
> same per-segment `effectiveEstimate` lengths. What changed is *which segments a roll-up
> sums*, not how any of them is painted.

- **Planned** = Σ `effectiveEstimate` of the tickets **currently in the sprint and currently
  assigned to that developer**, whatever colour their segments are. Structurally ≥ 0. A ticket
  removed from scope, or handed off to another developer, leaves the sender's Planned
  immediately; an added ticket enters it immediately. This is exactly what
  `capacity.lines[].planned_hours` has always computed — that computation is now **the**
  canonical one, and Closure / Sprint detail / PDF adopt it rather than keeping a second.
- **Baseline** = **what the developer was signed up for at the last Activate**: Σ of the
  **activation-time** estimate (`effectiveEstimate` over the frozen `ticket_baseline` snapshot,
  override-aware; a retro sprint's reconstructed `planned_hours`) over every baseline ticket
  they held at the anchor — **including** tickets later handed off (`handoff`, or passed on to a
  tester), dropped (`removed`) or taken out of the sprint (`removed_mid_sprint`). It does not
  move during the sprint: reassignments move Planned, re-estimates move bar lengths, neither
  moves Baseline. In a PLANNING sprint (no activation yet) it is the live Σ green.

  > **CHANGED in Increment 38.** Until then this read *"Σ green (baseline) per developer"* at the
  > LIVE estimate, i.e. only the baseline work a developer still RETAINED — so a developer whose
  > whole baseline was handed on read Baseline ≈ 0 and the number no longer answered its own
  > question ("what were they signed up for?"). Product-owner decision: the definition wins over
  > "Σ green". Bar colours and lengths (§1–§4) are unchanged.
- **±Change** = Σ red (added & worked, **credited only to the developer who currently holds the
  ticket**) − Σ blue (removed). Reassignment-to-other-dev (grey) is **not** counted at the sender.
  *(Increment 38)* "Removed" subtracts the **activation-time** estimate Baseline counted — both a
  `removed` segment and a baseline ticket taken out of the sprint (`removed_mid_sprint`, which has
  no segment) — so `Baseline + ±Change` balances for removals.

  > **CHANGED in Increment 30 (follow-up) — a red segment counts only for the CURRENT holder.**
  > Product-owner decision, variant A. Previously *every* developer who acquired a ticket and
  > logged on it received `+estimate`, and nothing ever cancelled it, because Increment 17 had
  > (deliberately) given the sender 0 rather than `−estimate`. With two people that is
  > invisible; with three it inflates. Measured: a 12 h ticket passing A(baseline) → B → C
  > credited **+12 to B and +12 to C**, so the sprint reported +24 h of extra scope for one 12 h
  > ticket, growing with every further hop.
  >
  > Now the positive direction follows the same rule as `Planned` (§5, invariant 7): only the
  > developer who holds the ticket **now** carries it. A mid-chain acquirer reports 0 — their
  > real work is still visible in **Delivered** and in their logged hours, which is where
  > "who did the work" belongs; ±Change answers "how did this person's scope move", and a
  > ticket they no longer hold has moved on.
  >
  > The **negative** direction is untouched: `removed` (blue) still subtracts, because that
  > ticket left the sprint entirely rather than moving to someone else. `SEGMENT_CHANGE_SIGN`
  > survives as an **upper bound** on the positive side, never as the flag itself — exactly the
  > relationship `SEGMENT_PLANNED_CONTRIBUTION` now has to `counts_to_planned`.

  ⚠️ Since Increment 30, `Planned` already reflects every one of those movements, so **±Change
  must never be added to Planned** — doing so double-counts added work. ±Change is a *flow*
  (how scope moved since activation); Planned is a *stock* (where scope stands now).

  `Baseline + ±Change` is the nearer composition, but **it is not an identity** — measured, not
  assumed. An `idle` ticket (added, held, never worked) enters `Planned` yet neither `Baseline`
  nor `±Change`, so the sum under-reports by exactly those hours; a `handoff` sender keeps their
  `Baseline` while their `Planned` has already dropped. The two coincide only for a developer
  whose every ticket is baseline-or-acquired. **Anything displaying Planned must read the
  canonical value, never reconstruct it from Baseline and ±Change.**
- **Delivered** = Σ **burned remaining work** per ticket, uniformly:
  `max(0, remaining@sprint-start − remaining@sprint-end)`, where remaining@sprint-start is
  the frozen `ticket_baseline.remaining_hours` (falling back to the estimate of record when
  the baseline carried no remaining) and remaining@sprint-end is the live remaining (active
  sprint), or the freeze-snapshot value once frozen. A **journal-gapped** reconstructed
  baseline remaining (retrospective sprints where no "Remaining work" journal precedes
  `start_date` — reconstruction then falls back to the ticket's CURRENT remaining, typically
  0 after the fact, and flags it in `reconstruction_gaps_json`) counts as **no remaining**,
  never as a number — and so does an `added_retroactively` baseline (SPEC_25), captured
  live at add-click time, AFTER the work it retro-credits. In both cases the
  estimate-of-record fallback applies (`closure.ts` `baselineRemaining`, the one
  gap-aware reader all consumers share), so a done retro-added ticket delivers its
  estimate exactly as before. A **completed** ticket's remaining@end
  is 0, so it delivers exactly what was left of it when the sprint began — for a ticket
  begun AND finished in one sprint that equals its estimate, byte-identical to the previous
  rule; for a ticket spanning sprints each sprint delivers the slice it actually burned
  instead of the final sprint absorbing the whole estimate at once (velocity stays smooth).
  Credit: a completed ticket → the developer with **max logged time** (tie → whoever moved
  it out of `in progress` to a dev-done status; unchanged); a still-open ticket's burned
  progress → the developer with max logged time **in this sprint's window**. Includes
  completed red.

  > **CHANGED in Increment 34 (user decision 3a, `docs/INCREMENT_34_CONTRACTS.md`).**
  > Until then Delivered was Σ estimate of completed tickets only — a 150 h task spanning
  > three sprints reported 0, 0, 150. The rule is deliberately UNIFORM (no "long-running"
  > kind or flag — Increment 30 §2 proved kind-based special-casing cannot express scope
  > truth): every ticket delivers its burned remaining, and the single-sprint case reduces
  > to the old number exactly. Re-estimates UP mid-sprint clamp at 0, never negative.
  > Velocity (`closure.ts` completed_hours) adopts the same rule at close time going
  > forward; already-closed sprints are NOT backfilled.
  >
  > **CHANGED in Increment 37:** the Velocity VIEW (`GET /sprints/:id/velocity`) no longer
  > displays the close-time bake at all — each history row now reads the SAME
  > `computeClosureStats` totals Closure shows (`planned_hours` := `total_planned_hours`,
  > `completed_hours` := `total_delivered_hours`), and the per-connection breakdown
  > partitions the per-ticket CREDITED delivered amounts, so it sums to the displayed
  > total exactly, by construction. The baked `sprint.completed_hours` column keeps being
  > written at close (historical artifact, cheap tie-breaker data) but no surface
  > displays it any more. Frozen sprints stay immutable via the snapshot reads
  > (invariant 10); an unfrozen closed sprint's row can move until freeze — that is the
  > same liveness Closure itself has, which is the point: ONE set of numbers.
- **Effectivity / Overshoot** of a **completed** ticket measure its estimate against the
  **cumulative developer-logged time across every sprint the ticket was a member of**
  (Σ of each such sprint's calendar-window dev-logged changelog rows — local data, frozen
  sprints included), not the final sprint's window alone. *(Increment 34, user decision
  3b: a 150 h estimate with 160 h spent across three sprints is 107 %, not "33 %".)*
  Single-sprint tickets reduce to the previous rule exactly.
- **Logged** = that developer's own time entries with `spent_on` inside the sprint's
  **calendar window** (`start_date ≤ spent_on ≤ end_date` — FOLLOWUPS #8 unification,
  2026-08-19, applied at derivation AND at read time: the burnup uses the same bounds, so
  the two surfaces reconcile. The old activation-date lower bound silently hid work logged
  between start_date and the Activate click; the missing upper bound let a grace-period
  update vacuum the SUCCESSOR sprint's work on shared/carried tickets into a finished
  sprint's Logged. Late logging during grace still counts — a late entry is backdated via
  `spent_on` into the window, which is the whole point of grace).
### 5a. Which estimate — and the two places that stay frozen (Increment 28)

The roll-ups above resolve a ticket's estimate through **`effectiveEstimate`** (§3), the same
resolution everywhere — this was already true before Increment 30 and is unchanged by it;
Increment 30 changed *which tickets* Planned sums, never *which estimate* a ticket resolves to.
The original wording follows.

The roll-ups above resolve a ticket's estimate through **`effectiveEstimate`** (§3), the same
resolution everywhere: Capacity's per-developer lines, its "Planned" header, Closure, the segments'
bar lengths and the PDF. Before Increment 28 `computeClosureStats` read the frozen
`sprint_item.planned_hours` snapshot instead, so an estimate changed *after* a ticket was added left
the green bar and "Planned" showing the old number while the capacity line showed the new one —
a §3 and §5.5 violation at once. One estimate of record, always.

Four deliberate exceptions, which are **not** drift:
- **Retrospective sprints** keep the frozen snapshot — `retro.ts` writes a reconstructed
  *historical* estimate there, and a retro sprint is about the past.
- **`closure.ts`'s `completed_hours`** (the close-time bake) and the **burndown anchor**
  (`sprint.baseline_total_hours`) stay frozen per SPEC_05's "the frozen baseline never shrinks".
  Consequence: after an estimate change, Closure's "Planned" and the burndown's starting height can
  legitimately differ. *(Increment 37: the Velocity view no longer displays the bake — see §5's
  Delivered note; the column itself keeps its frozen-at-close semantics.)*
- *(Increment 31)* **FROZEN sprints** (`sprint.frozen_at != null` — a finished sprint whose
  post-finish grace period has elapsed, `docs/INCREMENT_31_CONTRACTS.md`): the estimate of
  record is the freeze-time snapshot `sprint_item.frozen_effective_hours`, and the holder /
  status / parent edge every roll-up reads come from the sibling `frozen_*` columns. A frozen
  sprint is locally immutable BY WHERE READS LOOK: its live `work_package_cache` rows may keep
  syncing or be deleted outright (Import cleanup) without any number moving. Reactivating the
  sprint clears the freeze and returns it to the live rules above.

**Double counting** (parent and child both in the sprint) suppresses the parent's hours from the
sum — but the parent's holder **keeps a capacity line at 0 h**. A developer must never disappear
from the panel because of leaf suppression, and `has_sprint_work` stays true so the line cannot be
removed.

### 5b. How the Capacity panel DISPLAYS the roll-ups — the four slash-separated numbers

A **developer's** line on the Capacity panel prints §5's roll-ups as
**`Baseline / Planned / ±Change / Capacity`** (e.g. `32h / 40h / +0h / 40h`); hovering the
numbers shows one labelled line per number with its definition (*Increment 38* — the wording
lives in ONE place, `CAPACITY_NUMBER_DEFINITIONS` in `apps/web/src/lib/capacity.ts`).
Reading guide, in §5's terms:

1. **Baseline** — what they were signed up for at the last Activate: the estimates frozen at
   that moment, kept even when a ticket is later handed on or removed (the anchor ±Change is
   measured against).
2. **Planned** — what they hold right now: every ticket currently in the sprint and assigned
   to them (invariant 7).
3. **±Change** — how their scope moved since activation: plus added and worked, minus
   removed (signed; §5's flow number).
4. **Capacity** — their available hours for the sprint (the same value as the editable
   input beside the bar).

Worked example of the deliberate §5 non-identity: `32h / 40h / +0h / 40h` is a developer
whose baseline is 32 h and who was later handed an 8 h ticket they have **not yet logged
on** — the ticket is orange-hatched `idle`, so it is already in Planned (current scope)
but not yet in ±Change (which needs logged work) nor in Baseline. `Baseline + ±Change ≠
Planned` here **by design** — see §5's "it is not an identity" note.

Two-number lines are NOT the same format: a **non-developer or the Unassigned bucket**
prints only `planned / available` (with an em dash instead of the availability input) —
those lines have no Baseline/±Change because they are not plannable capacity (§0).

> **History, so nobody "fixes" this back:** the four-number format has existed since
> Increment 17 (the Planned/±Change structural split) and gained its current meaning in
> Increment 30 (Planned = current scope, Baseline kept as its own figure). It only *looks*
> new since the identity unification: before it, any person without an explicitly set
> developer role silently lost their per-developer closure row to identity fragmentation,
> so most lines fell back to the two-number rendering. One person = one row also meant
> everyone finally got the full four-number line.

### 5c. Scope-origin split — planned before activation vs added during the sprint (Increment 35)

A management-facing split of the sprint into **what was committed by planning** (items with
origin `baseline` — added and estimated before the Activate click, or a retro sprint's
reconstructed equivalent) and **what arrived during the sprint** (origin `added_mid_sprint`
or `added_retroactively` — retro adds are by definition work nobody planned). Two axes, both
partitioned by that origin:

- **Scope**: ticket counts and Σ `sprint_item.planned_hours` (the estimate frozen at
  plan/add time — deliberately NOT live `effectiveEstimate`: the question is "what did we
  think when we committed it", so the frozen figure is the honest one, freeze-proof and
  retro-safe by construction).
- **Reality**: Σ of the per-ticket **calendar-window dev-logged hours** the response already
  computes (§5 "Logged" window rules apply unchanged).

Headline: `added_logged_share_pct` = added.dev_logged / (baseline.dev_logged +
added.dev_logged) × 100 — "X % of developer time in this sprint went to work added during
the sprint"; `added_estimate_share_pct` analogously over estimates. Both null when their
denominator is 0. Items with outcome `removed` (dropped in planning, never committed) are
excluded entirely; `removed_mid_sprint` items stay in their origin group. Purely derived and
displayed (Closure, Reports, PDF — stat block + donut; per-ticket rows carry `origin` so the
table can badge added rows); it feeds no other number (invariant 13).

## 6. Invariants — tests MUST FAIL if violated
1. In ACTIVE/CLOSED, a **baseline** ticket on a developer renders **green** even with **zero logged time**. **Never hatched.**
2. Re-activating (planning → activate again, possibly repeatedly) **re-captures baseline**; previously-planned tickets stay **green**.
3. Only tickets added **after** the current activation use red / blue / orange-hatched.
4. Non-developers never render green/red — always solid grey. `handoff` (baseline reassigned to
   another developer) stays **blue-hatched**, never solid grey — it must remain visually distinct
   from the non-developer-role grey.
5. Planned / Delivered / ±Change and the per-developer table are **identical** across Capacity panel, Closure, Sprint detail, PDF — including *(Increment 36)* the any-state **sprint status PDF** (`POST /sprints/:id/status-pdf`), which must REUSE the same computations (capacity + closure-stats), never recompute its own — and *(Increment 37)* the **Velocity view**, whose per-sprint `planned`/`completed` are `computeClosureStats`' `total_planned_hours`/`total_delivered_hours` verbatim. A test MUST fail if Velocity's row for a sprint differs from that sprint's Closure header, or if the per-connection breakdown does not sum EXACTLY to the row's displayed completed/delivered figure.
6. `developerSegments` is **state-aware** (planning vs active/closed) — one function, no second copy.
7. *(Increment 30)* **Planned = current scope.** For every developer, their Planned equals
   Σ `effectiveEstimate` over the tickets currently in the sprint and currently assigned to
   them — so a removal, an addition or a handoff changes it immediately. A test MUST fail if
   any surface still reports the baseline sum under the name "Planned".
8. *(Increment 30)* **The header equals the sum of the rows it sits above.** The aggregate
   Planned is Σ of the per-developer Planned values **displayed underneath it** — developers
   only (§0: non-developers are not plannable capacity), consistent across Capacity, Closure,
   Sprint detail and PDF. A header that cannot be reproduced by adding up its own visible rows
   is a contract violation, not a rounding detail.
9. *(Increment 30)* **`Planned` and `±Change` are never added together** (§5): Planned already
   contains every post-activation movement. `Baseline + ±Change` is the composition that
   balances.
10. *(Increment 31)* **A frozen sprint's numbers are immutable.** For a sprint with
    `frozen_at != null`, Planned / Baseline / ±Change / Delivered / Logged, the per-ticket
    lines and the segments are IDENTICAL before and after any mutation **or deletion** of its
    `work_package_cache` rows. A test MUST fail if any read path still consults the live cache
    for a frozen sprint.
11. *(Increment 34)* **Delivered = burned remaining, uniformly.** A ticket begun AND finished
    within one sprint delivers exactly its estimate of record (the reduction to the previous
    rule MUST hold byte-for-byte); a ticket spanning sprints delivers per sprint exactly the
    remaining it burned there (`max(0, remaining@start − remaining@end)`) — a test MUST fail
    if the final sprint of a multi-sprint ticket absorbs the full estimate while an earlier
    member sprint burned part of it, and if a mid-sprint re-estimate UP makes any delivered
    figure negative.
12. *(Increment 34)* **Effectivity/Overshoot of a completed ticket use CUMULATIVE dev-logged
    time** — Σ of the calendar-window dev-logged rows of every sprint the ticket was a member
    of. A test MUST fail if a done multi-sprint ticket's delta/overshoot/accuracy read only
    the final sprint's window.
13. *(Increment 35)* **Scope-origin split is derived, never load-bearing.** The
    `scope_origin` block (planned-before-activation vs added-during-sprint — see §5c) is
    computed FROM the same per-ticket figures the response already carries
    (`planned_hours` by `origin`, the per-ticket calendar-window dev-logged) and feeds
    NOTHING else: Planned / Baseline / ±Change / Delivered / Logged / burndown /
    velocity are byte-identical with or without it. Groups: `baseline` = origin
    `baseline`; `added` = origin `added_mid_sprint` OR `added_retroactively`. Items with
    outcome `removed` (dropped before activation — never committed scope) are excluded;
    `removed_mid_sprint` items stay in their origin group (their logged hours are real —
    SPEC_05 §1). A test MUST fail if the two groups' estimates don't partition
    Σ planned_hours of the included items, if their dev-logged doesn't partition the
    per-ticket windowed dev-logged sum, or if adding the block changes any pre-existing
    figure.

14. *(Increment 38)* **Baseline = signed up for at the last Activate.** For an activated
    sprint, a developer's Baseline equals Σ activation-time estimate over the baseline tickets
    the activation SNAPSHOT assigns to them, regardless of later reassignment, re-estimate or
    removal; the baseline holder is never taken from the live assignee. A test MUST fail if a
    ticket reassigned after activation shows up as the new holder's baseline, or if the
    sender's Baseline drops (`closureStats.test.ts` "Increment 38").

## 7. Changing these rules
Edit **this file** in the same change and update the invariant tests (§6). Agents must treat this document as binding.
