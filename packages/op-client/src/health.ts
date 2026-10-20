import type { OpClientConfig } from "./client";
import { createOpClient, OpHttpError } from "./impl";

/**
 * Health-check primitive (SPEC_02 §4): a single GET /api/v3/users/me with a
 * hard timeout and NO retries — a health check must fail fast, not mask a sick
 * server behind backoff. Never throws; every failure lands in the result.
 */

export interface OpHealthResult {
  ok: boolean;
  latency_ms: number;
  /** null when ok; short human-readable reason otherwise (HTTP status or network error). */
  error: string | null;
}

const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;

/**
 * Map an arbitrary failure to a short, human-readable reason. Undici wraps
 * network failures as "TypeError: fetch failed" with the useful detail on
 * `cause` (possibly an AggregateError), so unwrap before falling back to the
 * top-level message.
 */
export function shortErrorMessage(err: unknown): string {
  if (err instanceof OpHttpError) return `HTTP ${err.status}`;
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof AggregateError && cause.errors.length > 0) {
      const first = cause.errors[0];
      if (first instanceof Error && first.message) return first.message;
    }
    if (cause instanceof Error && cause.message) return cause.message;
    return err.message;
  }
  return String(err);
}

/**
 * GET /api/v3/users/me with a hard timeout (default 5000 ms), NO retries.
 * Never throws; failures land in the result.
 */
export async function checkOpHealth(
  config: OpClientConfig & { timeoutMs?: number },
): Promise<OpHealthResult> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  // maxRetries: 0 overrides whatever the caller's config says — retries would
  // turn one probe into several and inflate latency on a failing server.
  const client = createOpClient({ ...config, maxRetries: 0 });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Never hold the process open for a probe (and always clear it below).
  if (typeof timer === "object" && typeof timer.unref === "function") timer.unref();

  const start = performance.now();
  try {
    await client.request({ path: "/api/v3/users/me", signal: controller.signal });
    return { ok: true, latency_ms: Math.round(performance.now() - start), error: null };
  } catch (err) {
    const latency_ms = Math.round(performance.now() - start);
    // An abort here can only come from OUR timer (we own the controller).
    const error = controller.signal.aborted
      ? `timeout after ${timeoutMs} ms`
      : shortErrorMessage(err);
    return { ok: false, latency_ms, error };
  } finally {
    clearTimeout(timer);
  }
}
