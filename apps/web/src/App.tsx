import { useCallback, useEffect, useState } from "react";
import type {
  AddConnectionResponse,
  AuthMeResponse,
  ConnectionSyncOutcome,
  ConnectionsHealthResponse,
  Sprint,
  SyncRefreshAllResponse,
  SyncRun,
  TriggerSyncBody,
  VaultStatusResponse,
} from "@osp/contracts";
import { api, ApiError, isSyncRefreshAllResponse, setAuthHandlers, subscribeConnectionsHealth } from "./api-client";
import { RoleProvider } from "./lib/role";
import { useAsync } from "./lib/useAsync";
import { EmptyState, ErrorBox, Spinner } from "./components/ui";
import { BrandMark, Header, type SyncConflict, type Tab } from "./components/Header";
import { VaultCreateScreen, VaultUnlockScreen } from "./components/VaultGate";
import { SetupScreen } from "./components/SetupScreen";
import { ImportScreen } from "./components/ImportScreen";
import { BacklogScreen } from "./components/BacklogScreen";
import { SprintBoardScreen } from "./components/SprintBoardScreen";
import { BurndownScreen } from "./components/BurndownScreen";
import { VelocityScreen } from "./components/VelocityScreen";
import { ClosureScreen } from "./components/ClosureScreen";
import { PeopleScreen } from "./components/PeopleScreen";
import { ReportsScreen } from "./components/ReportsScreen";
import { DataScreen } from "./components/DataScreen";
import { SettingsScreen } from "./components/SettingsScreen";

/**
 * Increment 22: reads the `details` payload of a 409 SYNC_IN_PROGRESS error
 * (`ApiError.body.error.details`) — freeform per the contract (no
 * `@osp/contracts` type this increment), shaped by the backend as
 * `{ runId, started_at, last_progress_at }`.
 */
function readSyncConflict(err: unknown): SyncConflict | undefined {
  if (!(err instanceof ApiError) || err.body?.error.code !== "SYNC_IN_PROGRESS") return undefined;
  const details = err.body.error.details as
    | { runId?: unknown; started_at?: unknown; last_progress_at?: unknown }
    | undefined;
  if (details == null || typeof details.runId !== "number" || typeof details.started_at !== "string") {
    return undefined;
  }
  return {
    runId: details.runId,
    startedAt: details.started_at,
    lastProgressAt: typeof details.last_progress_at === "string" ? details.last_progress_at : null,
  };
}

/**
 * Top-level shell (SPEC §8, SPEC_02 §6). The vault gates everything: until it
 * is initialized and unlocked no OP feature is reachable. Once unlocked, the
 * stored connections load automatically — `connected` simply means "at least
 * one server is stored"; no token is ever re-entered here. All data flows
 * through the typed `api` client — the browser never talks to OP directly.
 */
