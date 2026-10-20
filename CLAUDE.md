# OP Sprint Planner — project instructions

## ⛔ HARD GUARDRAIL — never run this app's dev server against the real DB or default ports

**Incident (Increment 11):** a background agent ran `pnpm --filter @osp/api dev` with no
`OSP_DB_PATH` and no `PORT` override. It silently connected to the user's real
`apps/api/osp.sqlite` and, while live-testing the new Delete-sprint feature in the browser,
permanently deleted **all of the user's real sprints** (baseline, changelog, burndown,
capacity, closure — everything Delete cascades). OpenProject itself was never touched (this
app is GET-only to OP by a separate, unrelated invariant) — the loss was purely local
planning data, with no undo.

Since **Increment 27** persistence is **PostgreSQL**, not SQLite. The incident's mechanism —
a process silently reaching the real database because the target had a default — transfers
directly, so the rules transfer with it. Only the name of the variable changed.

**This must never happen again. Rules — unconditional, not suggestions:**

1. **Never** start `apps/api` (`dev`, `start`, or any script that boots the server) without
   explicitly setting `DATABASE_URL`. There is no default — `apps/api/src/server.ts`
   (`resolveDatabaseUrl`) throws immediately if it's unset. Do not "fix" that by adding a
   fallback back in; the fallback is exactly what caused the incident.
2. **Never** start `apps/api` without explicitly setting `PORT` either — same reasoning
   (`apps/api/src/index.ts`, `resolvePort`), so a stray process can never silently bind the
   same port the user's own dev session uses.
3. Every dev/mock/e2e/live-verify invocation you run — as the main agent or as any
   subagent — **must** target a throwaway database you created for that run, named
   `osp_test_*` or `osp_e2e_*`, plus a non-default, ephemeral `PORT` (never 3001/8099/5173,
   the app's own defaults). Example:
   ```bash
   psql postgres://localhost:5432/postgres -c 'CREATE DATABASE "osp_test_agent_1"'
   DATABASE_URL=postgres://localhost:5432/osp_test_agent_1 PORT=3999 \
     pnpm --filter @osp/api start
   # …and DROP DATABASE when you're done.
   ```
   Unit tests don't need any of this: they run on **PGlite**, in-process and ephemeral by
   construction (`docs/INCREMENT_27_CONTRACTS.md` §7).
4. **Databases that are off-limits to any agent, for any reason:**
   - **`osp`** — the user's real planning data. Not for "just checking", not for a migration
     dry-run, not read-only.
   - **Every database listed in `OSP_FOREIGN_DATABASES`** (untracked `.env.local`) — those
     belong to completely unrelated projects that share the same Postgres instance. Never
     read, never write, never drop. Machine-specific details live in `CLAUDE.local.md`.
   - The legacy **`apps/api/osp.sqlite`** (plus its `-wal`/`-shm` files) — retained as the
     pre-migration rollback copy. Read-only input to the one-off migration script, via a
     WAL-safe `sqlite3 … ".backup"` snapshot; never opened in place, never modified, never
     deleted.
   Connect to the `postgres` maintenance database only to `CREATE`/`DROP` your own throwaway.
5. **Destructive features** (Delete sprint, vault reset, DB migrations, JSON import in
   replace mode) are tested **exclusively** against a throwaway DB you created for that
   purpose. If you are not certain a database is one you created in this session, do not
   write to it, and do not delete anything in it.
6. When orchestrating parallel subagents (Task/Agent tool), this rule goes in **every**
   agent's prompt explicitly, every time — do not assume a shared memory or a prior
   instruction covers it. State the exact env vars each agent must use.

`tests/src/env-isolation-guard.test.ts` enforces rules 1–4 mechanically: it fails the suite
if a run targets anything that isn't a throwaway database. It is the codified memory of a
real data-loss incident — treat a failure there as a stop-the-line event, never as a test to
relax.

If you are ever unsure whether a command you're about to run could touch the real
database, stop and point it at an explicit, obviously-scratch `DATABASE_URL` — there is no
legitimate reason for an agent to omit it.

## Capacity bar contract — MANDATORY

Any change to capacity / segment / closure / burndown / bar rendering **MUST** follow
`docs/CAPACITY_BAR_RULES.md`. That document is the single source of truth for bar colours,
baseline semantics, and roll-up accounting across Capacity panel, Closure, Sprint detail,
and PDF. Changing these rules means editing that file first, in the same change, and
updating its §6 invariant tests. No code may diverge from it.

## Working conventions

- Reply to the user in Czech; code, comments, and commits stay in English.
- Multi-agent orchestration for larger increments follows Phase 0 (frozen contracts) → N
  parallel specialists on disjoint directories → Phase 2 integration. See project memory
  (`osp-work-style`, `osp-run-and-test`) for the established pattern and current state.
- Commit coherent changes; do not push (no remote in use, branch `build/op-sprint-planner`).
- Always live-verify a change against a running instance — **on isolated ports/DB per the
  guardrail above** — rather than trusting only the automated test suite.
