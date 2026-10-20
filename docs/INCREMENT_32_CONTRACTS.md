# Increment 32 — Off-sprint logged time ("what are the developers ACTUALLY working on") — FROZEN CONTRACTS (Phase 0)

> Product ask (user, 2026-08-19): developers visibly work on tickets that are not in the
> sprint. Detect it — TIME ONLY (status changes explicitly cut from scope) — via the OP
> GET API, for **all developers** (not just those with sprint tickets), and show it in the
> **Capacity panel** as an expandable section: per person a TOTAL of hours plus the
> concrete ticket list. GET-only to OP, as always.

## §0 Design pillars

1. **Inverted query, no ticket enumeration.** `GET /api/v3/time_entries` filtered by
   `user ∈ <developer op ids>` + `spent_on` inside the sprint's calendar window — one
   paginated read per connection. This also catches work in projects that were never
   imported (the endpoint is instance-global); the ticket's subject comes from the
   entry's own `_links.workPackage.title`, so no extra per-ticket fetches.
2. **The sprint's calendar window is authoritative** — `[start_date, end_date]`, the same
   bounds Logged uses everywhere since FOLLOWUPS #8. Client-side upper bound; the OP-side
   filter is `spent_on >=d start_date` (server-side range narrowing is an optimization,
   correctness lives client-side).
3. **Replace-on-refresh, not an event log.** Each fetch REPLACES the sprint's stored
   off-sprint rows (delete + insert in one transaction). Entries get edited and deleted
   in OP; this is a report of current truth, not history. Consequently freeze semantics
   come free: a frozen sprint runs no updates, so its last-written report simply stays.
4. **Identity through the canonical resolver** (`createPersonResolver`) — actors fold to
   one person exactly like everywhere else since the identity unification.

## §1 Who counts as "all developers"

`team_member` rows with `op_user_id != null` whose `capacityEffectiveRole(role) ===
"developer"` (i.e. everyone except explicit tester/customer/other — the same default
rule /capacity and closure share). A person with no OP id cannot be queried by the
`user` filter and is skipped (no fabrication). The roster is read at fetch time.

## §2 Data model (packages/db — Agent A)

New migration **0004** — ⚠️ MIGRATION CONVENTIONS (hard rules, learned 2026-08-19):
write it **idempotently** (`CREATE TABLE IF NOT EXISTS`), NEVER regenerate or rename an
existing migration file, and assume the user's `tsx watch` dev server may apply an
intermediate state to the real database at any moment during development.

Table `off_sprint_time_entry`:
- `id` serial PK
- `sprint_id` integer NOT NULL → sprint.id ON DELETE CASCADE
- `connection_id` integer NULL → op_connection.id (the connection the entry came from)
- `op_time_entry_id` integer NOT NULL
- `wp_op_id` integer NOT NULL
- `wp_subject` text NULL (denormalized from `_links.workPackage.title` — the WP is
  typically NOT in the local cache; never re-fetched)
- `actor_op_id` integer NOT NULL, `actor_name` text NULL (from `_links.user`)
- `spent_on` date NOT NULL (as 'YYYY-MM-DD' string mode, matching sprint dates)
- `hours` double precision NOT NULL
- `fetched_at` isoTimestamp NOT NULL
- UNIQUE (`sprint_id`, `op_time_entry_id`)
- index on `sprint_id`

Repos: `offSprintTime.replaceForSprint(sprintId, rows)` (transactional delete+insert),
`offSprintTime.listBySprint(sprintId)`. Export/import (packages/db/src/export/tables.ts)
must round-trip the new table.

## §3 Fetch & persist (apps/api — Agent A)

Inside the existing sprint update pass (`runUpdateCore`, after step F — so it runs on
manual updates, the 30-min scheduler, activation and grace updates; frozen sprints never
reach it, by the SPRINT_FROZEN gate):

1. Build the §1 roster; collect their `op_user_id`s.
2. For each connection in the run's partition set (dedup; production has one), call the
   existing `fetchAllTimeEntries(op, { filters })` with
   `[{ user: { operator: "=", values: ids.map(String) } },
     { spent_on: { operator: ">=d", values: [sprint.start_date] } }]`.
   If the OP instance rejects the `user` or `spent_on` filter (older OP — treat exactly
   like the SPEC_07 OP_QUERY_INVALID taxonomy), degrade by dropping `spent_on` first,
   then `user` LAST RESORT → in that case filter fully client-side. Never fail the whole
   update run because of this fetch: catch, log, keep the previous stored report.
3. Client-side: keep entries with `start_date <= spentOn <= end_date`, drop entries whose
   `wp_op_id` is in the sprint's item set (any outcome — a removed-mid-sprint ticket is
   still "sprint work", not off-sprint), map to §2 rows, `replaceForSprint`.
4. Best-effort by design: an OP outage → log + keep old rows (same posture as freeze's
   final update).

## §4 API (apps/api routes — Agent A)

`GET /api/sprints/:id/off-sprint-time` → `OffSprintTimeResponse`:

```
{
  window: { from: start_date, to: end_date },
  fetched_at: string | null,          // max(fetched_at) of stored rows, null = never
  total_hours: number,
  per_person: [{
    op_user_id: number,
    name: string,                      // canonical (resolver) display name
    total_hours: number,
    tickets: [{ wp_op_id, subject: string | null, hours: number,
                connection_id: number | null }]
  }]                                   // sorted by total_hours desc, then name
}
```

Aggregation server-side, actors folded via `buildPersonResolver`. Read-only, works with
a locked vault (stored rows only). Zod schemas in @osp/contracts (Agent A adds them; the
orchestrator pre-froze only this shape).

## §5 UI (apps/web — Agent B)

Capacity panel gains a collapsible subsection at the bottom:

- Header row: **"Outside the sprint"** + total hours + the window dates + a subtle
  "as of <fetched_at>" note; collapsed by default; nothing renders at all when there are
  no rows (and the section shows a one-line empty state while an active sprint has
  simply not fetched yet).
- Expanded: one row per person — name + total hours — each expandable again to the
  ticket list: `#<wp_op_id> <subject> — <hours>` (subject may be null → just the id;
  ticket ids here are typically NOT local tickets, so no jump-link — plain text).
- People WITHOUT a capacity line still appear here (the whole point: the roster is all
  developers). No new colours; muted/grey styling, British English copy.
- Data via a new `api.getOffSprintTime(sprintId)`; reload together with the panel's
  existing `refresh()` sources.

## §6 Tests

Agent A: unit tests for the fetch windowing/exclusion/degradation (mock OP client shape
like sprint-lifecycle.test.ts), repos replace semantics, endpoint aggregation + identity
folding (two spellings of one actor fold to one person). Agent B: component tests for
the section (empty/collapsed/expanded/person-expand). Orchestrator (Phase 2): e2e leg +
live-verify on a throwaway DB + the real-data check.

## §7 Hard boundaries (every agent, verbatim)

- ⛔ Repo-root CLAUDE.md DATABASE_URL/PORT guardrail applies verbatim. Unit tests =
  PGlite only; any live run = throwaway `osp_test_*` DB + non-default port; `osp` and
  `atlas-core` are OFF-LIMITS.
- ⛔ OpenProject strictly GET-only.
- ⛔ Migration rules from §2. Do not touch the sync engine's scope selection, the freeze
  machinery, or CAPACITY_BAR_RULES colours. Status-change detection is OUT OF SCOPE.
- Ownership: A = packages/db + packages/op-client (only if a filter helper is genuinely
  needed) + apps/api; B = apps/web. Contracts doc is frozen — on conflict, stop and
  report.
