/**
 * Mock OP scenario control panel (SPEC_03 §6).
 *
 * Plain vanilla JS, no build step, no framework, no CDN. Served BY the mock at
 * /__mock/ui, so every fetch below is same-origin against the mock's admin API
 * (/__mock/*) — no CORS anywhere, and the OP namespace /api/v3/* is never
 * touched from here.
 */
"use strict";

const $ = (id) => document.getElementById(id);

// ── Same-origin admin API ────────────────────────────────────────────────────

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${method} ${path}${text ? ` — ${text.slice(0, 300)}` : ""}`);
  }
  return text ? JSON.parse(text) : null;
}

// ── Messages ─────────────────────────────────────────────────────────────────

function setMessage(text, kind) {
  const el = $("message");
  el.textContent = text || "";
  el.className = `message${kind ? ` ${kind}` : ""}`;
}

// ── Scenario dropdown ────────────────────────────────────────────────────────

let scenarioList = [];

function showDescription() {
  const selected = scenarioList.find((s) => s.name === $("scenario-select").value);
  $("scenario-description").textContent = selected
    ? `${selected.description} (start ${selected.start_date}, ${selected.total_days} timeline day${selected.total_days === 1 ? "" : "s"})`
    : "";
}

async function loadScenarioList() {
  scenarioList = await api("GET", "/__mock/scenarios");
  const select = $("scenario-select");
  select.replaceChildren(
    ...scenarioList.map((s) => {
      const option = document.createElement("option");
      option.value = s.name;
      option.textContent = `${s.name} (${s.total_days}d)`;
      option.title = s.description;
      return option;
    }),
  );
  showDescription();
}

// ── State rendering ──────────────────────────────────────────────────────────

function td(text, className) {
  const cell = document.createElement("td");
  cell.textContent = text;
  if (className) cell.className = className;
  return cell;
}

const hours = (v) => (v === null || v === undefined ? "–" : `${v}h`);

function renderState(state) {
  if (state.scenario === null) {
    $("state-meta").textContent = "mode: fixtures (no scenario loaded — legacy static mock)";
  } else {
    $("state-meta").textContent =
      `scenario: ${state.scenario} · day ${state.day}/${state.total_days} · ` +
      `date ${state.date ?? "–"} · pending days: ${state.pending_days}`;
  }
  const tbody = $("wp-tbody");
  tbody.replaceChildren(
    ...state.work_packages.map((wp) => {
      const row = document.createElement("tr");
      row.append(
        td(String(wp.id)),
        td(wp.subject, "subject"),
        td(wp.status),
        td(wp.assignee ?? "–"),
        td(wp.accountable ?? "–"),
        td(hours(wp.estimated_hours), "num"),
        td(hours(wp.remaining_hours), "num"),
        td(hours(wp.spent_hours), "num"),
        td(wp.version ?? "–"),
        td(wp.updated_at),
      );
      return row;
    }),
  );
  if (state.work_packages.length === 0) {
    const row = document.createElement("tr");
    const cell = td("no scenario work packages (fixture mode serves fixtures/data/*.json)", "empty");
    cell.colSpan = 10;
    row.append(cell);
    tbody.append(row);
  }
}

async function refreshState() {
  renderState(await api("GET", "/__mock/state"));
}

// ── Sprint Planner helper results ────────────────────────────────────────────

function helperLine(kind, result) {
  const line = document.createElement("span");
  if (result.ok) {
    line.className = "ok";
    line.textContent = `${kind}: OK${result.detail ? ` (${result.detail})` : ""}`;
  } else {
    line.className = "fail";
    const hint = /423/.test(result.detail ?? "") ? " — unlock the app vault" : "";
    line.textContent = `${kind}: ${result.detail ?? "failed"}${hint}`;
  }
  return line;
}

function renderHelperResults(app) {
  const box = $("helper-results");
  box.replaceChildren();
  if (!app) return;
  if (app.sync) box.append(helperLine("sync", app.sync));
  if (app.snapshot) box.append(helperLine("snapshot", app.snapshot));
}

// ── Actions ──────────────────────────────────────────────────────────────────

const BUTTONS = ["btn-load", "btn-advance", "btn-urgent", "btn-reset", "btn-refresh"];

async function action(fn) {
  for (const id of BUTTONS) $(id).disabled = true;
  try {
    setMessage("");
    await fn();
  } catch (e) {
    setMessage(e instanceof Error ? e.message : String(e), "error");
  } finally {
    for (const id of BUTTONS) $(id).disabled = false;
  }
}

$("btn-load").addEventListener("click", () =>
  action(async () => {
    const name = $("scenario-select").value;
    if (!name) throw new Error("no scenario selected");
    const state = await api("POST", `/__mock/load/${encodeURIComponent(name)}`);
    renderHelperResults(null);
    renderState(state);
    setMessage(`loaded "${name}" at day 0 (${state.date})`, "ok");
  }),
);

$("btn-advance").addEventListener("click", () =>
  action(async () => {
    const sync = $("helper-sync").checked;
    const snapshot = $("helper-snapshot").checked;
    const appUrl = $("app-url").value.trim();
    // Only involve the Sprint Planner when a helper is enabled (SPEC_03 §6).
    const body = (sync || snapshot) && appUrl ? { app_url: appUrl, sync, snapshot } : {};
    const result = await api("POST", "/__mock/advance-day", body);
    renderHelperResults(result.app);
    setMessage(`advanced to day ${result.day} (${result.date}), applied ${result.applied_events} event(s)`, "ok");
    await refreshState();
  }),
);

$("btn-urgent").addEventListener("click", () =>
  action(async () => {
    const result = await api("POST", "/__mock/inject-urgent");
    const wp = result.work_package;
    setMessage(`injected urgent WP #${wp.id} "${wp.subject}"`, "ok");
    await refreshState();
  }),
);

$("btn-reset").addEventListener("click", () =>
  action(async () => {
    await api("POST", "/__mock/reset");
    renderHelperResults(null);
    setMessage("mock reset to fixture mode", "ok");
    await refreshState();
  }),
);

$("btn-refresh").addEventListener("click", () => action(refreshState));
$("scenario-select").addEventListener("change", showDescription);

// ── Boot ─────────────────────────────────────────────────────────────────────

action(async () => {
  await loadScenarioList();
  await refreshState();
});
