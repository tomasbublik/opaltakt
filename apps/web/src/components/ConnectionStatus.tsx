import { useRef, useState } from "react";
import type { AggregateHealthColor, Connection, ConnectionStatus as HealthStatus } from "@osp/contracts";
import { relativeTime } from "../lib/format";
import { useDismissablePopover } from "../lib/useDismissablePopover";
import { useCan } from "../lib/role";

/**
 * SPEC_02 §6 header indicator: aggregate colored dot + current server URL,
 * click opens a popover listing every stored connection with per-server
 * health, a "Test now" action and a "Lock vault" action. Data arrives from
 * App's single health subscription — this component is presentation-only.
 */

/** Map a per-server status onto a dot color class. A manually disconnected
 * server (Increment 8 §2) reads as neutral/grey regardless of its last known
 * health — it's no longer being probed, so showing a stale ok/fail would be
 * misleading. */
function statusDotClass(status: HealthStatus, enabled: boolean): AggregateHealthColor {
  if (!enabled) return "neutral";
  return status === "ok" ? "green" : status === "fail" ? "red" : "neutral";
}

export function ConnectionStatusIndicator({
  aggregate,
  connections,
  onTestConnection,
  onLockVault,
  now,
}: {
  aggregate: AggregateHealthColor;
  connections: Connection[];
  onTestConnection: (id: number) => void;
  onLockVault: () => void;
  /** Injectable clock for deterministic tests. */
  now?: Date;
}) {
  const canPlan = useCan("plan");
  const [open, setOpen] = useState(false);
  const [testingId, setTestingId] = useState<number | undefined>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  // SPEC_10 §b: close on outside-click or Escape. `containerRef` wraps both the
  // trigger button and the popover so a re-click on the trigger toggles via its
  // own onClick rather than racing the outside-click listener.
  const containerRef = useDismissablePopover<HTMLDivElement>(
    open,
    () => setOpen(false),
    triggerRef,
  );

  const current = connections.find((c) => c.is_current) ?? connections[0];

  function testNow(id: number) {
    setTestingId(id);
    Promise.resolve(onTestConnection(id)).finally(() => setTestingId(undefined));
  }

  return (
    <div className="conn-status" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="conn-status-btn"
        aria-label={`connection status: ${aggregate}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`status-dot ${aggregate}`} aria-hidden="true" />
        <span className="conn-status-url">
          {current ? (current.label ?? current.base_url) : "no server"}
        </span>
      </button>

      {open ? (
        <div className="conn-popover" role="dialog" aria-label="Connections">
          {connections.length === 0 ? (
            <div className="muted">No servers configured yet — add one on the Setup tab.</div>
          ) : (
            connections.map((c) => (
              <div className="conn-row" key={c.id}>
                <span
                  className={`status-dot ${statusDotClass(c.health.last_status, c.enabled)}`}
                  aria-label={`server status: ${c.enabled ? c.health.last_status : "disabled"}`}
                />
                <div className="conn-row-info">
                  <div className="conn-row-title">
                    {c.base_url}
                    {c.label ? <span className="muted"> — {c.label}</span> : null}
                    {c.is_current ? <span className="badge open">current</span> : null}
                  </div>
                  <div className="muted">
                    checked {relativeTime(c.health.last_check_at, now)}
                    {c.health.last_latency_ms != null ? ` · ${c.health.last_latency_ms} ms` : ""}
                  </div>
                  {c.health.last_status === "fail" && c.health.last_error ? (
                    <div className="conn-row-error">{c.health.last_error}</div>
                  ) : null}
                </div>
                {canPlan ? (
                  <button
                    type="button"
                    className="btn small secondary"
                    disabled={testingId === c.id}
                    onClick={() => testNow(c.id)}
                  >
                    {testingId === c.id ? "Testing…" : "Test now"}
                  </button>
                ) : null}
              </div>
            ))
          )}
          {canPlan ? (
            <div className="conn-popover-footer">
              <button type="button" className="btn small secondary" onClick={onLockVault}>
                Lock vault
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
