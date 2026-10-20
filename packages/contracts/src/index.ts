/**
 * @osp/contracts — the FROZEN shared contract for OpalTakt.
 *
 * Zero runtime dependencies beyond `zod`. Every specialist imports from here.
 * Do not change after Phase 0 without cross-team agreement (SPEC §9).
 */
export * from "./common";
export * from "./entities";
export * from "./errors";
export * from "./api";
export * from "./identity";
export * from "./auth";
