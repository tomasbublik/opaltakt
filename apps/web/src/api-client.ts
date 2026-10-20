import type {
  ActivateSprintResponse,
  AddConnectionBody,
  AddConnectionResponse,
  AddSprintItemBody,
  AddSprintItemByIdBody,
  AddSprintItemByIdResponse,
  AppConfigResponse,
  AuthLogoutResponse,
  AuthMeResponse,
  VersionResponse,
  BacklogFilterOptionsQuery,
  BacklogFilterOptionsResponse,
  BacklogQuery,
  BacklogResponse,
  BurndownResponse,
  CapacityResponse,
  OffSprintTimeResponse,
  ClosureReportResponse,
  ClosureStatsResponse,
  Connection,
  ConnectionsHealthResponse,
  ConnectionsResponse,
  CreateEstimateOverrideBody,
  CreateSprintBody,
  DeleteConnectionResponse,
  DeleteSprintResponse,
  DeleteOutOfSelectionResponse,
  DoneRulesResponse,
  DoubleCountFixResponse,
  FinishSprintBody,
  ImportsResponse,
  ImportWorkPackageResponse,
  OutOfSelectionResponse,
  VersionsResponse,
  EstimateOverrideResponse,
  ErrorResponse,
  PeopleResponse,
  PersonSummary,
  ProjectsResponse,
  ReactivateSprintBody,
  ReactivateSprintResponse,
  RebuildBurndownResponse,
  RemoveFromBacklogResponse,
  RemoveImportResponse,
  ReportDetailResponse,
  ReportsListResponse,
  RetroPreviewResponse,
  RetroSeedBody,
  RetroSeedResponse,
  SetCapacityBody,
  SetPersonRoleBody,
  SprintItemResponse,
  SprintItemsResponse,
  SprintItemsDetailedResponse,
  SprintResponse,
  SprintsResponse,
  SprintUpdateRunResponse,
  SprintUpdateRunsResponse,
  SyncRefreshAllResponse,
  SyncRun,
  SyncStatusResponse,
  TicketChangelogResponse,
  TriggerSyncBody,
  UpdateAppConfigBody,
  UpdateConnectionBody,
  UpdateDoneRulesBody,
  UpdateSprintBody,
  UpdateSprintRunBody,
  CancelSyncResponse,
  CapacityAuditResponse,
  CarrySprintItemBody,
  CarrySprintItemResponse,
  CreateUserAliasBody,
  SprintPeopleResponse,
  UserAliasResponse,
  VaultChangePassphraseBody,
  VaultInitBody,
  VaultResetBody,
  VaultResetResponse,
  VaultStatusResponse,
  VaultUnlockBody,
  VelocityResponse,
  VersionExportResponse,
} from "@osp/contracts";

/**
 * Typed API client derived from @osp/contracts (SPEC §7, SPEC_02 §5).
 * Agent C uses these methods; only the backend base URL is configurable.
 * Frontend NEVER talks to OpenProject directly, and tokens only ever flow
 * frontend → backend inside add/update connection bodies (SPEC §2, SPEC_02 §3).
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ErrorResponse | undefined,
  ) {
    super(body?.error.message ?? `HTTP ${status}`);
    this.name = "ApiError";
  }
}

/**
 * Increment 23 (SPEC_23 §1) — discriminates `POST /api/sync`'s two possible
 * response shapes: a plain `SyncRun` (single-project sync, `project_op_id`
 * given — unchanged) vs. `SyncRefreshAllResponse` (refresh-all, no
 * `project_op_id` — one entry per connection, none of them fatal to the
 * others). `SyncRun` never has a `connections` field, so its presence is a
 * safe, structural discriminant — never assume the shape from the request
 * alone.
 */
export function isSyncRefreshAllResponse(
  x: SyncRun | SyncRefreshAllResponse,
): x is SyncRefreshAllResponse {
  return "connections" in x;
}

const BASE = "/api";

/**
 * Increment 39 (§6) — central auth/role reactions. App registers these once;
 * `req()` calls them so a 401 UNAUTHENTICATED from ANY call sends the app to
 * the sign-in state (no crash), and a 403 FORBIDDEN_ROLE surfaces as a calm
 * inline notice. The backend is the enforcement; this is feedback only.
 */
