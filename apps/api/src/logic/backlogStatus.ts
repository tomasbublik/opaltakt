/**
 * Work-package statuses hidden from the backlog (done work isn't a planning
 * candidate). Matched case-insensitively on status name. Cached tickets keep
 * these statuses — this only filters the /backlog view (and, since it shares
 * the SAME "is this ticket still an open planning candidate" question, the
 * capacity computation's live-item filter, `logic/capacitySummary.ts`).
 *
 * Extracted out of `routes/index.ts` in Increment 36 so both call sites share
 * ONE literal — no risk of the set drifting between the route and the shared
 * capacity module.
 */
export const HIDDEN_BACKLOG_STATUSES = new Set(["closed", "resolved", "rejected", "tested"]);
