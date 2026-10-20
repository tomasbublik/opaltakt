import { describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../test-utils";

/**
 * SPEC_13 §6 — a retrospective sprint's capacity stays editable after it leaves
 * planning (it's a reconstructed historical figure), and every such edit is
 * audited. A NORMAL sprint's capacity lock is UNCHANGED (409 once out of
 * planning / locked) — the regression guard for not loosening the normal rule.
 */

async function makeLockedSprint(t: TestApp, retro: boolean): Promise<number> {
  const created = await t.app.inject({
    method: "POST",
    url: "/api/sprints",
    payload: { name: retro ? "Retro" : "Normal", start_date: "2026-06-01", end_date: "2026-06-05" },
  });
  const id = created.json().id as number;
  if (retro) await t.repos.sprints.update(id, { is_retrospective: true });
  await t.repos.sprints.activate(id, "2026-06-01T09:00:00Z", 0);
  await t.repos.sprints.close(id, 0, "2026-06-05T18:00:00Z", "finished");
  return id;
}

describe("SPEC_13 §6 retro capacity editable after lock, with audit", () => {
  it("editing a LOCKED retrospective sprint's capacity succeeds and writes an audit row", async () => {
    const t = await buildTestApp();
    const id = await makeLockedSprint(t, true);

    const put1 = await t.app.inject({
      method: "PUT",
      url: `/api/sprints/${id}/capacity`,
      payload: { members: [{ op_user_id: 5, available_hours: 20, pto_days: 1 }] },
    });
    expect(put1.statusCode).toBe(200);

    const audit1 = (
      await t.app.inject({ method: "GET", url: `/api/sprints/${id}/capacity-audit` })
    ).json();
    expect(audit1).toHaveLength(1);
    const changes = JSON.parse(audit1[0].changes_json);
    const memberIds = Object.keys(changes);
    expect(memberIds).toHaveLength(1);
    expect(changes[memberIds[0]!].available_hours).toEqual({ from: null, to: 20 });
    expect(changes[memberIds[0]!].pto_days).toEqual({ from: null, to: 1 });

    // A second edit → a second audit row, capturing the before→after diff.
    const put2 = await t.app.inject({
      method: "PUT",
      url: `/api/sprints/${id}/capacity`,
      payload: { members: [{ op_user_id: 5, available_hours: 30, pto_days: 1 }] },
    });
    expect(put2.statusCode).toBe(200);
    const audit2 = (
      await t.app.inject({ method: "GET", url: `/api/sprints/${id}/capacity-audit` })
    ).json();
    expect(audit2).toHaveLength(2);
    // Newest first.
    const latest = JSON.parse(audit2[0].changes_json);
    const mid = Object.keys(latest)[0]!;
    expect(latest[mid].available_hours).toEqual({ from: 20, to: 30 });
    await t.close();
  });

  it("editing a LOCKED NON-retrospective sprint's capacity still 409s (regression)", async () => {
    const t = await buildTestApp();
    const id = await makeLockedSprint(t, false);
    const put = await t.app.inject({
      method: "PUT",
      url: `/api/sprints/${id}/capacity`,
      payload: { members: [{ op_user_id: 5, available_hours: 20, pto_days: 0 }] },
    });
    expect(put.statusCode).toBe(409);
    expect(put.json().error.code).toBe("SPRINT_LOCKED");
    // And no audit row was written.
    const audit = (
      await t.app.inject({ method: "GET", url: `/api/sprints/${id}/capacity-audit` })
    ).json();
    expect(audit).toHaveLength(0);
    await t.close();
  });

  it("an ACTIVE non-retrospective sprint's capacity 409s SPRINT_NOT_PLANNING", async () => {
    const t = await buildTestApp();
    const created = await t.app.inject({
      method: "POST",
      url: "/api/sprints",
      payload: { name: "Active", start_date: "2026-06-01", end_date: "2026-06-05" },
    });
    const id = created.json().id as number;
    await t.repos.sprints.activate(id, "2026-06-01T09:00:00Z", 0);
    const put = await t.app.inject({
      method: "PUT",
      url: `/api/sprints/${id}/capacity`,
      payload: { members: [{ op_user_id: 5, available_hours: 20, pto_days: 0 }] },
    });
    expect(put.statusCode).toBe(409);
    expect(put.json().error.code).toBe("SPRINT_NOT_PLANNING");
    await t.close();
  });
});
