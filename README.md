# OpalTakt

OpalTakt (formerly "OP Sprint Planner") is a local, single-user "Head of Dev cockpit" over an OpenProject instance. OpenProject
is a **read-only source of truth** — the app **never writes to OP**. All sprint
planning (sprints, capacity, burndown, velocity, closure) lives locally in PostgreSQL.

See `Sprint Planning nad OP/SPEC_OP_Sprint_Planner.md` for the full specification.

## Architecture

pnpm-workspaces monorepo, Node 24, TypeScript (ESM):

```
packages/
  contracts/   @osp/contracts  — Zod schemas + TS types for every entity (§4) and
                                 REST endpoint (§7), error codes. THE frozen contract.
  db/          @osp/db          — Drizzle PostgreSQL schema (24 tables) + migrations +
                                 repository implementations + openDb() factory.
  op-client/   @osp/op-client   — GET-only OpenProject v3 client (Basic auth,
                                 pagination, 429 retry). Non-GET throws before any I/O.
  sync/        @osp/sync        — incremental/full sync, time-entry aggregation,
                                 drift reconciliation, pure burndown-snapshot writer.
apps/
  api/         @osp/api         — Fastify backend: all §7 endpoints, §6 business logic
                                 (estimate override, leaf de-dup, per-assignee capacity,
                                 done/rejected rules, burndown, velocity, closure,
                                 version deep-link), DI, node-cron nightly snapshot job.
  web/         @osp/web         — React + Vite UI: setup, backlog, dnd-kit sprint board,
                                 Recharts burndown/velocity, closure + OP deep-link.
fixtures/      @osp/fixtures    — OP v3 fixtures + GET-only mock OP server.
tests/         @osp/tests       — A↔B integration, read-only guard, burndown math,
                                 Playwright e2e.
```

Data flow: `React (web) → local Fastify API → PostgreSQL`, and `API → op-client → OpenProject`
(GET only). The OP token never reaches the browser — the backend is the only client of OP.

## Prerequisites

- Node.js **24** (see `.nvmrc`)
- pnpm **11+**
- PostgreSQL 14–18 on `localhost:5432` (any local install or container). This
  application uses its own persistent `osp` database, created once with
  `createdb osp`.

## Configure

```bash
cp .env.example .env.local   # untracked — your DATABASE_URL, PORT, OSP_FOREIGN_DATABASES
```

## Install

```bash
pnpm install
```

## Run (development, against the mock OP server)

```bash
# API, web UI and mock OpenProject at once. DATABASE_URL and PORT come from
# .env.local — there is no default, the script refuses to start without them:
pnpm dev

# — or three separate terminals, same effect:

# terminal 1 — mock OpenProject on http://127.0.0.1:8099
pnpm mock:op

# terminal 2 — API on http://127.0.0.1:3001 (Postgres database `osp`)
DATABASE_URL=postgres://dev@localhost:5432/osp PORT=3001 OSP_AUTH=none pnpm --filter @osp/api dev

# terminal 3 — web UI on http://127.0.0.1:5173 (proxies /api → :3001)
pnpm --filter @osp/web dev
```

> **`DATABASE_URL` and `PORT` have no default in the API itself (SPEC_12 §0, SPEC_27 §6) — it refuses
> to start without them, on purpose.** The root `pnpm dev` script supplies explicit local-development
> defaults; override either variable when you need another target. This is a hard guardrail, not an oversight: a
> background agent once ran `pnpm --filter @osp/api dev` bare, silently landed on the real
> database, and destroyed real sprint history while live-testing the Delete-sprint
> feature. Every invocation — yours included — now has to say explicitly which DB it
> means. **Never run `pnpm --filter @osp/api dev|start` (or the mock/web dev servers)
> against default ports, and NEVER against the real `osp` database, from an agent or
> automated script** — always point `DATABASE_URL` at a throwaway database (`osp_test_*` /
> `osp_e2e_*`, created and dropped for that run) and pass a non-default `PORT`. Unit tests
> need neither: they run on in-process PGlite. See `CLAUDE.md` for the full rule.

