/**
 * Faithful TypeScript representations of the OpenProject API v3 (HAL+JSON)
 * responses the sync engine consumes (SPEC §5). All READ-only.
 *
 * Durations (estimatedTime, remainingTime, spentTime, hours) are ISO-8601
 * duration strings, e.g. "PT8H", "P1DT4H", or null. Agent A parses them to hours.
 */

/** A HAL link object. */
export interface HalLink {
  href: string | null;
  title?: string;
  /** Present on templated links (e.g. some collection navigation). */
  templated?: boolean;
  method?: string;
}

/** A HAL collection envelope (`_type: "Collection"`), used by list endpoints. */
export interface HalCollection<T> {
  _type: "Collection" | "WorkPackageCollection";
  total: number;
  count: number;
  pageSize: number;
  offset: number;
  _embedded: {
    elements: T[];
  };
  _links: {
    self: HalLink;
    jumpTo?: HalLink;
    changeSize?: HalLink;
    /** Present when more pages exist; drives the pagination loop. */
    nextByOffset?: HalLink;
    previousByOffset?: HalLink;
  };
}

// ── /api/v3/users/me & user references ───────────────────────────────────────
export interface OpUser {
  _type: "User";
  id: number;
  name: string;
  login?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  status?: string;
  _links?: {
    self?: HalLink;
  };
}

// ── /api/v3/memberships (SPEC_13 §1a) ────────────────────────────────────────
// The project's member roster — readable by ANY token that can see the project
// (unlike the admin-gated `GET /api/v3/users` collection), so it's a valid
// non-admin source for (name → id) identity enrichment. Only `_links.principal`
// (the member — `title` = display name, `href` = /api/v3/users/:id) is load-
// bearing here; a principal can also be a group/placeholder in real OP, but this
// app only consumes user principals. `project` is present when the membership is
// project-scoped (the common case; global roles have none).
export interface OpMembership {
  _type: "Membership";
  id: number;
  _links: {
    self?: HalLink;
    /** The member: user (or group/placeholder) — title = name, href = its id. */
    principal: HalLink;
    /** The project this membership grants access to (absent for global roles). */
    project?: HalLink;
    /** Assigned role(s); not consumed by identity resolution. */
    roles?: HalLink | HalLink[];
  };
}

// ── /api/v3/projects ─────────────────────────────────────────────────────────
export interface OpProject {
  _type: "Project";
  id: number;
  identifier: string;
  name: string;
  active?: boolean;
  _links?: {
    self?: HalLink;
    parent?: HalLink;
  };
}

// ── /api/v3/work_packages ────────────────────────────────────────────────────
export interface OpWorkPackage {
  _type: "WorkPackage";
  id: number;
  subject: string;
  /** ISO-8601 duration or null. Core, read (SPEC §5). */
  estimatedTime: string | null;
  /** ISO-8601 duration or null. Read directly — do NOT derive (SPEC §5). */
  remainingTime: string | null;
  /** Rollup over children — beware double counting (SPEC §6). */
  derivedEstimatedTime?: string | null;
  derivedRemainingTime?: string | null;
  /** Requires "view time entries" permission; may be null → use Time Entries API. */
  spentTime?: string | null;
  /** Only with Backlogs module active; else undefined/null (SPEC §5). */
  storyPoints?: number | null;
  /** Backlog rank; only with Backlogs module; may be null (SPEC §5). */
  position?: number | null;
  percentageDone?: number | null;
  createdAt?: string;
  updatedAt: string;
  /** Custom fields surface as customFieldN; resolve names via schema. */
  [customField: `customField${number}`]: unknown;
  _links: {
    self: HalLink;
    status: HalLink;
    type: HalLink;
    project: HalLink;
    assignee?: HalLink;
    /** Separate from assignee (SPEC_03 §2a / SPEC_04 §1) — "who signs off", not "who works it". */
    accountable?: HalLink;
    responsible?: HalLink;
    version?: HalLink;
    priority?: HalLink;
    parent?: HalLink;
  };
}

