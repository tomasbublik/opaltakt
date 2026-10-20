import type { ReactNode } from "react";
import { ApiError } from "../api-client";

/**
 * Best-effort read of `error.details.sprintName` (SPEC_05 §6.2): sprint-lifecycle
 * AppErrors (e.g. SPRINT_NOT_ACTIVE) carry the sprint's real name there, so an
 * error never reads like it references some other, internally-numbered sprint.
 */
function detailSprintName(details: unknown): string | undefined {
  if (details && typeof details === "object" && "sprintName" in details) {
    const name = (details as Record<string, unknown>).sprintName;
    return typeof name === "string" && name.length > 0 ? name : undefined;
  }
  return undefined;
}

/** Turn any thrown error into a user-facing message, surfacing the API code. */
export function errorMessage(error: Error): string {
  if (error instanceof ApiError) {
    const code = error.body?.error.code;
    const msg = error.body?.error.message ?? error.message;
    const sprintName = detailSprintName(error.body?.error.details);
    // Only append — the backend message is expected to already name the sprint
    // (SPEC_05 §6.2); this is a defensive backstop for messages that don't.
    const named = sprintName && !msg.includes(sprintName) ? `${msg} (sprint: ${sprintName})` : msg;
    return code ? `${named} (${code})` : named;
  }
  return error.message;
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="msg" role="status">
      {label}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="msg error" role="alert">
      {errorMessage(error)}
      {onRetry ? (
        <>
          {" "}
          <button className="btn small secondary" onClick={onRetry} type="button">
            Retry
          </button>
        </>
      ) : null}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="msg" role="note">
      {children}
    </div>
  );
}

export function Panel({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="panel">
      {(title || actions) && (
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {title ? <h2 style={{ flex: 1 }}>{title}</h2> : <div className="spacer" />}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * Minimal modal dialog (SPEC_04 §6 ticket changelog panel). No new UI library —
 * just a fixed overlay + centered panel reusing the app's existing tokens.
 * Clicking the overlay or the × closes it; content clicks don't propagate.
 */
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="modal-overlay" role="presentation" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3 style={{ flex: 1, margin: 0 }}>{title}</h3>
          <button type="button" className="btn small secondary" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/**
 * Small state machine renderer: shows spinner / error / empty / content
 * based on an async result. Keeps every screen's loading UX consistent.
 */
export function Async<T>({
  state,
  children,
  isEmpty,
  empty,
  loadingLabel,
}: {
  state: { data: T | undefined; error: Error | undefined; loading: boolean; reload: () => void };
  children: (data: T) => ReactNode;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  loadingLabel?: string;
}) {
  if (state.error) return <ErrorBox error={state.error} onRetry={state.reload} />;
  if (state.loading && state.data === undefined) return <Spinner label={loadingLabel} />;
  if (state.data === undefined) return <Spinner label={loadingLabel} />;
  if (isEmpty && isEmpty(state.data)) return <>{empty ?? <EmptyState>Nothing here yet.</EmptyState>}</>;
  return <>{children(state.data)}</>;
}
