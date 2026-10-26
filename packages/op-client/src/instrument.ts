import type { OpClient, OpRequestOptions } from "./client";
import { shortErrorMessage } from "./health";

/**
 * Piggyback instrumentation (SPEC_02 §4): wrap a client so EVERY network
 * request reports its outcome. The API layer uses these reports to refresh a
 * connection's health from real traffic, which in turn suppresses heartbeat
 * pings for busy connections.
 */

export interface OpCallReport {
  ok: boolean;
  latency_ms: number;
  error: string | null;
}

/**
 * Wrap `client` so every request reports through `onResult`.
 *
 * - The observer must never break the caller: onResult exceptions are swallowed.
 * - ReadOnlyViolationError propagates synchronously and is NOT reported — it is
 *   thrown before any I/O, so there is no network attempt to account for.
 * - The impl's get* helpers dispatch through `this.request`, so a naive spread
 *   copy only instruments calls made ON the wrapper. Here every get* explicitly
 *   rebinds `this` to the wrapper, so all traffic funnels through the timed
 *   request regardless of how the method was obtained (even destructured).
 *
 * ⚠️ Increment 20 fix: the get* entries below are REGULAR methods reading
 * `this` dynamically (`this ?? wrapped`), not arrow functions closing over a
 * fixed `wrapped`. This is load-bearing for composing wrappers: an OUTER
 * wrapper (e.g. `withHardCancel`/`withTimeout`) rebinds `this` via
 * `client.getWorkPackages.call(outerWrapped, query)` when IT wraps an
 * already-instrumented client — an arrow function ignores that `.call()`
 * entirely (arrow functions can't be rebound), so the outer layer's `request`
 * override would silently never run, and neither would its timeout/cancel
 * signal ever reach the real fetch. `this ?? wrapped` keeps BOTH properties:
 * an outer `.call(x)` threads `x` through correctly, while a genuinely
 * DETACHED/destructured call (`this` is `undefined` in this module's strict
 * mode) still falls back to this layer's own `wrapped`, exactly as before.
 * Confirmed via a real end-to-end incident: `withHardCancel(instrumentOpClient(
 * raw, cb), {...})`'s composed abort signal was silently never reaching
 * `fetch()` until this fix — the SAME latent bug has therefore also meant
 * `withTimeout` was never effective for sprint activation, which composes it
 * the identical way (`withTimeout(buildOpClient(...), ...)` where
 * `buildOpClient` always returns an instrumented client) — see `timeout.ts`'s
 * matching fix.
 */
export function instrumentOpClient(
  client: OpClient,
  onResult: (r: OpCallReport) => void,
): OpClient {
  const report = (r: OpCallReport): void => {
    try {
      onResult(r);
    } catch {
      // Observer failures must never surface into the caller.
    }
  };

  // NOT async: a synchronous throw from the read-only guard must stay
  // synchronous (an async wrapper would turn it into a rejection).
  function timedRequest<T>(options: OpRequestOptions): Promise<T> {
    const start = performance.now();
    const promise = client.request<T>(options); // may throw ReadOnlyViolationError
    return promise.then(
      (value) => {
        report({
          ok: true,
          latency_ms: Math.round(performance.now() - start),
          error: null,
        });
        return value;
      },
      (err: unknown) => {
        // Increment 20: an abort (per-request timeout OR a user-requested
        // cancellation, from an outer `withHardCancel` layer composing its
        // OWN signal into `options.signal` before calling us) is NOT a
        // connection-health signal — either the user chose to stop, or the
        // wrapper's own timeout already owns deciding what that means.
        // `options.signal` here is the CALLER's already-composed signal
        // (external cancel ORed with the outer wrapper's per-attempt timeout
        // controller, `AbortSignal.any([...])`) — by the time this handler
        // runs, `isOpCancelledError(err)` can never match: `err` is still the
        // RAW abort rejection from the underlying request, and the outer
        // wrapper only classifies it as `OpCancelledError` AFTER this
        // `client.request()` promise (ours) has already settled and this
        // handler has already run — checking `options.signal?.aborted`
        // directly (rather than the error's TYPE) is the only signal
        // available at this layer, and covers both causes uniformly. Skip
        // the health report entirely for either. Confirmed live: without
        // this, an aborted sync's OWN cancellation flipped the connection to
        // unhealthy, making its already-cached rows read back as newly
        // `stale` even though work_package_cache itself was never touched —
        // a rollback correctness check (byte-identical cache) failed on
        // THIS field alone, purely as a side effect of cancelling.
        if (options.signal?.aborted) throw err;

        // HTTP 400 means OP responded and rejected OUR query (e.g. an
        // unsupported filter attribute) — the server is reachable and
        // healthy, only the request was malformed. Reporting this as a
        // health failure would flip a perfectly fine connection to red over
        // a client-side bug (SPEC_07 §3: OP_QUERY_INVALID must never look
        // like OP_UNREACHABLE). The error still propagates to the caller —
        // only the HEALTH signal is affected.
        const status = (err as { status?: number } | null)?.status;
        const isQueryError = status === 400;
        report({
          ok: isQueryError,
          latency_ms: Math.round(performance.now() - start),
          error: isQueryError ? null : shortErrorMessage(err),
        });
        throw err;
      },
    );
  }

  const wrapped: OpClient = {
    request: timedRequest,
    // Regular methods reading `this` dynamically (falling back to our own
    // `wrapped` when detached) — see the doc comment above for why this
    // matters (composability with an outer wrapper) vs. the old arrow-
    // function-closing-over-`wrapped` pattern (which silently broke it).
    getCurrentUser() { return client.getCurrentUser.call(this ?? wrapped); },
    getUsers(query?) { return client.getUsers.call(this ?? wrapped, query); },
    getUser(id) { return client.getUser.call(this ?? wrapped, id); },
    getMemberships(query?) { return client.getMemberships.call(this ?? wrapped, query); },
    getProjects(query?) { return client.getProjects.call(this ?? wrapped, query); },
    getProject(id) { return client.getProject.call(this ?? wrapped, id); },
    getWorkPackages(query) { return client.getWorkPackages.call(this ?? wrapped, query); },
    getTimeEntries(query) { return client.getTimeEntries.call(this ?? wrapped, query); },
    getVersions(projectOpId?) { return client.getVersions.call(this ?? wrapped, projectOpId); },
    getStatuses() { return client.getStatuses.call(this ?? wrapped); },
    getWorkPackageSchema() { return client.getWorkPackageSchema.call(this ?? wrapped); },
    getActivities(wpId) { return client.getActivities.call(this ?? wrapped, wpId); },
  };

  return wrapped;
}