type AuthHandlers = {
  onUnauthenticated?: () => void;
  onForbidden?: (message: string) => void;
};
let authHandlers: AuthHandlers = {};
export function setAuthHandlers(h: AuthHandlers): void {
  authHandlers = h;
}

function reactToAuthError(status: number, body: ErrorResponse | undefined): void {
  const code = body?.error.code;
  if (status === 401 && code === "UNAUTHENTICATED") authHandlers.onUnauthenticated?.();
  else if (status === 403 && code === "FORBIDDEN_ROLE") {
    authHandlers.onForbidden?.(body?.error.message ?? "This action requires the Planner role");
  } else if (status === 403 && code === "NO_ROLE") authHandlers.onUnauthenticated?.();
}

async function req<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    reactToAuthError(res.status, json as ErrorResponse | undefined);
    throw new ApiError(res.status, json as ErrorResponse | undefined);
  }
  return json as T;
}

/** Same reaction for the raw-fetch download helpers below. */
function notifyAuthFailure(status: number, body: unknown): void {
  reactToAuthError(status, body as ErrorResponse | undefined);
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return "";
  const usp = new URLSearchParams();
  for (const [k, v] of entries) usp.set(k, String(v));
  return `?${usp.toString()}`;
}

/**
 * Increment 27 (§6): the local→file JSON export/import envelope. Deliberately
 * kept minimal and untyped-at-the-row-level here — `tables` is a bag of
 * arbitrary per-table row arrays whose shape is owned by the backend/DB
 * schema (`packages/db`), not something the frontend needs to model field by
 * field. Only the envelope-level fields the UI actually reads/displays are
 * named.
 */
export interface DataExportEnvelope {
  schema_version: number;
  exported_at: string;
  source: { app: string; increment: number };
  includes_credentials: boolean;
  tables: Record<string, unknown[]>;
}

/**
 * Increment 27: the frozen schema version this build knows how to read/write
 * (contract §6 — "schema_version: 1"). Exposed so DataScreen can reject an
 * incompatible file client-side, before ever uploading it.
 */
export const DATA_EXPORT_SCHEMA_VERSION = 1;

/**
 * Increment 27: best-effort summary of what `POST /api/data/import` actually
 * did, for the post-import confirmation screen. The exact response shape
 * isn't nailed down by the frozen contract (§6 specifies the file format,
 * not the import route's response body) — every field here is optional and
 * defensively read, so the UI degrades to a generic "Import complete"
 * message if the backend returns something narrower (or wider) than this.
 */
export interface DataImportResult {
  /** Per-table row counts actually written, if the backend reports them. */
  tables?: Record<string, number>;
  imported_at?: string;
}

/**
 * Increment 27 (§6): request body for POST /api/data/import. The uploaded
 * file's parsed JSON, exactly as exported — plus an optional `passphrase`
 * layered on top for the one case the contract calls out explicitly
 * ("the credentialed [export] ... requires the passphrase at import time",
 * §6 "Credentials"). ASSUMPTION (not nailed down by the frozen contract,
 * flagged for reconciliation with Agent C's route): the passphrase travels
 * as a sibling field on the same uploaded-envelope object, not a separate
 * request. If the backend route expects a different shape (e.g. multipart,
 * or the passphrase in a header), `apps/web/src/components/DataScreen.tsx`
 * and this function are the only places that need to change.
 */
export type DataImportRequest = DataExportEnvelope & { passphrase?: string };

/**
 * Increment 27 (§6): GET /api/data/export?include_credentials=0|1 streams a
 * raw `application/json` file download (Content-Disposition: attachment),
 * mirroring `downloadReportPdf` below — not the app's usual parsed-JSON
 * envelope, so it bypasses `req()`. Filename prefers the server's
 * Content-Disposition header; falls back to a local timestamped name so a
 * download is never unnamed even if a proxy strips the header.
 */
