import type {
  CapacityLine,
  CapacityMode,
  PersonResolver,
  PersonRole,
  SprintItemOrigin,
  SprintItemOutcome,
} from "@osp/contracts";
import { capacityEffectiveRole, createPersonResolver, UNASSIGNED_PERSON_KEY } from "@osp/contracts";
import { computePlannedScope } from "./plannedScope";
import { accumulateCapacitySegments } from "./scopeCapacity";

/**
 * Capacity occupancy (SPEC §6). Default mode per_person: available_hours per
 * member vs planned load, computed PER ASSIGNEE and in AGGREGATE. Unassigned
 * work is shown on its own line. Effort is summed at LEAF level (double-count
 * guard), so a parent whose child is also in the sprint does not inflate load.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SPEC_10 §c — DESIGN NOTE: roster must be scoped to THIS sprint's
 * participants, no 0h/0h phantom people
 * ─────────────────────────────────────────────────────────────────────────
 * CONFIRMED ROSTER RULE (SPEC_10 §4 decision #2): a person is a participant
 * of sprint S iff (a) they have a `sprint_member_capacity` row for S
 * (`repos.capacities.listBySprint(S)` — ALREADY correctly filtered by
 * `sprint_id`, verified: packages/db/src/repos.ts's capacityRepository does
 * `.where(eq(sprintMemberCapacity.sprintId, sprintId))`, no leak found there
 * in a static read), OR (b) they are the CURRENT assignee/accountable of a
 * sprint item in S (including a pure grey-redistribution RECEIVER who owned
 * nothing at activation, SPEC_09 §4). A person satisfying NEITHER — no
 * capacity row for S, no current sprint work in S — must not appear as a
 * line at all, "0h/0h" or otherwise.
 *
 * STATIC READ SO FAR: `computeCapacity()` below only ever creates a line for
 * a key present in `plannedByAssignee` (built purely from `countableItems`,
 * i.e. items ACTUALLY in the sprint) — a capacity-only row with zero sprint
 * items does NOT currently produce a line through this function's own logic,
 * and the DB query for capacity rows is correctly sprint-scoped. This means
 * the reported #c leak (Jan Bily / Vojtech Kolar, 0h/0h, no ticket) is NOT
 * reproducible from reading this file + the capacity repo alone — it needs a
 * LIVE repro (Agent B): build two sprints (one OLD/closed with capacity set
 * for some people, one NEW/fresh), open the fresh sprint's capacity panel,
 * and trace exactly which query/response field is putting the stale people
 * there. Prime suspects to check, in order: (1) `buildCapacityResponse`
 * (routes/index.ts) — does it merge in `repos.teamMembers.list()` (a GLOBAL,
 * unscoped list) anywhere alongside `capacityRows`/`computeCapacity()`'s
 * output, instead of relying purely on computeCapacity's own roster logic?
 * (2) the frontend (apps/web/src/components/SprintBoardScreen.tsx) — does
 * `added` (session-local "Add person" state) or `people`
 * (backlogPeople(items)) ever get merged into the RENDERED roster beyond
 * just being "Add person" dropdown options, and does switching sprints
 * properly reset `added` (it's `useState([])` with no sprint-id key/effect
 * reset — confirm it actually clears on a sprint switch, not just on
 * remount)? (3) grep the whole capacity path for ANY `repos.teamMembers.*`
 * or `repos.capacities.*` call that ISN'T sprint_id-scoped.
 *
 * SEPARATE, RELATED, ALSO-WORTH-FIXING GAP (found while writing this note,
 * not the reported bug but adjacent — fix if time allows, do not let it
 * block #c): `plannedByAssignee` groups by a sprint item's CURRENT
 * assignee_op_id only. Combined with Increment 9's grey math (SPEC_09 §3,
 * where `baseline_hours`/`redistributed_out_hours` attribute to the
 * ORIGINAL owner even once every one of their baseline items has been
 * reassigned away), an original owner with ZERO items currently assigned to
 * them gets NO entry in `plannedByAssignee` at all — meaning THEY NEVER GET
 * A LINE, so their grey "redistributed out" segment can never render, even
 * though `accumulateCapacitySegments` computed it correctly. Fix: the roster
 * key set computeCapacity() iterates needs to be the UNION of (a) current
 * assignees (existing `plannedByAssignee.keys()`) and (b) every ORIGINAL
 * owner with a non-empty segment entry (`segmentsByAssignee.keys()`) — not
 * `plannedByAssignee.keys()` alone — so a fully-reassigned-away original
 * owner still gets a (baseline-length, all-grey) line.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * RESOLVED (Agent B, Increment 10): live repro against the mock (fresh DB:
 * create+set-capacity+finish sprint 1, create empty sprint 2, GET sprint 2's
 * capacity) produced NO 0h/0h phantom from this backend — `computeCapacity`
 * never invented a capacity-only line, and `repos.capacities.listBySprint`
 * IS sprint-scoped (no cross-sprint leak). So the reported Jan Bily / Vojtech
 * Kolar 0h/0h line was NOT coming from apps/api; it is a frontend concern
 * (SprintBoardScreen's session-local `added` roster state — flagged to
 * Agent C). What this file now enforces authoritatively is the SPEC_10 §4 #2
 * roster rule going forward: the line set below is the UNION of current
 * assignees, grey-segment original owners, and capacity-set participants
 * (available_hours>0) — a capacity row with available_hours==0 and zero items
 * produces NO line, so a 0h/0h phantom can never originate here regardless of
 * what the frontend sends. The redistributed_out gap above is also fixed (the
 * roster now unions `segmentsByAssignee.keys()`).
 */
