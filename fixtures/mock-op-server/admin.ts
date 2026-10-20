import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdvanceDayRequest,
  AdvanceDayResult,
  AppHelperResult,
} from "../scenario-types";
import type { ScenarioEngine } from "./engine";
import { MockEngineError } from "./engine";

/**
 * Admin interface /__mock/* (SPEC_03 §5). This is the OPERATOR's tooling —
 * it is NOT OpenProject and op-client never calls it. Living in a separate
 * namespace keeps the app's GET-only-on-/api/v3/* guardrail unambiguous.
 *
 *  GET  /__mock/scenarios          → ScenarioSummary[]
 *  POST /__mock/load/:name         → MockStateSummary
 *  POST /__mock/advance-day        → AdvanceDayResult  (body: AdvanceDayRequest)
 *  POST /__mock/goto-day/:n        → MockStateSummary
 *  POST /__mock/inject-urgent      → { work_package: WorkPackageStateSummary }
 *  POST /__mock/set-latency-ms     → { latency_ms }  (body: { ms: number })
 *  GET  /__mock/state              → MockStateSummary
 *  POST /__mock/reset              → { mode: "fixtures" }
 *  GET  /__mock/ui (+ /__mock/ui/*) → static control panel from fixtures/mock-ui/
 */

/** fixtures/mock-ui/ — built by Agent M2; 404s gracefully while it's absent. */
const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "mock-ui");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendAdminError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

/** Read + JSON-parse the request body; empty body → {}. */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw === "") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new MockEngineError(400, "Request body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof MockEngineError) throw err;
    throw new MockEngineError(400, "Request body is not valid JSON");
  }
}

/**
 * POST {app_url}{path} — the optional advance-day helper (SPEC_03 §6) that
 * triggers the Sprint Planner's sync/snapshot so burndown grows by itself.
 * NEVER throws: failures are reported as AppHelperResult (e.g.
 * "HTTP 423 VAULT_LOCKED" from the app's error envelope code).
 */
async function postToApp(
  appUrl: string,
  path: string,
  body: unknown,
): Promise<AppHelperResult> {
  const url = `${appUrl.replace(/\/+$/, "")}${path}`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) return { ok: true, detail: null };
    let code: string | null = null;
    try {
      const envelope = (await response.json()) as { error?: { code?: unknown } };
      if (typeof envelope?.error?.code === "string") code = envelope.error.code;
    } catch {
      // Non-JSON error body — report the bare HTTP status.
    }
    return { ok: false, detail: code === null ? `HTTP ${response.status}` : `HTTP ${response.status} ${code}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function handleAdvanceDay(
  engine: ScenarioEngine,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as AdvanceDayRequest;
  const result: AdvanceDayResult = engine.advanceDay();
  // Optional app helper — runs AFTER advancing; failures reported, not thrown.
  if (typeof body.app_url === "string" && body.app_url !== "") {
    const app: NonNullable<AdvanceDayResult["app"]> = {};
    if (body.sync !== false) {
      app.sync = await postToApp(body.app_url, "/api/sync", {});
    }
    if (body.snapshot !== false) {
      app.snapshot = await postToApp(body.app_url, "/api/snapshot", { date: result.date });
    }
    result.app = app;
  }
  sendJson(res, 200, result);
}

function serveUi(path: string, res: ServerResponse): void {
  const rel =
    path === "/__mock/ui" || path === "/__mock/ui/"
      ? "index.html"
      : decodeURIComponent(path.slice("/__mock/ui/".length));
  const file = normalize(join(UI_DIR, rel));
  // Path-traversal guard: the resolved file must stay inside mock-ui/.
  if (file !== UI_DIR && !file.startsWith(UI_DIR + sep)) {
    sendAdminError(res, 404, "Not found");
    return;
  }
  let data: Buffer;
  try {
    data = readFileSync(file);
  } catch {
    // Missing file OR the whole mock-ui/ dir (M2 builds it in parallel).
    sendAdminError(res, 404, `No mock-ui file for ${path}`);
    return;
  }
  res.writeHead(200, {
    "content-type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    "content-length": data.byteLength,
  });
  res.end(data);
}

/** Route one /__mock/* request. Throws MockEngineError for engine failures. */
export async function handleAdmin(
  engine: ScenarioEngine,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const requireMethod = (expected: string): boolean => {
    if (method === expected) return true;
    sendAdminError(res, 405, `${path} requires ${expected}`);
    return false;
  };

  if (path === "/__mock/scenarios") {
    if (requireMethod("GET")) sendJson(res, 200, await engine.listScenarios());
    return;
  }
  if (path === "/__mock/state") {
    if (requireMethod("GET")) sendJson(res, 200, engine.stateSummary());
    return;
  }
  if (path === "/__mock/ui" || path.startsWith("/__mock/ui/")) {
    if (requireMethod("GET")) serveUi(path, res);
    return;
  }

  const loadMatch = /^\/__mock\/load\/([^/]+)$/.exec(path);
  if (loadMatch !== null) {
    if (requireMethod("POST")) {
      sendJson(res, 200, await engine.load(decodeURIComponent(loadMatch[1]!)));
    }
    return;
  }
  if (path === "/__mock/advance-day") {
    if (requireMethod("POST")) await handleAdvanceDay(engine, req, res);
    return;
  }
  const gotoMatch = /^\/__mock\/goto-day\/([^/]+)$/.exec(path);
  if (gotoMatch !== null) {
    if (requireMethod("POST")) {
      const raw = decodeURIComponent(gotoMatch[1]!);
      const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
      sendJson(res, 200, engine.gotoDay(n));
    }
    return;
  }
  if (path === "/__mock/inject-urgent") {
    if (requireMethod("POST")) {
      sendJson(res, 200, { work_package: engine.injectUrgent() });
    }
    return;
  }
  // SPEC_19 §2 abort-test harness: inject an artificial delay before every
  // work_packages collection response so a paged sync stays "in flight" long
  // enough to click Abort. Pure test surface (like every /__mock/* route) —
  // op-client never targets /__mock, so this cannot affect the read-only-to-OP
  // guardrail. A fresh /__mock/load/:name (or { ms: 0 }) resets it to off.
  if (path === "/__mock/set-latency-ms") {
    if (requireMethod("POST")) {
      const body = await readJsonBody(req);
      const ms = typeof body.ms === "number" ? body.ms : Number(body.ms);
      const applied = engine.setWorkPackagesLatency(ms);
      sendJson(res, 200, { latency_ms: applied });
    }
    return;
  }
  if (path === "/__mock/reset") {
    if (requireMethod("POST")) {
      engine.reset();
      sendJson(res, 200, { mode: "fixtures" });
    }
    return;
  }

  sendAdminError(res, 404, `No mock admin route for ${path}`);
}
