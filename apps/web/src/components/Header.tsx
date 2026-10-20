import { useEffect, useState } from "react";
import type {
  AggregateHealthColor,
  Connection,
  ConnectionSyncOutcome,
  SyncCoverage,
  SyncStatusResponse,
} from "@osp/contracts";
import { api } from "../api-client";
import { formatDate, relativeTime } from "../lib/format";
import { ConnectionStatusIndicator } from "./ConnectionStatus";
import { useRole } from "../lib/role";

/**
 * Increment 23 (SPEC_23 §1) — one line per connection in a refresh-all "Sync
 * now": "Acme: updated 3 tickets", "mock: skipped (disconnected)", "Acme:
 * error — <message>". `run?.wp_count` (not `outcome.message`) drives the
 * "synced" wording so it reads consistently regardless of what the backend
 * puts in `message` for that status; `message` (always populated) drives the
 * "skipped"/"error" wording, per the contract's own doc comment.
 */
export function formatConnectionSyncOutcome(o: ConnectionSyncOutcome): string {
  const label = o.connection_label ?? `connection ${o.connection_id}`;
  if (o.status === "synced") {
    const count = o.run?.wp_count ?? 0;
    const base = `${label}: updated ${count} ticket${count === 1 ? "" : "s"}`;
    // Increment 29 (SPEC_29 §4.1/§4.3, contract §4.3) — "synced" no longer
    // means "everything is current": a connection can report success while
    // only touching a fraction of what's actually cached (the bug this whole
    // increment fixes). `coverage` is null for skipped/error outcomes (never
    // reached here) but can legitimately be null for `synced` too if the
    // backend hasn't populated it — degrade to the old text rather than throw.
    return o.coverage != null
      ? `${base} (${o.coverage.refreshed}/${o.coverage.total_cached} cached tickets refreshed)`
      : base;
  }
  if (o.status === "skipped") {
    return `${label}: skipped (${o.message})`;
  }
  return `${label}: error — ${o.message}`;
}

/**
 * Increment 29 (contract §4.3) — the mandatory "not everything was actually
 * refreshed" warning text. Only ever rendered when `not_refreshed > 0`; a
 * green "synced" with a silently qualified coverage block is exactly the
 * failure mode this increment exists to end (docs/INCREMENT_29_CONTRACTS.md
 * §0). `oldest_cached_at` is folded into the SAME line when present, since
 * "how stale" is the natural follow-up to "how much wasn't refreshed".
 */
export function formatCoverageWarning(c: SyncCoverage): string {
  const n = c.not_refreshed;
  const oldest = c.oldest_cached_at != null ? ` — oldest cached record: ${formatDate(c.oldest_cached_at)}` : "";
  return `${n} cached ticket${n === 1 ? "" : "s"} not refreshed this run${oldest}`;
}

/** Increment 29 (contract §4.2) — informational only; nothing is auto-deleted
 * here, the user removes orphans explicitly via the out-of-selection cleanup
 * screen (Import tab). */
export function formatOrphanNote(c: SyncCoverage): string {
  const n = c.orphan_op_ids.length;
  return `${n} ticket${n === 1 ? "" : "s"} no longer exist in OpenProject`;
}

/**
 * One connection's refresh-all outcome, including the Increment 29 coverage
 * detail. `coverage` is deliberately allowed to be null (skipped/error
 * outcomes, or a synced one the backend didn't populate) — every extra line
 * below is gated on it being present, so "nothing was measured" renders as
 * nothing extra rather than a false "all clear" or a crash.
 */
