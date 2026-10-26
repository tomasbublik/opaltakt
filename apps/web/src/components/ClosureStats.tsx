import { useState } from "react";
import type { ClosureStatsResponse, TicketClosureDetail } from "@osp/contracts";
import { formatHours, formatPct } from "../lib/format";
import { CAPACITY_NUMBER_DEFINITIONS } from "../lib/capacity";
import { opWorkPackageUrl } from "./BacklogScreen";
import { EmptyState } from "./ui";
import { MultiSprintBadge } from "./CarryOverControl";

const ANOMALY_LABEL: Record<string, string> = {
  unassigned_in_progress: "In progress with no assignee — this should never happen",
};

/** ClosureStatsResponse's inner bucket shape (`{ count, items }`) — the zod
 * schema behind it (ClosureBucket in @osp/contracts/api.ts) is a local,
 * un-exported const, so this mirrors its shape rather than importing a type
 * that doesn't exist on the public contract surface. */
type ClosureBucketLike = ClosureStatsResponse["done"];

/**
 * SPEC_14 §3: the role-aware closure statistics view — total planned/
 * delivered/logged/dev-logged hours, the done/not-done/rejected/ambiguous
 * buckets, a distinct anomalies callout, estimate effectivity (Increment 16,
 * SPEC_16 §1 — renamed from "accuracy", calculation unchanged), and the
 * per-developer/per-ticket breakdown tables. Consumes GET /sprints/:id/closure-stats
 * (ClosureStatsResponse) — additive to, and independent of, the older
 * ClosureReportResponse view in ClosureScreen.tsx, which stays unchanged.
 *
 * Rendered from two places: directly on the (in-progress or already closed)
 * sprint's own Closure screen, AND on a closed sprint's Reports Detail page
 * (SPEC_14 §4), which is why it takes plain data props rather than fetching
 * anything itself.
 */