export interface CapacityMemberInput {
  member_id: number;
  op_user_id: number | null;
  name: string;
  available_hours: number;
  /**
   * Increment 14 (SPEC_14 §2 consequence #1): this capacity member's
   * team_member.role. Optional — every pre-Increment-14 caller/test omits it,
   * in which case the line defaults to "developer" (`is_developer: true`) so
   * existing totals/behavior are byte-for-byte unchanged. A non-developer line
   * still appears (its committed hours are "grey" — work that left the
   * developer's hands) but is excluded from total_available/planned_hours.
   */
  role?: PersonRole;
}

export interface CapacityItemInput {
  wp_op_id: number;
  parent_op_id: number | null;
  assignee_op_id: number | null;
  assignee_name: string | null;
  /**
   * Identity unification: the item's OP connection, scoping its assignee's
   * identity resolution (a bare op_user_id is only unique per connection).
   * Optional — a pure unit-test caller may omit it (single-connection fixtures
   * resolve identically either way).
   */
  connection_id?: number | null;
  planned_hours: number | null;
  /**
   * Increment 5 (SPEC_05 §2) scope-segment inputs. Optional: a pre-activation
   * (planning) sprint — and every existing caller/test that predates this
   * increment — omits them, in which case each item is treated as origin
   * "baseline" / outcome "planned", so baseline_hours == the old planned sum,
   * added_hours = removed_hours = 0, and every derived number (planned_hours,
   * overloaded, has_sprint_work, totals) is identical to pre-Increment-5.
   */
  origin?: SprintItemOrigin;
  outcome?: SprintItemOutcome;
  /**
   * Increment 9 (SPEC_09 §3) grey-redistribution inputs, both optional so every
   * pre-Increment-9 caller is unaffected (see scopeCapacity.ts's field docs for
   * the exact "undefined vs null" opt-in contract on original_assignee_op_id).
   * Only meaningful for origin="baseline" items.
   */
  original_assignee_op_id?: number | null;
  is_done?: boolean;
  /**
   * Increment 13 (REVISED, SPEC_13 §1a): the auto-materialized `team_member.id`
   * for a retrospective-sprint item's reconstructed start_date assignee NAME.
   * A person's identity IS their name, so the route materializes a team_member
   * per reconstructed name (regardless of whether an OP user id is known) and
   * passes its id here. That makes every reconstructed person a FULL capacity
   * line — hours summed, `member_id` present so availability is settable — even
   * with `assignee_op_id === null`. Grouping keys off op_user_id when known
   * (so two spellings that resolve to the same account merge) and off this
   * member_id otherwise (so each name keeps its own line, never collapsing into
   * the genuinely-unassigned bucket). Every non-retro caller omits it.
   */
  member_id?: number | null;
  /**
   * Increment 14 (SPEC_14 §2 consequence #1): the assignee's team_member.role.
   * Same opt-in contract as CapacityMemberInput.role — omitted → "developer".
   */
  role?: PersonRole;
}

