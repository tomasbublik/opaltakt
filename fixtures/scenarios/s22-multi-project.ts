/**
 * S22 — Increment 40: "which OpenProject project is this ticket from?"
 * (`docs/INCREMENT_40_CONTRACTS.md` §2 Agent D, §1.1–§1.3).
 *
 * A PAIR of scenarios, modelled exactly like the s16/s17 cross-server twin:
 *
 *   s22-multi-project          — server ONE. One sprint's worth of tickets
 *                                spanning two visible projects plus one
 *                                HIDDEN project:
 *        8700  northwind            "Northwind Payments"
 *        8701  harbor-ops           "Harbor Ops"
 *        8702  lighthouse-internal  "Lighthouse Internal"  (hidden — its WP
 *              #87005 is visible, but the project is absent from
 *              GET /api/v3/projects and GET /api/v3/projects/8702 → 404, so
 *              the app can learn its NAME only from the WP's
 *              `_links.project.title` and its identifier stays unknown)
 *
 *   s22-multi-project-server2  — server TWO. Reuses project op_id **8700**
 *                                for a DIFFERENT project:
 *        8700  nw-logistics         "Northwind Logistics"
 *              A project op_id is unique only WITHIN one server (pillar 2):
 *              the app must key every project lookup on
 *              `${connection_id}:${project_op_id}`, so the two 8700s keep
 *              their own names/identifiers and a `projectKey` filter for one
 *              never returns the other's tickets.
 *
 * Load each half onto its OWN mock instance and its OWN connection (the
 * golden test uses two recording mocks; e2e uses only server one).
 *
 * The rename leg ("project renamed in OP after the sprint was frozen") is NOT
 * baked into the timeline — it is driven on demand through the operator-only
 * `POST /__mock/rename-project/:id` admin action, so a test controls exactly
 * when it happens relative to freeze.
 *
 * ── Identity hygiene (Increment 15's lesson) ────────────────────────────────
 * Every id below is fresh (grep-verified against fixtures/scenarios/s*.ts):
 *   • projects 8700–8702, versions 8710–8712 (+ 8720 on server two);
 *   • work packages 87001–87006 (server one) and 87101–87102 (server two) —
 *     disjoint, because `work_package_cache` keys op_id GLOBALLY;
 *   • people 4701/4702 (server one) and 4711 (server two), fictional names
 *     not used by any other scenario. The common dev/tester/customer cast is
 *     kept on both halves (registry invariant; one `me: true` identity each).
 * All project/person names are fictional (public-release scrub rule).
 */
import type { Scenario } from "../scenario-types";
import { cast } from "./helpers";

/** Server one's projects (op_id → identifier/name). */
export const S22_PROJECTS = {
  northwind: { id: 8700, identifier: "northwind", name: "Northwind Payments" },
  harbor: { id: 8701, identifier: "harbor-ops", name: "Harbor Ops" },
  /** Hidden: WPs visible, project itself 404 / unlisted. */
  hidden: { id: 8702, identifier: "lighthouse-internal", name: "Lighthouse Internal" },
} as const;

/** Server two's project — SAME op_id as server one's northwind, different project. */
export const S22_SERVER2_PROJECT = {
  id: S22_PROJECTS.northwind.id,
  identifier: "nw-logistics",
  name: "Northwind Logistics",
} as const;

/** Server one's work packages. */
export const S22_WP = {
  /** northwind, Mira, 6 h. */
  nwSettlement: 87001,
  /** northwind, Teodor, 4 h. */
  nwRefundRetry: 87002,
  /** harbor-ops, Mira, 5 h. */
  hbBerthImport: 87003,
  /** harbor-ops, Teodor, 3 h. */
  hbCraneAlert: 87004,
  /** HIDDEN project lighthouse-internal, Mira, 2 h. */
  hiddenAuthBump: 87005,
  /** harbor-ops, unassigned backlog-only ticket, 1 h. */
  hbGateFirmware: 87006,
} as const;

/** Server two's work packages (project op_id 8700 = Northwind Logistics). */
export const S22_SERVER2_WP = {
  nlRouteOptimiser: 87101,
  nlDockManifest: 87102,
} as const;

/** OP user ids owned exclusively by this scenario pair. */
export const S22_USERS = {
  mira: { id: 4701, name: "Mira Holloway" },
  teodor: { id: 4702, name: "Teodor Rask" },
  ines: { id: 4711, name: "Ines Varga" },
} as const;

