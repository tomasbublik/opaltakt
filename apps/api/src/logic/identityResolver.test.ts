import { describe, expect, it } from "vitest";
import type {
  HalCollection,
  OpClient,
  OpMembership,
  OpWorkPackage,
} from "@osp/op-client";
import type { UserNameAlias } from "@osp/contracts";
import { createIdentityResolver } from "./identityResolver";

function coll<T>(elements: T[]): HalCollection<T> {
  return {
    _type: "Collection",
    total: elements.length,
    count: elements.length,
    pageSize: 100,
    offset: 1,
    _embedded: { elements },
    _links: { self: { href: "/self" } },
  };
}

/** SPEC_13 §1a (revised): the index is built from NON-admin sources only —
 * memberships (`_links.principal`) here. `getUsers` must NEVER be called; it
 * throws to prove the resolver doesn't touch it. */
function fakeOpWithMemberships(memberships: OpMembership[]): OpClient {
  return {
    request: <T>() => Promise.resolve(undefined as T),
    getCurrentUser: () => Promise.resolve({ _type: "User", id: 1, name: "x" }),
    getProjects: () => Promise.resolve(coll([]) as never),
    getWorkPackages: () => Promise.resolve(coll([]) as never),
    getTimeEntries: () => Promise.resolve(coll([]) as never),
    getVersions: () => Promise.resolve(coll([]) as never),
    getStatuses: () => Promise.resolve(coll([]) as never),
    getWorkPackageSchema: () => Promise.resolve({ _type: "Schema" } as never),
    getActivities: () => Promise.resolve(coll([]) as never),
    getUser: () => Promise.resolve(null),
    getUsers: () => {
      throw new Error("getUsers (admin-gated) must never be called by the resolver");
    },
    getMemberships: (query) => {
      const projFilter = ((query?.filters as unknown[]) ?? []).find(
        (f): f is { project: { values?: string[] } } =>
          typeof f === "object" && f !== null && "project" in f,
      );
      if (projFilter) {
        const ids = new Set((projFilter.project.values ?? []).map((v) => Number(v)));
        return Promise.resolve(
          coll(
            memberships.filter((m) => {
              const pid = Number((m._links.project?.href ?? "").split("/").pop());
              return ids.has(pid);
            }),
          ),
        );
      }
      return Promise.resolve(coll(memberships));
    },
  };
}

function membership(id: number, userId: number, name: string, projectId = 100): OpMembership {
  return {
    _type: "Membership",
    id,
    _links: {
      principal: { href: `/api/v3/users/${userId}`, title: name },
      project: { href: `/api/v3/projects/${projectId}` },
    },
  };
}

function wpWithAssignee(id: number, userId: number, name: string, projectId = 100): OpWorkPackage {
  return {
    _type: "WorkPackage",
    id,
    subject: `WP ${id}`,
    updatedAt: "2026-07-01T00:00:00Z",
    _links: {
      self: { href: `/api/v3/work_packages/${id}` },
      status: { href: "/api/v3/statuses/1", title: "New" },
      type: { href: "/api/v3/types/1", title: "Task" },
      project: { href: `/api/v3/projects/${projectId}` },
      assignee: { href: `/api/v3/users/${userId}`, title: name },
    },
  } as OpWorkPackage;
}

const MEMBERS: OpMembership[] = [
  membership(1, 5, "Jan Bily"),
  membership(2, 7, "Cameron Dalby"),
];

function alias(
  journal_name: string,
  op_user_id: number | null,
  merge_into_name: string | null = null,
): UserNameAlias {
  return {
    id: 1,
    connection_id: 1,
    journal_name,
    op_user_id,
    merge_into_name,
    created_at: "2026-07-15T00:00:00Z",
  };
}

describe("identityResolver (SPEC_13 §1a, revised)", () => {
  it("resolves an exact membership name; never fuzzy-maps the Belka/Bily pair", async () => {
    const r = await createIdentityResolver(fakeOpWithMemberships(MEMBERS), [], {
      projectOpIds: [100],
    });
    expect(r.resolve("Cameron Dalby")).toEqual({
      op_user_id: 7,
      resolution: "exact",
      canonical_name: null,
    });
    // "Jan Belka" is NOT "Jan Bily" — unresolved, never substituted, but that
    // is NON-blocking (the caller still gives it a line).
    expect(r.resolve("Jan Belka")).toEqual({
      op_user_id: null,
      resolution: "unresolved",
      canonical_name: null,
    });
  });

  it("enriches identity from a work package's assignee link (no memberships needed)", async () => {
    const r = await createIdentityResolver(null, [], {
      workPackages: [wpWithAssignee(11, 3, "John Arden")],
    });
    expect(r.resolve("John Arden")).toEqual({
      op_user_id: 3,
      resolution: "exact",
      canonical_name: null,
    });
  });

  it("falls back to an alias only when the index has no exact match", async () => {
    const r = await createIdentityResolver(fakeOpWithMemberships(MEMBERS), [alias("Jan Belka", 5)], {
      projectOpIds: [100],
    });
    expect(r.resolve("Jan Belka")).toEqual({
      op_user_id: 5,
      resolution: "alias",
      canonical_name: null,
    });
    // Exact still wins over an alias for the same name.
    const r2 = await createIdentityResolver(
      fakeOpWithMemberships(MEMBERS),
      [alias("Cameron Dalby", 999)],
      { projectOpIds: [100] },
    );
    expect(r2.resolve("Cameron Dalby")).toEqual({
      op_user_id: 7,
      resolution: "exact",
      canonical_name: null,
    });
  });

  it("a merge_into_name alias whose canonical name resolves chains to that id", async () => {
    // "Jan Belka" (old journal name) folds under "Jan Bily", who IS in the index.
    const r = await createIdentityResolver(
      fakeOpWithMemberships(MEMBERS),
      [alias("Jan Belka", null, "Jan Bily")],
      { projectOpIds: [100] },
    );
    expect(r.resolve("Jan Belka")).toEqual({
      op_user_id: 5,
      resolution: "alias",
      canonical_name: null,
    });
  });

  it("a merge_into_name alias with no resolvable canonical folds under the name", async () => {
    // Canonical name has no id anywhere → fold this name's hours under it.
    const r = await createIdentityResolver(null, [alias("Jan Belka", null, "Jan B.")]);
    expect(r.resolve("Jan Belka")).toEqual({
      op_user_id: null,
      resolution: "alias",
      canonical_name: "Jan B.",
    });
  });

  it("a null/empty name resolves to null (no name to resolve)", async () => {
    const r = await createIdentityResolver(fakeOpWithMemberships(MEMBERS), [], {
      projectOpIds: [100],
    });
    expect(r.resolve(null)).toEqual({ op_user_id: null, resolution: null, canonical_name: null });
    expect(r.resolve("")).toEqual({ op_user_id: null, resolution: null, canonical_name: null });
  });

  it("with no OP client, aliases still resolve offline; unknown names are unresolved", async () => {
    const r = await createIdentityResolver(null, [alias("Jan Belka", 5)]);
    expect(r.resolve("Jan Belka")).toEqual({
      op_user_id: 5,
      resolution: "alias",
      canonical_name: null,
    });
    expect(r.resolve("Cameron Dalby")).toEqual({
      op_user_id: null,
      resolution: "unresolved",
      canonical_name: null,
    });
  });
});