export interface ComputedCapacity {
  lines: CapacityLine[];
  total_available_hours: number;
  total_planned_hours: number;
}

const UNASSIGNED_KEY = UNASSIGNED_PERSON_KEY;

/**
 * Identity unification (HANDOFF; golden tests `identity-golden*.test.ts`) —
 * the old local `personKey(opUserId, memberId)` (bare numeric id / `m:<id>`)
 * was the repo's SECOND, independent identity definition and is DELETED. All
 * grouping now goes through THE canonical `createPersonResolver` from
 * `@osp/contracts` (the same one closureStats keys by), so `/capacity` lines
 * and `/closure-stats` per-developer rows are the same people BY CONSTRUCTION:
 *   - a person with a team_member row keys `tm:<id>` — spellings, ids and
 *     connections all fold onto it (SPEC_13 §1a's "two spellings that resolve
 *     to the same account merge", now for every surface at once);
 *   - a retro auto-materialized name keys `tm:<member_id>` too (identity IS
 *     the name — each name got its own roster row);
 *   - the genuinely-unassigned bucket is unchanged.
 */
interface KeyedMeta {
  op_user_id: number | null;
  member_id: number | null;
  name: string | null;
  role: PersonRole | null;
}

export function computeCapacity(
  _mode: CapacityMode,
  members: CapacityMemberInput[],
  items: CapacityItemInput[],
  /**
   * SPEC_11 §4 — pre-resolved OP user id → display name, built by the route
   * (buildCapacityResponse) from local caches + op.getUser. Used to name a
   * roster participant who has NO current work package and NO capacity row —
   * e.g. a grey-redistribution ORIGINAL owner fully reassigned away — instead
   * of fabricating "User <id>". Optional so every existing caller/test is
   * unaffected; a truly unresolvable id falls back to "Unknown user (<id>)".
   */
  namesByOpUser: ReadonlyMap<number, string> = new Map(),
  /**
   * THE canonical person resolver (identity unification). The route builds it
   * from team_member + user_name_alias + cached-WP pairs; a pure unit-test
   * caller may omit it, in which case a resolver is built from the `members`
   * input alone — for the single-connection, roster-known fixtures those tests
   * use, the grouping is identical to the old op_user_id/member_id keying.
   */
  resolver?: PersonResolver,
): ComputedCapacity {
  const res =
    resolver ??
    createPersonResolver({
      members: members.map((m) => ({
        id: m.member_id,
        op_user_id: m.op_user_id,
        name: m.name,
        role: m.role ?? "unset",
      })),
    });
  const metaByKey = new Map<number | string, KeyedMeta>();
  const noteMeta = (key: number | string, meta: KeyedMeta): void => {
    const prev = metaByKey.get(key);
    if (!prev) {
      metaByKey.set(key, meta);
      return;
    }
    // Fill gaps only — the first (usually richest) resolution wins per field.
    metaByKey.set(key, {
      op_user_id: prev.op_user_id ?? meta.op_user_id,
      member_id: prev.member_id ?? meta.member_id,
      name: prev.name ?? meta.name,
      role: prev.role ?? meta.role,
    });
  };
  /** Canonical grouping key for one item (SPEC_13 §1a, unified): resolve the
   * person; a resolved roster person wins, a retro member_id keeps its own
   * line, an unresolvable assignee keeps a stable raw key, no assignee at all
   * is the unassigned bucket. */
  const itemKey = (it: CapacityItemInput): number | string => {
    const r =
      it.assignee_op_id != null || it.assignee_name != null
        ? res.resolve(it.connection_id ?? null, it.assignee_op_id ?? null, it.assignee_name ?? null)
        : null;
    if (r != null && (r.member_id != null || it.member_id == null)) {
      noteMeta(r.key, {
        op_user_id: r.op_user_id,
        member_id: r.member_id,
        name: r.name,
        role: r.role,
      });
      return r.key;
    }
    if (it.member_id != null) {
      const key = res.memberKey(it.member_id);
      noteMeta(key, {
        op_user_id: it.assignee_op_id ?? null,
        member_id: it.member_id,
        name: it.assignee_name ?? null,
        role: it.role ?? null,
      });
      return key;
    }
    return UNASSIGNED_KEY;
  };
  /** Canonical key + meta for a grey-redistribution ORIGINAL owner (id-only). */
  const originalOwnerKey = (connectionId: number | null, opUserId: number): number | string => {
    const r = res.resolve(connectionId, opUserId, null);
    if (r == null) return UNASSIGNED_KEY;
    noteMeta(r.key, {
      op_user_id: r.op_user_id,
      member_id: r.member_id,
      name: r.name,
      role: r.role,
    });
    return r.key;
  };
  /**
   * Increment 30 (`docs/CAPACITY_BAR_RULES.md` §5, `docs/INCREMENT_30_CONTRACTS.md`
   * §2) — THE canonical `Planned`: Σ `effectiveEstimate` of the items currently
   * in scope and currently assigned to that person, leaf-suppressed. Computed
   * ONCE, here, and consumed by `/capacity`, `/closure-stats`, sprint detail and
   * the PDF (closureStats.ts feeds the SAME helper with its own identity keys).
   *
   * It also owns the leaf-effort call this function used to make itself, so
   * there is exactly one double-count guard evaluation per capacity read.
   */
  const plannedScope = computePlannedScope(
    items.map((i) => ({
      wp_op_id: i.wp_op_id,
      parent_op_id: i.parent_op_id,
      holder_key: itemKey(i) === UNASSIGNED_KEY ? null : itemKey(i),
      estimate_hours: i.planned_hours,
      // A removed / removed-mid-sprint item is no longer in scope, so it
      // contributes 0 — its holder still gets a line (the blue reduction on the
      // bar comes from the segment fields below, which are unchanged).
      in_scope: i.outcome !== "removed" && i.outcome !== "removed_mid_sprint",
    })),
  );
  const leafIds = plannedScope.leaf_ids;
  const countableItems = items.filter((i) => leafIds.has(i.wp_op_id));
  /**
   * Increment 28 (INCREMENT_28_CONTRACTS §0c/§2b) — items the leaf guard
   * SUPPRESSES (a parent whose child is also in the sprint). Measured defect:
   * these used to be dropped from the input entirely, so a developer whose only
   * ticket was such a parent produced NO capacity line at all — while
   * `closureStats.ts` (which has no leaf filtering) still counted them,
   * violating CAPACITY_BAR_RULES §5 invariant 5.
   *
   * The fix keeps the person VISIBLE while contributing exactly ZERO hours:
   * suppressed items are deliberately NOT fed to `accumulateCapacitySegments`
   * and NOT summed into `plannedByAssignee`, they only (a) add their holder to
   * the roster and (b) supply a name/role/member_id *if nothing else already
   * did*. So no existing line's value, name or role can move — the only
   * possible difference is a previously-missing line appearing at 0 h.
   */
  const suppressedItems = items.filter((i) => !leafIds.has(i.wp_op_id));

  // Scope segments (SPEC_05 §2), grouped by the SAME assignee key. Absent
  // origin/outcome default to a planning item (baseline / planned) so a
  // pre-activation sprint yields baseline == planned, added = removed = 0.
  const segmentsByAssignee = accumulateCapacitySegments(
    countableItems.map((it) => ({
      wp_op_id: it.wp_op_id,
      parent_op_id: it.parent_op_id,
      assignee_op_id: it.assignee_op_id,
      assignee_name: it.assignee_name,
      planned_hours: it.planned_hours,
      origin: it.origin ?? "baseline",
      outcome: it.outcome ?? "planned",
      // Pass the grey-redistribution inputs THROUGH verbatim — do NOT `?? null`
      // original_assignee_op_id (undefined = opt out of grey tracking, null =
      // "baseline row exists, unassigned at capture"; distinct, see the field doc).
      original_assignee_op_id: it.original_assignee_op_id,
      is_done: it.is_done ?? false,
      // SPEC_13 §3: keep an unresolved journal name in its OWN segment bucket.
      bucket_key: itemKey(it),
      // Identity unification — the ORIGINAL owner's bucket must be the SAME
      // canonical key their own line groups under, or a fully-reassigned-away
      // owner's grey segment lands on a phantom raw-id bucket.
      original_bucket_key:
        it.original_assignee_op_id != null
          ? originalOwnerKey(it.connection_id ?? null, it.original_assignee_op_id)
          : undefined,
    })),
  );
  // SPEC_09 §3: the two redistributed_* fields must be present here too, or
  // currentCommittedHours' `+ seg.redistributed_in_hours` NaNs for anyone
  // with no segments at all (e.g. an added-then-removed net-zero item).
  const NO_SEGMENTS = {
    baseline_hours: 0,
    added_hours: 0,
    removed_hours: 0,
    redistributed_out_hours: 0,
    redistributed_in_hours: 0,
  } as const;

  // Which people/buckets to show + their display name — driven by the CURRENT
  // assignee of every countable item (unchanged from before Increment 5). The
  // raw planned sum decides visibility exactly as before (a person is always
  // shown, the unassigned bucket only when its sum > 0); the DISPLAYED value is
  // the current committed total from the segments (equal to this sum in
  // planning). Removed-mid-sprint items still sum here, so a person whose
  // baseline work was reduced still appears to show their blue reduction.
  const plannedByAssignee = new Map<number | string, number>();
  // Display name per grouping key — from the item's assignee name (the live WP
  // name for a normal sprint, or the reconstructed journal name for a retro
  // person). Keyed by the SAME personKey so a member-keyed retro line is named
  // by its journal name, not a fabricated id label.
  const nameByKey = new Map<number | string, string>();
  // The auto-materialized team_member.id an item carries (retro only), so a
  // member-keyed line surfaces a settable member_id even with no capacity row.
  const memberIdByItem = new Map<number | string, number>();
  // Increment 14 (SPEC_14 §2 consequence #1): the holder's role per roster key,
  // from the item's assignee OR (below) the capacity member. Absent → "developer"
  // (pre-Increment-14 default keeps every existing caller's totals unchanged).
  const roleByKey = new Map<number | string, PersonRole>();
  for (const it of countableItems) {
    const key = itemKey(it);
    plannedByAssignee.set(key, (plannedByAssignee.get(key) ?? 0) + (it.planned_hours ?? 0));
    if (it.assignee_name) nameByKey.set(key, it.assignee_name);
    if (it.member_id != null) memberIdByItem.set(key, it.member_id);
    if (it.role) roleByKey.set(key, it.role);
  }

  // Increment 28 §2b — roster keys contributed by leaf-suppressed items ONLY.
  // No hours are added anywhere; name/role/member_id are filled in only when a
  // countable item hasn't already provided them, so every pre-existing line is
  // byte-identical. The genuinely-unassigned bucket is skipped: its visibility
  // rule (`unassignedPlanned > 0`) must stay driven by real hours.
  const suppressedKeys = new Set<number | string>();
  for (const it of suppressedItems) {
    const key = itemKey(it);
    if (key === UNASSIGNED_KEY) continue;
    suppressedKeys.add(key);
    if (it.assignee_name && !nameByKey.has(key)) nameByKey.set(key, it.assignee_name);
    if (it.member_id != null && !memberIdByItem.has(key)) memberIdByItem.set(key, it.member_id);
    if (it.role && !roleByKey.has(key)) roleByKey.set(key, it.role);
  }

  // Saved availability, looked up by the SAME personKey (op user id when the
  // member has one, else its team_member id). SPEC_10 §c: a capacity row for
  // THIS sprint with available_hours>0 marks a PARTICIPANT (the roster rule,
  // SPEC_10 §4 decision #2) — such a person gets a line even with no sprint
  // item. A capacity row with available_hours==0 does NOT invent a person (that
  // is the "0h/0h phantom" SPEC_10 §c removes). The name here also lets a pure
  // capacity-only participant be labelled without a current work package.
  // SPEC_13 §1a: keying by personKey (not op_user_id alone) is what lets a
  // retro person WITHOUT an OP id keep their saved availability across
  // activation — their capacity row keys by team_member id, matching the item.
  const capByKey = new Map<
    number | string,
    { member_id: number; available_hours: number; name: string }
  >();
  for (const m of members) {
    // A capacity row references its team_member directly — the member IS the
    // person, so the canonical member key groups it with every item resolution
    // that reached the same person (by id, name, alias or connection variant).
    const key = res.memberKey(m.member_id);
    noteMeta(key, {
      op_user_id: m.op_user_id,
      member_id: m.member_id,
      name: m.name,
      role: m.role ?? null,
    });
    capByKey.set(key, {
      member_id: m.member_id,
      available_hours: m.available_hours,
      name: m.name,
    });
    // A capacity member's role wins over an item-derived one (same person,
    // same team_member.role — this just covers a capacity-only participant
    // with no sprint item to carry the role).
    if (m.role) roleByKey.set(key, m.role);
  }

  // SPEC_10 §c — the sprint roster is the UNION of this sprint's participants:
  //   (1) current assignees of a sprint item (`plannedByAssignee`);
  //   (2) ORIGINAL owners with a non-empty grey segment — a baseline owner who
  //       has been fully reassigned away owns ZERO current items, so they are
  //       absent from `plannedByAssignee`, yet still need a line to render their
  //       `redistributed_out` segment (`segmentsByAssignee`, SPEC_09 §3);
  //   (3) people with capacity EXPLICITLY set for THIS sprint (available>0).
  // Everyone else — no current work, no grey segment, no available capacity —
  // never appears (kills the 0h/0h phantom). The capacity query is already
  // sprint-scoped (repos.capacities.listBySprint), so members from other/closed
  // sprints can't leak in here.
  const rosterKeys = new Set<number | string>();
  for (const key of plannedByAssignee.keys()) if (key !== UNASSIGNED_KEY) rosterKeys.add(key);
  for (const key of segmentsByAssignee.keys()) if (key !== UNASSIGNED_KEY) rosterKeys.add(key);
  for (const [key, cap] of capByKey)
    if (key !== UNASSIGNED_KEY && cap.available_hours > 0) rosterKeys.add(key);
  //   (4) Increment 28 §2b: holders of a leaf-SUPPRESSED item (a parent whose
  //       child is also in the sprint). They contribute 0 h — NO_SEGMENTS below
  //       gives planned_hours 0 and has_sprint_work false — but they must not
  //       vanish from the panel while the sprint list badges their ticket.
  for (const key of suppressedKeys) rosterKeys.add(key);

  const lines: CapacityLine[] = [];

  // One line per roster participant, named from the current work package / the
  // reconstructed journal name (or the capacity member name for a pure
  // capacity-only participant), with their saved availability (0 if none).
  // planned_hours is the CURRENT committed total (baseline + added - removed +
  // redistributed_in), which for a planning sprint equals the plain planned sum
  // as before and is 0 for a capacity-only line.
  for (const key of rosterKeys) {
    const seg = segmentsByAssignee.get(key) ?? NO_SEGMENTS;
    // Increment 30 — the canonical current-scope Planned, NOT the old
    // `currentCommittedHours(seg)` (baseline + added − removed + redistributed_in).
    // Measured divergence that made the change necessary: a baseline ticket
    // handed from A to B left its hours in A's `baseline_hours` (nothing
    // subtracts `redistributed_out` there) AND added them to B's
    // `redistributed_in`, so a handoff counted on BOTH lines and inflated the
    // aggregate. Under the canonical rule the ticket belongs to exactly one
    // holder — whoever holds it now.
    const committed = plannedScope.by_holder.get(key) ?? 0;
    // Identity unification: the person's op_user_id/member_id come from the
    // canonical resolution meta, not from the key's shape (the key is opaque).
    const meta = metaByKey.get(key);
    const opUserId = meta?.op_user_id ?? null;
    const cap = capByKey.get(key);
    const available = cap?.available_hours ?? 0;
    // SPEC_14 §2 consequence #1/#2: default "developer" so pre-Increment-14
    // callers are unaffected; a non-developer line still appears (grey) but is
    // dropped from the totals below. The resolver's raw role fills in when no
    // item/member carried one (same effective-role default as the route).
    const role: PersonRole =
      roleByKey.get(key) ?? (meta?.role != null ? capacityEffectiveRole(meta.role) : "developer");
    lines.push({
      // SPEC_13 §1a: a retro line ALWAYS has a settable member_id — from the
      // capacity row if saved, else the item's auto-materialized team_member.
      member_id: cap?.member_id ?? memberIdByItem.get(key) ?? meta?.member_id ?? null,
      op_user_id: opUserId,
      // SPEC_11 §4: NEVER fabricate "User <id>". Resolve in order — current
      // work-package / reconstructed assignee name, capacity-member name,
      // pre-resolved map (local caches + op.getUser), canonical roster name,
      // then "Unknown user (<id>)".
      name:
        nameByKey.get(key) ??
        cap?.name ??
        (opUserId !== null ? namesByOpUser.get(opUserId) : undefined) ??
        meta?.name ??
        (opUserId !== null ? `Unknown user (${opUserId})` : `Unknown user (${String(key)})`),
      available_hours: available,
      planned_hours: committed,
      // Available never grows with scope creep, so overload appears exactly when
      // committed passes the frozen ceiling (SPEC_05 §1).
      overloaded: available > 0 && committed > available,
      // Re-derived from items: owns at least one item that ever counted (SPEC_05
      // §2) — an added-then-removed item nets to zero and does NOT make it true.
      // SPEC_09 §4: a pure receiver (owned nothing at activation) still "has
      // sprint work" once they've received redistributed hours.
      // Increment 28 §2b: a holder whose ONLY sprint ticket is leaf-suppressed
      // contributes 0 h, but the CapacityLine contract is explicit that this
      // flag means "is the assignee of a work package in the sprint (even a
      // 0-estimate one)" — such a line must not offer a Remove button, because
      // it is re-derived from the items and would come straight back.
      has_sprint_work:
        seg.baseline_hours + seg.added_hours > 0 ||
        seg.redistributed_in_hours > 0 ||
        suppressedKeys.has(key),
      baseline_hours: seg.baseline_hours,
      added_hours: seg.added_hours,
      removed_hours: seg.removed_hours,
      redistributed_out_hours: seg.redistributed_out_hours,
      redistributed_in_hours: seg.redistributed_in_hours,
      role,
      is_developer: role === "developer",
    });
  }

  // Unassigned bucket (always shown separately per SPEC §6).
  const unassignedPlanned = plannedByAssignee.get(UNASSIGNED_KEY) ?? 0;
  if (unassignedPlanned > 0) {
    const seg = segmentsByAssignee.get(UNASSIGNED_KEY) ?? NO_SEGMENTS;
    // Increment 30 — same canonical rule as the per-person lines above.
    const committed = plannedScope.unassigned_hours;
    lines.push({
      member_id: null,
      op_user_id: null,
      name: "Unassigned",
      available_hours: 0,
      planned_hours: committed,
      overloaded: false,
      has_sprint_work: true,
      baseline_hours: seg.baseline_hours,
      added_hours: seg.added_hours,
      removed_hours: seg.removed_hours,
      redistributed_out_hours: seg.redistributed_out_hours,
      redistributed_in_hours: seg.redistributed_in_hours,
      // The unassigned bucket has no person, so no role — "unset"/non-developer.
      // It is NEVER availability-editable and shows only as grey, but its
      // committed planned hours stay in total_planned_hours (unchanged from
      // pre-Increment-14 — see the totals note below).
      role: "unset",
      is_developer: false,
    });
  }

  lines.sort((a, b) => {
    const au = a.op_user_id == null;
    const bu = b.op_user_id == null;
    if (au !== bu) return au ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  // Increment 14 (SPEC_14 §2 consequence #1) — "capacity = Developers only":
  // testers/customers/other still APPEAR as (grey) lines but do NOT count
  // toward the planning aggregate. Pre-Increment-14 callers omit role → every
  // real person defaults to "developer", so their totals are unchanged. The
  // genuinely-unassigned bucket (member_id === null && op_user_id === null) is
  // NOT a developer, but its committed hours counted toward total_planned_hours
  // before this increment — that pre-existing behavior is preserved (only the
  // per-person developer filter is added on top), so it stays in the sum. Its
  // available_hours is always 0, so its inclusion never moves availability.
  const isUnassignedBucket = (l: CapacityLine): boolean =>
    l.member_id === null && l.op_user_id === null;
  const total_available_hours = lines.reduce(
    (s, l) => (l.is_developer ? s + l.available_hours : s),
    0,
  );
  const total_planned_hours = lines.reduce(
    (s, l) => (l.is_developer || isUnassignedBucket(l) ? s + l.planned_hours : s),
    0,
  );

  return { lines, total_available_hours, total_planned_hours };
}