function ConnectionSyncOutcomeRow({ outcome }: { outcome: ConnectionSyncOutcome }) {
  const coverage = outcome.coverage;
  return (
    <div
      data-testid={`sync-outcome-${outcome.connection_id}`}
      style={{ display: "flex", flexDirection: "column", gap: 2 }}
    >
      <span>{formatConnectionSyncOutcome(outcome)}</span>
      {coverage != null && coverage.not_refreshed > 0 ? (
        <span
          className="msg warn"
          role="alert"
          data-testid={`coverage-warning-${outcome.connection_id}`}
          style={{ padding: "4px 8px", fontSize: 12 }}
        >
          {formatCoverageWarning(coverage)}
        </span>
      ) : coverage != null && coverage.oldest_cached_at != null ? (
        // Fully refreshed this run — still surface data age per contract §4.3
        // ("show data age when available"), just without warning styling.
        <span className="muted" style={{ fontSize: 11 }}>
          oldest cached record: {formatDate(coverage.oldest_cached_at)}
        </span>
      ) : null}
      {coverage != null && coverage.orphan_op_ids.length > 0 ? (
        <span
          className="muted"
          data-testid={`coverage-orphans-${outcome.connection_id}`}
          style={{ fontSize: 11 }}
        >
          {formatOrphanNote(coverage)}
        </span>
      ) : null}
    </div>
  );
}

