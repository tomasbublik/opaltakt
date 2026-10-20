import type { OpClient, OpRequestOptions } from "./client";
import { OpTimeoutError } from "./timeout";

/**
 * Increment 20 (SPEC_20 §1/§6) — HARD-cancel-aware per-request timeout wrapper.
 *
 * The Increment 19 incident: a sync's page fetch that NEVER resolves (OP hangs,
 * no timeout anywhere in the client) leaves the page loop stuck inside a single
 * `await` forever, so the "between pages" DB-flag cancel checkpoint is never
 * reached — Cancel does nothing and the app is unusable until the backend is
 * killed. This wrapper bounds every OP request with its OWN per-attempt
 * `AbortController` timeout AND threads a per-RUN external cancel signal into
 * every request, so an in-flight fetch aborts near-instantly when the user
 * cancels (not "whenever the current page finishes, if ever").
 *
 * It is deliberately SEPARATE from {@link withTimeout} (which is used by sprint
 * activation/retro/scheduled updates and whose exact behaviour those call sites
 * depend on). The key difference is the retry/cancel distinction below.
 *
 * Structurally identical funnel to `withTimeout`/`instrumentOpClient`: override
 * `request` and rebind every typed method via `.call(wrapped)` so ALL traffic
 * flows through the timed+retried `request`, however the method was obtained.
 */

/** Product default: exactly 30 s per request (SPEC_20 §6). */
export const DEFAULT_HARD_CANCEL_TIMEOUT_MS = 30_000;
/** Mirrors impl.ts's DEFAULT_MAX_RETRIES so timeout retries match network ones. */
const DEFAULT_MAX_RETRIES = 3;
/** Mirrors impl.ts's BASE_BACKOFF_MS. */
const DEFAULT_BASE_BACKOFF_MS = 200;

/**
 * Thrown by a wrapped call when the caller-supplied EXTERNAL cancel signal
 * (`opts.signal`) fired — i.e. a genuine user-requested cancellation, NOT a
 * network/timeout failure. `packages/sync` catches this to distinguish "user
 * cancelled → finish aborted, drop staging" from "a request failed → finish
 * error". Detect with {@link isOpCancelledError} (robust across realms).
 */
export class OpCancelledError extends Error {
  override readonly name = "OpCancelledError";
  readonly code = "OP_CANCELLED" as const;
  constructor(
    readonly path: string,
    cause?: unknown,
  ) {
    super(`OpenProject GET ${path} cancelled by caller`, { cause });
  }
}

/** True iff `err` is an external-cancel error from a {@link withHardCancel} client. */
export function isOpCancelledError(err: unknown): err is OpCancelledError {
  return (
    err instanceof OpCancelledError ||
    (err instanceof Error && err.name === "OpCancelledError")
  );
}

export interface HardCancelOptions {
  /** Per-request timeout in ms (SPEC_20 §6: 30 s product default). */
  timeoutMs?: number;
  /**
   * The PER-RUN external cancel signal. When it fires, the in-flight request
   * aborts and the call rejects with {@link OpCancelledError} — never retried.
   */
  signal?: AbortSignal;
  /** Timeout retries before giving up (defaults to impl.ts's 3). */
  maxRetries?: number;
  /** Base backoff between timeout retries (defaults to impl.ts's 200 ms). */
  baseBackoffMs?: number;
}

/**
 * A backoff delay that resolves early if `signal` fires — a cancel that lands
 * while we're merely SITTING in a retry backoff (not even making a request)
 * must still resolve near-instantly, not wait out the full delay.
 */
function interruptibleDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (typeof timer === "object" && typeof timer.unref === "function") timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Wrap `client` so every request:
 *  - aborts after `opts.timeoutMs` via its OWN fresh per-attempt controller;
 *  - composes `opts.signal` (external cancel) so aborting EITHER aborts the
 *    request;
 *  - on the EXTERNAL signal → rejects with {@link OpCancelledError}, NOT
 *    retried (genuine user cancellation, propagate immediately);
 *  - on the per-attempt TIMEOUT → retried up to `maxRetries` with an
 *    interruptible backoff (same semantics as impl.ts's network-error retry),
 *    then rejects with {@link OpTimeoutError};
 *  - on any other error (network exhausted / 429 / 5xx / read-only) →
 *    propagates untouched (impl.ts already did its own retrying).
 */
export function withHardCancel(client: OpClient, opts: HardCancelOptions): OpClient {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HARD_CANCEL_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseBackoff = opts.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;

  async function hardRequest<T>(options: OpRequestOptions): Promise<T> {
    let attempt = 0;
    for (;;) {
      // Cancelled before we even start a request → fail fast.
      if (opts.signal?.aborted) {
        throw new OpCancelledError(options.path, opts.signal.reason);
      }

      const attemptController = new AbortController();
      const timer = setTimeout(() => attemptController.abort(), timeoutMs);
      if (typeof timer === "object" && typeof timer.unref === "function") timer.unref();

      // Compose external cancel + our per-attempt timeout — abort on EITHER.
      const signal = opts.signal
        ? AbortSignal.any([opts.signal, attemptController.signal])
        : attemptController.signal;

      try {
        const value = await client.request<T>({ ...options, signal });
        clearTimeout(timer);
        return value;
      } catch (err) {
        clearTimeout(timer);

        // EXTERNAL cancel wins — a user cancellation is never retried. Our own
        // per-attempt controller is a DIFFERENT object, so this is an
        // unambiguous "the caller's signal fired" check.
        if (opts.signal?.aborted) {
          throw new OpCancelledError(options.path, err);
        }

        // OUR per-attempt timeout fired → retryable, same as impl.ts's
        // network-error path: fresh attempt with a fresh full timeout.
        if (attemptController.signal.aborted) {
          if (attempt < maxRetries) {
            await interruptibleDelay(baseBackoff * 2 ** attempt, opts.signal);
            // Cancel landed DURING the backoff → propagate promptly, don't
            // burn the next attempt waiting out the (possibly long) delay.
            if (opts.signal?.aborted) {
              throw new OpCancelledError(options.path, opts.signal.reason);
            }
            attempt += 1;
            continue;
          }
          throw new OpTimeoutError(timeoutMs, options.path, err);
        }

        // Any other failure already went through impl.ts's own retry handling
        // (network/429/5xx) or is a synchronous read-only violation — propagate.
        throw err;
      }
    }
  }

  // Regular methods reading `this` dynamically (falling back to our own
  // `wrapped` when detached) — NOT arrow functions closing over a fixed
  // `wrapped`. This is THE fix for the real end-to-end bug this increment's
  // own integration testing surfaced: `apps/api` always builds its OP client
  // via `instrumentOpClient(raw, healthCb)` first (health piggybacking), then
  // hands THAT to `createSyncEngine`, which wraps it again with
  // `withHardCancel`. If `withHardCancel`'s own typed methods were arrow
  // functions (the ORIGINAL pattern, copied from `instrument.ts`/`timeout.ts`
  // before they were fixed too), `instrumentOpClient`'s arrow-function
  // `getWorkPackages` would ignore this wrapper's `.call(wrapped, ...)`
  // entirely (arrow functions can't be rebound) and keep routing through ITS
  // OWN `this.request`, silently bypassing the composed timeout/cancel signal
  // — a hung request would never abort, exactly the reported production
  // incident. `this ?? wrapped` preserves detached/destructured calls too.
  const wrapped: OpClient = {
    request: hardRequest,
    getCurrentUser() { return client.getCurrentUser.call(this ?? wrapped); },
    getUsers(query?) { return client.getUsers.call(this ?? wrapped, query); },
    getUser(id) { return client.getUser.call(this ?? wrapped, id); },
    getMemberships(query?) { return client.getMemberships.call(this ?? wrapped, query); },
    getProjects() { return client.getProjects.call(this ?? wrapped); },
    getWorkPackages(query) { return client.getWorkPackages.call(this ?? wrapped, query); },
    getTimeEntries(query) { return client.getTimeEntries.call(this ?? wrapped, query); },
    getVersions(projectOpId?) { return client.getVersions.call(this ?? wrapped, projectOpId); },
    getStatuses() { return client.getStatuses.call(this ?? wrapped); },
    getWorkPackageSchema() { return client.getWorkPackageSchema.call(this ?? wrapped); },
    getActivities(wpId) { return client.getActivities.call(this ?? wrapped, wpId); },
  };

  return wrapped;
}
