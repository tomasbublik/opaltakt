/**
 * Increment 40 (docs/INCREMENT_40_CONTRACTS.md §2.B4, decision P1) — the
 * "Project" column of both PDF ticket tables (`report.ts` "Per ticket",
 * `statusReport.ts` ticketTableHtml), shared so the two documents can never
 * disagree on the layout rules:
 *
 *  - column right after `#`; cell = identifier → name → `—` (§1.2: PDFs show
 *    the short identifier), wrapped in `<span class="proj">` so a long value is
 *    truncated with an ellipsis (a bare `td` max-width does not truncate in an
 *    auto table layout);
 *  - legend under the table, `identifier — name` per distinct project of the
 *    rows shown, sorted by identifier; omitted when no row has a project;
 *  - SINGLE-PROJECT rule: when every row resolves to the SAME non-null project
 *    key (and no row is `—`), the column and legend are omitted and the
 *    sub-header carries `Project: <name> (<identifier>)` instead. Zero rows →
 *    no project line at all.
 *
 * Display-only: the `key` a caller supplies is built from the project op_id
 * (connection-scoped where the caller knows the connection) — never from a
 * name/identifier alone (§0 pillar 2).
 */

export interface PdfProjectRow {
  /** Stable project identity for the single-project rule; null = unknown. */
  key: string | null;
  name: string | null;
  identifier: string | null;
}

export interface PdfProjectLayout {
  showColumn: boolean;
  /** Escaped `Project: …` sub-header text, or null. */
  headerHtml: string | null;
  /** Escaped `<th>` for the column (empty string when the column is omitted). */
  thHtml: string;
  /** Escaped `<td>` for one row (empty string when the column is omitted). */
  tdHtml(row: PdfProjectRow): string;
  /** Escaped legend paragraph (empty string when omitted). */
  legendHtml: string;
}

/** `.proj` truncation + legend styling — appended to each PDF's <style>. */
export const PDF_PROJECT_CSS =
  ".proj{display:inline-block;max-width:14ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom;}" +
  ".proj-legend{color:#64748b;font-size:12px;margin:6px 0 0;}";

function label(row: PdfProjectRow): string | null {
  return row.identifier ?? row.name;
}

export function planPdfProjects(
  rows: readonly PdfProjectRow[],
  esc: (s: string) => string,
): PdfProjectLayout {
  const none: PdfProjectLayout = {
    showColumn: false,
    headerHtml: null,
    thHtml: "",
    tdHtml: () => "",
    legendHtml: "",
  };
  if (rows.length === 0) return none;

  const firstKey = rows[0]!.key;
  const single =
    firstKey != null && rows.every((r) => r.key === firstKey && label(r) != null);
  if (single) {
    const r = rows.find((x) => x.name != null && x.identifier != null) ?? rows[0]!;
    const text =
      r.name != null && r.identifier != null
        ? `${r.name} (${r.identifier})`
        : (r.name ?? r.identifier ?? "");
    return { ...none, headerHtml: `Project: ${esc(text)}` };
  }

  // Distinct projects of the rows shown (by key; a key-less row with a
  // display value is its own entry), sorted by identifier.
  const distinct = new Map<string, { name: string | null; identifier: string | null }>();
  for (const r of rows) {
    if (label(r) == null) continue;
    const k = r.key ?? `?:${r.identifier ?? ""}:${r.name ?? ""}`;
    const prev = distinct.get(k);
    if (!prev) distinct.set(k, { name: r.name, identifier: r.identifier });
    else
      distinct.set(k, { name: prev.name ?? r.name, identifier: prev.identifier ?? r.identifier });
  }
  const sortKey = (p: { name: string | null; identifier: string | null }): string =>
    (p.identifier ?? p.name ?? "").toLowerCase();
  const legendEntries = [...distinct.values()]
    .sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
    .map((p) =>
      p.identifier != null && p.name != null && p.identifier !== p.name
        ? `${esc(p.identifier)} — ${esc(p.name)}`
        : esc((p.identifier ?? p.name)!),
    );

  return {
    showColumn: true,
    headerHtml: null,
    thHtml: "<th>Project</th>",
    tdHtml: (row) => {
      const l = label(row);
      if (l == null) return "<td>—</td>";
      const title = row.name != null ? ` title="${esc(row.name)}"` : "";
      return `<td><span class="proj"${title}>${esc(l)}</span></td>`;
    },
    legendHtml:
      legendEntries.length > 0
        ? `<p class="proj-legend">Projects: ${legendEntries.join(" · ")}</p>`
        : "",
  };
}
