import { describe, expect, it } from "vitest";
import { openDb } from "./factory";
import type { NewWorkPackageCache } from "./repositories";

/**
 * Increment 27 — `isoTimestamp` CANONICALISES sub-second precision.
 *
 * Under SQLite an ISO string was stored and returned byte-for-byte. Under
 * Postgres these columns are real `timestamptz`, so the value makes a
 * string → Date → timestamptz → Date → string round trip and comes back in
 * `Date#toISOString()`'s canonical form — which ALWAYS carries milliseconds:
 *
 *     written "2026-07-01T09:00:00Z"  →  read "2026-07-01T09:00:00.000Z"
 *
 * The instant is identical and both forms satisfy the `IsoDateTime` contract
 * (`z.string().datetime({ offset: true })`), so nothing downstream breaks —
 * app code never compares these fields as strings (verified by grep). But a
 * TEST that pins the exact bytes would now fail for no semantic reason, so
 * timestamp assertions compare the INSTANT. `expectSameInstant` exists to make
 * that intent obvious rather than sprinkling `Date.parse` around.
 */
function expectSameInstant(actual: string | null | undefined, expected: string): void {
  expect(actual, `expected a timestamp equal to ${expected}, got ${String(actual)}`).toBeTruthy();
  expect(new Date(actual!).toISOString()).toBe(new Date(expected).toISOString());
}

function wp(partial: Partial<NewWorkPackageCache> & { op_id: number }): NewWorkPackageCache {
  return {
    connection_id: partial.connection_id ?? null,
    op_id: partial.op_id,
    project_op_id: partial.project_op_id ?? 100,
    subject: partial.subject ?? `WP ${partial.op_id}`,
    type_name: partial.type_name ?? "Task",
    status_name: partial.status_name ?? "New",
    status_is_closed: partial.status_is_closed ?? false,
    assignee_op_id: partial.assignee_op_id ?? null,
    assignee_name: partial.assignee_name ?? null,
    estimated_hours: partial.estimated_hours ?? null,
    remaining_hours: partial.remaining_hours ?? null,
    spent_hours: partial.spent_hours ?? null,
    story_points: partial.story_points ?? null,
    version_op_id: partial.version_op_id ?? null,
    version_name: partial.version_name ?? null,
    priority: partial.priority ?? null,
    parent_op_id: partial.parent_op_id ?? null,
    percentage_done: partial.percentage_done ?? null,
    updated_at_op: partial.updated_at_op ?? "2026-06-01T00:00:00Z",
    raw_json: partial.raw_json ?? "{}",
  };
}

