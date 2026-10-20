import { useState } from "react";
import type { AddConnectionResponse, Connection } from "@osp/contracts";
import { api, ApiError } from "../api-client";
import { ErrorBox, EmptyState, Panel } from "./ui";

/**
 * SPEC_02 §6 Setup: manage the stored OP servers (add / remove / relabel /
 * pick the current one / re-enter a missing token) plus the vault controls
 * (lock, change passphrase, reset). Tokens are sent once in a request body and
 * cleared from component state immediately — they are never returned by any
 * API response (SPEC_02 §3).
 */

const RESET_CONFIRM_WORD = "RESET";

export function SetupScreen({
  connections,
  onChanged,
  onAdded,
  onVaultLocked,
  onVaultReset,
}: {
  connections: Connection[];
  /** Any server list mutation happened — reload connections/health. */
  onChanged: () => void;
  /** A server was added (response may lack `user` when validation failed). */
  onAdded: (resp: AddConnectionResponse) => void;
  onVaultLocked: () => void;
  onVaultReset: () => void;
}) {
  return (
    <>
      <Panel title="Servers">
        {connections.length === 0 ? (
          <EmptyState>No servers yet. Add your first OpenProject server below.</EmptyState>
        ) : (
          <div>
            {connections.map((c) => (
              <ServerRow key={c.id} connection={c} onChanged={onChanged} />
            ))}
          </div>
        )}
      </Panel>

      <AddServerPanel onAdded={onAdded} />

      <VaultPanel onVaultLocked={onVaultLocked} onVaultReset={onVaultReset} />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// One stored server
// ─────────────────────────────────────────────────────────────────────────────

function ServerRow({ connection: c, onChanged }: { connection: Connection; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  const [editingLabel, setEditingLabel] = useState(false);
  const [label, setLabel] = useState(c.label ?? "");
  const [token, setToken] = useState("");

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      onChanged();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveLabel() {
    const ok = await run(() => api.updateConnection(c.id, { label: label.trim() === "" ? null : label.trim() }));
    if (ok) setEditingLabel(false);
  }

  async function saveToken(e: React.FormEvent) {
    e.preventDefault();
    const ok = await run(() => api.updateConnection(c.id, { token }));
    // The token never outlives the request in component state.
    setToken("");
    if (!ok) return;
  }

  function remove() {
    if (!window.confirm(`Remove ${c.base_url}? Its stored token is deleted too.`)) return;
    void run(() => api.deleteConnection(c.id));
  }

  const status = c.health.last_status;
  // A manually disconnected server (Increment 8 §2) reads as neutral/grey
  // regardless of its last known health — it's no longer being probed, so a
  // stale ok/fail would be misleading.
  const dot = !c.enabled ? "neutral" : status === "ok" ? "green" : status === "fail" ? "red" : "neutral";

  return (
    <div className="server-row">
      <div className="row" style={{ alignItems: "center" }}>
        <span
          className={`status-dot ${dot}`}
          aria-label={`server status: ${c.enabled ? status : "disabled"}`}
        />
        <div style={{ flex: 1 }}>
          <div>
            <strong>{c.base_url}</strong>
            {c.label ? <span className="muted"> — {c.label}</span> : null}{" "}
            {c.is_current ? <span className="badge open">current</span> : null}
          </div>
          {c.health.last_error && status === "fail" ? (
            <div className="muted" style={{ color: "var(--danger)" }}>{c.health.last_error}</div>
          ) : null}
        </div>
        {!c.is_current ? (
          <button
            type="button"
            className="btn small secondary"
            disabled={busy || !c.enabled}
            onClick={() => void run(() => api.updateConnection(c.id, { current: true }))}
          >
            Use this server
          </button>
        ) : null}
        <button
          type="button"
          className="btn small secondary"
          disabled={busy}
          onClick={() => {
            setLabel(c.label ?? "");
            setEditingLabel((v) => !v);
          }}
        >
          Edit label
        </button>
        <button
          type="button"
          className="btn small secondary"
          disabled={busy}
          title={
            c.enabled
              ? "Temporarily exclude this server's projects/tickets from the pickers"
              : "Reconnect this server"
          }
          onClick={() => void run(() => api.updateConnection(c.id, { enabled: !c.enabled }))}
        >
          {c.enabled ? "Disconnect" : "Connect"}
        </button>
        <button type="button" className="btn small danger" disabled={busy} onClick={remove}>
          Remove
        </button>
      </div>
      {!c.enabled ? (
        <div className="msg warn" style={{ marginTop: 8 }}>
          Disconnected — its projects and tickets are hidden from the Import picker until
          reconnected. Nothing was deleted.
        </div>
      ) : null}

      {editingLabel ? (
        <div className="row" style={{ marginTop: 8 }}>
          <div className="field" style={{ flex: 1, marginBottom: 0 }}>
            <label htmlFor={`label-${c.id}`}>Label</label>
            <input
              id={`label-${c.id}`}
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <button type="button" className="btn small" disabled={busy} onClick={() => void saveLabel()}>
            Save label
          </button>
        </div>
      ) : null}

      {!c.has_token ? (
        <form className="row" style={{ marginTop: 8 }} onSubmit={saveToken}>
          <div className="msg warn" style={{ flexBasis: "100%", padding: "8px 10px" }}>
            Token missing (vault was reset) — re-enter the API token for this server.
          </div>
          <div className="field" style={{ flex: 1, marginBottom: 0 }}>
            <label htmlFor={`token-${c.id}`}>Re-enter API token</label>
            <input
              id={`token-${c.id}`}
              type="password"
              required
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </div>
          <button type="submit" className="btn small" disabled={busy || token.length === 0}>
            Save token
          </button>
        </form>
      ) : null}

      {error ? <div style={{ marginTop: 8 }}><ErrorBox error={error} /></div> : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Add server
// ─────────────────────────────────────────────────────────────────────────────

function AddServerPanel({ onAdded }: { onAdded: (resp: AddConnectionResponse) => void }) {
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  const [result, setResult] = useState<AddConnectionResponse | undefined>();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      const resp = await api.addConnection({
        base_url: baseUrl,
        token,
        label: label.trim() === "" ? undefined : label.trim(),
      });
      // The token is encrypted server-side; drop it from the UI immediately.
      setToken("");
      setBaseUrl("");
      setLabel("");
      setResult(resp);
      onAdded(resp);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError(new Error("Server already added."));
      } else {
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Add server">
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="op-url">OpenProject URL</label>
          <input
            id="op-url"
            type="url"
            required
            placeholder="https://openproject.example.com"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="op-token">API token</label>
          <input
            id="op-token"
            type="password"
            required
            autoComplete="off"
            placeholder="Your OpenProject API token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="op-label">Label (optional)</label>
          <input
            id="op-label"
            type="text"
            placeholder="e.g. Production"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        <div className="row">
          <button className="btn" type="submit" disabled={busy || !baseUrl || !token}>
            {busy ? "Adding…" : "Add server"}
          </button>
        </div>
      </form>

      {error ? <div style={{ marginTop: 12 }}><ErrorBox error={error} /></div> : null}

      {result ? (
        result.user ? (
          <div className="msg ok" role="status" style={{ marginTop: 12 }}>
            Connected as <strong>{result.user.name}</strong>
            {result.user.login ? ` (${result.user.login})` : ""}.
          </div>
        ) : (
          <div className="msg warn" role="status" style={{ marginTop: 12 }}>
            Server stored, but validation failed — it may be unreachable or the
            token invalid. Its status stays red until it can be reached.
          </div>
        )
      ) : null}
    </Panel>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Vault controls
// ─────────────────────────────────────────────────────────────────────────────

function VaultPanel({
  onVaultLocked,
  onVaultReset,
}: {
  onVaultLocked: () => void;
  onVaultReset: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  const [message, setMessage] = useState<string | undefined>();

  const [oldPass, setOldPass] = useState("");
  const [newPass, setNewPass] = useState("");
  const [newPassConfirm, setNewPassConfirm] = useState("");

  const [resetConfirm, setResetConfirm] = useState("");

  async function lockNow() {
    setBusy(true);
    setError(undefined);
    try {
      await api.lockVault();
      onVaultLocked();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  }

  async function changePassphrase(e: React.FormEvent) {
    e.preventDefault();
    if (newPass.length < 8 || newPass !== newPassConfirm) return;
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      await api.changeVaultPassphrase({ old_passphrase: oldPass, new_passphrase: newPass });
      setMessage("Passphrase changed. All tokens were re-encrypted.");
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      // Passphrases never outlive the request in component state.
      setOldPass("");
      setNewPass("");
      setNewPassConfirm("");
      setBusy(false);
    }
  }

  async function resetVault() {
    if (resetConfirm !== RESET_CONFIRM_WORD) return;
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const r = await api.resetVault({ confirm: true });
      setResetConfirm("");
      setMessage(`Vault reset — ${r.cleared_tokens} stored token(s) deleted. Server URLs were kept.`);
      onVaultReset();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  }

  const mismatch = newPassConfirm.length > 0 && newPass !== newPassConfirm;

  return (
    <Panel
      title="Vault"
      actions={
        <button type="button" className="btn small secondary" disabled={busy} onClick={() => void lockNow()}>
          Lock now
        </button>
      }
    >
      <p className="muted">
        Your OpenProject tokens are encrypted with the master passphrase. Locking
        keeps everything stored but blocks OP calls until you unlock again.
      </p>

      <h3 style={{ fontSize: 13, margin: "12px 0 8px", color: "var(--muted)" }}>Change passphrase</h3>
      <form onSubmit={changePassphrase}>
        <div className="row">
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="vault-old-pass">Current passphrase</label>
            <input
              id="vault-old-pass"
              type="password"
              required
              autoComplete="current-password"
              value={oldPass}
              onChange={(e) => setOldPass(e.target.value)}
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="vault-new-pass">New passphrase (min 8 characters)</label>
            <input
              id="vault-new-pass"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              value={newPass}
              onChange={(e) => setNewPass(e.target.value)}
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="vault-new-pass-confirm">Confirm new passphrase</label>
            <input
              id="vault-new-pass-confirm"
              type="password"
              required
              autoComplete="new-password"
              value={newPassConfirm}
              onChange={(e) => setNewPassConfirm(e.target.value)}
            />
          </div>
          <button
            className="btn"
            type="submit"
            disabled={busy || oldPass.length === 0 || newPass.length < 8 || newPass !== newPassConfirm}
          >
            Change passphrase
          </button>
        </div>
        {mismatch ? <div className="msg warn" style={{ marginTop: 8 }}>New passphrases do not match.</div> : null}
      </form>

      <h3 style={{ fontSize: 13, margin: "16px 0 8px", color: "var(--muted)" }}>Reset vault</h3>
      <p className="muted">
        Deletes <strong>all stored tokens</strong> (server URLs are kept) — you
        will have to re-enter every token. Type <strong>{RESET_CONFIRM_WORD}</strong> to confirm.
      </p>
      <div className="row">
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="vault-reset-confirm">Type {RESET_CONFIRM_WORD} to confirm</label>
          <input
            id="vault-reset-confirm"
            type="text"
            autoComplete="off"
            value={resetConfirm}
            onChange={(e) => setResetConfirm(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="btn danger"
          disabled={busy || resetConfirm !== RESET_CONFIRM_WORD}
          onClick={() => void resetVault()}
        >
          Reset vault
        </button>
      </div>

      {message ? <div className="msg ok" role="status" style={{ marginTop: 12 }}>{message}</div> : null}
      {error ? <div style={{ marginTop: 12 }}><ErrorBox error={error} /></div> : null}
    </Panel>
  );
}
