import type {
  OpActivity,
  OpStatus,
  ReconstructedWpState,
  ReconstructFallback,
  VersionScopeEvent,
} from "@osp/op-client";

/**
 * Increment 12 (SPEC_12 §1/§2) — the reconstruction engine's contract as
 * consumed by the retrospective-planning backend (apps/api/src/logic/retro.ts).
 *
 * The concrete implementation lives in `@osp/op-client`'s `reconstruct.ts`
 * (Agent A): `stateAtDate` walks a work package's OP journals to rebuild its
 * state as of any past date; `versionScopeEvents` reads Version journals to
 * detect when a ticket entered/left a sprint's version. We depend on it through
 * this small INTERFACE (dependency-injected via AppDeps.reconstruct) so the
 * backend can inject a deterministic fake in tests (no OP round-trips). The
 * shape mirrors `@osp/op-client`'s frozen exports exactly — the types are
 * re-exported here so retro.ts has a single import surface.
 */
export type { ReconstructedWpState, ReconstructFallback, VersionScopeEvent };

export interface ReconstructEngine {
  stateAtDate(
    activities: OpActivity[],
    statusById: Map<number, OpStatus>,
    targetDate: string,
    fallback: ReconstructFallback,
    /** SPEC_15 — the WP's own `createdAt`, an extra "did it exist yet" signal
     * alongside the earliest journaled activity. Optional for callers that
     * don't have it handy; see `@osp/op-client`'s `stateAtDate` doc for why. */
    wpCreatedAt?: string | null,
  ): ReconstructedWpState;
  versionScopeEvents(
    activities: OpActivity[],
    targetVersionName: string,
  ): VersionScopeEvent[];
}
