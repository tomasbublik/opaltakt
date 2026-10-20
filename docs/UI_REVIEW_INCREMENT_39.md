# UI review — Increment 39 (OpalTakt rebrand + chrome refresh)

Scope: header, global tokens/typography/controls (`apps/web/src/styles.css`), PDF report
styling. Capacity-bar colours and semantics are untouched (`docs/CAPACITY_BAR_RULES.md`):
no `.bar-*`, `.badge.removed`, `.card-removed` or `--capacity-*`, `--ok`, `--danger`, `--warn`,
`--brand-orange-600` value changed.

## Findings

| # | Severity | Finding |
|---|----------|---------|
| 1 | High (reported bug) | Header overflowed the right edge. Root cause: one non-wrapping flex row held brand + connection chip + 11 nowrap tab buttons (`.nav {flex:1}`) + the nowrap sync cluster (and the refresh-all summary was a flex *child* of the header row). Sum of intrinsic widths > viewport at <= 1440px, so "Last synced ..." / Sync now / Full refresh ran off-screen; "Sprint board" also wrapped to two lines. |
| 2 | Medium | Dark-navy header with orange active tab: loud, brand-heavy, low hierarchy; orange also used for the version-mismatch warning, competing with the capacity-bar orange marker. |
| 3 | Medium | Backlog/Import (and other wide) tables widened the whole page below ~1100px (page-level horizontal scroll). |
| 4 | Medium | No consistent keyboard focus style; secondary buttons/inputs had no hover/focus affordance. |
| 5 | Low | Amber text (`--warn` #d97706 on `--warn-bg`) is ~3:1 — below AA for small text; green/red text on tinted chips borderline. |
| 6 | Low | Ad-hoc radii/shadows/spacing, no type scale; system font only. |
| 7 | Low (functional) | e2e `tc-status-capacity-changelog-scoping.spec.ts:292` clicks heading "OP Sprint Planner" — now "OpalTakt" (tests/** is out of scope here; must be updated). |

## What changed

- **Rebrand:** `apps/web/index.html` title, header/gate `<h1>`, PDF titles + a "OpalTakt · Sprint report/status" masthead and footer
  (`report.ts`, `statusReport.ts` — markup/CSS only), README title/intro, root `package.json` name `opaltakt`,
  Data-import error wording. Internal ids (`@osp/*`, `OSP_*`, `osp*` DBs) untouched.
- **Logo:** `BrandMark` (exported) is now a slate rounded tile with three decreasing bars in pearl / indigo / cyan tints
  (stylised burndown + opal iridescence), inline SVG, fixed literals (never capacity tokens).
- **Header layout (fix):** two rows — top: brand, connection chip, spacer, sync status + actions, reserved empty
  `.app-header-account` slot for the future "user - role badge - Sign out" cluster; second: tabs (`.nav`, nowrap,
  underline active state, horizontal scroll only as a last resort < ~900px). The sync sentence ellipsises
  (`.sync-text`, full text in DOM/title) so buttons never get pushed out; the top row can wrap. Refresh-all summary is a
  full-width row. All aria-labels, test ids, button labels and props preserved.
  Verified no header overflow at 1024/1280/1440/1920 (and 900 via tab scroll).
- **Chrome refresh:** white sticky header with hairline rule, slate neutrals, single indigo accent (`--primary`),
  spacing/radius/shadow tokens, Inter (Google Fonts, system fallback), unified `:focus-visible` ring, button/input hover
  states, quieter table headers + row hover, AA-safe amber/green/red text (`--warn-text` etc.), version badge as a pill.
- **Tables:** all `<table>`s wrapped in `.table-scroll` so wide tables scroll inside their panel.

## Recommended follow-ups (not done)

- Update the e2e heading selector (finding 7).
- Replace the many inline `style={{...}}` in screens (spacing, colours) with classes/tokens; they bypass the scale.
- Sprint board is very dense (capacity, double-counting warning, columns); consider collapsible sections and a sticky
  sprint selector.
- Responsive pass below 900px (nothing was designed for tablets/phones); consider a tab overflow menu.
- Self-host Inter (the app is local/offline-capable; Google Fonts is a runtime dependency) or drop the font link.
- Dark theme; `prefers-reduced-motion`; audit contrast of capacity hatch colours against AA for non-text graphics.
- PDF: add page numbers/header via Chromium `displayHeaderFooter` (renderer lives in report.ts; touches logic, so skipped).

## Possible real bugs noticed

- Closure screen (active sprint, mock): Planned 68h vs Baseline 72h with identical scope and no changes; likely intended
  (Planned = current scope per Increment 30) but worth confirming against the mock data.
- Backlog/Velocity/Import panels show "Loading..." for a noticeable moment on every tab switch (no cached data).
- The double-counting warning is shown on the mock sprint where #1001 is parent of #1002 — expected.