function AuthedApp({ me, onSignOut }: { me: AuthMeResponse; onSignOut: () => void }) {
  // Increment 39 (§6): a Viewer never touches the vault (no OP traffic, no
  // unlock/init) and lands on the read-only board.
  const isViewer = me.role === "Viewer";
  const [vault, setVault] = useState<VaultStatusResponse | undefined>();
  const [vaultError, setVaultError] = useState<Error | undefined>();
  const [tab, setTab] = useState<Tab>(isViewer ? "board" : "setup");
  const [selectedSprintId, setSelectedSprintId] = useState<number | undefined>();
  const [refreshKey, setRefreshKey] = useState(0);
  // Increment 29 (orchestrator correction, revised contract §7) — SEPARATE
  // from `refreshKey`, and consumed ONLY by `syncState` below. A refresh-all
  // is not one atomic operation: it's N+1 separate `sync_run`s (one per
  // import selection, plus the coverage pass), each committing its own
  // staged batch independently. Between those commits the cache is
  // genuinely half-updated (project A refreshed, project B not yet) — that
  // is the real mechanism behind SPEC_28 §1.2's "44h at Starting → 4h at
  // Importing 9/14", not a caching bug. The 1s poll used to bump
  // `refreshKey`, which EVERY consumer (backlog, capacity, closure, sprints)
  // depends on, so those partial totals got rendered mid-sync. Now only the
  // progress bar/current-run status ticks live; everything else waits for
  // the settled state (`refreshKey` bumps once, in `runSync`'s `finally`).
  const [syncPollKey, setSyncPollKey] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [health, setHealth] = useState<ConnectionsHealthResponse | undefined>();
  const [landed, setLanded] = useState(false);
  // Increment 22 (SPEC_22 §…): a 409 SYNC_IN_PROGRESS from "Sync now" creates
  // no sync_run row for THIS attempt, so the next status poll has nothing new
  // to surface — unlike every other sync outcome, this one has to be captured
  // right here from the rejected promise. Cleared on the next sync attempt or
  // once the user cancels the conflicting run.
  const [syncConflict, setSyncConflict] = useState<SyncConflict | undefined>();
  // Increment 23 (SPEC_23 §1): the per-connection breakdown of the last
  // refresh-all "Sync now" — undefined for a single-project sync (still a
  // bare SyncRun, no breakdown to show) or before any refresh-all has run
  // this session. Cleared at the start of every new "Sync now" click so a
  // stale summary never lingers next to a fresh, still-running sync.
  const [syncSummary, setSyncSummary] = useState<ConnectionSyncOutcome[] | undefined>();
  // Increment 29 (contract §5): whether the run that produced `syncSummary`
  // was a "Full refresh" rather than an ordinary "Sync now" — lets the
  // header label the result panel accordingly. Reset alongside `syncSummary`
  // at the start of every new refresh-all attempt.
  const [syncWasFullRefresh, setSyncWasFullRefresh] = useState(false);

  const refreshData = useCallback(() => setRefreshKey((k) => k + 1), []);

  const reloadVault = useCallback(() => {
    setVaultError(undefined);
    api.getVaultStatus().then(
      (v) => setVault(v),
      (err: unknown) => setVaultError(err instanceof Error ? err : new Error(String(err))),
    );
  }, []);

  useEffect(() => {
    if (!isViewer) reloadVault();
  }, [reloadVault, isViewer]);

  // `unlocked` doubles as "may load data": a Viewer reads stored rows only,
  // which works with a locked (or never-initialised) vault.
  const unlocked = isViewer || (vault != null && vault.initialized && !vault.locked);

  // Stored connections (SPEC_02): with an unlocked vault the app is
  // immediately "connected" when at least one server exists — that's the point
  // of the vault, no token re-entry.
  const connectionsState = useAsync(
    () => (unlocked ? api.getConnections() : Promise.resolve([])),
    [unlocked, refreshKey],
  );
  const connections = connectionsState.data ?? [];
  const connected = unlocked && connections.length > 0;
  const currentConn = connections.find((c) => c.is_current) ?? connections[0];

  // Live health feed: SSE with polling fallback, subscribed once per unlock.
  useEffect(() => {
    if (!unlocked) {
      setHealth(undefined);
      return;
    }
    return subscribeConnectionsHealth(setHealth);
  }, [unlocked]);

  // Immediate health refresh after any user-triggered action (sync, import,
  // connection edits…) — everything funnels through refreshKey.
  useEffect(() => {
    if (!unlocked) return;
    let cancelled = false;
    api
      .getConnectionsHealth()
      .then((h) => {
        if (!cancelled) setHealth(h);
      })
      .catch(() => {
        // Feed keeps trying; the header just shows the last known state.
      });
    return () => {
      cancelled = true;
    };
  }, [unlocked, refreshKey]);

  // Landing after unlock: 0 servers → Setup; otherwise Backlog when something
  // is already imported, else Import (existing behaviour, minus the token step).
  // Fetches its own snapshot instead of reading the useAsync state, which is
  // still stale (pre-unlock) in the effect flush where `unlocked` flips.
  const land = useCallback(async () => {
    if (isViewer) {
      setTab("board");
      return;
    }
    let conns;
    try {
      conns = await api.getConnections();
    } catch {
      setTab("setup");
      return;
    }
    if (conns.length === 0) {
      setTab("setup");
      return;
    }
    try {
      const imports = await api.getImports();
      setTab(imports.length > 0 ? "backlog" : "import");
    } catch {
      setTab("import");
    }
  }, [isViewer]);

  useEffect(() => {
    if (!unlocked) {
      if (landed) setLanded(false);
      return;
    }
    if (landed) return;
    setLanded(true);
    void land();
  }, [unlocked, landed, land]);

  // Sync status drives the header "Last synced …" label + progress bar. The
  // ONLY consumer of `syncPollKey` (ticked every 1s while a sync runs) — see
  // its declaration above for why nothing else may share that dependency.
  // Still depends on `refreshKey` too, so a non-poll trigger (e.g. cancelling
  // a conflicting run) still refreshes this immediately.
  const syncState = useAsync(
    () => (connected ? api.getSyncStatus() : Promise.resolve(undefined)),
    [connected, refreshKey, syncPollKey],
  );

  // Sprint list is shared by the board / burndown / velocity / closure screens.
  const sprintsState = useAsync(
    () => (connected ? api.getSprints() : Promise.resolve([] as Sprint[])),
    [connected, refreshKey],
  );
  const sprints = sprintsState.data ?? [];

  // Auto-select a sensible default sprint (active first, else newest).
  useEffect(() => {
    if (selectedSprintId != null && sprints.some((s) => s.id === selectedSprintId)) return;
    const newest = sprints[sprints.length - 1];
    if (newest == null) return;
    const active = sprints.find((s) => s.status === "active");
    setSelectedSprintId((active ?? newest).id);
  }, [sprints, selectedSprintId]);

  // Run a sync (import a selection, or refresh everything with an empty body).
  // Polls status while it runs so the header shows a live progress bar — that
  // poll ticks ONLY `syncPollKey` (see its declaration above), never
  // `refreshData()`. A refresh-all is many separate `sync_run` commits, not
  // one atomic operation, so re-fetching backlog/capacity/closure/sprints on
  // every tick would render genuinely half-updated intermediate totals
  // (SPEC_28 §1.2's "44h at Starting → 4h at Importing 9/14" — this was the
  // real mechanism, not a caching bug; corrected in
  // docs/INCREMENT_29_CONTRACTS.md §7). `refreshData()` bumps `refreshKey`
  // exactly ONCE, in `finally`, once the run has fully settled — every other
  // consumer of `refreshKey` sees the new state in one step, never a partial
  // one. Rejects on failure so callers can surface the error (the Import
  // screen does; "Sync now" swallows it — see syncNow() below).
  const runSync = useCallback(
    async (body: TriggerSyncBody): Promise<SyncRun | SyncRefreshAllResponse> => {
      setSyncing(true);
      const poll = window.setInterval(() => setSyncPollKey((k) => k + 1), 1000);
      try {
        return await api.triggerSync(body);
      } finally {
        window.clearInterval(poll);
        setSyncing(false);
        // One last poll tick so the header reflects the just-finished run's
        // terminal status immediately, without waiting up to 1s for the next
        // interval that no longer exists.
        setSyncPollKey((k) => k + 1);
        refreshData();
      }
    },
    [refreshData],
  );

  // ImportScreen always supplies `project_op_id`, so per SPEC_23 §1's
  // contract its response is contractually always a bare SyncRun — narrow
  // runSync's now-widened return type back down for that one caller instead
  // of leaking the refresh-all union into a component that never sees it.
  const runProjectSync = useCallback(
    async (body: TriggerSyncBody): Promise<SyncRun> => {
      const result = await runSync(body);
      if (isSyncRefreshAllResponse(result)) {
        // Defensive only — a project-scoped sync should never come back as
        // a refresh-all response; fail loudly rather than silently misread it.
        throw new Error("Unexpected refresh-all response for a project-scoped sync");
      }
      return result;
    },
    [runSync],
  );

  // Shared by "Sync now" ({}) and "Full refresh" ({ full_refresh: true }) —
  // both are refresh-all calls with identical running/disabled/progress and
  // conflict handling (Increment 29 contract §5: "same handling, reuse it,
  // don't fork it").
  const runRefreshAll = useCallback(
    (body: TriggerSyncBody) => {
      if (!connected) return;
      setSyncConflict(undefined);
      setSyncSummary(undefined);
      setSyncWasFullRefresh(false);
      void runSync(body)
        .then((result) => {
          // Increment 23 (SPEC_23 §1): refresh-all now reports PER CONNECTION —
          // a disconnected/unreachable one is "skipped", never a bare, unexplained
          // failure for the whole sync. Surface the breakdown instead of
          // collapsing it back into a single pass/fail.
          setSyncSummary(isSyncRefreshAllResponse(result) ? result.connections : undefined);
          setSyncWasFullRefresh(isSyncRefreshAllResponse(result) ? result.full_refresh : false);
        })
        .catch((err: unknown) => {
          // A 409 SYNC_IN_PROGRESS never created a sync_run row for THIS attempt,
          // so there is nothing for the next status poll to surface — capture it
          // here instead (Increment 22). Any other failure still lands in the
          // existing sync_run "error" status, surfaced via the next poll as before.
          const conflict = readSyncConflict(err);
          if (conflict != null) setSyncConflict(conflict);
        });
    },
    [connected, runSync],
  );

  function syncNow() {
    runRefreshAll({});
  }

  // Increment 29 (contract §5): "Full refresh" — posts { full_refresh: true }
  // and no project_op_id, so every recorded import selection's sync_watermark
  // is cleared before it runs, rebuilding the incremental cut-offs from
  // scratch.
  function fullRefreshNow() {
    runRefreshAll({ full_refresh: true });
  }

  // Cancel the run reported by a SYNC_IN_PROGRESS conflict, then refresh so
  // the header's next poll sees it gone.
  const handleCancelConflictingSync = useCallback(
    (runId: number) => {
      void api
        .cancelSync(runId)
        .catch(() => {
          // Swallow — the next status poll reflects the true state either way.
        })
        .then(() => {
          setSyncConflict(undefined);
          refreshData();
        });
    },
    [refreshData],
  );

  // "Test now" in the header popover: run the check, then refresh everything
  // (the refreshKey effect re-reads health immediately).
  const handleTestConnection = useCallback(
    async (id: number) => {
      try {
        await api.testConnection(id);
      } catch {
        // Failure lands in the connection's health record; the refresh shows it.
      }
      refreshData();
    },
    [refreshData],
  );

  // Lock from the header popover (Setup's own button calls the API itself).
  const handleLockVault = useCallback(() => {
    void api
      .lockVault()
      .catch(() => {
        // Even if the call fails, fall through to a status re-check.
      })
      .then(() => setVault({ initialized: true, locked: true }));
  }, []);

  // A server was added on Setup. If it is the first one and validated OK,
  // route the user onward like the old post-connect flow did.
  const handleServerAdded = useCallback(
    (resp: AddConnectionResponse) => {
      const wasFirst = connections.length === 0;
      refreshData();
      if (wasFirst && resp.user != null) {
        api.getImports().then(
          (imports) => setTab(imports.length > 0 ? "backlog" : "import"),
          () => setTab("import"),
        );
      }
    },
    [connections.length, refreshData],
  );

  // ── Vault gate ─────────────────────────────────────────────────────────────
  if (!isViewer && vaultError) {
    return (
      <Gate>
        <ErrorBox error={vaultError} onRetry={reloadVault} />
      </Gate>
    );
  }
  if (!isViewer && vault == null) {
    return (
      <Gate>
        <Spinner label="Checking vault…" />
      </Gate>
    );
  }
  if (!isViewer && vault != null && !vault.initialized) {
    return (
      <Gate>
        <VaultCreateScreen onCreated={() => setVault({ initialized: true, locked: false })} />
      </Gate>
    );
  }
  if (!isViewer && vault != null && vault.locked) {
    return (
      <Gate>
        <VaultUnlockScreen
          onUnlocked={() => setVault({ initialized: true, locked: false })}
          onReset={reloadVault}
        />
      </Gate>
    );
  }

  // ── Unlocked app ───────────────────────────────────────────────────────────
  return (
    <div className="app-shell">
      <Header
        tab={tab}
        onTab={setTab}
        connected={connected}
        syncStatus={syncState.data}
        syncing={syncing}
        onSyncNow={syncNow}
        onFullRefresh={fullRefreshNow}
        syncConflict={syncConflict}
        onCancelConflictingSync={handleCancelConflictingSync}
        syncSummary={syncSummary}
        syncFullRefresh={syncWasFullRefresh}
        aggregate={health?.aggregate ?? "neutral"}
        connections={health?.connections ?? connections}
        onTestConnection={(id) => void handleTestConnection(id)}
        onLockVault={handleLockVault}
        userName={me.user.name}
        onSignOut={onSignOut}
      />
      <main className="content">
        {isViewer && (tab === "setup" || tab === "import" || tab === "data") ? (
          // Defensive: those tabs are hidden for a Viewer, never reachable.
          <EmptyState>This screen is available to Planners only.</EmptyState>
        ) : isViewer && !connected ? (
          <EmptyState>No data yet — a Planner needs to set up and import the first sprint.</EmptyState>
        ) : tab === "setup" || !connected ? (
          <SetupScreen
            connections={connections}
            onChanged={refreshData}
            onAdded={handleServerAdded}
            onVaultLocked={() => setVault({ initialized: true, locked: true })}
            onVaultReset={() => {
              reloadVault();
              refreshData();
            }}
          />
        ) : tab === "import" ? (
          <ImportScreen
            refreshKey={refreshKey}
            onImport={runProjectSync}
            onAdded={refreshData}
            onRemoved={refreshData}
            onViewBacklog={() => setTab("backlog")}
          />
        ) : tab === "backlog" && currentConn != null ? (
          <BacklogScreen refreshKey={refreshKey} baseUrl={currentConn.base_url} onDataChanged={refreshData} />
        ) : tab === "board" ? (
          <SprintBoardScreen
            sprints={sprints}
            selectedSprintId={selectedSprintId}
            onSelectSprint={setSelectedSprintId}
            onSprintsChanged={refreshData}
            refreshKey={refreshKey}
            baseUrl={currentConn?.base_url}
            onGoToSetup={() => setTab("setup")}
          />
        ) : tab === "burndown" ? (
          <BurndownScreen
            sprints={sprints}
            selectedSprintId={selectedSprintId}
            onSelectSprint={setSelectedSprintId}
            refreshKey={refreshKey}
          />
        ) : tab === "velocity" ? (
          <VelocityScreen
            sprints={sprints}
            selectedSprintId={selectedSprintId}
            onSelectSprint={setSelectedSprintId}
            refreshKey={refreshKey}
          />
        ) : tab === "closure" ? (
          <ClosureScreen
            sprints={sprints}
            selectedSprintId={selectedSprintId}
            onSelectSprint={setSelectedSprintId}
            onSprintsChanged={refreshData}
            baseUrl={currentConn?.base_url}
          />
        ) : tab === "people" ? (
          <PeopleScreen refreshKey={refreshKey} />
        ) : tab === "reports" ? (
          <ReportsScreen refreshKey={refreshKey} baseUrl={currentConn?.base_url} />
        ) : tab === "data" ? (
          <DataScreen onImported={refreshData} />
        ) : tab === "settings" ? (
          <SettingsScreen onGoToPeople={() => setTab("people")} />
        ) : null}
      </main>
    </div>
  );
}