Open http://127.0.0.1:5173, and on the **Setup** screen use base URL `http://127.0.0.1:8099`
with any non-empty token (the mock ignores auth). Then go to **Import**.

### Importing work (multi-project, additive)

On the **Import** screen: pick a project, then (optionally) pick one of its versions — the
version list has a fulltext search filter, and "All versions" imports the whole project.
Click **Import**. Repeat for more projects/versions; the backlog is the **union** of every
import (filterable by project). "Sync now" refreshes exactly what was imported (a
version-limited import stays limited). **Closed / Resolved / Rejected / Tested** work packages
are hidden from the backlog (still cached, so a ticket that changes state mid-sprint is tracked
in burndown/closure). You can also **add a single ticket by its OpenProject id** on the Import
screen (a GET id-filter fetch) — handy for pulling in one specific work package.

### Run against a real OpenProject

Point the Setup screen (or `POST /api/connection`) at your real OP base URL and an API
token. Auth is HTTP Basic `apikey:<token>`. The client is GET-only, so nothing is ever
written back to OP.

## Simulating OpenProject changes (mock)

To make the mock feel like a live OpenProject during a demo, `fixtures/sim.ts` lets you
edit the mock's own backing data (statuses, spent time). The mock server re-reads
`work_packages.json` and `time_entries.json` **fresh on every request**, so a change
appears on the next **"Sync now"** (or `POST /api/sync`) — no mock restart needed.

**This does NOT violate the app's read-only guarantee.** The app still only ever *GETs*
OpenProject; here *you* (acting as the OP admin) edit the mock's JSON files directly. The
app never writes to OP.

The org's 10 work-package statuses (mirrors `fixtures/data/statuses.json`):

| id | name | closed? |
|----|------|---------|
| 1  | New            | no  |
| 2  | Confirmed      | no  |
| 7  | In progress    | no  |
| 3  | Developed      | no  |
| 4  | Merge pending  | no  |
| 5  | Tested         | no  |
| 6  | On hold        | no  |
| 14 | Rejected       | yes |
| 15 | Resolved       | yes |
| 12 | Closed         | yes |

### Log time on a task

```bash
# Log 3h on WP 1008 on a given day (spentOn), optionally with a user + comment.
pnpm --filter @osp/fixtures sim log-time --wp 1008 --hours 3 --on 2026-07-02 --user 2 --comment "review + fixes"
```

This appends a time entry to `time_entries.json` and recomputes that WP's `spentTime` to
the cumulative logged hours. Then click **"Sync now"** in the app (or `curl -XPOST
http://127.0.0.1:3001/api/sync`) to pull it in.

### Change a task's status

```bash
# Status name is case-insensitive and matched against statuses.json.
pnpm --filter @osp/fixtures sim set-status --wp 1008 --status "Merge pending"
pnpm --filter @osp/fixtures sim set-status --wp 1010 --status resolved
```

This repoints the WP's `_links.status` (href + title) and bumps `updatedAt`. Sync again to
see the new status (and, for closed statuses like Resolved/Rejected/Closed, the item is
treated as done in burndown/velocity).

## Configuration (environment variables)

