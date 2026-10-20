/**
 * S16 — assignee identity collision, "mock" server side (SPEC_23 §2).
 *
 * One HALF of a deliberately-paired fixture (its twin is
 * s17-assignee-collision-acme). Together they reproduce the CONFIRMED
 * cross-server identity incident behind SPEC_23 §2:
 *
 *   Alan Turing        = mock  server, OP user **id 3**   (this file)
 *   Cameron Dalby  = Acme server, OP user **id 3**   (s17)
 *
 * The SAME numeric `op_user_id` (3) names DIFFERENT people on the two servers.
 * The old assignee filter matched by bare `op_user_id`, so it (a) deduped id 3
 * to a single dropdown entry — Cameron Dalby silently vanished — and (b)
 * made selecting id 3 return BOTH servers' tickets (a cross-server data leak).
 * The fix keys identity on `(connection_id, op_user_id)` (`FilterOptionEntry.
 * key = "${connection_id}:${op_id}"`), so each server's id-3 person is distinct
 * and its filter matches only its own connection's rows.
 *
 * This scenario is meant to be loaded onto its OWN connection (a dedicated
 * recording mock) by tp-sync-disconnected-assignee-identity.spec.ts; s17 loads
 * onto a SECOND connection. The e2e spec then proves both people appear as
 * distinct dropdown options and neither's assigneeKey leaks the other's rows.
 *
 * ── The other shared id: Grace Hopper (id 5) on BOTH servers ────────────────
 * Grace Hopper carries the SAME id (5) AND the SAME name on both servers — the
 * strongest form of the collision. Under the fix `(connection_id, id)` still
 * separates Grace@mock (`${mockConn}:5`) from Grace@acme (`${eftConn}:5`), so
 * selecting one never returns the other's rows. This proves the discriminator
 * is genuinely the connection, not merely the id OR the name.
 *
 * ── FRESH-ID / FRESH-NAME NOTE (Increment 15 collision gotcha) ──────────────
 * work_package_cache keys tickets by `op_id` GLOBALLY (schema `wp_cache_op_id_uq`),
 * so every WP op_id must be unique across the whole shared e2e DB. This file's
 * WP ids (83001-83005), project 8300 and version 8310 appear in NO other
 * scenario (grep-verified against fixtures/scenarios/s*.ts). The person NAMES
 * "Alan Turing"/"Grace Hopper" DO also exist in the static fixture-mode data
 * (fixtures/data/work_packages.json — that fixture is literally where the SPEC
 * narrative's "Alan Turing = id 3" originates) and "Cameron Dalby" exists in
 * s9/s12/s13 at id 106 — but under the SPEC_23 fix identity is per-connection,
 * so reusing the incident's real names on a DEDICATED connection is safe (every
 * query in the spec is connection-scoped) and, if anything, a stronger test.
 */
import type { Scenario } from "../scenario-types";

export const s16AssigneeCollisionMock: Scenario = {
  name: "s16-assignee-collision-mock",
  description:
    "SPEC_23 §2 assignee-identity collision — the 'mock' server half. Alan Turing is OP user id 3 (the same " +
    "numeric id Cameron Dalby has on the Acme twin s17), and Grace Hopper is id 5 on BOTH servers. Loaded " +
    "onto its own connection so the e2e spec can prove (connection_id, op_user_id) identity keeps id-3 Alan " +
    "distinct from id-3 Cameron and id-5 Grace@mock distinct from id-5 Grace@acme — no dropdown dedup, no " +
    "cross-server ticket leak.",
  startDate: "2026-07-13",
  seed: {
    users: [
      { key: "me", id: 1, name: "Mock Me", login: "mock.me", me: true },
      // id 3 — collides with Cameron Dalby (id 3) on the Acme twin.
      { key: "alan", id: 3, name: "Alan Turing", login: "alan.turing" },
      // id 5 — collides (same id AND name) with Grace Hopper on the Acme twin.
      { key: "grace", id: 5, name: "Grace Hopper", login: "grace.hopper" },
    ],
    projects: [{ id: 8300, identifier: "osp-collision-mock", name: "OSP Collision Mock" }],
    versions: [{ key: "v_mock", id: 8310, name: "Mock 1.0", projectId: 8300 }],
    workPackages: [
      {
        key: "alan-1",
        id: 83001,
        subject: "Mock — Alan task A",
        project: 8300,
        status: "In progress",
        assignee: "alan",
        estimatedHours: 4,
        remainingHours: 4,
        version: "v_mock",
      },
      {
        key: "alan-2",
        id: 83002,
        subject: "Mock — Alan task B",
        project: 8300,
        status: "New",
        assignee: "alan",
        estimatedHours: 6,
        remainingHours: 6,
        version: "v_mock",
      },
      {
        key: "alan-3",
        id: 83003,
        subject: "Mock — Alan task C",
        project: 8300,
        status: "New",
        assignee: "alan",
        estimatedHours: 2,
        remainingHours: 2,
        version: "v_mock",
      },
      {
        key: "grace-1",
        id: 83004,
        subject: "Mock — Grace task A",
        project: 8300,
        status: "In progress",
        assignee: "grace",
        estimatedHours: 3,
        remainingHours: 3,
        version: "v_mock",
      },
      {
        key: "grace-2",
        id: 83005,
        subject: "Mock — Grace task B",
        project: 8300,
        status: "New",
        assignee: "grace",
        estimatedHours: 5,
        remainingHours: 5,
        version: "v_mock",
      },
    ],
  },
  // The seed IS the state — this is an identity/scoping fixture, no burndown.
  timeline: [],
};