type AuthState =
  | { kind: "loading" }
  | { kind: "signin" }
  | { kind: "error"; error: Error }
  | { kind: "noaccess"; me: AuthMeResponse }
  | { kind: "ok"; me: AuthMeResponse };

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  access_denied: "Sign-in was cancelled or not permitted. Please try again.",
  idp_error: "Microsoft reported a problem during sign-in. Please try again.",
  login_expired: "That sign-in attempt expired. Please try again.",
  callback_failed: "Sign-in could not be completed. Please try again.",
};

function describeAuthError(code: string): string {
  return AUTH_ERROR_MESSAGES[code] ?? "Sign-in did not complete. Please try again.";
}

/** Reads `?auth_error=<code>` once, then strips it from the address bar. */
function takeAuthError(): string | undefined {
  try {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("auth_error");
    if (code == null) return undefined;
    url.searchParams.delete("auth_error");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    return code;
  } catch {
    return undefined;
  }
}

/**
 * Increment 39 (§6) — auth gate. Asks /api/auth/me first: 401 → sign-in page,
 * no role → No-access page, otherwise the app, with the role in context.
 * A 401 from ANY later call (expired session) lands back on the sign-in page
 * via `setAuthHandlers`; a 403 FORBIDDEN_ROLE shows a calm inline notice.
 */