| Var | Default | Used by |
|---|---|---|
| `PORT` / `HOST` | *(none — required)* / `127.0.0.1` | API |
| `DATABASE_URL` | *(none — required)* | API (Postgres connection string, e.g. `postgres://dev@localhost:5432/osp`) |
| `OSP_AUTH` | *(none — required)* | API — `entra` (Microsoft Entra ID sign-in) or `none` (no sign-in, everyone is a Planner). See [Authentication](#authentication) |
| `OSP_PUBLIC_URL` | *(none — required for `entra`)* | API — browser-facing origin, e.g. `http://localhost:5173`; redirect URI is `${OSP_PUBLIC_URL}/api/auth/callback` |
| `OSP_SESSION_SECRET` | *(none — required for `entra`)* | API — base64 of ≥ 32 random bytes (`openssl rand -base64 48`); encrypts the session cookie |
| `OSP_ENTRA_TENANT_ID` / `OSP_ENTRA_CLIENT_ID` | *(none — required for `entra`)* | API — Entra tenant and app (client) GUIDs |
| `OSP_ENTRA_CLIENT_SECRET` | *(none — required for `entra`)* | API — app client secret; never logged, never returned |
| `OSP_GIT_SHA` | `git rev-parse --short HEAD` | API + web build — reported by `/api/version` |
| `OSP_FOREIGN_DATABASES` | *(empty)* | other projects' databases on the same Postgres server; tests and restore/migration scripts refuse them |
| `OSP_SNAPSHOT_CRON` | `0 2 * * *` | nightly burndown-snapshot job |
| `OSP_DISABLE_SCHEDULER` | — | set `1` to disable the cron job |
| `MOCK_OP_PORT` / `MOCK_OP_HOST` | `8099` / `127.0.0.1` | mock OP server |
| `VITE_API_URL` | `http://127.0.0.1:3001` | web dev proxy target |
| `WEB_URL` | `http://127.0.0.1:5173` | Playwright baseURL |

> **Token storage (MVP):** the OP token is stored **as-is** in `op_connection.token_encrypted`
> (no encryption) per the MVP decision. Encrypting at rest (OS keychain / passphrase) is an
> M5 hardening item — see below.

## Authentication

`OSP_AUTH` is **required, with no default** — the API refuses to start without it (same
philosophy as `DATABASE_URL`/`PORT`: a forgotten setting must never silently deploy an open app).

| Mode | Behaviour |
|---|---|
| `none` | No sign-in. Every request acts as a synthetic **Local user** with the `Planner` role. For local single-user use, unit tests and e2e. |
| `entra` | OpenID Connect authorization-code flow with PKCE against Microsoft Entra ID (confidential client). All of `OSP_PUBLIC_URL`, `OSP_SESSION_SECRET`, `OSP_ENTRA_TENANT_ID`, `OSP_ENTRA_CLIENT_ID`, `OSP_ENTRA_CLIENT_SECRET` are required; startup lists any that are missing. |

**Roles** come from the ID token's `roles` claim (Entra *App roles*):

- **Planner** — everything.
- **Viewer** — sees every planning screen and report and can generate report PDFs, but can
  never change planning data or configuration and never causes any OpenProject traffic
  (Import/Setup/Data are Planner-only, so are reads that contact OpenProject).
- Signed in with neither role → `403 NO_ROLE` on every protected route.

The backend enforces this: every API route declares its access level (`public` / `viewer` /
`planner`) and the server refuses to start if one doesn't.

**Sessions** are stateless: an encrypted (AES-256-GCM), httpOnly, `SameSite=Lax` cookie
`osp_session` (`Secure` when `OSP_PUBLIC_URL` is https), 8 h absolute lifetime, no refresh
tokens. A restart signs nobody out; rotating `OSP_SESSION_SECRET` signs everybody out.

**Entra app registration** (Azure portal → *Microsoft Entra ID* → *App registrations* → *New*):

1. Platform **Web**, redirect URI `${OSP_PUBLIC_URL}/api/auth/callback`
   (e.g. `http://localhost:5173/api/auth/callback` behind the Vite dev proxy). Front-channel
   logout URL optional; sign-out returns to `${OSP_PUBLIC_URL}/`.
2. *Certificates & secrets* → new client secret → `OSP_ENTRA_CLIENT_SECRET`.
   *Overview* → Application (client) ID → `OSP_ENTRA_CLIENT_ID`, Directory (tenant) ID →
   `OSP_ENTRA_TENANT_ID`.
3. *App roles* → create two roles, allowed member type *Users/Groups*, values exactly
   **`Planner`** and **`Viewer`**.
4. *Enterprise applications* → this app → *Properties* → **Assignment required = Yes**, then
   *Users and groups* → assign people/groups to a role.

The endpoints are built from Entra's documented per-tenant v2 pattern
(`https://login.microsoftonline.com/<tenant>/oauth2/v2.0/{authorize,token,logout}`, JWKS at
`/discovery/v2.0/keys`, issuer `…/<tenant>/v2.0`) — there is **no discovery request**, so
`/api/auth/login` never makes an outbound call. The callback verifies state, nonce, PKCE and the
ID token's signature, issuer, audience and expiry (via `openid-client`); a failure redirects to
`/?auth_error=<code>` (`access_denied`, `idp_error`, `login_expired`, `callback_failed`).

## Versioning

The app follows [SemVer](https://semver.org). The **single source of truth** is the
`version` field of the root `package.json`; every release is a git tag `v<version>`.

- `GET /api/version` → `{ version, git_sha, schema_migration }` — the API's own build.
- The web header shows `v<version>` (hover for the git SHA). If the web build and the API
  report different versions (a stale tab after a deploy), the badge turns amber.
- Container builds have no `.git`, so they pass the SHA in via `OSP_GIT_SHA`.

Release: bump `version` in the root `package.json`, commit, `git tag v<version>`.

## Sprint freeze & the post-finish grace period (Increment 31)

Once a sprint is **finished**, a grace period starts (default **3 days**, configurable on
the **Settings** tab, anchored at the moment you clicked Finish). During grace the sprint
still accepts update runs — late time logs and final status flips keep arriving (the
30-minute scheduler updates it automatically). When the grace period elapses, the sweep
**freezes** the sprint:

- its numbers are snapshotted onto its own rows and become **immutable** — Capacity,
  Closure and the item list read the snapshot, never the live cache, so nothing about the
  sprint moves again, whatever happens in OpenProject;
- further update runs are refused with `SPRINT_FROZEN` (reactivating the sprint unfreezes
  it and clears the snapshot);
- its tickets **stop being protected on the Import page** — the out-of-selection cleanup
  can finally remove them from the local cache, provably without changing any frozen
  number (`docs/CAPACITY_BAR_RULES.md` §6 invariant 10). This is what keeps the Import
  page from growing forever as sprints accumulate.

Details: `docs/INCREMENT_31_CONTRACTS.md`.

## Backup, restore & transfer

Since Increment 27 the store is **PostgreSQL**, and there are two ways to get data
out of it. They are not alternatives — use both, for different jobs.

| | `pg_dump` (`scripts/backup.sh`) | JSON export (`GET /api/data/export`) |
|---|---|---|
| Contents | **everything**, byte-exact, incl. the OP work-package cache | only the local, unrecoverable planning data |
| Portability | same major PostgreSQL version | any version, any machine, human-readable |
| Use it for | scheduled backups, disaster recovery | moving to another machine, a diffable snapshot in git |
| Speed / size | fast, compressed (~100 KB today) | slower, larger, but readable |

Rule of thumb: **`pg_dump` for safety, JSON for moving.**

### Scheduled / ad-hoc backup

```bash
DATABASE_URL=postgres://dev@localhost:5432/osp \
  scripts/backup.sh --db osp --label nightly
# → backups/osp-20260810-031500-nightly.dump
```

`--db` is mandatory and must match the database named in `DATABASE_URL`. That
looks redundant, and it is the point: a stale `DATABASE_URL` left in a shell can
never silently redirect a backup — or, far worse, a restore — at a database
nobody meant to touch. The script also verifies the finished dump is readable by
`pg_restore` before declaring success, so a corrupt backup is caught while the
source database still exists.

A nightly cron entry:

```cron
15 3 * * *  cd /path/to/op-sprint-planning && DATABASE_URL=postgres://dev@localhost:5432/osp scripts/backup.sh --db osp --label nightly >> /tmp/osp-backup.log 2>&1
```

### Restore

```bash
# into a fresh, empty database
createdb osp_restored
DATABASE_URL=postgres://dev@localhost:5432/osp_restored \
  scripts/restore.sh --db osp_restored --file backups/osp-20260810-031500-nightly.dump

# over an existing, populated database (destructive)
DATABASE_URL=postgres://dev@localhost:5432/osp \
  scripts/restore.sh --db osp --file backups/osp-…dump --clean
```

`--clean` drops every object first and demands you retype the database name to
confirm (or `--yes` when running unattended). Restoring into any database listed in
`OSP_FOREIGN_DATABASES` is refused outright — those belong to unrelated projects
sharing the same server.

Without `--clean`, `pg_restore` loads into an **empty** database; pointed at a
populated one it produces duplicate-key errors, not a merge.

### Moving your data to another machine (or to a server)

Two routes. The JSON one is usually what you want, because it does not care what
PostgreSQL version lives at the other end.

**A. JSON export/import** — in the app: *Data → Export*, or:

```bash
# on the source machine
curl -sS 'http://127.0.0.1:3001/api/data/export' -o osp-export.json

# on the target machine (REPLACES everything the app knows — see below)
curl -sS -X POST 'http://your-server:3001/api/data/import' \
  -H 'content-type: application/json' \
  -d "{\"payload\": $(cat osp-export.json)}"
```

Then click **Sync now** in the app: the OP work-package cache is deliberately not
part of the export (it is re-fetched from OpenProject in seconds), so the backlog
is empty until you do.

By default the export contains **no credentials** — the OP API tokens are emitted
as `null` and the vault is left out — so it is safe to hand around. You re-enter
the tokens once on the target machine. If you want the connections to keep working
untouched:

```bash
curl -sS 'http://127.0.0.1:3001/api/data/export?include_credentials=1' -o osp-full.json
```

⚠️ That file contains your encrypted OP tokens and the vault's KDF material. Its
only protection is your vault passphrase — treat it like the passphrase itself.
Importing it *requires* that passphrase (`{"payload": …, "passphrase": "…"}`), and
a wrong one aborts the whole import without touching a single row.

**Import is replace-only.** It wipes the planning tables and loads the file, in a
single transaction — so a failed import can never leave you half-migrated, but a
successful one does overwrite whatever was there. There is no merge mode.

**B. `pg_dump` → `pg_restore`** — byte-exact, including the work-package cache, but
requires a compatible PostgreSQL at the other end:

```bash
DATABASE_URL=…/osp scripts/backup.sh --db osp --label transfer
scp backups/osp-…-transfer.dump server:/tmp/
ssh server 'createdb osp && DATABASE_URL=…/osp scripts/restore.sh --db osp --file /tmp/osp-…-transfer.dump'
```

### One-off SQLite → PostgreSQL migration (Increment 27)

For upgrading a pre-Increment-27 installation. Reads the old `osp.sqlite`
**read-only** and loads it into a Postgres database:

```bash
DATABASE_URL=postgres://dev@localhost:5432/osp \
  scripts/migrate-sqlite-to-pg.sh --sqlite apps/api/osp.sqlite --i-know-what-im-doing
```

- The source `.sqlite`, `-wal` and `-shm` files are never opened for writing. The
  script byte-copies all three to a temp directory and runs SQLite's `.backup`
  there, which folds the write-ahead log into one consistent snapshot.
  **This matters:** a plain `cp osp.sqlite copy.sqlite` yields a file that opens
  cleanly, passes `integrity_check` and reports *identical row counts* while
  serving stale contents — on the real database it showed a closed, locked sprint
  as still in `planning`. Never migrate from a naive copy.
- Re-runnable: it truncates and reloads the target, so running it twice is the
  same as running it once.
- It refuses to write to `osp` or to `OSP_FOREIGN_DATABASES` unless `--i-know-what-im-doing` is
  passed — the real cut has to be deliberate. Take a `scripts/backup.sh` first.
- It prints a per-table row-count parity table and value-level spot checks of
  sprints, baselines, changelog and capacity, and exits non-zero if anything
  disagrees. Use `--dry-run` to inspect the payload without writing.

Afterwards, run **Sync now** to repopulate the work-package cache.

## Testing

```bash
pnpm -r typecheck          # all packages
pnpm -r test               # all unit/integration/contract suites (91 tests)
```

Notable suites:
- `@osp/op-client` — GET-only guard (POST/PATCH/PUT/DELETE throw before any network I/O), auth, pagination, retry.
- `@osp/tests` — A↔B integration, **read-only guard** (a recording mock OP observes exactly `{GET}` across a full sync), and burndown math on hand-checked numbers.

### End-to-end (Playwright) — deferred setup

Browsers aren't installed by default. To run the UI e2e:

```bash
pnpm exec playwright install chromium
# start the api + web dev servers (see "Run" above), then:
pnpm --filter @osp/tests test:e2e
```

`tests/e2e/smoke.spec.ts` loads the app and asserts the Setup screen. The full
connect→sync→backlog→sprint→drag-drop→burndown→close→version-export flow is scripted in
`tests/e2e/placeholder.spec.ts` (currently `test.skip`, documented for enabling). The
backend half of that flow is already covered headlessly by the vitest integration suite,
and has been verified live end-to-end (real API against the mock OP server).

## Diagnostics — `pnpm diag` (cross-surface consistency report)

When a number looks wrong (Capacity vs Closure vs the UI), don't debug from
screenshots — run the read-only diagnostic and attach its output:

```bash
DATABASE_URL=postgres://dev@localhost:5432/osp pnpm diag -- --sprint 4
```

For one sprint it fetches `/api/sprints/:id/capacity` and `/closure-stats`
through the real routes (in-process, no server, no port), sums the raw
`sprint_item.planned_hours` snapshots per person, and prints:

- a per-person table — `/capacity` planned × Σ item snapshot ×
  `/closure-stats` planned × logged (closure vs raw changelog) — with ⚠️ on
  every row where the surfaces disagree;
- duplicate identities (the same name appearing more than once on either
  surface) and people who **logged time but have no per-developer row**;
- the header cross-checks (`CAPACITY_BAR_RULES.md` §6 invariants 5 + 8).

It is **read-only by construction** (only `buildApp` + GET routes — no
boot-time writes), so pointing it at the production database for diagnostics
is safe. `DATABASE_URL` still has to be explicit — there is deliberately no
default (the Increment-12 guardrail). The identity model behind the person
matching is documented in `docs/IDENTITY_MODEL.md`.

## Read-only guarantee (hard invariant)

`op-client`'s `request()` throws `ReadOnlyViolationError` for any non-GET method **before**
issuing a network call. This is covered by unit tests and a system-level test asserting that
across a full sync run the only HTTP method reaching OP is `GET`.

## Known limitations & M5 backlog

- **Token encryption at rest** — currently stored raw (MVP). Add OS-keychain or passphrase-derived encryption.
- **Contract gap (capacity):** there is still no `GET` for capacity/team members, so the board
  computes capacity load client-side. Adding `GET /api/sprints/:id/capacity` would make it
  server-authoritative (a post-MVP contract change). Per-sprint membership is now
  server-authoritative via `GET /api/sprints/:id/items` (the board reads it per selected sprint
  rather than the backlog's global `in_sprint` flag).
- **Incremental sync filter** — passes a full ISO-8601 timestamp to OP's `updatedAt >=d`
  operator; verify against a real OP instance during hardening.
- **Sync is progressive** — `POST /api/sync` still blocks until done, but the engine upserts
  work packages page-by-page and records `sync_run.total_count`/`wp_count`; the UI polls
  `GET /api/sync/status` concurrently to show a progress bar and fill the backlog as tickets
  arrive. Time entries are fetched **scoped to the project** (not globally).
- **Backlog hides Closed/Resolved** work packages (done work isn't a planning candidate). They
  remain cached, so a ticket that closes mid-sprint is still tracked in burndown/closure.
- **e2e browsers** not installed in CI/sandbox (see above).
```

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
