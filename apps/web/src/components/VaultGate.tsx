import { useState } from "react";
import { api } from "../api-client";
import { ErrorBox, Panel } from "./ui";

/**
 * SPEC_02 §6 vault gate: shown before the app when the vault is missing or
 * locked. The passphrase only ever travels in the request body — it is never
 * stored anywhere in the frontend beyond the controlled inputs, which are
 * cleared as soon as the request settles.
 */

const RESET_CONFIRM_WORD = "RESET";

/** First run: create the master passphrase that encrypts all OP tokens. */
export function VaultCreateScreen({ onCreated }: { onCreated: () => void }) {
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | undefined>();

  const tooShort = passphrase.length > 0 && passphrase.length < 8;
  const mismatch = confirm.length > 0 && confirm !== passphrase;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (passphrase.length < 8 || passphrase !== confirm) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.initVault({ passphrase });
      setPassphrase("");
      setConfirm("");
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Create passphrase">
      <p className="muted">
        This passphrase encrypts all your OpenProject API tokens locally. It is
        never stored and <strong>cannot be recovered</strong> — if you forget
        it, the only way out is a vault reset, which deletes the stored tokens
        (server URLs are kept).
      </p>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="vault-pass">Passphrase (min 8 characters)</label>
          <input
            id="vault-pass"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="vault-pass-confirm">Confirm passphrase</label>
          <input
            id="vault-pass-confirm"
            type="password"
            required
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>
        {tooShort ? <div className="msg warn">Passphrase must be at least 8 characters.</div> : null}
        {mismatch ? <div className="msg warn">Passphrases do not match.</div> : null}
        <div className="row" style={{ marginTop: 12 }}>
          <button
            className="btn"
            type="submit"
            disabled={busy || passphrase.length < 8 || passphrase !== confirm}
          >
            {busy ? "Creating…" : "Create vault"}
          </button>
        </div>
      </form>
      {error ? <div style={{ marginTop: 12 }}><ErrorBox error={error} /></div> : null}
    </Panel>
  );
}

/**
 * Every start: unlock the vault with the master passphrase. Offers a
 * "Reset vault" escape hatch for a forgotten passphrase — it deletes the
 * stored tokens but keeps the server URLs.
 */
export function VaultUnlockScreen({
  onUnlocked,
  onReset,
}: {
  onUnlocked: () => void;
  /** Called after a successful reset — the caller re-checks vault status. */
  onReset: () => void;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  const [showReset, setShowReset] = useState(false);
  const [resetConfirm, setResetConfirm] = useState("");
  const [resetError, setResetError] = useState<Error | undefined>();

  async function unlock(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.unlockVault({ passphrase });
      setPassphrase("");
      onUnlocked();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (resetConfirm !== RESET_CONFIRM_WORD) return;
    setBusy(true);
    setResetError(undefined);
    try {
      await api.resetVault({ confirm: true });
      setResetConfirm("");
      onReset();
    } catch (err) {
      setResetError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Unlock vault">
      <p className="muted">
        Enter your master passphrase to decrypt the stored OpenProject tokens.
      </p>
      <form onSubmit={unlock}>
        <div className="field">
          <label htmlFor="vault-unlock-pass">Passphrase</label>
          <input
            id="vault-unlock-pass"
            type="password"
            required
            autoComplete="current-password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
          />
        </div>
        <div className="row">
          <button className="btn" type="submit" disabled={busy || passphrase.length === 0}>
            {busy ? "Unlocking…" : "Unlock"}
          </button>
        </div>
      </form>
      {error ? <div style={{ marginTop: 12 }}><ErrorBox error={error} /></div> : null}

      <div style={{ marginTop: 20, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
        {!showReset ? (
          <button
            type="button"
            className="btn small secondary"
            onClick={() => setShowReset(true)}
          >
            Forgot passphrase? Reset vault…
          </button>
        ) : (
          <div>
            <p className="msg warn">
              Resetting the vault <strong>deletes all stored tokens</strong> —
              you will have to re-enter them. Server URLs are kept. Type{" "}
              <strong>{RESET_CONFIRM_WORD}</strong> to confirm.
            </p>
            <div className="field">
              <label htmlFor="vault-reset-confirm">Type {RESET_CONFIRM_WORD} to confirm</label>
              <input
                id="vault-reset-confirm"
                type="text"
                autoComplete="off"
                value={resetConfirm}
                onChange={(e) => setResetConfirm(e.target.value)}
              />
            </div>
            <div className="row">
              <button
                type="button"
                className="btn danger"
                disabled={busy || resetConfirm !== RESET_CONFIRM_WORD}
                onClick={reset}
              >
                Reset vault
              </button>
              <button
                type="button"
                className="btn small secondary"
                onClick={() => {
                  setShowReset(false);
                  setResetConfirm("");
                  setResetError(undefined);
                }}
              >
                Cancel
              </button>
            </div>
            {resetError ? <div style={{ marginTop: 12 }}><ErrorBox error={resetError} /></div> : null}
          </div>
        )}
      </div>
    </Panel>
  );
}