/** `Date.now() - started_at` in ms → "MM:SS" (SPEC_19 §2b). */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const ss = String(totalSeconds % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

/**
 * Increment 22: a 409 SYNC_IN_PROGRESS from "Sync now" — no `sync_run` row
 * was ever created for THIS attempt, so unlike every other sync outcome
 * there is nothing for the next status poll to surface. App.tsx captures it
 * straight from the rejected promise and hands it down here.
 */
export type SyncConflict = { runId: number; startedAt: string; lastProgressAt: string | null };

export type Tab =
  | "setup"
  | "import"
  | "backlog"
  | "board"
  | "burndown"
  | "velocity"
  | "closure"
  | "people"
  | "reports"
  | "data"
  | "settings";

export const TABS: { id: Tab; label: string }[] = [
  { id: "setup", label: "Setup" },
  { id: "import", label: "Import" },
  { id: "backlog", label: "Backlog" },
  { id: "board", label: "Sprint board" },
  { id: "burndown", label: "Burndown" },
  { id: "velocity", label: "Velocity" },
  { id: "closure", label: "Closure" },
  // Increment 14 (SPEC_14 §2/§4): Settings → People (role registry) and the
  // management-facing Reports/PDF screen — both new top-level tabs.
  { id: "people", label: "People" },
  { id: "reports", label: "Reports" },
  // Increment 27 (§6): Settings → Data — local JSON export/import, the
  // SQLite→PG hard cut's backup/transfer format.
  { id: "data", label: "Data" },
  // Increment 31 (docs/INCREMENT_31_CONTRACTS.md §4): app-wide settings —
  // freeze grace period + the (previously edit-less) overshoot threshold.
  { id: "settings", label: "Settings" },
];

/** Increment 39 (§6): tabs a Viewer never sees (Planner-only screens). */
export const VIEWER_HIDDEN_TABS: readonly Tab[] = ["setup", "import", "data"];

/**
 * Increment 39 (§6) — the signed-in user cluster: name, an understated role
 * pill and Sign out. In `none` mode there is no sign-in, so it reads
 * "Local user · Planner" with no Sign out button.
 */
function AccountCluster({ userName, onSignOut }: { userName?: string; onSignOut?: () => void }) {
  const { role, mode } = useRole();
  if (userName == null) return null;
  return (
    <div className="app-header-account" data-slot="account">
      <span className="account-name" data-testid="account-name">
        {mode === "none" ? "Local user" : userName}
      </span>
      <span className={`role-badge ${role === "Planner" ? "planner" : "viewer"}`} data-testid="role-badge">
        {role}
      </span>
      {mode !== "none" && onSignOut != null ? (
        <button type="button" className="btn small secondary" onClick={onSignOut}>
          Sign out
        </button>
      ) : null}
    </div>
  );
}

/**
 * The running build: web version from compile time, API version from
 * GET /api/version. A mismatch (stale tab after a deploy, or a web build
 * pointed at a different API) is flagged so nobody compares numbers across two
 * different versions without knowing it.
 */
function VersionBadge() {
  const [apiVersion, setApiVersion] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    // Best-effort and purely informational: any failure (old API without the
    // endpoint, a test double without the method) just leaves the web version.
    Promise.resolve()
      .then(() => api.getVersion())
      .then((v) => {
        if (alive) setApiVersion(v.version);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const mismatch = apiVersion !== null && apiVersion !== __APP_VERSION__;
  const sha = __APP_GIT_SHA__ ? ` (${__APP_GIT_SHA__})` : "";
  return (
    <span
      className="version-badge"
      data-mismatch={mismatch || undefined}
      title={
        mismatch
          ? `Web ${__APP_VERSION__} talks to API ${apiVersion} — reload the page`
          : `Version ${__APP_VERSION__}${sha}`
      }
    >
      v{__APP_VERSION__}
      {mismatch ? ` ≠ API v${apiVersion}` : ""}
    </span>
  );
}

/**
 * App mark — an "opal" tile: a dark slate rounded square holding three bars of
 * decreasing length (a stylised burndown), tinted in the pale pearl / indigo /
 * cyan range of a precious opal. Drawn inline so the header never fetches an
 * asset. Fixed literal colours (not capacity tokens) so the bar-semantic
 * palette in CAPACITY_BAR_RULES.md can never leak into the logo.
 */
export function BrandMark() {
  return (
    <svg
      width="26"
      height="26"
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
      className="brand-mark"
    >
      <rect width="32" height="32" rx="8" fill="#0f172a" />
      <rect x="7" y="8" width="18" height="3.6" rx="1.8" fill="#f1f5f9" />
      <rect x="7" y="14.2" width="13" height="3.6" rx="1.8" fill="#a5b4fc" />
      <rect x="7" y="20.4" width="8" height="3.6" rx="1.8" fill="#67e8f9" />
    </svg>
  );
}

export function Header({
  tab,
  onTab,
  connected,
  syncStatus,
  syncing,
  onSyncNow,
  onFullRefresh,
  syncConflict,
  onCancelConflictingSync,
  syncSummary,
  syncFullRefresh,
  aggregate,
  connections,
  onTestConnection,
  onLockVault,
  userName,
  onSignOut,
  now,
}: {
  tab: Tab;
  onTab: (t: Tab) => void;
  connected: boolean;
  syncStatus: SyncStatusResponse | undefined;
  syncing: boolean;
  onSyncNow: () => void;
  /** Increment 29 (contract §5) — refresh-all with `full_refresh: true`:
   * clears every sync watermark first so no stale incremental cut-off can
   * survive it. Shares "Sync now"'s running/disabled/progress handling —
   * both funnel through the same App-level `runSync`. */
  onFullRefresh: () => void;
  /** Increment 22: set when the last "Sync now" click hit a 409 SYNC_IN_PROGRESS. */
  syncConflict?: SyncConflict;
  onCancelConflictingSync: (runId: number) => void;
  /** Increment 23 (SPEC_23 §1): per-connection breakdown of the last
   * refresh-all "Sync now" — undefined for a project-scoped sync (still a
   * bare SyncRun) or before one has run this session. */
  syncSummary?: ConnectionSyncOutcome[];
  /** Increment 29 (contract §5) — whether the run that produced `syncSummary`
   * was a full refresh, so the result panel can label it distinctly. */
  syncFullRefresh?: boolean;
  /** Aggregate health color for the status dot (SPEC_02 §4). */
  aggregate: AggregateHealthColor;
  /** All stored connections (with health) for the popover list. */
  connections: Connection[];
  onTestConnection: (id: number) => void;
  onLockVault: () => void;
  /** Increment 39: display name of the signed-in user (omit → no account cluster). */
  userName?: string;
  onSignOut?: () => void;
  /** Injectable clock for deterministic tests. */
  now?: Date;
}) {
  const { role } = useRole();
  const isViewer = role === "Viewer";
  const running = syncing || syncStatus?.current != null;
  const lastSynced = syncStatus?.last_synced_at ?? null;

  const current = syncStatus?.current;
  const total = current?.total_count ?? null;
  const processed = current?.wp_count ?? 0;
  const pct = total != null && total > 0 ? Math.round((processed / total) * 100) : null;
  const elapsedMs = syncStatus?.current_elapsed_ms ?? null;

  // Increment 19 (SPEC_19 §2c): local "I just clicked Abort" state, but also
  // deferring to `current.cancel_requested` from a PRIOR poll tick — another
  // tab/session could have triggered the cancel, not just this one. Resets
  // whenever the underlying run id changes (a fresh sync started, or this one
  // finished and `current` went to null).
  const currentRunId = current?.id ?? null;
  const [cancelClicked, setCancelClicked] = useState(false);
  useEffect(() => {
    setCancelClicked(false);
  }, [currentRunId]);
  const cancelling = cancelClicked || (current?.cancel_requested ?? false);

  function handleAbort() {
    if (current == null || cancelling) return;
    setCancelClicked(true);
    void api.cancelSync(current.id).catch(() => {
      // Swallow — the next status poll reflects the true state either way.
    });
  }

  // SPEC_19 §2c: once the poll observes the sync gone (`current === null`)
  // and the LAST run ended `"aborted"`, show a brief distinct message instead
  // of the normal "Last synced …" — it naturally reverts to normal on the
  // next successful sync (last.status becomes "success" again).
  const justAborted = !running && syncStatus?.last?.status === "aborted";
  // Increment 20 (SPEC_20 §3): "aborted" now has two causes sharing the same
  // status value — a user's own Abort click (`cancel_requested: true`) vs. the
  // watchdog's automatic 15-minute max-duration cutoff (nobody clicked
  // anything, `cancel_requested` stays false). Distinct copy for each; both
  // still read as "stopped, backlog unchanged" so there's no ambiguity about
  // data safety either way.
  const wasUserCancelled = justAborted && syncStatus?.last?.cancel_requested === true;
  // Increment 20 (SPEC_20 §3): a mid-sync watchdog "no progress for 60s" stop
  // ends the run as `status: "error"` (not "aborted") with a descriptive
  // `error` string on the last run — a genuinely new scenario (a sync that
  // silently stalls and self-terminates), distinct from an immediate
  // connection-failure error a user would already have seen pre-Increment 20.
  // Surface it rather than silently falling back to "Last synced …".
  const justErrored = !running && syncStatus?.last?.status === "error";
  // Increment 22 (SPEC_22 §4): every "Sync now" outcome must be visibly
  // reported, including a successful run that processed zero work packages —
  // the plain "Last synced …" label alone wouldn't look any different than
  // any other sync, so append an explicit outcome qualifier sourced from the
  // just-finished run's own wp_count.
  const justSucceeded = !running && syncStatus?.last?.status === "success";
  const lastWpCount = syncStatus?.last?.wp_count ?? 0;

  return (
    <header className="app-header">
      <div className="app-header-top">
        <div className="brand">
          <BrandMark />
          <h1>OpalTakt</h1>
          <VersionBadge />
        </div>
        <ConnectionStatusIndicator
          aggregate={aggregate}
          connections={connections}
          onTestConnection={onTestConnection}
          onLockVault={onLockVault}
          now={now}
        />
        <div className="app-header-spacer" />
      {connected ? (
          <div className="sync-status">
          {running ? (
            <span
              aria-label="sync progress"
              style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
            >
              <span
                aria-hidden="true"
                style={{ width: 140, height: 6, background: "var(--border)", borderRadius: 999, overflow: "hidden", display: "inline-block" }}
              >
                <span
                  style={{ display: "block", height: "100%", width: pct != null ? `${pct}%` : "40%", background: "var(--primary)", transition: "width .3s" }}
                />
              </span>
              <span className="muted">
                {total != null ? `Importing ${processed}/${total}${pct != null ? ` (${pct}%)` : ""}` : "Starting…"}
                {elapsedMs != null ? ` · ${formatElapsed(elapsedMs)}` : ""}
              </span>
            </span>
          ) : syncConflict != null ? (
            <span
              aria-label="sync conflict"
              style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
              className="muted"
            >
              A sync is already running (started {relativeTime(syncConflict.startedAt, now)})
              <button
                type="button"
                className="btn small secondary"
                onClick={() => onCancelConflictingSync(syncConflict.runId)}
              >
                Cancel it
              </button>
            </span>
          ) : justAborted ? (
            <span aria-label={wasUserCancelled ? "sync cancelled" : "sync stopped"} className="muted sync-text">
              {wasUserCancelled
                ? "Sync cancelled — backlog unchanged"
                : "Sync stopped automatically (ran too long) — backlog unchanged"}
            </span>
          ) : justErrored ? (
            <span aria-label="sync error" className="muted sync-text" title={syncStatus?.last?.error ?? undefined}>
              {syncStatus?.last?.error ? `Sync failed — ${syncStatus.last.error}` : "Sync failed"}
            </span>
          ) : (
            <span aria-label="last synced" className="sync-text">
              Last synced {relativeTime(lastSynced, now)}
              {justSucceeded
                ? ` — ${lastWpCount === 0 ? "no changes" : `updated ${lastWpCount}`}`
                : ""}
            </span>
          )}
          {!isViewer && running && current != null ? (
            <button
              type="button"
              className="btn small secondary"
              aria-label="Abort sync"
              disabled={cancelling}
              onClick={handleAbort}
            >
              {cancelling ? "Cancelling…" : "Abort"}
            </button>
          ) : null}
          {!isViewer ? (
          <button
            type="button"
            className="btn small secondary"
            disabled={running}
            onClick={onSyncNow}
          >
            {running ? "Syncing…" : "Sync now"}
          </button>
          ) : null}
          {/* Increment 29 (contract §5) — re-reads EVERY cached ticket and
              rebuilds the sync cut-offs from scratch (clears every
              sync_watermark row first), unlike the normal incremental "Sync
              now". Shares the same running/disabled state — only one sync
              (of either kind) can be in flight at a time. */}
          {!isViewer ? (
          <button
            type="button"
            className="btn small secondary"
            disabled={running}
            onClick={onFullRefresh}
            title="Re-reads every cached ticket from OpenProject and rebuilds the sync cut-offs from scratch. Slower than Sync now — use it if data still looks stale after a normal sync."
          >
            {running ? "Syncing…" : "Full refresh"}
          </button>
          ) : null}
        </div>
      ) : null}
        <AccountCluster userName={userName} onSignOut={onSignOut} />
      </div>
      <nav className="nav" aria-label="Screens">
        {TABS.filter((t) => !(isViewer && VIEWER_HIDDEN_TABS.includes(t.id))).map((t) => {
          const disabled = !connected && t.id !== "setup";
          return (
            <button
              key={t.id}
              type="button"
              disabled={disabled}
              aria-current={tab === t.id}
              onClick={() => onTab(t.id)}
            >
              {t.label}
            </button>
          );
        })}
      </nav>
      {/* Increment 23 (SPEC_23 §1): the refresh-all "Sync now" per-connection
            breakdown — one line per connection, e.g. "Acme: updated 3
            tickets" / "mock: skipped (disconnected)". Only present once the
            most recent "Sync now" was a refresh-all AND has finished (never
            shown mid-run, alongside the progress bar above). Increment 29:
            each line now also carries the coverage detail (refreshed/total,
            the mandatory not-refreshed warning, data age, orphan note). */}
      {connected && !running && syncSummary != null && syncSummary.length > 0 ? (
          <div
            className="sync-summary muted"
            aria-label="sync summary"
          >
            {syncFullRefresh ? (
              <span data-testid="full-refresh-label" className="sync-summary-label">
                Full refresh
              </span>
            ) : null}
            {syncSummary.map((o) => (
              <ConnectionSyncOutcomeRow key={o.connection_id} outcome={o} />
            ))}
          </div>
        ) : null}
    </header>
  );
}
