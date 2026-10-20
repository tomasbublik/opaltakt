/**
 * S11 — effective-estimate backlog cases (SPEC_16 §5).
 *
 * A small, STATIC (no timeline) backlog scenario purpose-built for the
 * `effectiveEstimate` rule: "Remaining work" beats "Work" as the planning
 * estimate whenever it is nonzero AND differs from Work — otherwise Work
 * wins. None of these tickets ever get baselined into a sprint by this
 * scenario (no timeline mutates them), so exercising the rule here can never
 * disturb a frozen sprint baseline elsewhere.
 *
 * Four WPs, one per branch of the rule (override itself is app-side — Agent
 * B/C's territory — and is exercised via `POST /work-packages/:id/estimate`
 * against any of these, not via fixture data):
 *   - WP 1901 "remaining-wins": Work 24h / Remaining 18h -> effective 18h.
 *     Mirrors the exact SPEC_16 §5 worked example (ticket #11765: Work 24,
 *     Remaining 18, Spent 11) WITHOUT reusing id 11765 itself, which already
 *     names a DIFFERENT (baselined, Work 8/Remaining 4) ticket in
 *     s9-role-closure.ts — reusing the id here would collide in any shared
 *     work_package_cache once both scenarios' tickets are synced in the same
 *     backend across a Playwright run.
 *   - WP 1902 "remaining-equals-work": Work 8h / Remaining 8h -> effective 8h
 *     (remaining == work, so rule 3 applies: fall through to Work).
 *   - WP 1903 "remaining-zero": Work 12h / Remaining 0h -> effective 12h
 *     (remaining == 0, so rule 3 applies).
 *   - WP 1904 "remaining-wins-small": Work 10h / Remaining 3h -> effective 3h
 *     (a second remaining-wins case with different numbers, so a test can't
 *     accidentally pass by hardcoding "18").
 *
 * All four sit in project 3 (Demo Project), open status "New", no version —
 * a plain backlog: importing/syncing Demo Project is enough to make them
 * show up under GET /backlog with no day-advance required.
 */
import type { Scenario } from "../scenario-types";
import { cast } from "./helpers";

export const s11EffectiveEstimate: Scenario = {
  name: "s11-effective-estimate",
  description:
    "Four static (no timeline) project-3 backlog tickets, one per branch of the SPEC_16 §5 " +
    "effectiveEstimate rule: WP 1901 Work 24h/Remaining 18h -> effective 18h (mirrors the spec's " +
    "#11765 worked example without colliding with s9-role-closure.ts's DIFFERENT, already-baselined " +
    "#11765); WP 1902 Work 8h/Remaining 8h -> effective 8h (remaining == work, falls through); " +
    "WP 1903 Work 12h/Remaining 0h -> effective 12h (remaining == 0, falls through); WP 1904 " +
    "Work 10h/Remaining 3h -> effective 3h (a second remaining-wins case). None are ever assigned " +
    "a version or touched by a timeline event, so none can ever be baselined by this scenario alone " +
    "-- SUGGESTED SETUP: import Demo Project and read GET /backlog's effective_hours for each.",
  startDate: "2026-07-13",
  seed: {
    users: cast(),
    versions: [],
    workPackages: [
      {
        key: "remaining-wins",
        id: 1901,
        subject: "Reconciliation batch export throughput regression",
        project: 3,
        status: "New",
        assignee: "dev",
        accountable: "customer",
        estimatedHours: 24,
        remainingHours: 18,
      },
      {
        key: "remaining-equals-work",
        id: 1902,
        subject: "Add retry/backoff to the webhook dispatcher",
        project: 3,
        status: "New",
        assignee: "dev",
        estimatedHours: 8,
        remainingHours: 8,
      },
      {
        key: "remaining-zero",
        id: 1903,
        subject: "Investigate flaky nightly import job",
        project: 3,
        status: "New",
        assignee: null,
        estimatedHours: 12,
        remainingHours: 0,
      },
      {
        key: "remaining-wins-small",
        id: 1904,
        subject: "Trim unused CSS from the legacy admin theme",
        project: 3,
        status: "New",
        assignee: "tester",
        estimatedHours: 10,
        remainingHours: 3,
      },
      {
        // Increment 22 — a day-spanning estimate (≥24h). Mirrors the real prod
        // WP 11592, whose remainingTime is "P1DT5H" == 29h. Its whole purpose is
        // to force the mock's HAL serializer down the day-component path so the
        // op-client round-trip (mock HTTP -> parseIsoDuration -> 29) can finally
        // be proven end-to-end — previously impossible because the mock never
        // emitted a `D` component. 29h == 1 day (24h) + 5h -> "P1DT5H".
        key: "day-spanning-remaining",
        id: 1905,
        subject: "Full re-key migration of the archived settlement ledger",
        project: 3,
        status: "New",
        assignee: "dev",
        estimatedHours: 29,
        remainingHours: 29,
      },
    ],
    timeEntries: [
      // Narrative fidelity with the SPEC_16 §5 example ("Spent 11h") — does
      // not feed effectiveEstimate itself (that only reads Work/Remaining),
      // just proves the rule holds "regardless of logged time".
      { wp: "remaining-wins", user: "dev", hours: 11, spentOn: "2026-07-13" },
    ],
  },
  timeline: [],
};