async function downloadDataExport(includeCredentials: boolean): Promise<void> {
  const res = await fetch(`${BASE}/data/export?include_credentials=${includeCredentials ? 1 : 0}`, {
    method: "GET",
  });
  if (!res.ok) {
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    notifyAuthFailure(res.status, json);
    throw new ApiError(res.status, json as ErrorResponse | undefined);
  }
  const blob = await res.blob();
  const disposition = res.headers.get("content-disposition") ?? "";
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  const filename = match?.[1] ?? defaultExportFilename();

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Increment 32 (docs/INCREMENT_32_CONTRACTS.md §4): OffSprintTimeResponse is
// re-exported so the components keep their existing import site; the type now
// comes from @osp/contracts (the Phase-2 swap of Agent B's inline placeholder).
export type { OffSprintTimeResponse };

/** Fallback export filename, timestamped to the minute — e.g. `osp-export-20260810-073919.json`. */
function defaultExportFilename(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `osp-export-${stamp}.json`;
}

/**
 * Increment 14 (SPEC_14 §4): POST /api/reports/:id/pdf streams raw PDF bytes
 * (Content-Disposition: attachment) rather than the app's usual JSON
 * envelope, so it can't go through `req()`. Fetches the blob directly and
 * triggers a normal browser download via a transient `<a download>` — the
 * same client-side-only pattern as any static file download, no server
 * redirect needed. The filename is read off Content-Disposition when
 * present, falling back to a sprint-id-based name so a download never comes
 * out unnamed even if a proxy strips the header.
 */
async function downloadReportPdf(sprintId: number): Promise<void> {
  const res = await fetch(`${BASE}/reports/${sprintId}/pdf`, { method: "POST" });
  if (!res.ok) {
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    notifyAuthFailure(res.status, json);
    throw new ApiError(res.status, json as ErrorResponse | undefined);
  }
  const blob = await res.blob();
  const disposition = res.headers.get("content-disposition") ?? "";
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  const filename = match?.[1] ?? `report-${sprintId}.pdf`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Fallback filename for the status PDF when Content-Disposition is missing — date-stamped
 *  (not time-stamped like the data export): two downloads of the same sprint on the same day
 *  colliding onto one filename is an acceptable fallback outcome here. */
function defaultStatusPdfFilename(sprintId: number): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  return `sprint-status-${sprintId}-${stamp}.pdf`;
}

/**
 * Increment 36 (docs/INCREMENT_36_CONTRACTS.md §3): POST /api/sprints/:id/status-pdf,
 * mirroring `downloadReportPdf` above exactly — same blob-download shape, same
 * Content-Disposition-with-local-fallback filename resolution, same ApiError-on-!ok
 * handling. Unlike the report PDF this works for a sprint in ANY status (planning,
 * active, finished, frozen) — the route has no closed/locked gate (INCREMENT_36_CONTRACTS §1).
 */
async function downloadSprintStatusPdf(sprintId: number): Promise<void> {
  const res = await fetch(`${BASE}/sprints/${sprintId}/status-pdf`, { method: "POST" });
  if (!res.ok) {
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    notifyAuthFailure(res.status, json);
    throw new ApiError(res.status, json as ErrorResponse | undefined);
  }
  const blob = await res.blob();
  const disposition = res.headers.get("content-disposition") ?? "";
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  const filename = match?.[1] ?? defaultStatusPdfFilename(sprintId);

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export const api = {
  // Increment 39 (§4/§6): who am I. 401 → ApiError (App shows the sign-in
  // page); `role: null` → signed in but no OpalTakt role (No-access page).
  getMe: () => req<AuthMeResponse>("GET", "/auth/me"),
  logout: () => req<AuthLogoutResponse>("POST", "/auth/logout"),

  // Vault (SPEC_02 §3) — master passphrase; the key lives only in the backend.
  getVaultStatus: () => req<VaultStatusResponse>("GET", "/vault/status"),
  // The contract defines no response body for init/unlock/lock/change —
  // callers must re-derive state (GET /vault/status) instead of trusting one.
  initVault: (b: VaultInitBody) => req<void>("POST", "/vault/init", b),
  unlockVault: (b: VaultUnlockBody) => req<void>("POST", "/vault/unlock", b),
  lockVault: () => req<void>("POST", "/vault/lock"),
  changeVaultPassphrase: (b: VaultChangePassphraseBody) =>
    req<void>("POST", "/vault/change-passphrase", b),
  resetVault: (b: VaultResetBody) => req<VaultResetResponse>("POST", "/vault/reset", b),

  // Connections (SPEC_02 §5) — multi-server registry, token-free responses.
  getConnections: () => req<ConnectionsResponse>("GET", "/connections"),
  addConnection: (b: AddConnectionBody) =>
    req<AddConnectionResponse>("POST", "/connections", b),
  updateConnection: (id: number, b: UpdateConnectionBody) =>
    req<Connection>("PATCH", `/connections/${id}`, b),
  deleteConnection: (id: number) =>
    req<DeleteConnectionResponse>("DELETE", `/connections/${id}`),
  testConnection: (id: number) =>
    req<Connection>("POST", `/connections/${id}/test`),
  getConnectionsHealth: () =>
    req<ConnectionsHealthResponse>("GET", "/connections/health"),

  getProjects: () => req<ProjectsResponse>("GET", "/projects"),
  getVersions: (projectId: number, connectionId?: number) =>
    req<VersionsResponse>(
      "GET",
      `/versions?projectId=${projectId}${connectionId !== undefined ? `&connectionId=${connectionId}` : ""}`,
    ),
  getImports: () => req<ImportsResponse>("GET", "/imports"),
  removeImport: (id: number) =>
    req<RemoveImportResponse>("DELETE", `/imports/${id}`),
  importWorkPackage: (opId: number) =>
    req<ImportWorkPackageResponse>("POST", "/work-packages", { op_id: opId }),

  // Increment 23 (SPEC_23 §1): a single-project sync (`project_op_id` set)
  // still resolves a bare `SyncRun`, unchanged. A REFRESH-ALL call (no
  // `project_op_id`) now resolves `SyncRefreshAllResponse` instead — one
  // disconnected/unreachable connection is `"skipped"`, never a 409 for the
  // whole batch. Callers MUST discriminate with `isSyncRefreshAllResponse`
  // rather than assuming either shape.
  triggerSync: (b: TriggerSyncBody) =>
    req<SyncRun | SyncRefreshAllResponse>("POST", "/sync", b),
  getSyncStatus: () => req<SyncStatusResponse>("GET", "/sync/status"),
  // Increment 19 (SPEC_19 §2c): cancels the in-flight run; idempotent if it
  // already finished — see the CancelSyncResponse doc-comment in contracts.
  cancelSync: (runId: number) =>
    req<CancelSyncResponse>("POST", `/sync/${runId}/cancel`),

  getBacklog: (q: BacklogQuery) =>
    req<BacklogResponse>("GET", `/backlog${qs(q)}`),
  // Increment 19 (SPEC_19 §1/§3): cascading facet options for the backlog
  // filter dropdowns — pass the CURRENTLY selected filters so each facet is
  // computed with every other active filter applied (never offers an option
  // that would yield zero rows).
  getBacklogFilterOptions: (q: BacklogFilterOptionsQuery) =>
    req<BacklogFilterOptionsResponse>("GET", `/backlog/filter-options${qs(q)}`),
  removeFromBacklog: (wpOpIds: number[]) =>
    req<RemoveFromBacklogResponse>("POST", "/backlog/remove", { wp_op_ids: wpOpIds }),

  // Increment 29 (docs/INCREMENT_29_CONTRACTS.md §6): cached tickets no
  // longer covered by any import selection — listed with protected
  // (in-sprint) rows flagged, and bulk-removable in one confirmation. LOCAL
  // ONLY: deletes the `work_package_cache` row, never writes to OpenProject;
  // a protected row is never deleted server-side regardless of what the
  // client asks for.
  getOutOfSelection: () => req<OutOfSelectionResponse>("GET", "/backlog/out-of-selection"),
  deleteOutOfSelection: (opIds: number[]) =>
    req<DeleteOutOfSelectionResponse>("POST", "/backlog/out-of-selection/delete", { op_ids: opIds }),

  createEstimateOverride: (b: CreateEstimateOverrideBody) =>
    req<EstimateOverrideResponse>("POST", "/estimate-override", b),

  getSprints: () => req<SprintsResponse>("GET", "/sprints"),
  createSprint: (b: CreateSprintBody) =>
    req<SprintResponse>("POST", "/sprints", b),
  updateSprint: (id: number, b: UpdateSprintBody) =>
    req<SprintResponse>("PATCH", `/sprints/${id}`, b),
  // Increment 11 (SPEC_11 §2): hard delete, works in any sprint status —
  // frontend gates it behind a confirm modal, the route itself is unconditional.
  deleteSprint: (id: number) =>
    req<DeleteSprintResponse>("DELETE", `/sprints/${id}`),

  // Increment 4 lifecycle (SPEC_04 §4/§6): activate → update* → finish/lock,
  // plus the per-ticket changelog. See SprintBoardScreen.tsx for the UI.
  activateSprint: (id: number) =>
    req<ActivateSprintResponse>("POST", `/sprints/${id}/activate`),
  updateSprintRun: (id: number, b?: UpdateSprintRunBody) =>
    req<SprintUpdateRunResponse>("POST", `/sprints/${id}/update`, b),
  getSprintUpdates: (id: number) =>
    req<SprintUpdateRunsResponse>("GET", `/sprints/${id}/updates`),
  finishSprint: (id: number, b?: FinishSprintBody) =>
    req<ClosureReportResponse>("POST", `/sprints/${id}/finish`, b),
  // Increment 11 (SPEC_11 §8b): only meaningful while today ∈ [start_date,
  // end_date] — the frontend both gates the button's visibility on that
  // window AND relies on the server's own 409 REACTIVATE_WINDOW_CLOSED guard.
  reactivateSprint: (id: number, b?: ReactivateSprintBody) =>
    req<ReactivateSprintResponse>("POST", `/sprints/${id}/reactivate`, b),
  getTicketChangelog: (sprintId: number, wpId: number) =>
    req<TicketChangelogResponse>("GET", `/sprints/${sprintId}/tickets/${wpId}/changelog`),

  getSprintItems: (id: number) =>
    req<SprintItemsResponse>("GET", `/sprints/${id}/items`),
  // SPEC_07 §5: sprint_item rows ENRICHED with ticket display fields, sourced
  // directly from the cache/baseline — immune to backlog dismissals (see
  // SprintBoardScreen.tsx for how it replaces the old backlog cross-reference).
  getSprintItemsDetailed: (id: number) =>
    req<SprintItemsDetailedResponse>("GET", `/sprints/${id}/items/detailed`),
  addSprintItem: (id: number, b: AddSprintItemBody) =>
    req<SprintItemResponse>("POST", `/sprints/${id}/items`, b),
  // Increment 25 (SPEC_25 §3/§6): "add ticket by ID" — fetches the work
  // package DIRECTLY from OP regardless of backlog/filters/version/status
  // (a done/tested ticket that never surfaced in the backlog, SPEC_25 §1's
  // "noční AU ticket" use case). Distinct route from addSprintItem above —
  // no planned_hours override, and connection_id is explicit rather than
  // inferred from a cached backlog row.
  addSprintItemById: (id: number, b: AddSprintItemByIdBody) =>
    req<AddSprintItemByIdResponse>("POST", `/sprints/${id}/items/by-id`, b),
  removeSprintItem: (id: number, wpId: number) =>
    req<SprintItemResponse>("DELETE", `/sprints/${id}/items/${wpId}`),
  // Increment 34 (docs/INCREMENT_34_CONTRACTS.md §5): carry an unfinished
  // ticket from THIS (typically closed/locked) sprint into a chosen open
  // one — the source sprint/item is never mutated, the target-side add
  // reuses the existing planning-add / mid-sprint-add paths server-side.
  carrySprintItem: (id: number, wpId: number, b: CarrySprintItemBody) =>
    req<CarrySprintItemResponse>("POST", `/sprints/${id}/items/${wpId}/carry`, b),

  // Increment 28 (docs/INCREMENT_28_CONTRACTS.md §2c) — one-click
  // double-counting fix: bulk-remove every flagged parent, or every flagged
  // child, through the existing per-item removal semantics. Both 409 on a
  // locked sprint (SPRINT_LOCKED). `wp_op_ids` is left unset here — every
  // flagged ticket of that side is removed, which is what the confirm modal
  // (SprintBoardScreen.tsx's DoubleCountFixButton) always names. The response
  // body is never read field-by-field; the caller always follows up with the
  // shared refreshKey bump (§1's invalidation), which is what actually repaints.
  removeDoubleCountParents: (id: number) =>
    req<DoubleCountFixResponse>("POST", `/sprints/${id}/double-count/remove-parents`),
  removeDoubleCountChildren: (id: number) =>
    req<DoubleCountFixResponse>("POST", `/sprints/${id}/double-count/remove-children`),

  getCapacity: (id: number) =>
    req<CapacityResponse>("GET", `/sprints/${id}/capacity`),
  setCapacity: (id: number, b: SetCapacityBody) =>
    req<CapacityResponse>("PUT", `/sprints/${id}/capacity`, b),

  getBurndown: (id: number) =>
    req<BurndownResponse>("GET", `/sprints/${id}/burndown`),
  // Increment 12 (SPEC_12 §5): recompute burndown_snapshot from OP journals +
  // time entries for ANY sprint (incl. locked) — never touches sprint.status.
  rebuildBurndown: (id: number) =>
    req<RebuildBurndownResponse>("POST", `/sprints/${id}/rebuild-burndown`),
  // Increment 12 (SPEC_12 §2/§8): bulk-add retrospective candidates (by OP
  // version or a pasted id list), each reconstructed to the sprint's
  // start_date state. Only valid while status="planning" && is_retrospective.
  seedRetro: (id: number, b: RetroSeedBody) =>
    req<RetroSeedResponse>("POST", `/sprints/${id}/retro/seed`, b),
  // Increment 12 (SPEC_12 §2/§9): read-only re-view of the CURRENT sprint
  // items' start_date-reconstructed state — drives the "this is what it
  // looked like on start_date" preview table before Activate.
  getRetroPreview: (id: number) =>
    req<RetroPreviewResponse>("GET", `/sprints/${id}/retro/preview`),
  // Increment 13 (REVISED, SPEC_13 §1a/§3): every person holding
  // retro-reconstructed work in this sprint — name, hours, ticket count, and
  // op_user_id WHEN known (null is normal, non-blocking). Neutral "who's in
  // this sprint" listing, NOT a "problems to fix" queue — every line here is
  // already a fully-functional capacity row regardless of op_user_id.
  getSprintPeople: (id: number) =>
    req<SprintPeopleResponse>("GET", `/sprints/${id}/people`),
  // Increment 13 (SPEC_13 §1b): pair a journal name to a real OP user, or
  // fold it under another name (a rename/merge) — applies retroactively
  // everywhere that name appears (re-resolved at read time), not just this
  // sprint. DELETE undoes a mistaken pairing. Purely OPTIONAL enrichment —
  // never a precondition for a capacity line to exist or be editable.
  createUserAlias: (b: CreateUserAliasBody) =>
    req<UserAliasResponse>("POST", "/user-aliases", b),
  deleteUserAlias: (id: number) => req<void>("DELETE", `/user-aliases/${id}`),
  // Increment 13 (SPEC_13 §6): trail of capacity edits made to a
  // retrospective sprint AFTER it left planning (the only case that writes
  // to it) — read-only, never gated on sprint status.
  getCapacityAudit: (id: number) =>
    req<CapacityAuditResponse>("GET", `/sprints/${id}/capacity-audit`),
  getVelocity: (id: number) =>
    req<VelocityResponse>("GET", `/sprints/${id}/velocity`),
  closeSprint: (id: number) =>
    req<ClosureReportResponse>("POST", `/sprints/${id}/close`),
  getVersionExport: (id: number) =>
    req<VersionExportResponse>("GET", `/sprints/${id}/version-export`),

  // Increment 14 (SPEC_14 §2): the role registry — "unset" is never guessed,
  // it's surfaced (Settings → People) so the done-matrix's ambiguous bucket
  // and the capacity-roster "developers only" rule both have somewhere to
  // point back to. GET /api/done-rules exists for completeness (Agent B's
  // contract) but SPEC_14 §2/§7 doesn't call for an editor UI here.
  getPeople: () => req<PeopleResponse>("GET", "/people"),
  setPersonRole: (id: number, b: SetPersonRoleBody) =>
    req<PersonSummary>("PUT", `/people/${id}/role`, b),
  getDoneRules: () => req<DoneRulesResponse>("GET", "/done-rules"),
  updateDoneRules: (b: UpdateDoneRulesBody) =>
    req<DoneRulesResponse>("PUT", "/done-rules", b),

  // Increment 14 (SPEC_14 §3): the NEW role-aware done/not-done/rejected/
  // ambiguous view — additive to, and independent of, ClosureReportResponse
  // above (which keeps powering /close, /finish, version-export unchanged).
  getClosureStats: (sprintId: number) =>
    req<ClosureStatsResponse>("GET", `/sprints/${sprintId}/closure-stats`),

  // Increment 14 (SPEC_14 §4): reports for closed sprints — READ-ONLY w.r.t.
  // sprint state, works retroactively from stored data alone.
  getReports: () => req<ReportsListResponse>("GET", "/reports"),
  getReportDetail: (id: number) => req<ReportDetailResponse>("GET", `/reports/${id}`),
  // Increment 14 (SPEC_14 §4): unlike every other route, the response is a
  // raw `application/pdf` download (Content-Disposition: attachment), not the
  // usual JSON envelope — so this bypasses `req()` and triggers a normal
  // browser download instead of returning a parsed body. READ-ONLY: never
  // changes sprint.status/is_locked, safe to call on a locked/closed sprint
  // any number of times (SPEC_14 §4's "View ≠ lock" guardrail).
  generateReportPdf: (id: number) => downloadReportPdf(id),

  // Increment 36 (docs/INCREMENT_36_CONTRACTS.md §3): sprint-status PDF —
  // works in ANY sprint state (planning/active/finished/frozen), unlike
  // generateReportPdf above which is closure-report-only. Same download
  // shape/error handling, different route and fallback filename.
  downloadSprintStatusPdf: (id: number) => downloadSprintStatusPdf(id),

  // Increment 27 (§6): Settings → Data — full local-planning-data JSON
  // export/import (the SQLite→PG hard cut's export format doubles as a
  // local backup/transfer format). Export is a file download, same pattern
  // as generateReportPdf above; import replaces local data in one shot —
  // see DataScreen.tsx for the mandatory confirm step.
  exportData: (includeCredentials: boolean) => downloadDataExport(includeCredentials),
  importData: (b: DataImportRequest) => req<DataImportResult>("POST", "/data/import", b),

  // Increment 31 (docs/INCREMENT_31_CONTRACTS.md §3/§4): the app-level
  // settings singleton — `overshoot_threshold_pct` (existing, previously
  // unedited from the UI) and `freeze_grace_days` (new). No OP calls; works
  // with a locked vault. See SettingsScreen.tsx.
  getConfig: () => req<AppConfigResponse>("GET", "/config"),
  getVersion: () => req<VersionResponse>("GET", "/version"),
  updateConfig: (b: UpdateAppConfigBody) => req<AppConfigResponse>("PUT", "/config", b),

  // Increment 32 (docs/INCREMENT_32_CONTRACTS.md §4/§5) — "Outside the
  // sprint": time logged, within the sprint's calendar window, on tickets
  // NOT in the sprint — for every developer, not just those with a capacity
  // line. Read-only, works with a locked vault (stored rows only).
  getOffSprintTime: (sprintId: number) =>
    req<OffSprintTimeResponse>("GET", `/sprints/${sprintId}/off-sprint-time`),
};

export type Api = typeof api;

/** Polling cadence for the health fallback when SSE is unavailable (SPEC_02 §4). */
export const HEALTH_POLL_INTERVAL_MS = 5_000;

/**
 * Live connection-health feed (SPEC_02 §6): prefers the SSE stream
 * `GET /api/connections/health/stream`; when EventSource is unavailable
 * (e.g. jsdom) or errors, falls back to polling GET /api/connections/health
 * every 5 s. Returns an unsubscribe function that closes/clears everything.
 */
export function subscribeConnectionsHealth(
  onUpdate: (health: ConnectionsHealthResponse) => void,
): () => void {
  let closed = false;
  let source: EventSource | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const poll = () => {
    void api
      .getConnectionsHealth()
      .then((h) => {
        if (!closed) onUpdate(h);
      })
      .catch(() => {
        // Backend unreachable / vault locked — keep polling quietly.
      });
  };

  const startPolling = () => {
    if (closed || timer !== undefined) return;
    poll();
    timer = setInterval(poll, HEALTH_POLL_INTERVAL_MS);
  };

  if (typeof EventSource !== "undefined") {
    source = new EventSource(`${BASE}/connections/health/stream`);
    source.onmessage = (ev) => {
      if (closed) return;
      try {
        onUpdate(JSON.parse(ev.data as string) as ConnectionsHealthResponse);
      } catch {
        // Malformed frame — wait for the next one.
      }
    };
    source.onerror = () => {
      // SSE broken (proxy, backend restart…) → degrade to polling.
      source?.close();
      source = undefined;
      startPolling();
    };
  } else {
    startPolling();
  }

  return () => {
    closed = true;
    source?.close();
    source = undefined;
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}
