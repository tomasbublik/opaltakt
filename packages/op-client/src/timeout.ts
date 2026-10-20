import type { OpClient, OpRequestOptions } from "./client";

/**
 * Per-call timeout wrapper (SPEC_09 §1/§6).
 *
 * Sprint activation fans out scoped OP queries across every connection the
 * sprint touches (Agent B, backend). A single slow/hung connection must not
 * stall the whole activation for minutes — each connection's traffic needs a
 * hard, catchable time bound. This wrapper is structurally identical to
 * `instrumentOpClient`: it wraps `request()` and rebinds every `get*` method via
 * `.call(wrapped)`, so ALL traffic funnels through the timed `request` no matter
 * how the method was obtained (even destructured).
 *
 * Bound = same AbortController + setTimeout + clearTimeout pattern as
 * `checkOpHealth` in ./health.ts.
 */

/**
 * Default per-connection activation timeout: 15 s. A scoped-by-id OP query is
 * fast when the server is healthy, so 15 s comfortably clears real latency while
 * being short enough not to visibly stall an activation progress bar.
 */
export const DEFAULT_ACTIVATION_TIMEOUT_MS = 15_000;

/**
 * Thrown when a wrapped call exceeds its timeout. Distinct from a generic
 * network failure (and from a caller-initiated abort, which propagates as the
 * caller's own DOMException/AbortError) so callers can attribute a precise
 * per-connection "timed out" message. Detect via `err instanceof OpTimeoutError`
 * (or `err.name === "OpTimeoutError"` across realms).
 */
export class OpTimeoutError extends Error {
  override readonly name = "OpTimeoutError";
  readonly code = "OP_TIMEOUT" as const;
  constructor(
    readonly timeoutMs: number,
    readonly path: string,
    /** The underlying abort error, if any (kept for debugging). */
    cause?: unknown,
  ) {
    super(`OpenProject GET ${path} timed out after ${timeoutMs} ms`, { cause });
  }
}

/**
 * Wrap `client` so every request aborts after `timeoutMs` ms and rejects with an
 * {@link OpTimeoutError}.
 *
 * - One AbortController per call; its `signal` is passed into the underlying
 *   `request`. A caller-supplied `signal` is NEVER dropped: the two are composed
 *   with `AbortSignal.any`, so aborting EITHER aborts the request.
 * - We own the timeout controller, so `controller.signal.aborted` distinguishes
 *   OUR timeout (→ OpTimeoutError) from a caller-initiated abort (→ the caller's
 *   own AbortError, propagated untouched).
 * - The timer is cleared on settle (success or failure) so it never leaks.
 */
export function withTimeout(
  client: OpClient,
  timeoutMs: number = DEFAULT_ACTIVATION_TIMEOUT_MS,
): OpClient {
  // NOT async: a synchronous throw from the read-only guard must stay
  // synchronous (an async wrapper would turn it into a rejection). We therefore
  // clear the armed timer explicitly if `request` throws before returning.
  function timedRequest<T>(options: OpRequestOptions): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Never hold the process open for a pending timeout (still cleared on settle).
    if (typeof timer === "object" && typeof timer.unref === "function") timer.unref();

    // Compose with any caller signal — abort on EITHER firing, drop neither.
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;

    let promise: Promise<T>;
    try {
      promise = client.request<T>({ ...options, signal }); // may throw ReadOnlyViolationError
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }

    return promise.then(
      (value) => {
        clearTimeout(timer);
        return value;
      },
      (err: unknown) => {
        clearTimeout(timer);
        // An abort where OUR controller fired can only be our timeout (we own
        // it). A caller abort leaves controller.signal.aborted false, so the
        // caller's own AbortError propagates untouched.
        if (controller.signal.aborted) {
          throw new OpTimeoutError(timeoutMs, options.path, err);
        }
        throw err;
      },
    );
  }

  const wrapped: OpClient = {
    request: timedRequest,
    // Increment 20 fix (see instrument.ts's matching doc comment for the full
    // story): regular methods reading `this` dynamically, falling back to our
    // own `wrapped` when detached — NOT arrow functions closing over a fixed
    // `wrapped`. An arrow function can't be rebound via `.call()`, so wrapping
    // an ALREADY-wrapped client (e.g. `withTimeout(instrumentOpClient(raw,
    // cb), ms)` — exactly how sprint activation builds its client) silently
    // never threaded this timeout's signal down to the real fetch. Confirmed
    // via a real end-to-end incident (Increment 20's hard-cancel work) that
    // an analogous composition was completely inert; this wrapper had the
    // identical bug and has likely never actually bounded activation traffic.
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
