/**
 * Frozen selector/data contract for T1–T8 (SPEC_06 §6 Fáze 0). Most of the app
 * already has stable aria-label/role/id selectors (confirmed by reading every
 * screen component before writing specs) — prefer `getByRole`/`getByLabel`/
 * `getByText` over these constants wherever one already exists. Only the
 * handful of genuinely ambiguous/repeated elements below got a NEW
 * `data-testid`, extending the existing kebab-case convention
 * (sprint-start/sprint-end/planned-hours-delta/burndown-chart/velocity-chart/
 * drop-backlog/drop-${id}).
 */

/** Sprint status badge text, inside the "Sprint details" panel. */
export const SPRINT_STATUS_TESTID = "sprint-status";

/** One WpCard's root — `wp-card-${op_id}`, matches the drop-${id} pattern. */
export function wpCardTestId(opId: number): string {
  return `wp-card-${opId}`;
}

/** Sprint-column drop zone (dnd-kit droppable) — the backlog one is fixed
 * "drop-backlog"; there is exactly one sprint column at a time, "drop-sprint". */
export const DROP_BACKLOG_TESTID = "drop-backlog";
export const DROP_SPRINT_TESTID = "drop-sprint";

/**
 * Scenario ticket ids referenced by the specs (fixtures/scenarios/*.ts —
 * see the scenario registry for full timelines). Centralized here so a
 * scenario-data change only needs updating in one place.
 */
export const SCENARIO_WP_IDS = {
  /** s1-accountable-handoff: dev→tester→customer handoff, single ticket. */
  s1: { handoff: 1101 },
  /** s2-status-spectrum: one WP per canonical status, ids 1201..1210. */
  s2: { first: 1201, last: 1210 },
  /** s3-epic-over-40h: one 80h epic crossing two sprints. */
  s3: { epic: 1301 },
  /** s4-volatile-sprint: baseline set + day-3 urgent additions. */
  s4: { baseline: [1401, 1402, 1403, 1404, 1405, 1406], urgent: [1451, 1452, 1453] },
  /** s5-burndown-happy: five WPs, 60h total, clean daily burn to 0. */
  s5: { tickets: [1501, 1502, 1503, 1504, 1505] },
  /** s6-carryover: five WPs, two left over at sprint end (1604, 1605). */
  s6: { tickets: [1601, 1602, 1603, 1604, 1605], carriedOver: [1604, 1605] },
} as const;
