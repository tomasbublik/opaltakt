/**
 * S17 — assignee identity collision, "Acme" server side (SPEC_23 §2), plus
 * the WP-11592 day-spanning-duration regression (SPEC_23 §1.2 / Increment 22).
 *
 * The twin of s16-assignee-collision-mock — read that file's header for the
 * full incident write-up. In short:
 *
 *   Alan Turing        = mock  server, OP user id 3   (s16)
 *   Cameron Dalby  = Acme server, OP user id 3   (THIS file)
 *   Grace Hopper       = id 5 on BOTH servers (same id AND name)
 *
 * Loaded onto a SECOND, independent connection so the e2e spec can prove that
 * `(connection_id, op_user_id)` identity keeps Cameron (id 3 @ Acme)
 * distinct from Alan (id 3 @ mock), and that selecting one server's id-3 person
 * never returns the other server's tickets.
 *
 * ── WP-11592 analogue: 29h → "P1DT5H" round trip (SPEC_23 §1.2) ─────────────
 * SPEC_23 §6 re-asserts the Increment-22 duration check: after syncing the
 * Acme connection, ticket "11592" has EFFECTIVE hours = 29h. Real OP encodes
 * 29h as the ISO-8601 duration "P1DT5H" (1 day = 24h, + 5h), which a naive
 * parser collapses to 5h. The op-client parseIsoDuration fix round-trips it to
 * 29 end-to-end. WP 84090 below (Work 29 / Remaining 29 → the mock serialises
 * "P1DT5H") is that ticket. The LITERAL op_id 11592 is already taken by s9 in
 * the shared cache (`wp_cache_op_id_uq` is global), so — exactly as the TO spec
 * did with its own 1905 — this uses a fresh op_id and stands in as the 11592
 * analogue; the id is irrelevant to the P1DT5H→29 assertion, the value is not.
 *
 * ── FRESH-ID NOTE (Increment 15 collision gotcha) ──────────────────────────
 * WP ids (84001-84003, 84090), project 8400 and version 8410 appear in NO other
 * scenario (grep-verified). See s16's header re: the deliberately-reused person
 * NAMES being safe under the SPEC_23 per-connection identity fix.
 */
import type { Scenario } from "../scenario-types";

export const s17AssigneeCollisionAcme: Scenario = {
  name: "s17-assignee-collision-acme",
  description:
    "SPEC_23 §2 assignee-identity collision — the 'Acme' server half. Cameron Dalby is OP user id 3 (the " +
    "same numeric id Alan Turing has on the mock twin s16), and Grace Hopper is id 5 on BOTH servers. Also carries " +
    "the WP-11592 analogue (op_id 84090, Work/Remaining 29h → 'P1DT5H') for the SPEC_23 §1.2 duration round-trip " +
    "regression. Loaded onto its own connection so the e2e spec can prove connection-scoped identity and no " +
    "cross-server ticket leak.",
  startDate: "2026-07-13",
  seed: {
    users: [
      { key: "me", id: 1, name: "Acme Me", login: "acme.me", me: true },
      // id 3 — collides with Alan Turing (id 3) on the mock twin.
      { key: "chris", id: 3, name: "Cameron Dalby", login: "cameron.dalby" },
      // id 5 — collides (same id AND name) with Grace Hopper on the mock twin.
      { key: "grace", id: 5, name: "Grace Hopper", login: "grace.hopper" },
    ],
    projects: [{ id: 8400, identifier: "osp-collision-acme", name: "OSP Collision Acme" }],
    versions: [{ key: "v_eft", id: 8410, name: "Acme 2.0", projectId: 8400 }],
    workPackages: [
      {
        key: "chris-1",
        id: 84001,
        subject: "Acme — Cameron task A",
        project: 8400,
        status: "In progress",
        assignee: "chris",
        estimatedHours: 4,
        remainingHours: 4,
        version: "v_eft",
      },
      {
        key: "chris-2",
        id: 84002,
        subject: "Acme — Cameron task B",
        project: 8400,
        status: "New",
        assignee: "chris",
        estimatedHours: 8,
        remainingHours: 8,
        version: "v_eft",
      },
      {
        key: "grace-1",
        id: 84003,
        subject: "Acme — Grace task A",
        project: 8400,
        status: "New",
        assignee: "grace",
        estimatedHours: 3,
        remainingHours: 3,
        version: "v_eft",
      },
      {
        // WP-11592 analogue — 29h == 1 day (24h) + 5h → the mock serialises this
        // as ISO duration "P1DT5H"; op-client's parseIsoDuration must round-trip
        // it back to 29 (NOT collapse to 5) so effective_hours === 29.
        key: "eft-11592",
        id: 84090,
        subject: "Acme — 11592 analogue (P1DT5H = 29h)",
        project: 8400,
        status: "In progress",
        assignee: "chris",
        estimatedHours: 29,
        remainingHours: 29,
        version: "v_eft",
      },
    ],
  },
  // The seed IS the state — identity/scoping + duration regression, no burndown.
  timeline: [],
};