// ── /api/v3/time_entries ─────────────────────────────────────────────────────
export interface OpTimeEntry {
  _type: "TimeEntry";
  id: number;
  /** ISO-8601 duration, e.g. "PT2H". */
  hours: string;
  /** Date the time was spent, "YYYY-MM-DD". */
  spentOn: string;
  comment?: { format?: string; raw?: string | null; html?: string };
  createdAt?: string;
  updatedAt?: string;
  _links: {
    self: HalLink;
    workPackage: HalLink;
    user: HalLink;
    project?: HalLink;
    activity?: HalLink;
  };
}

// ── /api/v3/versions ─────────────────────────────────────────────────────────
export interface OpVersion {
  _type: "Version";
  id: number;
  name: string;
  status?: string; // open | locked | closed
  description?: { format?: string; raw?: string | null; html?: string };
  _links: {
    self: HalLink;
    project?: HalLink;
    definingProject?: HalLink;
  };
}

// ── /api/v3/statuses ─────────────────────────────────────────────────────────
export interface OpStatus {
  _type: "Status";
  id: number;
  name: string;
  isClosed: boolean;
  color?: string;
  position?: number;
  defaultDoneRatio?: number | null;
  _links?: {
    self?: HalLink;
  };
}

// ── /api/v3/work_packages/:id/activities (SPEC_04 §3, SPEC_11 §5) ─────────────
// REAL SHAPE (confirmed against fixture_op_activities_11762 from production):
// `details` is an array of FORMATTED TEXT strings, NOT structured field diffs.
// There is NO `property`/`old`/`new`. Each entry carries the SAME change in
// three renderings; the parser reads `html` (field name lives in <strong>…,
// value(s) in <i>…) and falls back to `raw`. Example:
//   { "format": "custom",
//     "raw":  "Status changed from developed to tested",
//     "html": "<strong>Status</strong> changed from <i>developed</i> to <i>tested</i>" }
// See packages/op-client/src/journal.ts (deriveDetailEvents) for the parser.
export interface OpActivityDetail {
  /** OP's renderer tag, e.g. "custom" — not consumed by the parser. */
  format: string;
  /** Plain-text rendering, e.g. "Status changed from developed to tested". */
  raw: string;
  /** HTML rendering, e.g. "<strong>Status</strong> changed from <i>developed</i> to <i>tested</i>". */
  html: string;
}

export interface OpActivity {
  // Field-change journals are "Activity"; ones carrying a comment (possibly
  // WITH field changes too) are "Activity::Comment" — SPEC_11 §5 point 3.
  _type: "Activity" | "Activity::Comment";
  id: number;
  createdAt: string;
  /** Field-level changes in this activity; empty for a pure comment. */
  details: OpActivityDetail[];
  /**
   * Comment body. Real OP always supplies this object (empty `raw:""` for a
   * pure field-change activity); older mock shapes used `null`. The parser
   * treats a null/blank `raw` as "no comment".
   */
  comment: { format?: string; raw: string; html?: string } | null;
  _links: {
    self: HalLink;
    workPackage: HalLink;
    /** {href:null} when OP can't attribute an actor. Real OP OMITS `title`
     * here — the actor name must be resolved via GET /api/v3/users/:id. */
    user: HalLink;
  };
}

// ── /api/v3/work_packages/schema ─────────────────────────────────────────────
export interface OpSchemaProperty {
  type: string;
  name: string;
  required?: boolean;
  hasDefault?: boolean;
  writable?: boolean;
  /** For list custom fields: link to allowed values. */
  _links?: { allowedValues?: HalLink | HalLink[] };
}

export interface OpWorkPackageSchema {
  _type: "Schema";
  /** Keyed by property id, incl. customFieldN — resolve estimate/effort field. */
  [property: string]: OpSchemaProperty | string | undefined;
}
