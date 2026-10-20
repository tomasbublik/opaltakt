# Increment 39 — Sign-in (Microsoft Entra ID) with Planner / Viewer roles, OpalTakt rebrand

Frozen contract for the parallel work in this increment. Change it only by editing this
file first.

## 1. Modes — `OSP_AUTH` (required, no default)

| Value   | Meaning |
|---------|---------|
| `entra` | OIDC authorization-code flow (+PKCE) against Microsoft Entra ID, confidential client. |
| `none`  | No sign-in. Every request acts as a synthetic local user with role `Planner`. For local single-user use, unit tests and e2e. |

`apps/api/src/index.ts` refuses to start when `OSP_AUTH` is unset or unknown — same philosophy
as `DATABASE_URL`/`PORT` (a forgotten setting must fail loudly, never silently deploy an
open app). The vitest harness (`buildTestApp`) injects the auth config directly and does
not read the env.

`entra` mode env (all required in that mode; startup fails listing the missing ones):

| Var | Example |
|---|---|
| `OSP_ENTRA_TENANT_ID` | GUID |
| `OSP_ENTRA_CLIENT_ID` | GUID |
| `OSP_ENTRA_CLIENT_SECRET` | secret — never logged, never returned by any endpoint |
| `OSP_PUBLIC_URL` | `http://localhost:5173` — the browser-facing origin. The redirect URI is `${OSP_PUBLIC_URL}/api/auth/callback`; never derived from the request `Host` (the Vite proxy rewrites it). |
| `OSP_SESSION_SECRET` | ≥ 32 random bytes, base64 — encrypts the session cookie |

Issuer: `https://login.microsoftonline.com/${tenant}/v2.0`. Scopes: `openid profile email`.

## 2. Session

- Stateless, encrypted (AES-256-GCM, key derived from `OSP_SESSION_SECRET`) httpOnly cookie
  `osp_session`; `SameSite=Lax`; `Secure` when `OSP_PUBLIC_URL` is https; `Path=/`.
- Content: `{ sub, oid, name, email, roles, exp }`. Lifetime 8 h (absolute). No refresh
  tokens are stored; after expiry the user signs in again (Entra SSO makes it silent).
- The pending login (state, nonce, PKCE verifier, return path) lives in a separate
  short-lived encrypted cookie `osp_login` (10 min), cleared on callback.
- No server-side session store; a restart does not sign anyone out.

## 3. Roles

From the ID token `roles` claim (Entra App Roles, values exactly `Planner`, `Viewer`).
- `Planner` ⊇ `Viewer`. Both present → Planner.
- Signed in but neither role → **403 `NO_ROLE`** on every protected route; the web shows a
  "no access — ask the administrator" page with a sign-out button.

## 4. Endpoints (public — no session needed)

| Route | Behaviour |
|---|---|
| `GET /api/auth/me` | 200 `{ mode, user: { name, email, roles }, role: "Planner"\|"Viewer"\|null }`; 401 `UNAUTHENTICATED` when `entra` and no valid session. In `none` mode always 200 with `{ name: "Local user", email: null, roles: ["Planner"] }`. |
| `GET /api/auth/login?returnTo=/path` | 302 to Entra. `returnTo` must be a same-origin relative path (`/…`, not `//…`); anything else → `/`. In `none` mode 302 to `/`. |
| `GET /api/auth/callback` | Validates state/nonce/PKCE, ID token signature/issuer/audience/expiry (via `openid-client`), sets `osp_session`, 302 to `returnTo`. Errors → 302 `/?auth_error=<code>` (never a stack trace). |
| `POST /api/auth/logout` | Clears the cookie; 200 `{ logout_url }` = Entra end-session URL with `post_logout_redirect_uri=${OSP_PUBLIC_URL}/`. |
| `GET /health`, `GET /api/version` | Public. |

## 5. Authorization — fail closed

Every route **must** declare its access level in Fastify route `config`:
`config: { access: "public" | "viewer" | "planner" }`. An `onRoute` hook throws at startup
for any route under `/api` without it (a forgotten declaration can never become an open
route). A `preHandler` hook enforces: no session → 401 `UNAUTHENTICATED`; no role → 403
`NO_ROLE`; Viewer on a `planner` route → 403 `FORBIDDEN_ROLE`.

### Role matrix

**Principle:** a Viewer can see everything the planning screens and reports show and can
generate report PDFs, but can **never** change local planning data, never change
configuration, and never cause **any** OpenProject traffic.

`viewer` (Viewer and Planner):
- every `GET` that only reads the local database — sprints, items, detailed items,
  capacity, capacity-audit, burndown, velocity, closure-stats, people, sprint people,
  off-sprint-time, updates (run history), ticket changelog (stored rows), reports list/detail,
  backlog + filter-options (read-only view), done-rules, config, connections (list, no
  tokens), connections health stream, sync status, vault status, user-aliases,
  version-export.
- `POST /reports/:id/pdf`, `POST /sprints/:id/status-pdf` — report generation.

`planner` (Planner only): **everything else**, in particular
- every `POST/PUT/PATCH/DELETE` not listed above (sprint create/edit/delete, items
  add/remove/carry/by-id, capacity, activate/update/finish/close/reactivate, rebuild-burndown,
  retro seed, double-count fixes, estimate overrides, people roles, done-rules, config,
  aliases, backlog remove/delete, connections, vault *, sync + cancel, snapshot,
  work-packages, data import),
- **any `GET` that contacts OpenProject** (e.g. `/projects`, `/versions`, retro preview —
  verify each GET in code; when in doubt it is `planner`),
- Import-screen reads (`/imports`, `/backlog/out-of-selection`),
- `GET /data/export` (full data dump).

A table-driven test enumerates **all** registered `/api` routes and asserts each one's
declared access against the matrix, so adding a route without a decision fails CI.

## 6. Web

- On load the app calls `/api/auth/me`. 401 → full-screen sign-in page ("Sign in with
  Microsoft" → `/api/auth/login?returnTo=<current path>`). 403 `NO_ROLE` → no-access page.
- Header shows the user's name, a role badge and Sign out.
- Viewer: Import, Setup and Data tabs are hidden; Sync now / Full refresh hidden; the sprint
  board is read-only (no drag-and-drop, no Add/Return/Carry, no activate/update/finish/close,
  no capacity editing, no estimate overrides); People/Settings are read-only; vault
  unlock/init is not offered (a locked vault simply means no OP traffic, which a Viewer
  never needs). Report/PDF buttons stay.
- The backend is the enforcement; the UI hiding is comfort only. Any 403 `FORBIDDEN_ROLE`
  that still happens shows a calm inline message, never a crash.

## 7. Rebrand

Product name **OpalTakt** everywhere user-visible (title, header, PDF reports, README,
`package.json` name `opaltakt`). Internal identifiers stay: package scope `@osp/*`, env
prefix `OSP_*`, database names `osp`, `osp_test_*`, `osp_e2e_*` (the isolation guardrail
depends on them).