describe("db repositories (in-memory, migrated)", () => {
  it("connections: multi-row registry with a single current row", async () => {
    const { repositories: r, close } = await openDb({ ephemeral: true });
    const blob = { ct: "Y3Q=", nonce: "bm9uY2U=", tag: "dGFn" };
    const a = await r.connections.create({
      base_url: "https://op-a.example.com",
      label: "A",
      token_ct: blob.ct,
      token_nonce: blob.nonce,
      token_tag: blob.tag,
      default_project_op_id: 100,
    });
    // First row becomes current automatically.
    expect(a.is_current).toBe(true);
    expect(a.last_status).toBe("unknown");

    const b = await r.connections.create({
      base_url: "https://op-b.example.com",
      label: null,
      token_ct: null,
      token_nonce: null,
      token_tag: null,
      default_project_op_id: null,
    });
    expect(b.is_current).toBe(false);
    expect((await r.connections.getCurrent())?.id).toBe(a.id);

    // Duplicate base_url violates the UNIQUE index.
    await expect(
      r.connections.create({
        base_url: "https://op-a.example.com",
        label: null,
        token_ct: null,
        token_nonce: null,
        token_tag: null,
        default_project_op_id: null,
      }),
    ).rejects.toThrow(/UNIQUE/i);

    await r.connections.setCurrent(b.id);
    expect((await r.connections.getCurrent())?.id).toBe(b.id);
    expect((await r.connections.getById(a.id))?.is_current).toBe(false);

    await r.connections.updateHealth(b.id, {
      last_check_at: "2026-07-10T10:00:00Z",
      last_status: "fail",
      last_latency_ms: 12.5,
      last_error: "connect ECONNREFUSED",
    });
    const bAfter = await r.connections.getById(b.id);
    expect(bAfter?.last_status).toBe("fail");
    expect(bAfter?.last_latency_ms).toBe(12.5);
    // Partial patch leaves the other health fields alone.
    expect(bAfter?.last_activity_at).toBeNull();

    // Deleting the current row re-points current to the newest remaining one.
    expect(await r.connections.delete(b.id)).toBe(true);
    expect((await r.connections.getCurrent())?.id).toBe(a.id);
    await close();
  });

  it("connections: token lifecycle (encrypted set, legacy migration, reset)", async () => {
    const { repositories: r, close } = await openDb({ ephemeral: true });
    const c = await r.connections.create({
      base_url: "https://op.example.com",
      label: null,
      token_ct: null,
      token_nonce: null,
      token_tag: null,
      default_project_op_id: null,
    });
    // No token material at all → not listed as legacy.
    expect(await r.connections.listLegacyPlaintext()).toHaveLength(0);

    await r.connections.setEncryptedToken(c.id, {
      ct: "Y2lwaGVy",
      nonce: "bm9uY2U=",
      tag: "dGFn",
    });
    const withToken = await r.connections.getById(c.id);
    expect(withToken?.token_ct).toBe("Y2lwaGVy");
    expect(withToken?.token_encrypted).toBeNull();

    const cleared = await r.connections.clearAllTokens();
    expect(cleared).toBe(1);
    const afterReset = await r.connections.getById(c.id);
    expect(afterReset?.token_ct).toBeNull();
    expect(afterReset?.token_tag).toBeNull();
    // base_url survives a vault reset (SPEC_02 §3).
    expect(afterReset?.base_url).toBe("https://op.example.com");
    await close();
  });

  it("vault meta: singleton save/get/delete round-trip", async () => {
    const { repositories: r, close } = await openDb({ ephemeral: true });
    expect(await r.vaultMeta.get()).toBeNull();
    const meta = await r.vaultMeta.save({
      kdf_algo: "argon2id",
      kdf_salt: "c2FsdA==",
      kdf_params_json: JSON.stringify({ memoryKib: 65536, iterations: 3, parallelism: 4 }),
      verifier_ct: "dmVyaWZpZXI=",
      verifier_nonce: "bm9uY2U=",
    });
    expect(meta.id).toBe(1);
    // Second save replaces the singleton (re-key), never adds a row.
    const rekeyed = await r.vaultMeta.save({
      kdf_algo: "scrypt",
      kdf_salt: "c2FsdDI=",
      kdf_params_json: JSON.stringify({ N: 32768, r: 8, p: 1 }),
      verifier_ct: "djI=",
      verifier_nonce: "bjI=",
    });
    expect(rekeyed.id).toBe(1);
    expect((await r.vaultMeta.get())?.kdf_algo).toBe("scrypt");
    await r.vaultMeta.delete();
    expect(await r.vaultMeta.get()).toBeNull();
    await close();
  });

  it("work packages: upsertMany, find filters, maxUpdatedAtOp", async () => {
    const { repositories: r, close } = await openDb({ ephemeral: true });
    await r.workPackages.upsertMany([
      wp({ op_id: 1, estimated_hours: 8, assignee_op_id: 10, updated_at_op: "2026-06-01T00:00:00Z" }),
      wp({ op_id: 2, estimated_hours: null, assignee_op_id: 11, updated_at_op: "2026-06-05T00:00:00Z" }),
      wp({ op_id: 3, estimated_hours: 4, assignee_op_id: 10, status_name: "Closed", status_is_closed: true, updated_at_op: "2026-06-03T00:00:00Z" }),
    ]);
    // upsert (update path) — change estimate on op_id 1
    await r.workPackages.upsertMany([wp({ op_id: 1, estimated_hours: 12, assignee_op_id: 10 })]);
    const one = await r.workPackages.getByOpId(1);
    expect(one?.estimated_hours).toBe(12);

    const withEstimate = await r.workPackages.find({ projectOpId: 100, hasEstimate: true });
    expect(withEstimate.map((x) => x.op_id).sort()).toEqual([1, 3]);

    const byAssignee = await r.workPackages.find({ projectOpId: 100, assigneeOpId: 10 });
    expect(byAssignee.map((x) => x.op_id).sort()).toEqual([1, 3]);

    const max = await r.workPackages.maxUpdatedAtOp(100);
    expectSameInstant(max, "2026-06-05T00:00:00Z");
    await close();
  });

  it("work packages: status/priority filters match case-insensitively/trimmed (Increment 19)", async () => {
    const { repositories: r, close } = await openDb({ ephemeral: true });
    await r.workPackages.upsertMany([
      wp({ op_id: 1, status_name: "in progress", priority: "High" }),
      wp({ op_id: 2, status_name: "IN PROGRESS", priority: "low" }),
      wp({ op_id: 3, status_name: "New", priority: "Normal" }),
    ]);
    // Differently-cased QUERY matches a differently-cased STORED value, both ways.
    const upperQuery = await r.workPackages.find({ statusName: "IN PROGRESS" });
    expect(upperQuery.map((x) => x.op_id).sort()).toEqual([1, 2]);
    const lowerQuery = await r.workPackages.find({ statusName: "in progress" });
    expect(lowerQuery.map((x) => x.op_id).sort()).toEqual([1, 2]);
    // Surrounding whitespace is trimmed on both sides of the comparison.
    const paddedQuery = await r.workPackages.find({ statusName: "  In Progress  " });
    expect(paddedQuery.map((x) => x.op_id).sort()).toEqual([1, 2]);
    // priority filter (previously untested — the field didn't exist).
    const byPriority = await r.workPackages.find({ priority: "HIGH" });
    expect(byPriority.map((x) => x.op_id)).toEqual([1]);
    await close();
  });

  it("sprint + items lifecycle: create, add, setOutcome, close", async () => {
    const { repositories: r, close } = await openDb({ ephemeral: true });
    const s = await r.sprints.create({
      name: "Sprint 1",
      start_date: "2026-06-01",
      end_date: "2026-06-14",
      status: "planning",
      capacity_mode: "per_person",
    });
    expect(s.id).toBeGreaterThan(0);
    expect(s.completed_hours).toBeNull();

    const item = await r.sprintItems.add({
      sprint_id: s.id,
      wp_op_id: 1,
      planned_hours: 8,
      outcome: "planned",
      origin: "baseline",
    });
    expect(item.outcome).toBe("planned");
    const done = await r.sprintItems.setOutcome(item.id, "done");
    expect(done.outcome).toBe("done");

    const items = await r.sprintItems.listBySprint(s.id);
    expect(items).toHaveLength(1);

    const closed = await r.sprints.close(s.id, 8, "2026-06-14T18:00:00Z", "finished");
    expect(closed.status).toBe("closed");
    expect(closed.completed_hours).toBe(8);
    expect(closed.is_locked).toBe(true);
    expectSameInstant(closed.locked_at, "2026-06-14T18:00:00Z");
    expect(closed.lock_reason).toBe("finished");
    await close();
  });

  it("capacity + team members: replaceForSprint is idempotent-replace", async () => {
    const { repositories: r, close } = await openDb({ ephemeral: true });
    const s = await r.sprints.create({
      name: "S", start_date: "2026-06-01", end_date: "2026-06-14",
      status: "planning", capacity_mode: "per_person",
    });
    const m1 = await r.teamMembers.upsert({ op_user_id: 10, name: "Ann", default_hours_per_day: 8 });
    const m2 = await r.teamMembers.upsert({ op_user_id: 11, name: "Bob", default_hours_per_day: 6 });
    await r.capacities.replaceForSprint(s.id, [
      { sprint_id: s.id, member_id: m1.id, available_hours: 80, pto_days: 0 },
      { sprint_id: s.id, member_id: m2.id, available_hours: 60, pto_days: 1 },
    ]);
    let caps = await r.capacities.listBySprint(s.id);
    expect(caps).toHaveLength(2);
    // replace with a single row
    await r.capacities.replaceForSprint(s.id, [
      { sprint_id: s.id, member_id: m1.id, available_hours: 40, pto_days: 2 },
    ]);
    caps = await r.capacities.listBySprint(s.id);
    expect(caps).toHaveLength(1);
    expect(caps[0]!.available_hours).toBe(40);
    await close();
  });

  it("burndown snapshots upsert by (sprint, date)", async () => {
    const { repositories: r, close } = await openDb({ ephemeral: true });
    const s = await r.sprints.create({
      name: "S", start_date: "2026-06-01", end_date: "2026-06-14",
      status: "active", capacity_mode: "per_person",
    });
    await r.burndown.upsert({
      sprint_id: s.id, snapshot_date: "2026-06-02",
      remaining_hours: 40, logged_hours: 8, ideal_hours: 36, done_count: 1, total_count: 5,
      source: "live",
    });
    await r.burndown.upsert({
      sprint_id: s.id, snapshot_date: "2026-06-02",
      remaining_hours: 32, logged_hours: 16, ideal_hours: 32, done_count: 2, total_count: 5,
      source: "reconstructed",
    });
    const list = await r.burndown.listBySprint(s.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.remaining_hours).toBe(32);
    // Increment 12: source round-trips (upsert overwrote live → reconstructed).
    expect(list[0]!.source).toBe("reconstructed");
    await close();
  });

  it("sync runs: start/current/finish/latest", async () => {
    const { repositories: r, close } = await openDb({ ephemeral: true });
    const run = await r.syncRuns.start("full");
    expect(run.status).toBe("running");
    expect(await r.syncRuns.current()).not.toBeNull();
    await r.syncRuns.finish(run.id, "success", 42, null, "2026-06-01T01:00:00Z");
    expect(await r.syncRuns.current()).toBeNull();
    const latest = await r.syncRuns.latest();
    expect(latest?.status).toBe("success");
    expect(latest?.wp_count).toBe(42);
    await close();
  });

  it("sync runs: getById / requestCancel / isCancelled (Increment 19)", async () => {
    const { repositories: r, close } = await openDb({ ephemeral: true });
    const run = await r.syncRuns.start("full");
    expect(run.cancel_requested).toBe(false);

    // getById mirrors current()/latest() shape.
    expect((await r.syncRuns.getById(run.id))?.id).toBe(run.id);
    expect(await r.syncRuns.getById(9999)).toBeNull();
    expect(await r.syncRuns.isCancelled(run.id)).toBe(false);

    // requestCancel flips the flag on a running run and returns the updated row.
    const cancelled = await r.syncRuns.requestCancel(run.id);
    expect(cancelled?.cancel_requested).toBe(true);
    expect(await r.syncRuns.isCancelled(run.id)).toBe(true);
    expect(cancelled?.status).toBe("running"); // status untouched by the flag

    // requestCancel on a non-existent id is null.
    expect(await r.syncRuns.requestCancel(9999)).toBeNull();

    // Idempotent + no-op once finished: the flag stays as-is, no error.
    await r.syncRuns.finish(run.id, "aborted", 7, null, "2026-06-01T01:00:00Z");
    const afterFinish = await r.syncRuns.requestCancel(run.id);
    expect(afterFinish?.status).toBe("aborted");
    expect(afterFinish?.cancel_requested).toBe(true);
    await close();
  });

  it("sync runs: recoverOrphaned marks stuck 'running' rows aborted, leaves others (Increment 22)", async () => {
    const { repositories: r, close } = await openDb({ ephemeral: true });

    // A fresh DB has nothing running → no-op returning 0.
    expect(await r.syncRuns.recoverOrphaned()).toBe(0);

    // Two runs left stuck 'running' (the crash scenario) + one already finished.
    const stuckA = await r.syncRuns.start("full");
    const stuckB = await r.syncRuns.start("incremental");
    const done = await r.syncRuns.start("full");
    await r.syncRuns.finish(done.id, "success", 5, null, "2026-06-01T01:00:00Z");

    const recovered = await r.syncRuns.recoverOrphaned();
    expect(recovered).toBe(2);

    // Both formerly-running rows are now aborted with the diagnostic error + a
    // finished_at, so current() (the "one sync at a time" guard) is unblocked.
    expect(await r.syncRuns.current()).toBeNull();
    for (const id of [stuckA.id, stuckB.id]) {
      const row = await r.syncRuns.getById(id);
      expect(row?.status).toBe("aborted");
      expect(row?.error).toMatch(/Recovered at startup/);
      expect(row?.finished_at).not.toBeNull();
    }
    // The already-finished success row is untouched.
    expect((await r.syncRuns.getById(done.id))?.status).toBe("success");

    // Idempotent: a second call recovers nothing.
    expect(await r.syncRuns.recoverOrphaned()).toBe(0);
    await close();
  });

  it("estimate overrides upsert by wp", async () => {
    const { repositories: r, close } = await openDb({ ephemeral: true });
    await r.estimateOverrides.upsert({ wp_op_id: 1, planning_hours: 5, note: "a" });
    const o = await r.estimateOverrides.upsert({ wp_op_id: 1, planning_hours: 9, note: "b" });
    expect(o.planning_hours).toBe(9);
    const many = await r.estimateOverrides.getManyByWpOpIds([1, 2]);
    expect(many).toHaveLength(1);
    await close();
  });

  // ── Increment 4: sprint lifecycle (SPEC_04) ──────────────────────────────

  it("sprint activate: planning -> active, sets activated_at", async () => {
    const { repositories: r, close } = await openDb({ ephemeral: true });
    const s = await r.sprints.create({
      name: "S1",
      start_date: "2026-07-01",
      end_date: "2026-07-09",
      status: "planning",
      capacity_mode: "per_person",
    });
    expect(s.activated_at).toBeNull();
    expect(s.is_locked).toBe(false);
    expect(s.baseline_total_hours).toBeNull();
    const activated = await r.sprints.activate(s.id, "2026-07-01T09:00:00Z", 42);
    expect(activated.status).toBe("active");
    expectSameInstant(activated.activated_at, "2026-07-01T09:00:00Z");
    expect(activated.is_locked).toBe(false);
    expect(activated.baseline_total_hours).toBe(42);
    await close();
  });

  it("sprint retro columns: default false/null at create, settable via update (Increment 12)", async () => {
    const { repositories: r, close } = await openDb({ ephemeral: true });
    const s = await r.sprints.create({
      name: "Retro",
      start_date: "2026-07-01",
      end_date: "2026-07-09",
      status: "planning",
      capacity_mode: "per_person",
    });
    expect(s.is_retrospective).toBe(false);
    expect(s.retro_seed_kind).toBeNull();
    expect(s.retro_seed_value).toBeNull();
    expect(s.retro_replayed_at).toBeNull();

    const flagged = await r.sprints.update(s.id, { is_retrospective: true });
    expect(flagged.is_retrospective).toBe(true);

    const seeded = await r.sprints.update(s.id, {
      retro_seed_kind: "version",
      retro_seed_value: "3.5.039",
    });
    expect(seeded.retro_seed_kind).toBe("version");
    expect(seeded.retro_seed_value).toBe("3.5.039");

    const replayed = await r.sprints.update(s.id, { retro_replayed_at: "2026-07-15T10:00:00Z" });
    expectSameInstant(replayed.retro_replayed_at, "2026-07-15T10:00:00Z");
    // is_retrospective/seed values are untouched by a partial patch.
    expect(replayed.is_retrospective).toBe(true);
    expect(replayed.retro_seed_kind).toBe("version");
    await close();
  });

  it("ticket baseline: upsertMany is keyed on (sprint, wp) — re-activation overwrites, not duplicates", async () => {
    const { repositories: r, close } = await openDb({ ephemeral: true });
    const s = await r.sprints.create({
      name: "S1",
      start_date: "2026-07-01",
      end_date: "2026-07-09",
      status: "planning",
      capacity_mode: "per_person",
    });
    await r.ticketBaselines.upsertMany([
      {
        sprint_id: s.id,
        wp_op_id: 1101,
        captured_at: "2026-07-01T09:00:00Z",
        subject: "Implement invoice PDF export",
        status_name: "New",
        status_is_closed: false,
        assignee_op_id: 10,
        accountable_op_id: 20,
        original_assignee_op_id: 10,
        estimated_hours: 16,
        remaining_hours: 16,
        spent_hours: null,
        version_op_id: null,
        raw_json: "{}",
        origin: "baseline",
        reconstructed: false,
        reconstruction_gaps_json: null,
        assignee_name_raw: null,
      },
    ]);
    const first = await r.ticketBaselines.getBySprintAndWp(s.id, 1101);
    expect(first?.status_name).toBe("New");
    expect(first?.reconstructed).toBe(false);
    // Re-activation (or a defensive re-run) overwrites the SAME row — EXCEPT
    // original_assignee_op_id (SPEC_09 §3), which must stay frozen even if
    // the ticket has since been reassigned to someone else by the time of
    // this re-run (simulated here: assignee_op_id moves to 99, but
    // original_assignee_op_id in the payload is still passed as the NEW
    // current holder — the repo must still keep the FIRST-seen value, 10).
    await r.ticketBaselines.upsertMany([
      {
        sprint_id: s.id,
        wp_op_id: 1101,
        captured_at: "2026-07-01T09:05:00Z",
        subject: "Implement invoice PDF export",
        status_name: "Confirmed",
        status_is_closed: false,
        assignee_op_id: 99,
        accountable_op_id: 20,
        original_assignee_op_id: 99,
        estimated_hours: 16,
        remaining_hours: 16,
        spent_hours: null,
        version_op_id: null,
        raw_json: "{}",
        origin: "baseline",
        reconstructed: true,
        reconstruction_gaps_json: JSON.stringify(["estimated_hours"]),
        assignee_name_raw: null,
      },
    ]);
    const rows = await r.ticketBaselines.listBySprint(s.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status_name).toBe("Confirmed");
    // Increment 12: reconstruction provenance overwrites on re-upsert.
    expect(rows[0]?.reconstructed).toBe(true);
    // Increment 27: `*_json` columns are real `jsonb` now. Postgres normalises
    // on the way in — it REORDERS object keys and strips insignificant
    // whitespace — so the string that comes back is JSON-equal but NOT
    // byte-equal to what was written. Assert on the PARSED value; never
    // `toBe(JSON.stringify(...))`, and never compare re-stringified strings
    // either (that inherits the same reordering).
    expect(JSON.parse(rows[0]!.reconstruction_gaps_json!)).toEqual(["estimated_hours"]);
    expect(rows[0]?.assignee_op_id).toBe(99);
    // SPEC_09 §3: frozen at first insert, unaffected by the re-upsert above.
    expect(rows[0]?.original_assignee_op_id).toBe(10);
    await close();
  });

  it("sprint update run: start/finish lifecycle + latestBySprint", async () => {
    const { repositories: r, close } = await openDb({ ephemeral: true });
    const s = await r.sprints.create({
      name: "S1",
      start_date: "2026-07-01",
      end_date: "2026-07-09",
      status: "planning",
      capacity_mode: "per_person",
    });
    const run = await r.sprintUpdateRuns.start(s.id, "activation", "manual");
    expect(run.status).toBe("running");
    expect(run.kind).toBe("activation");
    const finished = await r.sprintUpdateRuns.finish(
      run.id,
      "success",
      3,
      2,
      null,
      "2026-07-01T09:01:00Z",
    );
    expect(finished.status).toBe("success");
    expect(finished.wp_count).toBe(3);
    expect(finished.changes_count).toBe(2);
    const latest = await r.sprintUpdateRuns.latestBySprint(s.id);
    expect(latest?.id).toBe(run.id);
    await close();
  });

  it("ticket changelog: insertMany dedups via dedup_key (idempotent re-run)", async () => {
    const { repositories: r, close } = await openDb({ ephemeral: true });
    const s = await r.sprints.create({
      name: "S1",
      start_date: "2026-07-01",
      end_date: "2026-07-09",
      status: "planning",
      capacity_mode: "per_person",
    });
    const run = await r.sprintUpdateRuns.start(s.id, "activation", "manual");
    const entry = {
      sprint_id: s.id,
      wp_op_id: 1101,
      update_run_id: run.id,
      occurred_at: "2026-07-06T09:00:00Z",
      actor_op_id: 10,
      actor_name: "Dev Dvorak",
      kind: "status_changed" as const,
      detail_json: JSON.stringify({ kind: "status_changed", from: "In progress", to: "Developed" }),
      source: "journal" as const,
      op_journal_id: 501,
      dedup_key: "journal:501",
    };
    const firstCount = await r.ticketChangelog.insertMany([entry]);
    expect(firstCount).toBe(1);
    // Same journal id re-processed on a later update run → dedup, zero new rows.
    const run2 = await r.sprintUpdateRuns.start(s.id, "update", "manual");
    const secondCount = await r.ticketChangelog.insertMany([{ ...entry, update_run_id: run2.id }]);
    expect(secondCount).toBe(0);
    const history = await r.ticketChangelog.listByTicket(s.id, 1101);
    expect(history).toHaveLength(1);
    expect(history[0]?.kind).toBe("status_changed");
    await close();
  });

  it("user name alias: upsert de-dupes on (connection, journal_name); delete removes", async () => {
    const { repositories: r, close } = await openDb({ ephemeral: true });
    const conn = await r.connections.create({
      base_url: "https://a.example.com",
      label: null,
      token_ct: null,
      token_nonce: null,
      token_tag: null,
      default_project_op_id: null,
    });
    const a1 = await r.userNameAliases.upsert({
      connection_id: conn.id,
      journal_name: "Jan Belka",
      op_user_id: 5,
    });
    // Re-posting the SAME (connection, journal_name) corrects the target — no dup.
    const a2 = await r.userNameAliases.upsert({
      connection_id: conn.id,
      journal_name: "Jan Belka",
      op_user_id: 9,
    });
    expect(a2.id).toBe(a1.id);
    const list = await r.userNameAliases.listByConnection(conn.id);
    expect(list).toHaveLength(1);
    expect(list[0]?.op_user_id).toBe(9);
    expect(list[0]?.merge_into_name).toBeNull();
    // SPEC_13 §1b (revised): re-posting the same journal_name with the OTHER
    // escape hatch (merge_into_name, no id) fully replaces the prior mapping.
    const a3 = await r.userNameAliases.upsert({
      connection_id: conn.id,
      journal_name: "Jan Belka",
      merge_into_name: "Jan Bily",
    });
    expect(a3.id).toBe(a1.id);
    const merged = await r.userNameAliases.listByConnection(conn.id);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.op_user_id).toBeNull();
    expect(merged[0]?.merge_into_name).toBe("Jan Bily");
    expect(await r.userNameAliases.delete(a1.id)).toBe(true);
    expect(await r.userNameAliases.listByConnection(conn.id)).toHaveLength(0);
    await close();
  });

  it("team member: getByName returns an EXACT-name match (auto-materialization dedup)", async () => {
    const { repositories: r, close } = await openDb({ ephemeral: true });
    expect(await r.teamMembers.getByName("Jan Belka")).toBeNull();
    const tm = await r.teamMembers.upsert({
      op_user_id: null,
      name: "Jan Belka",
      default_hours_per_day: 8,
    });
    const found = await r.teamMembers.getByName("Jan Belka");
    expect(found?.id).toBe(tm.id);
    expect(found?.op_user_id).toBeNull();
    // No fuzzy: a different spelling is a different person.
    expect(await r.teamMembers.getByName("Jan Bily")).toBeNull();
    await close();
  });

  it("sprint delete cascades capacity_edit_audit but NOT connection-scoped aliases", async () => {
    const { repositories: r, close } = await openDb({ ephemeral: true });
    const conn = await r.connections.create({
      base_url: "https://b.example.com",
      label: null,
      token_ct: null,
      token_nonce: null,
      token_tag: null,
      default_project_op_id: null,
    });
    await r.userNameAliases.upsert({ connection_id: conn.id, journal_name: "X", op_user_id: 1 });
    const s = await r.sprints.create({
      name: "S",
      start_date: "2026-07-01",
      end_date: "2026-07-09",
      status: "planning",
      capacity_mode: "per_person",
    });
    await r.capacityEditAudits.add({ sprint_id: s.id, changes_json: "{}" });
    expect(await r.capacityEditAudits.listBySprint(s.id)).toHaveLength(1);

    expect(await r.sprints.deleteWithCascade(s.id)).toBe(true);
    // Audit gone with the sprint...
    expect(await r.capacityEditAudits.listBySprint(s.id)).toHaveLength(0);
    // ...but the alias survives (connection-scoped, retroactive across sprints).
    expect(await r.userNameAliases.listByConnection(conn.id)).toHaveLength(1);
    await close();
  });

  // ── Increment 32 (docs/INCREMENT_32_CONTRACTS.md §2) — off-sprint time ─────
  it("off-sprint time: replaceForSprint is idempotent-replace (mirrors capacity/doneStatusRule)", async () => {
    const { repositories: r, close } = await openDb({ ephemeral: true });
    const s = await r.sprints.create({
      name: "S", start_date: "2026-06-01", end_date: "2026-06-14",
      status: "active", capacity_mode: "per_person",
    });
    await r.offSprintTime.replaceForSprint(s.id, [
      {
        sprint_id: s.id, connection_id: null, op_time_entry_id: 7001, wp_op_id: 2001,
        wp_subject: "Off-sprint A", actor_op_id: 10, actor_name: "Ann",
        spent_on: "2026-06-05", hours: 2, fetched_at: "2026-06-05T09:00:00.000Z",
      },
      {
        sprint_id: s.id, connection_id: null, op_time_entry_id: 7002, wp_op_id: 2002,
        wp_subject: "Off-sprint B", actor_op_id: 20, actor_name: "Bob",
        spent_on: "2026-06-06", hours: 3, fetched_at: "2026-06-05T09:00:00.000Z",
      },
    ]);
    let rows = await r.offSprintTime.listBySprint(s.id);
    expect(rows).toHaveLength(2);

    // Second run REPLACES the full set — an entry gone from OP disappears,
    // not merges (§0.3: "a report of current truth, not history").
    await r.offSprintTime.replaceForSprint(s.id, [
      {
        sprint_id: s.id, connection_id: null, op_time_entry_id: 7003, wp_op_id: 2003,
        wp_subject: "Off-sprint C", actor_op_id: 10, actor_name: "Ann",
        spent_on: "2026-06-07", hours: 5, fetched_at: "2026-06-06T09:00:00.000Z",
      },
    ]);
    rows = await r.offSprintTime.listBySprint(s.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.op_time_entry_id).toBe(7003);
    expect(rows[0]!.hours).toBe(5);
    await close();
  });

  it("off-sprint time: sprint delete cascades at the DB level (ON DELETE CASCADE, unlike most sprint-scoped tables)", async () => {
    const { repositories: r, close } = await openDb({ ephemeral: true });
    const s = await r.sprints.create({
      name: "S", start_date: "2026-06-01", end_date: "2026-06-14",
      status: "active", capacity_mode: "per_person",
    });
    await r.offSprintTime.replaceForSprint(s.id, [
      {
        sprint_id: s.id, connection_id: null, op_time_entry_id: 7001, wp_op_id: 2001,
        wp_subject: "Off-sprint A", actor_op_id: 10, actor_name: "Ann",
        spent_on: "2026-06-05", hours: 2, fetched_at: "2026-06-05T09:00:00.000Z",
      },
    ]);
    expect(await r.offSprintTime.listBySprint(s.id)).toHaveLength(1);
    expect(await r.sprints.deleteWithCascade(s.id)).toBe(true);
    expect(await r.offSprintTime.listBySprint(s.id)).toHaveLength(0);
    await close();
  });

  // ── Increment 20 (SPEC_20 §2/§3) — staging + progress heartbeat ────────────
  it("staging: stage → commit merges into live cache and clears staging", async () => {
    const { repositories: r, close } = await openDb({ ephemeral: true });
    const run = await r.syncRuns.start("full");
    await r.workPackages.stageBatch(run.id, [wp({ op_id: 1 }), wp({ op_id: 2 })]);
    // Live cache untouched while staged.
    expect(await r.workPackages.getByOpId(1)).toBeNull();

    const merged = await r.workPackages.commitStaging(run.id);
    expect(merged).toBe(2);
    // Live cache now holds the rows...
    expect((await r.workPackages.getByOpId(1))?.op_id).toBe(1);
    expect((await r.workPackages.getByOpId(2))?.op_id).toBe(2);
    // ...and staging is empty (a second commit merges nothing).
    expect(await r.workPackages.commitStaging(run.id)).toBe(0);
    await close();
  });

  it("staging: drop rolls back without touching the live cache", async () => {
    const { repositories: r, close } = await openDb({ ephemeral: true });
    // A pre-existing live row must survive an aborted run untouched.
    await r.workPackages.upsertMany([wp({ op_id: 1, subject: "original" })]);
    const run = await r.syncRuns.start("full");
    await r.workPackages.stageBatch(run.id, [
      wp({ op_id: 1, subject: "changed" }),
      wp({ op_id: 99 }),
    ]);

    await r.workPackages.dropStaging(run.id);
    // Live cache untouched: op_id 1 keeps its original subject, op_id 99 never landed.
    expect((await r.workPackages.getByOpId(1))?.subject).toBe("original");
    expect(await r.workPackages.getByOpId(99)).toBeNull();
    // Staging is empty — a commit now merges nothing.
    expect(await r.workPackages.commitStaging(run.id)).toBe(0);
    await close();
  });

  it("staging: commit upserts an existing op_id in place (no duplicate)", async () => {
    const { repositories: r, close } = await openDb({ ephemeral: true });
    await r.workPackages.upsertMany([wp({ op_id: 5, subject: "old", estimated_hours: 1 })]);
    const run = await r.syncRuns.start("full");
    await r.workPackages.stageBatch(run.id, [
      wp({ op_id: 5, subject: "new", estimated_hours: 8 }),
    ]);
    const merged = await r.workPackages.commitStaging(run.id);
    expect(merged).toBe(1);
    const row = await r.workPackages.getByOpId(5);
    expect(row?.subject).toBe("new");
    expect(row?.estimated_hours).toBe(8);
    // Exactly one live row for op_id 5 (upsert, not insert).
    expect(await r.workPackages.getManyByOpIds([5])).toHaveLength(1);
    await close();
  });

  it("staging: clearAllStaging removes rows regardless of run", async () => {
    const { repositories: r, close } = await openDb({ ephemeral: true });
    const runA = await r.syncRuns.start("full");
    const runB = await r.syncRuns.start("incremental");
    await r.workPackages.stageBatch(runA.id, [wp({ op_id: 1 })]);
    await r.workPackages.stageBatch(runB.id, [wp({ op_id: 2 })]);

    await r.workPackages.clearAllStaging();
    // Both runs' staging rows are gone — neither commits anything.
    expect(await r.workPackages.commitStaging(runA.id)).toBe(0);
    expect(await r.workPackages.commitStaging(runB.id)).toBe(0);
    // Live cache never received anything.
    expect(await r.workPackages.getByOpId(1)).toBeNull();
    expect(await r.workPackages.getByOpId(2)).toBeNull();
    await close();
  });

  it("staging: commit merges >200 rows across chunks", async () => {
    const { repositories: r, close } = await openDb({ ephemeral: true });
    const run = await r.syncRuns.start("full");
    const rows = Array.from({ length: 450 }, (_, i) => wp({ op_id: i + 1 }));
    await r.workPackages.stageBatch(run.id, rows);
    const merged = await r.workPackages.commitStaging(run.id);
    expect(merged).toBe(450);
    expect((await r.workPackages.getByOpId(1))?.op_id).toBe(1);
    expect((await r.workPackages.getByOpId(450))?.op_id).toBe(450);
    await close();
  });

  it("sync runs: progress() bumps last_progress_at (heartbeat)", async () => {
    const { repositories: r, close } = await openDb({ ephemeral: true });
    const run = await r.syncRuns.start("full");
    expect(run.last_progress_at).toBeNull();
    await r.syncRuns.progress(run.id, 10, 100);
    const after = await r.syncRuns.getById(run.id);
    expect(after?.last_progress_at).not.toBeNull();
    expect(after?.wp_count).toBe(10);
    expect(after?.total_count).toBe(100);
    await close();
  });

  // ── sync_watermark (Increment 29, CONTRACTS §3) ───────────────────────────
  it("watermarks: get() is null for an unknown (connection, project) pair", async () => {
    const { repositories: r, close } = await openDb({ ephemeral: true });
    const c = await r.connections.create({
      base_url: "https://op.example.com",
      label: null,
      token_ct: null,
      token_nonce: null,
      token_tag: null,
      default_project_op_id: null,
    });
    expect(await r.watermarks.get(c.id, 100)).toBeNull();
    expect(await r.watermarks.get(null, 100)).toBeNull();
    await close();
  });

  it("watermarks: set() upserts on the (connection, project) unique key", async () => {
    const { repositories: r, close } = await openDb({ ephemeral: true });
    const c = await r.connections.create({
      base_url: "https://op.example.com",
      label: null,
      token_ct: null,
      token_nonce: null,
      token_tag: null,
      default_project_op_id: null,
    });
    await r.watermarks.set(c.id, 100, "2026-08-01T10:00:00Z");
    expectSameInstant(await r.watermarks.get(c.id, 100), "2026-08-01T10:00:00Z");
    // Same pair → UPDATE in place, never a second row.
    await r.watermarks.set(c.id, 100, "2026-08-02T11:30:00Z");
    expectSameInstant(await r.watermarks.get(c.id, 100), "2026-08-02T11:30:00Z");
    // A DIFFERENT project on the same connection is its own watermark — the
    // whole point of keying per (connection, PROJECT): project 100's run must
    // never advance project 200's cutoff.
    expect(await r.watermarks.get(c.id, 200)).toBeNull();
    await r.watermarks.set(c.id, 200, "2026-07-01T00:00:00Z");
    expectSameInstant(await r.watermarks.get(c.id, 100), "2026-08-02T11:30:00Z");
    expectSameInstant(await r.watermarks.get(c.id, 200), "2026-07-01T00:00:00Z");
    await close();
  });

  it("watermarks: the legacy null-connection group upserts too (no duplicate rows)", async () => {
    // Postgres treats NULLs as DISTINCT in a unique index, so an ON CONFLICT
    // upsert would silently insert a NEW row on every successful sync for the
    // legacy group and the read would become non-deterministic.
    const { repositories: r, close, raw } = await openDb({ ephemeral: true });
    await r.watermarks.set(null, 100, "2026-08-01T10:00:00Z");
    await r.watermarks.set(null, 100, "2026-08-05T10:00:00Z");
    expectSameInstant(await r.watermarks.get(null, 100), "2026-08-05T10:00:00Z");
    const driver = raw as { query: (s: string) => Promise<{ rows: { n: string | number }[] }> };
    const { rows } = await driver.query(
      "SELECT count(*)::int AS n FROM sync_watermark WHERE connection_id IS NULL",
    );
    expect(Number(rows[0]!.n)).toBe(1);
    await close();
  });

  it("watermarks: clearForConnection() scopes to ONE connection", async () => {
    const { repositories: r, close } = await openDb({ ephemeral: true });
    const a = await r.connections.create({
      base_url: "https://a.example.com",
      label: "A",
      token_ct: null,
      token_nonce: null,
      token_tag: null,
      default_project_op_id: null,
    });
    const b = await r.connections.create({
      base_url: "https://b.example.com",
      label: "B",
      token_ct: null,
      token_nonce: null,
      token_tag: null,
      default_project_op_id: null,
    });
    await r.watermarks.set(a.id, 100, "2026-08-01T10:00:00Z");
    await r.watermarks.set(a.id, 200, "2026-08-01T10:00:00Z");
    await r.watermarks.set(b.id, 100, "2026-08-01T10:00:00Z");
    await r.watermarks.set(null, 100, "2026-08-01T10:00:00Z");

    await r.watermarks.clearForConnection(a.id);
    expect(await r.watermarks.get(a.id, 100)).toBeNull();
    expect(await r.watermarks.get(a.id, 200)).toBeNull();
    // Every OTHER connection (and the legacy null group) is untouched.
    expectSameInstant(await r.watermarks.get(b.id, 100), "2026-08-01T10:00:00Z");
    expectSameInstant(await r.watermarks.get(null, 100), "2026-08-01T10:00:00Z");

    // …and clearing the null group leaves the real connections alone.
    await r.watermarks.clearForConnection(null);
    expect(await r.watermarks.get(null, 100)).toBeNull();
    expectSameInstant(await r.watermarks.get(b.id, 100), "2026-08-01T10:00:00Z");
    await close();
  });
});
