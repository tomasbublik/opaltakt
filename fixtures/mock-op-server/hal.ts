import type {
  EngineJournal,
  EngineJournalDetail,
  EngineTimeEntry,
  EngineWorkPackage,
  ScenarioView,
} from "./engine";

/**
 * HAL (OpenProject API v3) serialization of the scenario state + the shared
 * filter/sort/pagination helpers. Shapes mirror fixtures/data/*.json in the
 * exact fields the app reads (packages/sync toWorkPackageCacheRow +
 * aggregateTimeEntries, packages/op-client parseIsoDuration/parseOpId).
 */

// ── Durations ────────────────────────────────────────────────────────────────

/**
 * Hours → ISO-8601 duration. Sub-24h stays "PT{h}H{m}M" (7.5 → "PT7H30M",
 * 0.75 → "PT45M"). Values ≥24h emit a day component the way real OpenProject
 * does (Increment 22): 29 → "P1DT5H", 24 → "P1D", 51.5 → "P2DT3H30M", 80 →
 * "P3DT8H" — confirmed against the real prod GET /work_packages/11592 response
 * (remainingTime "P1DT5H" for a 29h value). The `D` component is emitted ONLY
 * when nonzero, so every sub-24h fixture value serializes byte-for-byte as
 * before. Round-trips through @osp/op-client's parseIsoDuration. null stays null.
 */
export function hoursToIsoDuration(hours: number | null | undefined): string | null {
  if (hours === null || hours === undefined) return null;
  const totalMinutes = Math.round(hours * 60);
  const days = Math.floor(totalMinutes / (24 * 60));
  const rem = totalMinutes - days * 24 * 60;
  const h = Math.floor(rem / 60);
  const m = rem % 60;
  if (days === 0) {
    if (m === 0) return `PT${h}H`;
    if (h === 0) return `PT${m}M`;
    return `PT${h}H${m}M`;
  }
  let out = `P${days}D`;
  if (h !== 0 || m !== 0) {
    out += "T";
    if (h !== 0) out += `${h}H`;
    if (m !== 0) out += `${m}M`;
  }
  return out;
}

// ── Filters (OpenProject `filters` JSON query param) ─────────────────────────

export interface FilterClause {
  field: string;
  operator: string;
  values: string[];
}

/**
 * Parse the `filters` param — a JSON array of single-key clauses like
 * `{"project":{"operator":"=","values":["3"]}}`. Lenient like the legacy
 * fixture path: malformed input behaves as unfiltered.
 */
