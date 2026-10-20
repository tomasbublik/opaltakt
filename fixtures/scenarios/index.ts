/**
 * Scenario registry (SPEC_03 §7) — the contract point for the mock engine:
 * fixtures/mock-op-server/ imports `scenarios` from here and serves them via
 * GET /__mock/scenarios + POST /__mock/load/:name. Scenarios are pure DATA
 * conforming to fixtures/scenario-types.ts.
 */
import type { Scenario } from "../scenario-types";
import { s1AccountableHandoff } from "./s1-accountable-handoff";
import { s2StatusSpectrum } from "./s2-status-spectrum";
import { s3EpicOver40h } from "./s3-epic-over-40h";
import { s4VolatileSprint } from "./s4-volatile-sprint";
import { s5BurndownHappy } from "./s5-burndown-happy";
import { s6Carryover } from "./s6-carryover";
import { s7TesterRoundtrip } from "./s7-tester-roundtrip";
import { s8RetroScopeChurn } from "./s8-retro-scope-churn";
import { s9RoleClosure } from "./s9-role-closure";
import { s10DeveloperWorkAttribution } from "./s10-developer-work-attribution";
import { s11EffectiveEstimate } from "./s11-effective-estimate";
import { s12HandoffAttribution } from "./s12-handoff-attribution";
import { s13SprintListDimming } from "./s13-sprint-list-dimming";
import { s14BacklogFilterMatrix } from "./s14-backlog-filter-matrix";
import { s15StatusCasingDivergence } from "./s15-status-casing-divergence";
import { s16AssigneeCollisionMock } from "./s16-assignee-collision-mock";
import { s17AssigneeCollisionAcme } from "./s17-assignee-collision-acme";
import { s18NightlyAuTicket } from "./s18-nightly-au-ticket";
import { s19SyncCoverage } from "./s19-sync-coverage";
import { s20SyncCoverageOrphaned } from "./s20-sync-coverage-orphaned";
import { s21Inc30CurrentScopePlanned } from "./s21-inc30-current-scope-planned";

export const scenarios: Scenario[] = [
  s1AccountableHandoff,
  s2StatusSpectrum,
  s3EpicOver40h,
  s4VolatileSprint,
  s5BurndownHappy,
  s6Carryover,
  s7TesterRoundtrip,
  s8RetroScopeChurn,
  s9RoleClosure,
  s10DeveloperWorkAttribution,
  s11EffectiveEstimate,
  s12HandoffAttribution,
  s13SprintListDimming,
  s14BacklogFilterMatrix,
  s15StatusCasingDivergence,
  s16AssigneeCollisionMock,
  s17AssigneeCollisionAcme,
  s18NightlyAuTicket,
  s19SyncCoverage,
  s20SyncCoverageOrphaned,
  s21Inc30CurrentScopePlanned,
];

export {
  s1AccountableHandoff,
  s2StatusSpectrum,
  s3EpicOver40h,
  s4VolatileSprint,
  s5BurndownHappy,
  s6Carryover,
  s7TesterRoundtrip,
  s8RetroScopeChurn,
  s9RoleClosure,
  s10DeveloperWorkAttribution,
  s11EffectiveEstimate,
  s12HandoffAttribution,
  s13SprintListDimming,
  s14BacklogFilterMatrix,
  s15StatusCasingDivergence,
  s16AssigneeCollisionMock,
  s17AssigneeCollisionAcme,
  s18NightlyAuTicket,
  s19SyncCoverage,
  s20SyncCoverageOrphaned,
  s21Inc30CurrentScopePlanned,
};

/**
 * Increment 30 — S21's ids/estimates, re-exported so the verification suite
 * quotes the fixture's own numbers instead of re-typing literals (a renumbering
 * then breaks compilation rather than silently retargeting an assertion).
 */
export {
  S21_ESTIMATE,
  S21_PROJECT_ID,
  S21_REESTIMATED_HOURS,
  S21_USERS,
  S21_VERSION_ID,
  S21_WP,
} from "./s21-inc30-current-scope-planned";
