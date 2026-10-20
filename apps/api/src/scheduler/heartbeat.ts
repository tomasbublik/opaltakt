import { checkOpHealth, type OpHealthResult } from "@osp/op-client";

/**
 * Active heartbeat (SPEC_02 §4). Every `tickMs` it looks for connections that
 * have been silent for longer than `idleMs` — no real traffic (piggyback keeps
 * last_activity_at fresh) and no recent explicit check — and probes them with
 * the GET-only, no-retry health check. Busy connections are therefore never
 * pinged, and an idle server is re-checked roughly every idleMs+, not every
 * tick.
 *
 * All collaborators are INJECTED so tests never need a real vault/DB/OP.
 */

export interface HeartbeatCandidate {
  id: number;
  base_url: string;
  last_activity_at: string | null; // ISO
  last_check_at: string | null; // ISO
  has_token: boolean;
  /** Disconnect/Connect toggle (SPEC_07 §1) — a disabled server is never
   * pinged; its status stays whatever it was, honestly stale. */
  enabled: boolean;
}

export interface HeartbeatDeps {
  listConnections(): Promise<HeartbeatCandidate[]>;
  /** true → skip the whole tick (vault locked; no tokens available). */
  isVaultLocked(): boolean;
  /** Decrypted ad-hoc by the caller; null when the connection has no token. */
  getClientConfig(id: number): Promise<{ baseUrl: string; token: string } | null>;
  /** Persist the result (last_check_at = now, status ok/fail, latency, error) + push SSE. */
  recordCheck(id: number, result: OpHealthResult): Promise<void>;
  tickMs?: number; // default 10_000
  idleMs?: number; // default 20_000
  timeoutMs?: number; // default 5_000
  now?: () => Date;
  onError?: (err: unknown) => void; // default console.error; a failing connection must not kill the loop
}

export interface Heartbeat {
  stop(): void;
  /** run one tick immediately (tests/manual) */
  tickNow(): Promise<void>;
}

export const DEFAULT_HEARTBEAT_TICK_MS = 10_000;
export const DEFAULT_HEARTBEAT_IDLE_MS = 20_000;
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 5_000;

/** ISO → epoch ms; null/garbage count as "never" (epoch 0), i.e. maximally idle. */
function epochMs(iso: string | null): number {
  if (iso === null) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

export function startHeartbeat(deps: HeartbeatDeps): Heartbeat {
  const tickMs = deps.tickMs ?? DEFAULT_HEARTBEAT_TICK_MS;
  const idleMs = deps.idleMs ?? DEFAULT_HEARTBEAT_IDLE_MS;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const now = deps.now ?? (() => new Date());
  const onError = deps.onError ?? ((err) => console.error("[heartbeat]", err));

  // Overlapping-tick guard: if a tick is still in flight (slow checks), the
  // next interval fire is skipped rather than stacking probes.
  let running = false;

  async function tickNow(): Promise<void> {
    if (running) return;
    running = true;
    try {
      // Vault locked → no tokens can be decrypted; skip the whole tick and
      // leave every status as-is (statuses stay "unknown"/stale, honestly so).
      if (deps.isVaultLocked()) return;

      const candidates = await deps.listConnections();
      const cutoff = now().getTime() - idleMs;
      const due = candidates.filter(
        (c) =>
          // Disconnected → never pinged (SPEC_07 §1); its status stays as-is.
          c.enabled &&
          // No token → nothing to authenticate with; connection stays unknown.
          c.has_token &&
          // DUE when now - max(last_activity_at, last_check_at) > idleMs.
          Math.max(epochMs(c.last_activity_at), epochMs(c.last_check_at)) < cutoff,
      );

      // Checks run concurrently; each connection's failure is isolated so one
      // sick server never blocks or kills the others.
      await Promise.all(
        due.map(async (c) => {
          try {
            const config = await deps.getClientConfig(c.id);
            if (config === null) return; // token vanished between list and check
            const result = await checkOpHealth({
              baseUrl: config.baseUrl,
              token: config.token,
              timeoutMs,
            });
            await deps.recordCheck(c.id, result);
          } catch (err) {
            onError(err);
          }
        }),
      );
    } catch (err) {
      onError(err);
    } finally {
      running = false;
    }
  }

  const interval = setInterval(() => {
    void tickNow();
  }, tickMs);
  // Never keep the process alive just for the heartbeat.
  interval.unref?.();

  return {
    stop: () => clearInterval(interval),
    tickNow,
  };
}
