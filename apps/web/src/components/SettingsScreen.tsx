import { useEffect, useState } from "react";
import { api } from "../api-client";
import { useAsync } from "../lib/useAsync";
import { useCan } from "../lib/role";
import { Async, ErrorBox, Panel } from "./ui";

/**
 * Increment 31 (docs/INCREMENT_31_CONTRACTS.md §3/§4) — "Settings": the
 * app-level `report_config` singleton, edited via GET/PUT /api/config.
 *
 * `freeze_grace_days` is new: after a sprint finishes, updates (late time
 * logs, final status flips) still land for this many days; once the sweep
 * passes `locked_at + freeze_grace_days`, the sprint is frozen — its
 * numbers become immutable, it stops updating from OpenProject, and its
 * tickets stop being protected on the Import page (docs §0/§3). Reactivating
 * a sprint clears the freeze along with everything else reactivate resets.
 *
 * `overshoot_threshold_pct` already existed (SPEC_14 §3, read by
 * ClosureStats.tsx) but had no edit surface anywhere — this screen finally
 * gives it one.
 *
 * The People & roles tab (PeopleScreen.tsx) deliberately STAYS where it is
 * (docs §4 point 1 — moving it would churn e2e specs for no functional
 * gain); this screen only links to it.
 */
export function SettingsScreen({ onGoToPeople }: { onGoToPeople?: () => void }) {
  const state = useAsync(() => api.getConfig(), []);

  return (
    <Panel title="Settings">
      <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
        App-wide settings shared by every sprint and connection. People &amp; roles have their own tab
        {onGoToPeople ? (
          <>
            {" "}
            —{" "}
            <button
              type="button"
              className="btn small secondary"
              style={{ padding: "1px 8px" }}
              onClick={onGoToPeople}
            >
              go to People
            </button>
          </>
        ) : (
          " (Settings → People)."
        )}
      </p>
      <Async state={state} loadingLabel="Loading settings…">
        {(config) => <SettingsForm config={config} onSaved={() => state.reload()} />}
      </Async>
    </Panel>
  );
}

function SettingsForm({
  config,
  onSaved,
}: {
  config: { overshoot_threshold_pct: number; freeze_grace_days: number };
  onSaved: () => void;
}) {
  const canPlan = useCan("plan");
  const [graceDays, setGraceDays] = useState(String(config.freeze_grace_days));
  const [overshootPct, setOvershootPct] = useState(String(config.overshoot_threshold_pct));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  const [saved, setSaved] = useState(false);

  // Reflect a fresh GET (e.g. after `onSaved` reloads, or the config changed
  // in another tab) — but only while the fields aren't mid-edit-and-unsaved,
  // same convention as other screens' "server state wins once idle" forms.
  useEffect(() => {
    setGraceDays(String(config.freeze_grace_days));
    setOvershootPct(String(config.overshoot_threshold_pct));
  }, [config.freeze_grace_days, config.overshoot_threshold_pct]);

  useEffect(() => {
    if (!saved) return;
    const t = window.setTimeout(() => setSaved(false), 4000);
    return () => window.clearTimeout(t);
  }, [saved]);

  const graceDaysNum = Number(graceDays);
  const overshootPctNum = Number(overshootPct);
  const graceDaysValid = Number.isInteger(graceDaysNum) && graceDaysNum >= 0 && graceDaysNum <= 60;
  const overshootPctValid = Number.isFinite(overshootPctNum) && overshootPctNum > 0;

  async function save() {
    if (!graceDaysValid || !overshootPctValid || busy) return;
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      await api.updateConfig({
        freeze_grace_days: graceDaysNum,
        overshoot_threshold_pct: overshootPctNum,
      });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="field">
        <label htmlFor="settings-grace-days">Sprint freeze grace period (days)</label>
        <input
          id="settings-grace-days"
          type="number"
          min={0}
          max={60}
          step={1}
          value={graceDays}
          disabled={!canPlan}
          onChange={(e) => setGraceDays(e.target.value)}
        />
        <p className="muted" style={{ fontSize: 12, marginTop: 4, marginBottom: 0 }}>
          After a sprint is finished, updates from OpenProject (late time logs, final status changes) still
          arrive for this many days. Once the grace period elapses the sprint is <strong>frozen</strong>: its
          numbers become immutable, it no longer updates from OpenProject, and its tickets stop being
          protected on the Import page&apos;s out-of-selection cleanup. Reactivating a frozen sprint unfreezes
          it. 0 means the sprint freezes at the very first check after it finishes.
        </p>
        {!graceDaysValid ? (
          <div className="msg warn" style={{ marginTop: 4 }}>
            Must be a whole number of days between 0 and 60.
          </div>
        ) : null}
      </div>

      <div className="field">
        <label htmlFor="settings-overshoot-pct">Overshoot threshold (%)</label>
        <input
          id="settings-overshoot-pct"
          type="number"
          min={1}
          step={1}
          value={overshootPct}
          disabled={!canPlan}
          onChange={(e) => setOvershootPct(e.target.value)}
        />
        <p className="muted" style={{ fontSize: 12, marginTop: 4, marginBottom: 0 }}>
          A done ticket is flagged as an overshoot when logged time exceeds its estimate by more than this
          percentage (Closure and the closure report).
        </p>
        {!overshootPctValid ? (
          <div className="msg warn" style={{ marginTop: 4 }}>
            Must be a positive number.
          </div>
        ) : null}
      </div>

      {canPlan ? (
        <button className="btn" type="submit" disabled={busy || !graceDaysValid || !overshootPctValid}>
          {busy ? "Saving…" : "Save settings"}
        </button>
      ) : (
        <p className="muted" style={{ fontSize: 12 }}>Read-only — changing settings requires the Planner role.</p>
      )}

      {saved ? (
        <div className="msg ok" role="status" style={{ marginTop: 12 }}>
          Settings saved.
        </div>
      ) : null}
      {error ? (
        <div style={{ marginTop: 12 }}>
          <ErrorBox error={error} />
        </div>
      ) : null}
    </form>
  );
}
