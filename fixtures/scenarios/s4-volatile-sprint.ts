/**
 * S4 — volatile-sprint (SPEC_03 §7, covers §2 d).
 *
 * A running sprint whose scope is never stable: on day 3 (Saturday — a weekend
 * production incident) the timeline ADDS three urgent work packages via
 * addWorkPackage (fresh updatedAt, so the incremental sync catches them). The
 * team then drops planned work to firefight. "Something OUT of the sprint" is
 * a LOCAL Sprint Planner action (the operator removes WP 1405/1406), not an OP
 * change — the mock only ever adds scope.
 */
import type { Scenario } from "../scenario-types";
import { cast, ev, on, work } from "./helpers";

export const s4VolatileSprint: Scenario = {
  name: "s4-volatile-sprint",
  description:
    "Scope churn in a running sprint. OPERATOR FLOW: import Demo Project, create sprint " +
    "2026-07-01 -> 2026-07-09 with the six seeded WPs (1401-1406), advance through days 1-2 " +
    "(sync + snapshot daily), then advance to day 3 — a weekend production incident adds THREE " +
    "urgent WPs (1451-1453, 'URGENT: ...', priority Immediate/High, bumped updatedAt); re-sync " +
    "and they appear in the backlog. Pull them into the sprint and locally REMOVE WP 1405/1406 " +
    "to compensate — watch added/removed scope in the burndown and the capacity recalculation. " +
    "POST /__mock/inject-urgent adds one more escalation at any moment.",
  startDate: "2026-07-01",
  seed: {
    users: cast(),
    versions: [],
    workPackages: [
      // The planned sprint: 5-6 WPs, mixed estimates, in-progress-ish states.
      {
        key: "session",
        id: 1401,
        subject: "Refactor session storage",
        project: 3,
        status: "In progress",
        assignee: "dev",
        accountable: "customer",
        estimatedHours: 12,
        remainingHours: 12,
      },
      {
        key: "bulk-import",
        id: 1402,
        subject: "Bulk import endpoint",
        project: 3,
        status: "In progress",
        assignee: "dev",
        accountable: "customer",
        estimatedHours: 10,
        remainingHours: 10,
      },
      {
        key: "e2e",
        id: 1403,
        subject: "E2E tests for onboarding",
        project: 3,
        status: "In progress",
        assignee: "tester",
        estimatedHours: 8,
        remainingHours: 8,
      },
      {
        key: "empty-states",
        id: 1404,
        subject: "Polish empty states in the UI",
        project: 3,
        status: "Confirmed",
        assignee: "tester",
        estimatedHours: 5,
        remainingHours: 5,
      },
      {
        key: "db-driver",
        id: 1405,
        subject: "Upgrade the database driver",
        project: 3,
        status: "Confirmed",
        assignee: "dev",
        estimatedHours: 6,
        remainingHours: 6,
      },
      {
        key: "audit-spike",
        id: 1406,
        subject: "Spike: audit log storage format",
        project: 3,
        status: "Confirmed",
        assignee: "dev",
        accountable: "customer",
        estimatedHours: 4,
        remainingHours: 4,
      },
    ],
  },
  timeline: [
    // Days 1-2: the sprint hums along as planned.
    on(
      1,
      ...work("session", "dev", 6, 6),
      ...work("e2e", "tester", 4, 4),
    ),
    on(
      2,
      ...work("session", "dev", 6, 0),
      ev.status("session", "Developed"),
      ...work("e2e", "tester", 4, 0),
      ev.status("e2e", "Developed"),
      ev.status("empty-states", "In progress"),
      ...work("empty-states", "tester", 1, 4),
    ),
    // Day 3 (Saturday): production incident — three URGENT WPs land in OP.
    // addWorkPackage bumps updatedAt so the next incremental sync catches them.
    on(
      3,
      ev.add({
        key: "urgent-login",
        id: 1451,
        subject: "URGENT: Production login returns HTTP 500",
        type: "Bug",
        project: 3,
        status: "Confirmed",
        assignee: "dev",
        accountable: "customer",
        estimatedHours: 6,
        remainingHours: 6,
        priority: "Immediate",
      }),
      ev.add({
        key: "urgent-rounding",
        id: 1452,
        subject: "URGENT: Invoice totals off by one cent (rounding)",
        type: "Bug",
        project: 3,
        status: "New",
        assignee: "dev",
        accountable: "customer",
        estimatedHours: 4,
        remainingHours: 4,
        priority: "High",
      }),
      ev.add({
        key: "urgent-pipeline",
        id: 1453,
        subject: "URGENT: Hotfix deploy pipeline broken",
        type: "Bug",
        project: 3,
        status: "New",
        assignee: "tester",
        estimatedHours: 3,
        remainingHours: 3,
        priority: "High",
      }),
    ),
    // Day 5 (Monday): planned work parked, the team firefights.
    on(
      5,
      ev.status("urgent-login", "In progress"),
      ...work("urgent-login", "dev", 5, 1),
      ev.status("urgent-pipeline", "In progress"),
      ...work("urgent-pipeline", "tester", 3, 0),
      ev.status("urgent-pipeline", "Merge pending"),
      ...work("empty-states", "tester", 2, 2),
    ),
    on(
      6,
      ...work("urgent-login", "dev", 1, 0),
      ev.status("urgent-login", "Developed"),
      ev.status("urgent-rounding", "In progress"),
      ...work("urgent-rounding", "dev", 4, 0),
      ev.status("urgent-rounding", "Developed"),
      ...work("empty-states", "tester", 2, 0),
      ev.status("empty-states", "Developed"),
    ),
    // Days 7-8: back to the (reduced) plan.
    on(7, ...work("bulk-import", "dev", 5, 5)),
    on(
      8,
      ...work("bulk-import", "dev", 5, 0),
      ev.status("bulk-import", "Developed"),
    ),
    // WP 1405 (db-driver) and 1406 (audit-spike) never move — those are the
    // candidates the operator kicks OUT of the sprint locally in the app.
  ],
  // Scenario-flavored template for POST /__mock/inject-urgent.
  urgentTemplate: {
    subject: "URGENT: Customer escalation — checkout completely blocked",
    type: "Bug",
    project: 3,
    status: "Confirmed",
    assignee: "dev",
    accountable: "customer",
    estimatedHours: 5,
    remainingHours: 5,
    priority: "Immediate",
  },
};