export function parseFiltersParam(param: string | null): FilterClause[] {
  if (param === null || param === "") return [];
  try {
    const raw = JSON.parse(param) as unknown;
    if (!Array.isArray(raw)) return [];
    const out: FilterClause[] = [];
    for (const clause of raw) {
      if (clause === null || typeof clause !== "object") continue;
      for (const [field, spec] of Object.entries(clause as Record<string, unknown>)) {
        const s = spec as { operator?: unknown; values?: unknown } | null;
        out.push({
          field,
          operator: typeof s?.operator === "string" ? s.operator : "=",
          values: Array.isArray(s?.values) ? s.values.map(String) : [],
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Work-package predicate for scenario mode. Honors project/version/id "=",
 * status "=" (accepts status ID and NAME), assignee "=", updatedAt ">=d"
 * (ISO string comparison — engine stamps are lexicographically ordered).
 * Unknown filter fields are ignored (lenient, like real-OP defaults we rely on).
 */
export function workPackageMatches(
  wp: EngineWorkPackage,
  clauses: FilterClause[],
  view: ScenarioView,
): boolean {
  for (const c of clauses) {
    switch (c.field) {
      case "project":
        if (!c.values.includes(String(wp.projectId))) return false;
        break;
      case "version":
        if (!c.values.includes(String(wp.versionId))) return false;
        break;
      case "id":
        if (!c.values.includes(String(wp.id))) return false;
        break;
      case "status": {
        const status = view.statuses.find((s) => s.id === wp.statusId);
        const ok = c.values.some(
          (v) =>
            v === String(wp.statusId) ||
            (status !== undefined && v.toLowerCase() === status.name.toLowerCase()),
        );
        if (!ok) return false;
        break;
      }
      case "assignee": {
        const user =
          wp.assigneeId === null ? undefined : view.users.find((u) => u.id === wp.assigneeId);
        const ok = c.values.some(
          (v) =>
            (wp.assigneeId !== null && v === String(wp.assigneeId)) ||
            (user !== undefined && v.toLowerCase() === user.name.toLowerCase()),
        );
        if (!ok) return false;
        break;
      }
      case "updatedAt": {
        // The sync engine sends { updatedAt: { operator: ">=d", values: [iso] } }.
        const since = c.values[0];
        if (since !== undefined && !(wp.updatedAt >= since)) return false;
        break;
      }
      default:
        break;
    }
  }
  return true;
}

/**
 * Filter fields real OpenProject's time_entries endpoint actually supports
 * (SPEC_07 §3): entity_type, entity_id, project_id, user_id, ongoing,
 * spent_on, created_at, updated_at, activity_id. `workPackage`/`work_package`
 * is a DEPRECATED attribute real OP 400s on ("InvalidQuery") — the mock must
 * reject it too (see `timeEntriesFilterError` below), not silently accept it,
 * or tests would never catch a caller still sending it.
 */
const UNSUPPORTED_TIME_ENTRIES_FIELDS = new Set(["workPackage", "work_package"]);

/** Real-OP-shaped 400 body for an unsupported time_entries filter, or null if
 * every clause uses a supported field. Checked by the route BEFORE filtering. */
export function timeEntriesFilterError(clauses: FilterClause[]): {
  _type: "Error";
  errorIdentifier: string;
  message: string;
} | null {
  const bad = clauses.find((c) => UNSUPPORTED_TIME_ENTRIES_FIELDS.has(c.field));
  if (bad === undefined) return null;
  return {
    _type: "Error",
    errorIdentifier: "urn:openproject-org:api:v3:errors:InvalidQuery",
    message: `Filters ${bad.field === "workPackage" ? "Work package" : "work_package"} filter does not exist.`,
  };
}

/**
 * Time-entry predicate: entity_type/entity_id "=" (WorkPackage + wp id, the
 * supported replacement for the deprecated workPackage filter — see
 * `timeEntriesFilterError`), project_id "=", spentOn "="/"=d" (exact date) or
 * ">=d" (Increment 4: "time entries since sprint activation" — date-string
 * comparison, spentOn is YYYY-MM-DD so lexicographic order == chronological
 * order), user_id "=".
 */
export function timeEntryMatches(
  te: EngineTimeEntry,
  clauses: FilterClause[],
  view: ScenarioView,
): boolean {
  for (const c of clauses) {
    switch (c.field) {
      case "entity_type":
        // Only WorkPackage entries exist in this mock — any other value (or
        // none at all matching) is a real-OP-shaped "no match".
        if (!c.values.some((v) => v.toLowerCase() === "workpackage")) return false;
        break;
      case "entity_id":
        if (!c.values.includes(String(te.wpId))) return false;
        break;
      case "project_id": {
        const wp = view.workPackages.find((w) => w.id === te.wpId);
        if (wp === undefined || !c.values.includes(String(wp.projectId))) return false;
        break;
      }
      case "spentOn": {
        if (c.operator === ">=d") {
          const since = c.values[0];
          if (since !== undefined && !(te.spentOn >= since)) return false;
        } else {
          // "=" and "=d" both mean single-date equality here.
          if (!c.values.includes(te.spentOn)) return false;
        }
        break;
      }
      case "user_id":
        if (!c.values.includes(String(te.userId))) return false;
        break;
      default:
        break;
    }
  }
  return true;
}

// ── Sorting ──────────────────────────────────────────────────────────────────

export interface SortSpec {
  field: "id" | "updatedAt";
  dir: 1 | -1;
}

/** Parse `sortBy` (JSON [["id"|"updatedAt","asc"|"desc"]]); default id asc. */
export function parseSortBy(param: string | null): SortSpec {
  const fallback: SortSpec = { field: "id", dir: 1 };
  if (param === null || param === "") return fallback;
  try {
    const raw = JSON.parse(param) as unknown;
    if (!Array.isArray(raw) || !Array.isArray(raw[0])) return fallback;
    const [field, dir] = raw[0] as [unknown, unknown];
    return {
      field: field === "updatedAt" ? "updatedAt" : "id",
      dir: dir === "desc" ? -1 : 1,
    };
  } catch {
    return fallback;
  }
}

export function sortWorkPackages(
  wps: EngineWorkPackage[],
  sort: SortSpec,
): EngineWorkPackage[] {
  return [...wps].sort((a, b) => {
    if (sort.field === "updatedAt" && a.updatedAt !== b.updatedAt) {
      return a.updatedAt < b.updatedAt ? -sort.dir : sort.dir;
    }
    return (a.id - b.id) * sort.dir;
  });
}

// ── Pagination (same envelope + link style as the legacy fixture path) ───────

export interface HalCollectionLike {
  _type: string;
  total: number;
  count: number;
  pageSize: number;
  offset: number;
  _embedded: { elements: unknown[] };
  _links: Record<string, unknown>;
}

/** Build one collection page with nextByOffset/previousByOffset links. */
export function paginateCollection(args: {
  type: string;
  path: string;
  source: unknown[];
  offset: number;
  pageSize: number;
}): HalCollectionLike {
  const { type, path, source, offset, pageSize } = args;
  const total = source.length;
  const startIdx = (offset - 1) * pageSize;
  const elements = source.slice(startIdx, startIdx + pageSize);
  const links: Record<string, unknown> = {
    self: { href: `${path}?offset=${offset}&pageSize=${pageSize}` },
  };
  if (startIdx + pageSize < total) {
    links["nextByOffset"] = { href: `${path}?offset=${offset + 1}&pageSize=${pageSize}` };
  }
  if (offset > 1) {
    links["previousByOffset"] = { href: `${path}?offset=${offset - 1}&pageSize=${pageSize}` };
  }
  return {
    _type: type,
    total,
    count: elements.length,
    pageSize,
    offset,
    _embedded: { elements },
    _links: links,
  };
}

/** Simple unpaginated collection envelope (statuses, users, versions…). */
export function collection(path: string, elements: unknown[]): unknown {
  return {
    _type: "Collection",
    total: elements.length,
    count: elements.length,
    pageSize: 30,
    offset: 1,
    _embedded: { elements },
    _links: { self: { href: path } },
  };
}

// ── Element serialization ────────────────────────────────────────────────────

// Stable display-name → id maps for links whose TITLE is what the app reads.
const TYPE_IDS: Record<string, number> = {
  Task: 1,
  Milestone: 2,
  Phase: 3,
  Feature: 4,
  Epic: 5,
  "User story": 6,
  Bug: 7,
};
const PRIORITY_IDS: Record<string, number> = {
  Low: 7,
  Normal: 8,
  High: 9,
  Immediate: 10,
};

function userLink(view: ScenarioView, userId: number | null): unknown {
  if (userId === null) return { href: null };
  const user = view.users.find((u) => u.id === userId);
  return { href: `/api/v3/users/${userId}`, title: user?.name ?? `User ${userId}` };
}

/** Scenario WP → OP v3 HAL element (exactly the fields the app reads). */
export function workPackageToHal(wp: EngineWorkPackage, view: ScenarioView): unknown {
  const status = view.statuses.find((s) => s.id === wp.statusId);
  const project = view.projects.find((p) => p.id === wp.projectId);
  const version = wp.versionId === null ? undefined : view.versions.find((v) => v.id === wp.versionId);
  const parent = wp.parentId === null ? undefined : view.workPackages.find((w) => w.id === wp.parentId);
  return {
    _type: "WorkPackage",
    id: wp.id,
    subject: wp.subject,
    estimatedTime: hoursToIsoDuration(wp.estimatedHours),
    remainingTime: hoursToIsoDuration(wp.remainingHours),
    // ALWAYS null in scenario mode — forces the app's time-entry fallback
    // (the realistic no-permission OP path, frozen contract).
    spentTime: null,
    storyPoints: wp.storyPoints,
    percentageDone: wp.percentageDone,
    createdAt: wp.createdAt,
    updatedAt: wp.updatedAt,
    _links: {
      self: { href: `/api/v3/work_packages/${wp.id}`, title: wp.subject },
      status: { href: `/api/v3/statuses/${wp.statusId}`, title: status?.name ?? "" },
      type: {
        href: `/api/v3/types/${TYPE_IDS[wp.typeName] ?? 1}`,
        title: wp.typeName,
      },
      project: {
        href: `/api/v3/projects/${wp.projectId}`,
        title: project?.name ?? `Project ${wp.projectId}`,
      },
      assignee: userLink(view, wp.assigneeId),
      // accountable is a SEPARATE link from assignee (SPEC_03 §2a).
      accountable: userLink(view, wp.accountableId),
      version:
        version === undefined
          ? { href: null }
          : { href: `/api/v3/versions/${version.id}`, title: version.name },
      priority: {
        href: `/api/v3/priorities/${PRIORITY_IDS[wp.priority] ?? 8}`,
        title: wp.priority,
      },
      parent:
        parent === undefined
          ? { href: null }
          : { href: `/api/v3/work_packages/${parent.id}`, title: parent.subject },
    },
  };
}

/** Scenario time entry → OP v3 HAL element. */
export function timeEntryToHal(te: EngineTimeEntry, view: ScenarioView): unknown {
  const wp = view.workPackages.find((w) => w.id === te.wpId);
  const user = view.users.find((u) => u.id === te.userId);
  const project = wp === undefined ? undefined : view.projects.find((p) => p.id === wp.projectId);
  return {
    _type: "TimeEntry",
    id: te.id,
    hours: hoursToIsoDuration(te.hours),
    spentOn: te.spentOn,
    createdAt: te.createdAt,
    _links: {
      self: { href: `/api/v3/time_entries/${te.id}` },
      workPackage: {
        href: `/api/v3/work_packages/${te.wpId}`,
        title: wp?.subject ?? `Work package ${te.wpId}`,
      },
      user: { href: `/api/v3/users/${te.userId}`, title: user?.name ?? `User ${te.userId}` },
      project:
        wp === undefined
          ? { href: null }
          : {
              href: `/api/v3/projects/${wp.projectId}`,
              title: project?.name ?? `Project ${wp.projectId}`,
            },
    },
  };
}

/**
 * Hours → OP effort LABEL ("12h", 1.3 → "1.3h"). This is what real OP renders
 * in activity `details` text (NOT an ISO-8601 duration); round-trips through
 * @osp/op-client's parseHoursLabel. null stays null.
 */
export function hoursToLabel(hours: number | null | undefined): string | null {
  if (hours === null || hours === undefined) return null;
  return `${hours}h`;
}

/** Minimal HTML escaping for values embedded in the `html` rendering. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** OP display name for each engine journal property (as it appears in <strong>). */
const JOURNAL_FIELD_LABEL: Record<EngineJournalDetail["property"], string> = {
  status: "Status",
  assignee: "Assignee",
  accountable: "Accountable",
  estimatedTime: "Work",
  remainingTime: "Remaining work",
  version: "Version",
};

/** One journal detail's old/new value → its display TEXT (or null when empty). */
function journalValueText(
  property: EngineJournalDetail["property"],
  value: EngineJournalDetail["oldValue"],
): string | null {
  if (property === "estimatedTime" || property === "remainingTime") {
    return hoursToLabel(value as number | null);
  }
  if (value === null) return null;
  return (value as { id: number; name: string }).name;
}

/**
 * One engine journal detail → the REAL OP `{format, raw, html}` shape
 * (SPEC_11 §5) — formatted TEXT, NOT `{property, old, new}`. The field name
 * lives in `<strong>…</strong>`, the value(s) in `<i>…</i>`, so the op-client
 * parser produces IDENTICAL results whether fed this mock or the production
 * fixture.
 */
function journalDetailToHal(detail: EngineJournalDetail): {
  format: string;
  raw: string;
  html: string;
} {
  const field = JOURNAL_FIELD_LABEL[detail.property];
  const from = journalValueText(detail.property, detail.oldValue);
  const to = journalValueText(detail.property, detail.newValue);
  let raw: string;
  let html: string;
  if (from !== null && to !== null) {
    raw = `${field} changed from ${from} to ${to}`;
    html = `<strong>${escapeHtml(field)}</strong> changed from <i>${escapeHtml(from)}</i> to <i>${escapeHtml(to)}</i>`;
  } else if (to !== null) {
    raw = `${field} set to ${to}`;
    html = `<strong>${escapeHtml(field)}</strong> set to <i>${escapeHtml(to)}</i>`;
  } else {
    raw = `${field} deleted`;
    html = `<strong>${escapeHtml(field)}</strong> deleted`;
  }
  return { format: "custom", raw, html };
}

/** Scenario journal → OP v3 Activity HAL element (SPEC_04 §3, SPEC_11 §5). */
export function activityToHal(journal: EngineJournal, view: ScenarioView): unknown {
  const wp = view.workPackages.find((w) => w.id === journal.wpId);
  // A pure-comment journal (SPEC_10 §d) has NO field change: empty `details`,
  // the text in `comment`. A field-change journal is the mirror image. Real OP
  // types the latter "Activity::Comment" (SPEC_11 §5 p3).
  const details = journal.detail === null ? [] : [journalDetailToHal(journal.detail)];
  return {
    _type: journal.comment === null ? "Activity" : "Activity::Comment",
    id: journal.id,
    createdAt: journal.createdAt,
    details,
    // Real OP always supplies a comment object (empty raw on field-change
    // activities); mirror that so `comment.raw` is always safe to read.
    comment:
      journal.comment === null
        ? { format: "markdown", raw: "", html: "" }
        : { format: "markdown", raw: journal.comment, html: `<p>${escapeHtml(journal.comment)}</p>` },
    _links: {
      self: { href: `/api/v3/activities/${journal.id}` },
      workPackage: {
        href: `/api/v3/work_packages/${journal.wpId}`,
        title: wp?.subject ?? `Work package ${journal.wpId}`,
      },
      // SPEC_11 §5 p2 / §4: real OP OMITS `title` here — only the href/id. The
      // name must be resolved via GET /api/v3/users/:id.
      user: journal.actorId === null ? { href: null } : { href: `/api/v3/users/${journal.actorId}` },
    },
  };
}

export function userToHal(user: { id: number; name: string; login: string | null }): unknown {
  return {
    _type: "User",
    id: user.id,
    name: user.name,
    ...(user.login === null ? {} : { login: user.login }),
    status: "active",
    _links: { self: { href: `/api/v3/users/${user.id}`, title: user.name } },
  };
}

export function statusToHal(status: { id: number; name: string; isClosed: boolean }): unknown {
  return { _type: "Status", id: status.id, name: status.name, isClosed: status.isClosed };
}

/**
 * A project membership (SPEC_13 §1a) — the non-admin identity source. Only
 * `_links.principal` (title = user name, href = the user's id) is load-bearing;
 * `project` echoes which project the membership belongs to. `membershipId` is a
 * synthetic-but-stable id distinct from the user's id (real OP memberships have
 * their own ids). `projectId` may be null (unfiltered/global-style request).
 */
export function membershipToHal(
  membershipId: number,
  user: { id: number; name: string },
  projectId: number | null,
  view: ScenarioView,
): unknown {
  const project = projectId === null ? undefined : view.projects.find((p) => p.id === projectId);
  return {
    _type: "Membership",
    id: membershipId,
    _links: {
      self: { href: `/api/v3/memberships/${membershipId}` },
      principal: { href: `/api/v3/users/${user.id}`, title: user.name },
      project:
        projectId === null
          ? { href: null }
          : {
              href: `/api/v3/projects/${projectId}`,
              title: project?.name ?? `Project ${projectId}`,
            },
    },
  };
}

export function projectToHal(project: { id: number; identifier: string; name: string }): unknown {
  return {
    _type: "Project",
    id: project.id,
    identifier: project.identifier,
    name: project.name,
    active: true,
    _links: { self: { href: `/api/v3/projects/${project.id}`, title: project.name } },
  };
}

export function versionToHal(
  version: { id: number; name: string; projectId: number },
  view: ScenarioView,
): unknown {
  const project = view.projects.find((p) => p.id === version.projectId);
  return {
    _type: "Version",
    id: version.id,
    name: version.name,
    status: "open",
    _links: {
      self: { href: `/api/v3/versions/${version.id}`, title: version.name },
      definingProject: {
        href: `/api/v3/projects/${version.projectId}`,
        title: project?.name ?? `Project ${version.projectId}`,
      },
    },
  };
}