export function ClosureStatsView({
  stats,
  baseUrl,
}: {
  stats: ClosureStatsResponse;
  /** SPEC_09 §4: `TicketClosureDetail` carries no per-item connection_base_url
   * (like `ClosureItem`), so every deep link here is a "current connection"
   * best-effort link, same caveat as ClosureScreen's own TicketRef. */
  baseUrl?: string;
}) {
  return (
    <div data-testid="closure-stats">
      <div className="row" style={{ marginBottom: 16 }}>
        <div className="stat">
          {/* Increment 30 (`CAPACITY_BAR_RULES.md` §5): CURRENT SCOPE, Σ
              per_developer[].planned_hours — identical, by construction, to
              the Capacity panel's own "Planned (developers)" header for the
              same sprint. No relabel needed HERE (unlike the Capacity panel):
              this view's "Per developer" table already shows developers only
              (`ClosureStatsResponse.per_developer` is role-gated at the
              contract level), so summing every row visible below this header
              already reproduces it — invariant 8 holds without qualifying
              the label. */}
          <span className="stat-value" title="Sum of the developer rows in the table below.">
            {formatHours(stats.total_planned_hours)}
          </span>
          <span className="stat-label">Planned</span>
        </div>
        <div className="stat">
          {/* Increment 30 — `Baseline` is what `Planned` meant before this
              increment; Increment 38 — what the developers were signed up for
              at the last Activate (CAPACITY_BAR_RULES §5), kept as its OWN
              labelled figure: it's what ±Change is measured against and what
              the burndown anchors on. Never composed with Planned —
              `Baseline + ±Change` is the balancing sum, `Planned + ±Change`
              double-counts (invariant 9). */}
          <span className="stat-value" title={CAPACITY_NUMBER_DEFINITIONS.baseline}>
            {formatHours(stats.total_baseline_hours)}
          </span>
          <span className="stat-label">Baseline</span>
        </div>
        <div className="stat">
          {/* Increment 16 (SPEC_16 §3): Σ per_developer[].delivered_hours,
              inserted between Planned and Logged (all). */}
          <span className="stat-value">{formatHours(stats.total_delivered_hours)}</span>
          <span className="stat-label">Delivered</span>
        </div>
        <div className="stat">
          <span className="stat-value">{formatHours(stats.total_logged_hours)}</span>
          <span className="stat-label">Logged (all)</span>
        </div>
        <div className="stat">
          <span className="stat-value">{formatHours(stats.dev_logged_hours)}</span>
          <span className="stat-label">Logged (Developers)</span>
        </div>
        <div className="stat">
          <span className="stat-value">{formatPct(stats.estimate_accuracy_pct)}</span>
          {/* Increment 16 (SPEC_16 §1): renamed Accuracy → Effectivity — label
              only, the underlying field/calculation is unchanged. */}
          <span className="stat-label">Estimate effectivity (done only)</span>
        </div>
        {/* The bar can show a per-segment "overshoot" span for OPEN tickets
            (logged beyond — or without — an estimate); this figure deliberately
            does not: it is an accounting metric over completed work only. The
            tooltip spells that out so the two never read as a contradiction. */}
        <div
          className="stat"
          title="Completed tickets only — cumulative developer-logged time vs estimate across the ticket's sprints. Open tickets' logged time never counts here."
        >
          <span className="stat-value">{formatHours(stats.overshoot_hours)}</span>
          <span className="stat-label">Overshoot (flag &gt;{stats.overshoot_threshold_pct}%)</span>
        </div>
      </div>

      {stats.anomalies.length > 0 ? (
        <div className="msg warn" role="alert" data-testid="closure-anomalies" style={{ marginBottom: 16 }}>
          <strong>⚠ Anomalies ({stats.anomalies.length})</strong> — states that should never occur.
          <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
            {stats.anomalies.map((it) => (
              <li key={it.wp_op_id}>
                <TicketLabel item={it} baseUrl={baseUrl} /> —{" "}
                {it.anomaly ? (ANOMALY_LABEL[it.anomaly] ?? it.anomaly) : "anomaly"}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <ScopeOriginSection scopeOrigin={stats.scope_origin} />

      <div className="board" style={{ marginBottom: 16 }}>
        <BucketSection title="Done" bucket={stats.done} baseUrl={baseUrl} />
        <BucketSection title="Not done" bucket={stats.not_done} baseUrl={baseUrl} />
        <BucketSection title="Rejected" bucket={stats.rejected} baseUrl={baseUrl} />
        <BucketSection title="Ambiguous (role not set)" bucket={stats.ambiguous} baseUrl={baseUrl} showReason />
      </div>

      <h3 style={{ fontSize: 13, margin: "0 0 8px", color: "var(--muted)" }}>Per developer</h3>
      <div style={{ overflowX: "auto", marginBottom: 16 }}>
        <div className="table-scroll">
<table className="grid" data-testid="per-developer-table">
          <thead>
            <tr>
              <th>Developer</th>
              <th>Planned</th>
              <th>Logged</th>
              <th>Delivered</th>
              {/* Increment 16 (SPEC_16 §1): Accuracy → Effectivity, label only. */}
              <th>Effectivity</th>
              <th title="Completed tickets only">Overshoot</th>
            </tr>
          </thead>
          <tbody>
            {stats.per_developer.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <EmptyState>No developers held sprint work.</EmptyState>
                </td>
              </tr>
            ) : (
              stats.per_developer.map((d) => (
                <tr key={d.member_id ?? d.op_user_id ?? d.name}>
                  <td>{d.name}</td>
                  <td>{formatHours(d.planned_hours)}</td>
                  <td>{formatHours(d.logged_hours)}</td>
                  {/* Increment 15 (SPEC_15 §3): DELIVERED now reads the
                      corrected, max-logged-attributed `delivered_hours` —
                      NOT the deprecated `delivered_estimate_hours` alias
                      (same value today, but this is the field new code is
                      meant to read per the contract's rollout decision). */}
                  <td>{formatHours(d.delivered_hours)}</td>
                  <td>{formatPct(d.accuracy_pct)}</td>
                  <td>{formatHours(d.overshoot_hours)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
</div>
      </div>

      <h3 style={{ fontSize: 13, margin: "0 0 8px", color: "var(--muted)" }}>Per ticket</h3>
      <div style={{ overflowX: "auto" }}>
        <div className="table-scroll">
<table className="grid" data-testid="per-ticket-table">
          <thead>
            <tr>
              <th>Ticket</th>
              <th>Project</th>
              <th>Bucket</th>
              <th>Estimate</th>
              <th>Dev logged</th>
              <th>Total logged</th>
              <th>Delta</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {stats.per_ticket.length === 0 ? (
              <tr>
                <td colSpan={8}>
                  <EmptyState>No tickets.</EmptyState>
                </td>
              </tr>
            ) : (
              stats.per_ticket.map((t) => (
                <tr key={t.wp_op_id}>
                  <td>
                    {baseUrl ? (
                      <a href={opWorkPackageUrl(baseUrl, t.wp_op_id)} target="_blank" rel="noopener noreferrer">
                        #{t.wp_op_id} {t.subject}
                      </a>
                    ) : (
                      <>
                        #{t.wp_op_id} {t.subject}
                      </>
                    )}
                    {t.multi_sprint != null ? (
                      <>
                        {" "}
                        <MultiSprintBadge badge={t.multi_sprint} />
                      </>
                    ) : null}
                    {/* Increment 35 (§4/§2): scope-origin badge — a ticket that
                        arrived after activation (added_mid_sprint) or was
                        reconstructed as a retro addition (added_retroactively)
                        gets a visible marker next to the subject. Baseline
                        rows (the overwhelming majority) render this branch as
                        `null`, so they stay byte-identical to before this
                        increment. */}
                    {t.origin !== "baseline" ? (
                      <>
                        {" "}
                        <span className="badge" data-testid={`scope-origin-badge-${t.wp_op_id}`}>
                          {t.origin === "added_retroactively" ? "added (retro)" : "added"}
                        </span>
                      </>
                    ) : null}
                  </td>
                  {/* Increment 40 (C1, §1.2): name, tooltip = identifier;
                      name null → identifier; both null → "—". */}
                  <td title={t.project_identifier ?? undefined} data-testid={`per-ticket-project-${t.wp_op_id}`}>
                    {t.project_name ?? t.project_identifier ?? <span className="muted">—</span>}
                  </td>
                  <td>
                    <span className="badge">{t.bucket}</span>
                  </td>
                  <td>{formatHours(t.estimate_hours)}</td>
                  <td>
                    {formatHours(t.dev_logged_hours)}
                    {/* Increment 34 (§2/§3): a DONE multi-sprint ticket's
                        estimate accuracy is measured against CUMULATIVE
                        dev-logged (all its sprints), not just this window —
                        surfaced alongside the window figure so the two never
                        get confused. Single-sprint rows (multi_sprint null)
                        stay byte-identical to before this increment. */}
                    {t.multi_sprint != null && t.bucket === "done"
                      ? ` (${formatHours(t.cumulative_dev_logged_hours)} across sprints)`
                      : ""}
                  </td>
                  <td>{formatHours(t.total_logged_hours)}</td>
                  <td>{t.delta_hours != null ? formatHours(t.delta_hours) : "—"}</td>
                  <td>
                    {t.overshoot_flag ? (
                      <span
                        className="badge"
                        data-testid={`overshoot-flag-${t.wp_op_id}`}
                        style={{ color: "var(--danger)", borderColor: "var(--danger)" }}
                        title={`Overshoot exceeds the ${stats.overshoot_threshold_pct}% threshold`}
                      >
                        overshoot
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
</div>
      </div>
    </div>
  );
}

/** SPEC_09 §4: best-effort deep link (see the module doc above for why there's no per-item URL here). */
function TicketLabel({ item, baseUrl }: { item: Pick<TicketClosureDetail, "wp_op_id" | "subject">; baseUrl?: string }) {
  const label = `#${item.wp_op_id} ${item.subject}`;
  if (!baseUrl) return <>{label}</>;
  return (
    <a href={opWorkPackageUrl(baseUrl, item.wp_op_id)} target="_blank" rel="noopener noreferrer">
      {label}
    </a>
  );
}

function BucketSection({
  title,
  bucket,
  baseUrl,
  showReason = false,
}: {
  title: string;
  bucket: ClosureBucketLike;
  baseUrl?: string;
  /** Ambiguous bucket only: show each item's `ambiguous_reason`. */
  showReason?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        className="btn small secondary"
        onClick={() => setOpen((o) => !o)}
        data-testid={`bucket-toggle-${title}`}
        aria-expanded={open}
      >
        {title} ({bucket.count}) {open ? "▲" : "▼"}
      </button>
      {open ? (
        bucket.items.length === 0 ? (
          <EmptyState>None.</EmptyState>
        ) : (
          <ul style={{ margin: "8px 0 0", paddingLeft: 18 }} data-testid={`bucket-list-${title}`}>
            {bucket.items.map((it) => (
              <li key={it.wp_op_id} className={it.anomaly ? "anomaly-item" : undefined}>
                <TicketLabel item={it} baseUrl={baseUrl} /> — {it.status_name} —{" "}
                {it.holder_name ?? "Unassigned"}
                {it.holder_role && it.holder_role !== "unset" ? ` (${it.holder_role})` : ""}
                {showReason && it.ambiguous_reason ? (
                  <div className="muted" style={{ fontSize: 12 }}>
                    {it.ambiguous_reason}
                  </div>
                ) : null}
                {it.anomaly ? (
                  <div style={{ fontSize: 12, marginTop: 2 }}>
                    ⚠ {ANOMALY_LABEL[it.anomaly] ?? it.anomaly}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

/**
 * Increment 35 (docs/INCREMENT_35_CONTRACTS.md §4; CAPACITY_BAR_RULES §5c) —
 * same rounding convention as ClosureScreen's off-sprint `formatSharePct`
 * (0 decimals once the share is ≥10%, 1 decimal below, em dash on null).
 * Duplicated locally rather than imported: ClosureScreen.tsx imports
 * `ClosureStatsView` FROM this file, so importing the other way round would
 * create a circular module dependency.
 */
function formatScopeSharePct(pct: number | null): string {
  if (pct === null || Number.isNaN(pct)) return "—";
  return Math.abs(pct) >= 10 ? `${Math.round(pct)}%` : `${pct.toFixed(1)}%`;
}

/**
 * Increment 35 (§4): per-group share shown in the legend/table. Mirrors
 * whichever axis the donut fell back to (§5c) so the two never disagree:
 * dev-logged share when there IS logged time on the included scope, the
 * estimate share when there isn't yet, and a dash on both sides only when
 * neither axis has anything to show.
 */
function scopeOriginRowShares(
  scopeOrigin: ClosureStatsResponse["scope_origin"],
): { baseline: number | null; added: number | null } {
  if (scopeOrigin.added_logged_share_pct !== null) {
    return { added: scopeOrigin.added_logged_share_pct, baseline: 100 - scopeOrigin.added_logged_share_pct };
  }
  if (scopeOrigin.added_estimate_share_pct !== null) {
    return { added: scopeOrigin.added_estimate_share_pct, baseline: 100 - scopeOrigin.added_estimate_share_pct };
  }
  return { baseline: null, added: null };
}

/**
 * Increment 35 (§4) — a small two-slice donut, baseline (green, `--ok`) vs
 * added (red, `--danger`) — the SAME two semantic colours the capacity bar
 * uses for `baseline_worked` (`.bar-green`) and `acquired` (`.bar-red`), per
 * CAPACITY_BAR_RULES §5c's instruction to reuse the bar palette. Renders
 * nothing when both slices are zero (nothing to show yet).
 */
function ScopeOriginDonut({ baseline, added }: { baseline: number; added: number }) {
  const total = baseline + added;
  if (total <= 0) return null;

  const cx = 32;
  const cy = 32;
  const r = 24;
  const strokeWidth = 12;
  const circumference = 2 * Math.PI * r;
  const baselinePct = (baseline / total) * 100;
  const addedPct = 100 - baselinePct;
  const baselineLen = (baselinePct / 100) * circumference;
  const addedLen = circumference - baselineLen;

  return (
    <svg
      viewBox="0 0 64 64"
      width={64}
      height={64}
      role="img"
      aria-label={`${Math.round(baselinePct)}% planned before activation, ${Math.round(addedPct)}% added during the sprint`}
      data-testid="closure-scope-origin-donut"
    >
      {/* Rotated -90deg so both arcs start at 12 o'clock. */}
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke="var(--ok)"
        strokeWidth={strokeWidth}
        strokeDasharray={`${baselineLen} ${circumference - baselineLen}`}
        transform={`rotate(-90 ${cx} ${cy})`}
      />
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke="var(--danger)"
        strokeWidth={strokeWidth}
        strokeDasharray={`${addedLen} ${circumference - addedLen}`}
        strokeDashoffset={-baselineLen}
        transform={`rotate(-90 ${cx} ${cy})`}
      />
    </svg>
  );
}

/**
 * Increment 35 (docs/INCREMENT_35_CONTRACTS.md §4; CAPACITY_BAR_RULES §5c) —
 * "planned before activation" vs "added during the sprint": a headline share,
 * a two-slice donut, and a compact breakdown table. Gated like the off-sprint
 * section (ClosureScreen's `OffSprintClosureSection`): renders nothing at all
 * when the sprint has no included item yet (baseline + added ticket_count ===
 * 0), so a pre-Increment-35 (zeroed-default) response shows nothing new.
 *
 * Lives INSIDE `ClosureStatsView` (rather than as a sibling component like
 * `OffSprintClosureSection`) precisely so ClosureScreen AND ReportsScreen
 * pick it up for free — both already render `ClosureStatsView` with the full
 * `ClosureStatsResponse`, so this one edit covers both surfaces.
 */
function ScopeOriginSection({ scopeOrigin }: { scopeOrigin: ClosureStatsResponse["scope_origin"] }) {
  const { baseline, added } = scopeOrigin;
  if (baseline.ticket_count + added.ticket_count === 0) return null;

  // §5c fallback: prefer the "reality" axis (dev-logged); when nobody has
  // logged anything on the included scope yet, fall back to the "what did we
  // commit" axis (estimate) so the donut still shows something meaningful.
  const loggedTotal = baseline.dev_logged_hours + added.dev_logged_hours;
  const donutBaseline = loggedTotal > 0 ? baseline.dev_logged_hours : baseline.estimate_hours;
  const donutAdded = loggedTotal > 0 ? added.dev_logged_hours : added.estimate_hours;
  const shares = scopeOriginRowShares(scopeOrigin);

  return (
    <div style={{ marginTop: 4, marginBottom: 16 }} data-testid="closure-scope-origin-section">
      <h3 style={{ fontSize: 13, margin: "0 0 8px", color: "var(--muted)" }}>Scope origin</h3>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }} data-testid="closure-scope-origin-headline">
        {scopeOrigin.added_logged_share_pct === null ? (
          "No developer time logged yet to show the added-vs-planned split."
        ) : (
          <>
            <strong>{formatScopeSharePct(scopeOrigin.added_logged_share_pct)}</strong> of developer time went to
            work added during the sprint
          </>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", marginBottom: 8 }}>
        <ScopeOriginDonut baseline={donutBaseline} added={donutAdded} />
        <ul style={{ listStyle: "none", margin: 0, padding: 0, fontSize: 12 }}>
          <li style={{ marginBottom: 4 }}>
            <span
              aria-hidden="true"
              style={{ display: "inline-block", width: 10, height: 10, background: "var(--ok)", marginRight: 6, borderRadius: 2 }}
            />
            Planned before activation — {formatScopeSharePct(shares.baseline)}
          </li>
          <li>
            <span
              aria-hidden="true"
              style={{ display: "inline-block", width: 10, height: 10, background: "var(--danger)", marginRight: 6, borderRadius: 2 }}
            />
            Added during sprint — {formatScopeSharePct(shares.added)}
          </li>
        </ul>
      </div>
      <div style={{ overflowX: "auto" }}>
        <div className="table-scroll">
<table className="grid" data-testid="closure-scope-origin-table">
          <thead>
            <tr>
              <th>Group</th>
              <th>Tickets</th>
              <th>Estimated</th>
              <th>Dev logged</th>
              <th>Share</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Planned before activation</td>
              <td>{baseline.ticket_count}</td>
              <td>{formatHours(baseline.estimate_hours)}</td>
              <td>{formatHours(baseline.dev_logged_hours)}</td>
              <td>{formatScopeSharePct(shares.baseline)}</td>
            </tr>
            <tr>
              <td>Added during sprint</td>
              <td>{added.ticket_count}</td>
              <td>{formatHours(added.estimate_hours)}</td>
              <td>{formatHours(added.dev_logged_hours)}</td>
              <td>{formatScopeSharePct(shares.added)}</td>
            </tr>
          </tbody>
        </table>
</div>
      </div>
    </div>
  );
}