export const s22MultiProject: Scenario = {
  name: "s22-multi-project",
  description:
    "Increment 40 — one sprint's tickets spanning two OpenProject projects (northwind 'Northwind Payments', " +
    "harbor-ops 'Harbor Ops') plus a HIDDEN third project (lighthouse-internal) whose work package is visible " +
    "but whose /api/v3/projects/{id} is 404 and which is absent from /api/v3/projects. Server ONE of a pair: " +
    "s22-multi-project-server2 reuses project op_id 8700 for a different project. Renames are driven via " +
    "POST /__mock/rename-project/:id.",
  startDate: "2026-09-07",
  seed: {
    users: [
      ...cast(),
      { key: "mira", id: S22_USERS.mira.id, name: S22_USERS.mira.name, login: "mira.holloway" },
      { key: "teodor", id: S22_USERS.teodor.id, name: S22_USERS.teodor.name, login: "teodor.rask" },
    ],
    projects: [
      { ...S22_PROJECTS.northwind },
      { ...S22_PROJECTS.harbor },
      { ...S22_PROJECTS.hidden, hidden: true },
    ],
    versions: [
      { key: "v_nw", id: 8710, name: "NW 2026.3", projectId: S22_PROJECTS.northwind.id },
      { key: "v_hb", id: 8711, name: "HB 2026.3", projectId: S22_PROJECTS.harbor.id },
      { key: "v_lh", id: 8712, name: "LH 2026.3", projectId: S22_PROJECTS.hidden.id },
    ],
    workPackages: [
      {
        key: "nw-settlement",
        id: S22_WP.nwSettlement,
        subject: "Northwind — settlement report export",
        project: S22_PROJECTS.northwind.id,
        status: "In progress",
        assignee: "mira",
        estimatedHours: 6,
        remainingHours: 6,
        version: "v_nw",
      },
      {
        key: "nw-refund-retry",
        id: S22_WP.nwRefundRetry,
        subject: "Northwind — refund webhook retry",
        project: S22_PROJECTS.northwind.id,
        status: "New",
        assignee: "teodor",
        estimatedHours: 4,
        remainingHours: 4,
        version: "v_nw",
      },
      {
        key: "hb-berth-import",
        id: S22_WP.hbBerthImport,
        subject: "Harbor Ops — berth schedule import",
        project: S22_PROJECTS.harbor.id,
        status: "In progress",
        assignee: "mira",
        estimatedHours: 5,
        remainingHours: 5,
        version: "v_hb",
      },
      {
        key: "hb-crane-alert",
        id: S22_WP.hbCraneAlert,
        subject: "Harbor Ops — crane telemetry alert",
        project: S22_PROJECTS.harbor.id,
        status: "New",
        assignee: "teodor",
        estimatedHours: 3,
        remainingHours: 3,
        version: "v_hb",
      },
      {
        key: "lh-auth-bump",
        id: S22_WP.hiddenAuthBump,
        subject: "Lighthouse — shared auth library bump",
        project: S22_PROJECTS.hidden.id,
        status: "New",
        assignee: "mira",
        estimatedHours: 2,
        remainingHours: 2,
        version: "v_lh",
      },
      {
        key: "hb-gate-firmware",
        id: S22_WP.hbGateFirmware,
        subject: "Harbor Ops — gate camera firmware",
        project: S22_PROJECTS.harbor.id,
        status: "New",
        assignee: null,
        estimatedHours: 1,
        remainingHours: 1,
        version: "v_hb",
      },
    ],
  },
  // The seed IS the state — a descriptive-attribute fixture, no burndown.
  timeline: [],
};

export const s22MultiProjectServer2: Scenario = {
  name: "s22-multi-project-server2",
  description:
    "Increment 40 — server TWO of the s22-multi-project pair: project op_id 8700 here is 'Northwind Logistics' " +
    "(identifier nw-logistics), a DIFFERENT project from server one's 8700 'Northwind Payments'. Load onto its " +
    "own connection to prove project lookups are keyed (connection_id, project_op_id) and a projectKey filter " +
    "never leaks the other server's tickets.",
  startDate: "2026-09-07",
  seed: {
    users: [
      ...cast(),
      { key: "ines", id: S22_USERS.ines.id, name: S22_USERS.ines.name, login: "ines.varga" },
    ],
    projects: [{ ...S22_SERVER2_PROJECT }],
    versions: [{ key: "v_nl", id: 8720, name: "NL 2026.3", projectId: S22_SERVER2_PROJECT.id }],
    workPackages: [
      {
        key: "nl-route-optimiser",
        id: S22_SERVER2_WP.nlRouteOptimiser,
        subject: "Northwind Logistics — route optimiser tuning",
        project: S22_SERVER2_PROJECT.id,
        status: "In progress",
        assignee: "ines",
        estimatedHours: 7,
        remainingHours: 7,
        version: "v_nl",
      },
      {
        key: "nl-dock-manifest",
        id: S22_SERVER2_WP.nlDockManifest,
        subject: "Northwind Logistics — dock manifest validation",
        project: S22_SERVER2_PROJECT.id,
        status: "New",
        assignee: "ines",
        estimatedHours: 2,
        remainingHours: 2,
        version: "v_nl",
      },
    ],
  },
  timeline: [],
};