export function App() {
  const [auth, setAuth] = useState<AuthState>({ kind: "loading" });
  const [authError] = useState<string | undefined>(() => takeAuthError());
  const [expired, setExpired] = useState(false);
  const [forbidden, setForbidden] = useState<string | undefined>();

  const loadMe = useCallback(() => {
    setAuth({ kind: "loading" });
    api.getMe().then(
      (me) => setAuth(me.role == null ? { kind: "noaccess", me } : { kind: "ok", me }),
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) setAuth({ kind: "signin" });
        else setAuth({ kind: "error", error: err instanceof Error ? err : new Error(String(err)) });
      },
    );
  }, []);

  useEffect(() => {
    setAuthHandlers({
      onUnauthenticated: () => {
        setExpired(true);
        setAuth({ kind: "signin" });
      },
      onForbidden: (msg) => setForbidden(msg),
    });
    loadMe();
    return () => setAuthHandlers({});
  }, [loadMe]);

  const signOut = useCallback(() => {
    api.logout().then(
      (r) => {
        window.location.href = r.logout_url;
      },
      () => {
        window.location.href = "/";
      },
    );
  }, []);

  let body: React.ReactNode;
  if (auth.kind === "loading") {
    body = (
      <Gate>
        <Spinner label="Checking sign-in…" />
      </Gate>
    );
  } else if (auth.kind === "error") {
    body = (
      <Gate>
        <ErrorBox error={auth.error} onRetry={loadMe} />
      </Gate>
    );
  } else if (auth.kind === "signin") {
    body = <SignInPage message={authError != null ? describeAuthError(authError) : expired ? "Your session has ended. Please sign in again." : undefined} />;
  } else if (auth.kind === "noaccess") {
    body = <NoAccessPage name={auth.me.user.name} onSignOut={signOut} />;
  } else {
    body = (
      <RoleProvider value={{ role: auth.me.role ?? "Viewer", mode: auth.me.mode }}>
        <AuthedApp me={auth.me} onSignOut={signOut} />
      </RoleProvider>
    );
  }

  return (
    <>
      {body}
      {forbidden != null ? (
        <div className="forbidden-notice" role="status" data-testid="forbidden-notice">
          <span>{forbidden}. Your account has read-only access.</span>
          <button type="button" className="btn small secondary" onClick={() => setForbidden(undefined)}>
            Dismiss
          </button>
        </div>
      ) : null}
    </>
  );
}

function AuthCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="brand" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <BrandMark />
          <h1 style={{ margin: 0, fontSize: 22 }}>OpalTakt</h1>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Where the sign-in button sends the browser (exported for tests). */
export function loginUrl(): string {
  const returnTo = `${window.location.pathname}${window.location.search}`;
  return `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}

function SignInPage({ message }: { message?: string }) {
  return (
    <AuthCard>
      <p>Sprint planning, capacity and delivery insight for your OpenProject work.</p>
      {message != null ? (
        <div className="msg warn" role="alert" data-testid="auth-error">
          {message}
        </div>
      ) : null}
      <button
        type="button"
        className="btn"
        onClick={() => {
          window.location.href = loginUrl();
        }}
      >
        Sign in with Microsoft
      </button>
    </AuthCard>
  );
}

function NoAccessPage({ name, onSignOut }: { name: string; onSignOut: () => void }) {
  return (
    <AuthCard>
      <h2>No access</h2>
      <p>
        {name}, your account has no OpalTakt role (Planner or Viewer). Please ask your administrator to grant
        access, then sign in again.
      </p>
      <button type="button" className="btn secondary" onClick={onSignOut}>
        Sign out
      </button>
    </AuthCard>
  );
}

/** Minimal full-page wrapper for the pre-unlock screens. */
function Gate({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-top">
          <div className="brand">
            <BrandMark />
            <h1>OpalTakt</h1>
          </div>
        </div>
      </header>
      <main className="content" style={{ maxWidth: 560 }}>
        {children}
      </main>
    </div>
  );
}
