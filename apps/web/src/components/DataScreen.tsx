import { useRef, useState } from "react";
import {
  api,
  DATA_EXPORT_SCHEMA_VERSION,
  type DataExportEnvelope,
  type DataImportResult,
} from "../api-client";
import { formatDate } from "../lib/format";
import { ErrorBox, Modal, Panel } from "./ui";

/**
 * Increment 27 (§6) "Settings → Data": local planning-data JSON export/import
 * — the same format the SQLite→PG hard cut uses to migrate the real
 * `osp.sqlite`, doubling here as a local backup/transfer tool. Two
 * independent halves:
 *
 * - **Export** (`ExportSection`): always safe, always available. The
 *   "include credentials" opt-in is deliberately NOT a routine checkbox next
 *   to the export button — it's a separate, warn-styled reveal (mirrors
 *   `VaultUnlockScreen`'s "Forgot passphrase? Reset vault…" pattern in
 *   VaultGate.tsx) that states plainly the resulting file carries encrypted
 *   connection tokens and must be treated as a secret.
 *
 * - **Import** (`ImportSection`): replace-mode only (§6 "Import mode"). This
 *   is the single most destructive action in the app — it wipes EVERY local
 *   sprint, not just one — so it follows the exact confirm pattern
 *   `DeleteSprintButton` (SprintBoardScreen.tsx) already established: a
 *   `Modal` with an explicit "Are you sure" step naming what is destroyed,
 *   a disabled-while-busy danger button, and the modal staying open one
 *   more beat after success to show the outcome before the caller is told
 *   to refresh (here: the reminder that the work-package cache was NOT
 *   imported and "Sync now" is required).
 */
export function DataScreen({ onImported }: { onImported: () => void }) {
  return (
    <>
      <Panel title="Data">
        <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
          Export or replace all locally stored sprint-planning data — sprints, baselines, changelog, burndown,
          capacity and closure reports, team members and settings. This never reads from or writes to OpenProject
          itself; connection tokens are transported only if you explicitly opt in below.
        </p>
      </Panel>
      <ExportSection />
      <ImportSection onImported={onImported} />
    </>
  );
}

// ── Export ───────────────────────────────────────────────────────────────

function ExportSection() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  const [showCredentialsOption, setShowCredentialsOption] = useState(false);
  const [credentialsAck, setCredentialsAck] = useState(false);

  async function runExport(includeCredentials: boolean) {
    setBusy(true);
    setError(undefined);
    try {
      await api.exportData(includeCredentials);
      // A successful export is a same-tab file download — nothing more to
      // show here (the browser's own download UI is the confirmation).
      if (includeCredentials) setCredentialsAck(false);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Export">
      <p style={{ marginTop: 0 }}>
        Download a JSON file of your local planning data. It never includes the work-package cache or sync
        history — those come back from OpenProject on the next sync.
      </p>
      <div className="row">
        <button
          type="button"
          className="btn small"
          disabled={busy}
          onClick={() => void runExport(false)}
          data-testid="export-button"
        >
          {busy ? "Exporting…" : "Export data"}
        </button>
      </div>

      <div style={{ marginTop: 16, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
        {!showCredentialsOption ? (
          <button
            type="button"
            className="btn small secondary"
            onClick={() => setShowCredentialsOption(true)}
            data-testid="reveal-export-credentials"
          >
            Include connection credentials…
          </button>
        ) : (
          <div className="msg warn" data-testid="export-credentials-warning">
            <p style={{ marginTop: 0 }}>
              <strong>This file will contain your encrypted OpenProject connection tokens.</strong> Anyone who
              obtains it — together with your vault passphrase — can decrypt and use those tokens. Handle it as a
              secret: do not email it, commit it, or store it anywhere the connection tokens themselves would not
              be allowed.
            </p>
            <label className="row" style={{ alignItems: "center", gap: 8, marginBottom: 12 }}>
              <input
                type="checkbox"
                aria-label="I understand this export contains secret connection credentials"
                checked={credentialsAck}
                disabled={busy}
                onChange={(e) => setCredentialsAck(e.target.checked)}
                data-testid="export-credentials-ack"
              />
              I understand and want to include the connection credentials in this export.
            </label>
            <div className="row" style={{ marginBottom: 0 }}>
              <button
                type="button"
                className="btn small danger"
                disabled={busy || !credentialsAck}
                onClick={() => void runExport(true)}
                data-testid="export-with-credentials-button"
              >
                {busy ? "Exporting…" : "Export data with credentials"}
              </button>
              <button
                type="button"
                className="btn small secondary"
                disabled={busy}
                onClick={() => {
                  setShowCredentialsOption(false);
                  setCredentialsAck(false);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {error ? (
        <div style={{ marginTop: 12 }}>
          <ErrorBox error={error} />
        </div>
      ) : null}
    </Panel>
  );
}

// ── Import ───────────────────────────────────────────────────────────────

type ParsedFile = { name: string; envelope: DataExportEnvelope; rowCount: number };

/**
 * British DD/MM/YYYY (matches `formatDate`, Increment 16 §4) plus an
 * explicit UTC time — deliberately not the local-timezone-shifting
 * `Date#toLocaleString` this codebase avoids elsewhere for the same class of
 * bug (real-clock-vs-ISO ambiguity).
 */
function formatExportedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${formatDate(iso)} ${hh}:${mm} UTC`;
}

function totalRows(envelope: DataExportEnvelope): number {
  return Object.values(envelope.tables ?? {}).reduce(
    (sum, rows) => sum + (Array.isArray(rows) ? rows.length : 0),
    0,
  );
}

/** Read + parse a File as a §6 export envelope, or throw a friendly Error. */
async function readEnvelope(file: File): Promise<DataExportEnvelope> {
  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("That file doesn't look like an OpalTakt data export.");
  }
  const envelope = parsed as Partial<DataExportEnvelope>;
  if (envelope.schema_version !== DATA_EXPORT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported export format (schema version ${String(envelope.schema_version)}, this app reads version ` +
        `${DATA_EXPORT_SCHEMA_VERSION}).`,
    );
  }
  if (envelope.tables == null || typeof envelope.tables !== "object") {
    throw new Error("That file doesn't look like an OpalTakt data export (missing tables).");
  }
  return envelope as DataExportEnvelope;
}

function ImportSection({ onImported }: { onImported: () => void }) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [parsed, setParsed] = useState<ParsedFile | undefined>();
  const [readError, setReadError] = useState<Error | undefined>();
  const [passphrase, setPassphrase] = useState("");
  const [showConfirm, setShowConfirm] = useState(false);

  function resetFile() {
    setParsed(undefined);
    setReadError(undefined);
    setPassphrase("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleFileChosen(file: File) {
    setReadError(undefined);
    setParsed(undefined);
    try {
      const envelope = await readEnvelope(file);
      setParsed({ name: file.name, envelope, rowCount: totalRows(envelope) });
    } catch (err) {
      setReadError(err instanceof Error ? err : new Error(String(err)));
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  const needsPassphrase = parsed?.envelope.includes_credentials === true;
  const canOpenConfirm = parsed != null && (!needsPassphrase || passphrase.length > 0);

  return (
    <Panel title="Import (replace)">
      <p style={{ marginTop: 0 }}>
        Load a previously exported JSON file. Import always <strong>replaces</strong> your current local planning
        data — there is no way to merge — so review the summary below carefully before confirming.
      </p>

      <div className="field">
        <label htmlFor="import-file-input">Export file</label>
        <input
          id="import-file-input"
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          data-testid="import-file-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFileChosen(file);
          }}
        />
      </div>

      {readError ? (
        <div style={{ marginBottom: 12 }}>
          <ErrorBox error={readError} />
        </div>
      ) : null}

      {parsed ? (
        <div className="msg" data-testid="import-summary" style={{ marginBottom: 12 }}>
          <p style={{ marginTop: 0 }}>
            <strong>{parsed.name}</strong> — exported {formatExportedAt(parsed.envelope.exported_at)}, {parsed.rowCount} row
            {parsed.rowCount === 1 ? "" : "s"} across {Object.keys(parsed.envelope.tables).length} table
            {Object.keys(parsed.envelope.tables).length === 1 ? "" : "s"}.
          </p>
          {parsed.envelope.includes_credentials ? (
            <p className="muted" style={{ fontSize: 12 }}>
              This file includes encrypted connection credentials. Your vault passphrase is required to import
              them.
            </p>
          ) : (
            <p className="muted" style={{ fontSize: 12 }}>
              This file does not include connection credentials — existing connections keep their current tokens.
            </p>
          )}
          {needsPassphrase ? (
            <div className="field" style={{ marginTop: 8 }}>
              <label htmlFor="import-passphrase">Vault passphrase</label>
              <input
                id="import-passphrase"
                type="password"
                autoComplete="current-password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                data-testid="import-passphrase"
              />
            </div>
          ) : null}
          <div className="row" style={{ marginBottom: 0 }}>
            <button
              type="button"
              className="btn small danger"
              disabled={!canOpenConfirm}
              onClick={() => setShowConfirm(true)}
              data-testid="import-replace-button"
            >
              Replace local data…
            </button>
            <button type="button" className="btn small secondary" onClick={resetFile}>
              Choose a different file
            </button>
          </div>
        </div>
      ) : null}

      {showConfirm && parsed ? (
        <ImportConfirmModal
          fileName={parsed.name}
          envelope={parsed.envelope}
          passphrase={needsPassphrase ? passphrase : undefined}
          onClose={() => setShowConfirm(false)}
          onImported={() => {
            setShowConfirm(false);
            resetFile();
            onImported();
          }}
        />
      ) : null}
    </Panel>
  );
}

/**
 * The confirm/result modal — deliberately structured exactly like
 * `DeleteSprintButton` in SprintBoardScreen.tsx: a Yes/No confirm step, an
 * `error` state that keeps the confirm step open for retry, and a distinct
 * `imported` boolean (not a truthy check on the result) driving the
 * post-success view, so a backend response that omits optional fields can
 * never be mistaken for "the import didn't happen".
 */
function ImportConfirmModal({
  fileName,
  envelope,
  passphrase,
  onClose,
  onImported,
}: {
  fileName: string;
  envelope: DataExportEnvelope;
  passphrase: string | undefined;
  onClose: () => void;
  onImported: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  const [imported, setImported] = useState(false);
  const [result, setResult] = useState<DataImportResult | undefined>();

  async function confirm() {
    setBusy(true);
    setError(undefined);
    try {
      const res = await api.importData({ ...envelope, passphrase });
      setResult(res);
      setImported(true);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  }

  function handleClose() {
    if (busy) return;
    if (imported) {
      onImported();
    } else {
      onClose();
    }
  }

  const importedTableCount = result?.tables ? Object.keys(result.tables).length : undefined;

  return (
    <Modal title={imported ? "Import complete" : "Replace all local data?"} onClose={handleClose}>
      {imported ? (
        <>
          <p>
            Local planning data was replaced from <strong>{fileName}</strong>
            {importedTableCount != null ? ` — ${importedTableCount} tables loaded.` : "."}
          </p>
          <p className="msg warn" role="status" data-testid="import-sync-reminder">
            The work-package cache was intentionally not part of this import. Run <strong>Sync now</strong> to
            repopulate it from OpenProject before relying on the backlog or capacity numbers.
          </p>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="btn small" onClick={handleClose} data-testid="import-done-button">
              Done
            </button>
          </div>
        </>
      ) : (
        <>
          <p>
            Are you sure? This <strong>permanently erases</strong> every locally stored sprint and its full history
            — items, baselines, changelog, burndown, capacity, and closure reports — plus team members, roles,
            connection and project metadata, and every other locally stored planning setting. It is then replaced
            with the contents of <strong>{fileName}</strong>.
          </p>
          <p className="muted" style={{ fontSize: 12 }}>
            OpenProject itself is not touched. There is no undo — if you want to keep what's currently stored,
            export it first and cancel this import.
          </p>
          {error ? (
            <div style={{ marginBottom: 12 }}>
              <ErrorBox error={error} />
            </div>
          ) : null}
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="btn small secondary" disabled={busy} onClick={onClose}>
              No
            </button>
            <button
              type="button"
              className="btn small danger"
              disabled={busy}
              onClick={() => void confirm()}
              data-testid="import-confirm-button"
            >
              {busy ? "Replacing…" : "Yes, replace"}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
