import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FOREIGN_DATABASES,
  FORBIDDEN_DATABASES,
  THROWAWAY_DB_PATTERN,
  assertThrowawayDatabase,
  databaseNameFromUrl,
  isPgliteUrl,
  judgeDatabaseUrl,
  throwawayDatabaseName,
} from "./db-isolation";

/**
 * ⛔⛔ THE HARD ISOLATION GUARDRAIL — Postgres edition (Increment 27).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THIS FILE IS THE CODIFIED MEMORY OF A REAL DATA-LOSS INCIDENT.
 * If a change makes it fail, the change is wrong until proven otherwise.
 * Never weaken an assertion here to make a suite go green.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * WHAT HAPPENED. During Increment 11 a background agent ran the API with
 * NEITHER an explicit DB target NOR an explicit PORT. The server silently fell
 * back to the user's real database and, while live-testing the new
 * "Delete sprint" feature in a browser, PERMANENTLY DESTROYED every sprint the
 * user had — baselines, changelog, burndown, capacity, closure. No undo, no
 * backup. (OpenProject itself was untouched: this app is GET-only to OP by a
 * separate invariant. The loss was purely local planning data.)
 *
 * WHY IT STILL MATTERS AFTER THE POSTGRES CUT. Increment 27 replaced SQLite
 * with Postgres and `OSP_DB_PATH` with `DATABASE_URL`. The engine changed; the
 * failure mode did not — and one aspect got WORSE. Under SQLite, a wrong path
 * created a new *empty file*: annoying, not fatal. Under Postgres, a wrong
 * `DATABASE_URL` drops you inside an *existing, populated* database. On this
 * machine that is either `osp` (the user's real data) or `atlas-core` (a totally
 * unrelated project sharing the same server), so a stray migration or DELETE is
 * now cross-project data loss.
 *
 * WHAT THIS SUITE PROVES — four independent layers, deliberately redundant:
 *
 *   §1 POLICY. The pure decision function in `db-isolation.ts` is airtight:
 *      deny-by-default, explicit denylist for the catastrophic names, an
 *      anchored allowlist for throwaway shapes, case-insensitive, and it
 *      rejects a URL that names no database at all (which would silently
 *      resolve, server-side, to a database named after the OS user).
 *
 *   §2 DIRECT PROCESS PROOF. Spawn the REAL server entrypoint with
 *      `DATABASE_URL` and `PORT` actively DELETED from the child's environment
 *      and assert it exits non-zero, fast, with a "refusing to start" message,
 *      never announcing a listen. Proven for both guards independently.
 *
 *   §3 REPO-SCAN TRIPWIRE. Grep every checked-in script/config/skill that can
 *      boot the API and assert none reintroduces a bare invocation without an
 *      accompanying DATABASE_URL/PORT. Catches the regression BEFORE anyone
 *      runs it.
 *
 *   §4 NO FORBIDDEN NAME ANYWHERE. No checked-in test/config may hard-code a
 *      connection string pointing at `osp` or `atlas-core`.
 *
 * (The complementary e2e-level tripwire — "the e2e stack ran against a
 * throwaway database, and the user's real one was never opened" — lives in the
 * Playwright config plus tests/e2e/specs/te-retrospective-planning.spec.ts.)
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// tests/src/ → repo root is two levels up.
const REPO_ROOT = path.resolve(__dirname, "..", "..");

// ─────────────────────────────────────────────────────────────────────────────
// §1 — the policy function itself
// ─────────────────────────────────────────────────────────────────────────────

describe("§1 isolation policy — judgeDatabaseUrl is deny-by-default", () => {
  it("REJECTS the user's real database `osp`, in every spelling", () => {
    for (const url of [
      "postgres://dev@localhost:5432/osp",
      "postgresql://dev@localhost:5432/osp",
      "postgres://dev@localhost:5432/OSP", // PG folds identifiers
      "postgres://dev:pw@127.0.0.1:5432/osp",
      "postgres://dev@localhost:5432/osp?sslmode=disable",
      "  postgres://dev@localhost:5432/osp  ", // stray whitespace
    ]) {
      const verdict = judgeDatabaseUrl(url);
      expect(verdict.ok, `MUST reject ${url}`).toBe(false);
      expect(verdict.database).toBe("osp");
      expect(() => assertThrowawayDatabase(url)).toThrow(/REFUSING/);
    }
  });

  it("REJECTS another project's database listed in OSP_FOREIGN_DATABASES", () => {
    const url = "postgres://dev@localhost:5432/other-project";
    // Rejected twice over: not throwaway-shaped, and on the explicit denylist.
    expect(judgeDatabaseUrl(url).ok).toBe(false);
    expect(judgeDatabaseUrl(url, [...FORBIDDEN_DATABASES, "other-project"]).reason).toMatch(/denylist/);
    expect(() => assertThrowawayDatabase(url)).toThrow(/denylist|throwaway/i);
    for (const db of FOREIGN_DATABASES) {
      expect(FORBIDDEN_DATABASES, `${db} from OSP_FOREIGN_DATABASES must be denylisted`).toContain(db);
    }
  });

  it("REJECTS the admin/default databases (postgres, template0/1, the OS-user DB)", () => {
    for (const db of ["postgres", "template0", "template1", os.userInfo().username]) {
      const url = `postgres://dev@localhost:5432/${db}`;
      expect(judgeDatabaseUrl(url).ok, `MUST reject ${db}`).toBe(false);
    }
  });

  it("REJECTS a URL that names NO database (PG would fall back to the OS-user DB)", () => {
    for (const url of [
      "postgres://dev@localhost:5432",
      "postgres://dev@localhost:5432/",
      "postgres://localhost",
    ]) {
      const verdict = judgeDatabaseUrl(url);
      expect(verdict.ok, `MUST reject ${url}`).toBe(false);
      expect(verdict.database).toBeNull();
    }
  });

  it("REJECTS unset/empty — there is NO default, ever", () => {
    for (const url of [undefined, null, "", "   "]) {
      expect(judgeDatabaseUrl(url).ok).toBe(false);
      expect(() => assertThrowawayDatabase(url)).toThrow();
    }
  });

  it("REJECTS names that merely LOOK throwaway (substring/prefix/suffix traps)", () => {
    // Every one of these would slip past a naive `includes("osp_test")` or a
    // non-anchored regex. They are exactly the typos that end careers.
    for (const db of [
      "osp_prod", // wrong bucket
      "ospx", // typo'd real DB
      "osp2", // typo'd real DB
      "osp_test", // no unique suffix → could be a shared, long-lived DB
      "xosp_test_1", // prefixed
      "my_osp_e2e_1", // embedded
      "osp-test-1", // hyphens, not the sanctioned shape
      "OSP", // the real one, shouting
    ]) {
      const url = `postgres://dev@localhost:5432/${db}`;
      expect(judgeDatabaseUrl(url).ok, `MUST reject ${db}`).toBe(false);
    }
  });

  it("REJECTS non-Postgres connection strings (a leftover SQLite path must not pass)", () => {
    for (const url of [
      "./osp.sqlite",
      "/home/dev/op-sprint-planning/apps/api/osp.sqlite",
      ":memory:",
      "mysql://localhost/osp_test_1",
    ]) {
      expect(judgeDatabaseUrl(url).ok, `MUST reject ${url}`).toBe(false);
    }
  });

  it("ACCEPTS in-process PGlite — it cannot reach a shared server at all", () => {
    for (const url of ["pglite", "pglite://", "PGlite:", "memory://"]) {
      expect(isPgliteUrl(url)).toBe(true);
      expect(judgeDatabaseUrl(url).ok, `must accept ${url}`).toBe(true);
      expect(() => assertThrowawayDatabase(url)).not.toThrow();
    }
  });

  it("ACCEPTS a properly-shaped throwaway database", () => {
    for (const db of [
      "osp_test_e_12345",
      "osp_test_1_real",
      "osp_e2e_99887",
      "osp_smoke_abc123",
    ]) {
      const url = `postgres://dev@localhost:5432/${db}`;
      const verdict = judgeDatabaseUrl(url);
      expect(verdict.ok, `must accept ${db}: ${verdict.reason}`).toBe(true);
      expect(verdict.database).toBe(db);
    }
  });

  it("throwawayDatabaseName() always produces a name its own policy accepts, and never collides", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const name = throwawayDatabaseName();
      expect(THROWAWAY_DB_PATTERN.test(name), `${name} must match the allowlist`).toBe(true);
      expect(FORBIDDEN_DATABASES).not.toContain(name);
      expect(seen.has(name), `collision on ${name}`).toBe(false);
      seen.add(name);
      expect(() =>
        assertThrowawayDatabase(`postgres://dev@localhost:5432/${name}`),
      ).not.toThrow();
    }
    for (const prefix of ["test", "e2e", "smoke"] as const) {
      expect(THROWAWAY_DB_PATTERN.test(throwawayDatabaseName(prefix))).toBe(true);
    }
  });

  it("databaseNameFromUrl lower-cases and URL-decodes, so no encoding trick evades the denylist", () => {
    expect(databaseNameFromUrl("postgres://h/%6Fsp")).toBe("osp"); // %6F === 'o'
    expect(judgeDatabaseUrl("postgres://h/%6Fsp").ok).toBe(false);
    expect(databaseNameFromUrl("postgres://h/other%2Dproject")).toBe("other-project");
    expect(judgeDatabaseUrl("postgres://h/other%2Dproject", ["other-project"]).ok).toBe(false);
  });

  it("the error message names the incident, so whoever hits it understands the stakes", () => {
    expect(() =>
      assertThrowawayDatabase("postgres://dev@localhost:5432/osp"),
    ).toThrow(/Increment 11/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §1b — this very test process must itself be isolated
// ─────────────────────────────────────────────────────────────────────────────

describe("§1b the vitest process itself is not aimed at real data", () => {
  it("if DATABASE_URL is exported into this test run at all, it is a throwaway", () => {
    const url = process.env.DATABASE_URL;
    if (url === undefined) return; // the normal case: unit tests use PGlite
    expect(
      judgeDatabaseUrl(url).ok,
      `DATABASE_URL is exported into the vitest environment as ${JSON.stringify(url)} — ` +
        "a test could pick it up. It must be a throwaway or unset.",
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — the server refuses to boot bare (direct process proof)
// ─────────────────────────────────────────────────────────────────────────────

interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  timedOut: boolean;
  spawnError?: string;
}

/**
 * Boot the REAL API entrypoint exactly as an agent would (`pnpm --filter
 * @osp/api start`, from the repo root), but with a caller-controlled env. The
 * two guard vars are ACTIVELY deleted by the caller (not merely "not set") so
 * that a CI/shell that happens to export them from something else can't mask
 * the guard. Collects stdout+stderr, resolves on exit, and hard-kills after a
 * timeout so a (bug-)server that somehow DID boot can't hang the test.
 */
function bootApi(env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn("pnpm", ["--filter", "@osp/api", "start"], {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    const onData = (buf: Buffer): void => {
      output += buf.toString();
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      // e.g. pnpm not on PATH in this environment — not a guard failure.
      resolve({ code: null, signal: null, output, timedOut, spawnError: String(err) });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output, timedOut });
    });
  });
}

/** A copy of the current env with the given vars stripped out. */
function envWithout(...unset: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of unset) delete env[k];
  return env;
}

describe("§2 isolation guard — the server REFUSES to boot bare (direct process proof)", () => {
  it(
    "exits non-zero and complains when BOTH DATABASE_URL and PORT are unset (never opens a DB)",
    async () => {
      const res = await bootApi(envWithout("DATABASE_URL", "PORT", "PGDATABASE", "PGHOST"));

      if (res.spawnError) {
        // pnpm/tsx unavailable in this sandbox — can't prove it here, the
        // repo-scan + §1 policy still cover the guardrail. Don't false-fail.
        console.warn(`[§2] skipping direct boot proof: ${res.spawnError}`);
        return;
      }

      expect(res.timedOut, "bare boot must NOT hang/keep listening — it must exit fast").toBe(false);
      expect(res.code, `expected a non-zero exit, got ${res.code}. Output:\n${res.output}`).not.toBe(0);
      expect(res.code, "must exit (not be killed by our timeout signal)").not.toBeNull();
      // The message must clearly name at least one required var and say it's refusing.
      expect(
        /DATABASE_URL|PORT/.test(res.output),
        `error output must name a required env var. Output:\n${res.output}`,
      ).toBe(true);
      expect(
        /refusing to start|is not set|not set|required/i.test(res.output),
        `error output must state it is refusing to start / the var is required. Output:\n${res.output}`,
      ).toBe(true);
      // Belt-and-suspenders: it must NOT have announced a successful listen.
      expect(/listening|server listening|running at/i.test(res.output)).toBe(false);
    },
    45_000,
  );

  it(
    "with PORT set but DATABASE_URL unset, still refuses — proving the DB guard fires independently",
    async () => {
      // An ephemeral high port it must never actually bind (the DB guard throws
      // first). Chosen well away from the fixed e2e ports (8199/3199/5199).
      const env = envWithout("DATABASE_URL", "PGDATABASE", "PGHOST");
      env.PORT = "34199";
      const res = await bootApi(env);

      if (res.spawnError) {
        console.warn(`[§2] skipping direct boot proof (PORT-set case): ${res.spawnError}`);
        return;
      }

      expect(res.timedOut, "must not hang").toBe(false);
      expect(res.code, `expected non-zero exit, got ${res.code}. Output:\n${res.output}`).not.toBe(0);
      expect(
        /DATABASE_URL/.test(res.output),
        `with PORT set, the DATABASE_URL guard must be the one that fires. Output:\n${res.output}`,
      ).toBe(true);
      expect(
        /refusing to start|is not set|not set/i.test(res.output),
        `must state it's refusing to start. Output:\n${res.output}`,
      ).toBe(true);
      expect(/listening|server listening|running at/i.test(res.output)).toBe(false);
    },
    45_000,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 / §4 — repo-scan tripwires
// ─────────────────────────────────────────────────────────────────────────────

describe("§3 isolation guard — no checked-in script boots the API bare (repo-scan tripwire)", () => {
  /**
   * Every checked-in file that CAN launch apps/api. Pragmatic + targeted:
   * false negatives are acceptable, false positives are NOT — so the match
   * below only flags an invocation that actually *selects the API package* (or
   * a repo-wide parallel `dev` that starts it), and accepts an env supplied
   * either on the same line or in a clearly-scoped surrounding block (e.g. a
   * Playwright webServer entry's `env: { PORT, DATABASE_URL }`).
   */
  function candidateFiles(): string[] {
    const fixed = [
      path.join(REPO_ROOT, "package.json"),
      path.join(REPO_ROOT, "apps", "api", "package.json"),
      path.join(REPO_ROOT, "tests", "playwright.config.ts"),
    ];
    const skillsDir = path.join(REPO_ROOT, ".claude", "skills");
    const skillFiles: string[] = [];
    if (fs.existsSync(skillsDir)) {
      for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const skillMd = path.join(skillsDir, entry.name, "SKILL.md");
        if (fs.existsSync(skillMd)) skillFiles.push(skillMd);
      }
    }
    return [...fixed, ...skillFiles].filter((f) => fs.existsSync(f));
  }

  // An invocation that boots apps/api: a pnpm run that SELECTS @osp/api and
  // runs dev|start, OR a repo-wide `pnpm -r ... dev` (which starts the api among
  // the rest). Deliberately does NOT match apps/api/package.json's own leaf
  // scripts (`tsx src/index.ts`) — those are the definitions, can't carry env,
  // and are backstopped by index.ts/server.ts throwing without the vars.
  const BOOT_PATTERNS: RegExp[] = [
    /pnpm\b[^\n]*@osp\/api[^\n]*\b(?:dev|start)\b/,
    /pnpm\b[^\n]*\s-r\b[^\n]*\bdev\b/,
  ];
  const WINDOW = 12; // lines of surrounding context that count as "same block"

  function isBootLine(line: string): boolean {
    return BOOT_PATTERNS.some((re) => re.test(line));
  }

  it("finds at least one boot invocation to scan (guards against the regex silently matching nothing)", () => {
    const files = candidateFiles();
    expect(files.length, "expected to find checked-in files that can boot the API").toBeGreaterThan(0);
    let bootLines = 0;
    for (const file of files) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      bootLines += lines.filter(isBootLine).length;
    }
    expect(
      bootLines,
      "the scanner matched ZERO boot invocations — the pattern likely broke; without a real match the guard is vacuous",
    ).toBeGreaterThan(0);
  });

  it("every API-boot invocation supplies DATABASE_URL and PORT (same line or a clearly-scoped block)", () => {
    const violations: string[] = [];
    for (const file of candidateFiles()) {
      const rel = path.relative(REPO_ROOT, file);
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!isBootLine(line)) return;
        const sameLineOk = /DATABASE_URL/.test(line) && /PORT/.test(line);
        const block = lines.slice(Math.max(0, i - WINDOW), i + WINDOW + 1).join("\n");
        const blockOk = /DATABASE_URL/.test(block) && /PORT/.test(block);
        if (!sameLineOk && !blockOk) {
          violations.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(
      violations,
      "these API-boot invocations lack an accompanying DATABASE_URL/PORT override — the exact class of mistake that destroyed the user's data in Increment 11:\n" +
        violations.join("\n"),
    ).toEqual([]);
  });

  it("`OSP_DB_PATH` is fully retired — no checked-in boot config may still rely on it", () => {
    // Increment 27 deleted OSP_DB_PATH. A leftover ASSIGNMENT in a boot config
    // means someone believes they set a DB target when they set nothing at all,
    // and the server would then be started with DATABASE_URL unset.
    // Only assignments count (`OSP_DB_PATH=…` / `OSP_DB_PATH: …`); prose that
    // merely mentions the retired variable to say it is retired is fine.
    const ASSIGNMENT = /OSP_DB_PATH\s*[=:]/;
    const stale: string[] = [];
    for (const file of candidateFiles()) {
      const text = fs.readFileSync(file, "utf8");
      if (ASSIGNMENT.test(text)) stale.push(path.relative(REPO_ROOT, file));
    }
    expect(
      stale,
      `these boot configs still mention OSP_DB_PATH, which no longer does anything: ${stale.join(", ")}`,
    ).toEqual([]);
  });
});

describe("§4 isolation guard — no automated test points at a forbidden database", () => {
  /**
   * Every file a TEST RUN executes: the whole `tests/` package plus every
   * co-located `*.test.ts`.
   *
   * Deliberately NOT scanned:
   *  • non-test application source — `apps/api/src/server.ts` legitimately
   *    NAMES the real database in its "refusing to start" message, because
   *    telling a human what to set is the entire point of that message;
   *  • `scripts/` — `backup.sh`/`restore.sh` exist to act on the real
   *    database, run by a human with an explicit DATABASE_URL.
   * Automated tests are the thing that must never name it, and they are what
   * this scans.
   */
  function testFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string, all: boolean): void => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === "test-results" || e.name.startsWith(".")) {
          continue;
        }
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, all);
        else if (/\.(ts|tsx|js|mjs)$/.test(e.name) && (all || e.name.includes(".test."))) {
          out.push(full);
        }
      }
    };
    walk(path.join(REPO_ROOT, "tests"), true);
    walk(path.join(REPO_ROOT, "apps"), false);
    walk(path.join(REPO_ROOT, "packages"), false);
    return out;
  }

  /**
   * Blank out comments so explanatory prose ("never point this at
   * postgres://…/osp") isn't mistaken for a connection target. Crude but
   * sufficient — and it errs toward scanning MORE, never less.
   */
  function stripComments(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  }

  it("no test file hard-codes a connection string naming a forbidden database", () => {
    const URL_RE = /postgres(?:ql)?:\/\/[^\s"'`]+/g;
    const violations: string[] = [];
    for (const file of testFiles()) {
      // This very file (and the policy module) legitimately contain forbidden
      // URLs — as the NEGATIVE test data that proves they are rejected.
      const rel = path.relative(REPO_ROOT, file);
      if (rel.endsWith("env-isolation-guard.test.ts") || rel.endsWith("db-isolation.ts")) continue;
      const text = stripComments(fs.readFileSync(file, "utf8"));
      for (const match of text.match(URL_RE) ?? []) {
        // Skip templated URLs (`.../${dbName}`) — resolved at runtime and
        // covered by the assertThrowawayDatabase call at the use site.
        if (match.includes("${")) continue;
        const db = databaseNameFromUrl(match);
        if (db !== null && FORBIDDEN_DATABASES.includes(db)) {
          violations.push(`${rel}: ${match}`);
        }
      }
    }
    expect(
      violations,
      "an automated test points a connection string at a REAL database. This is how Increment 11 happened:\n" +
        violations.join("\n"),
    ).toEqual([]);
  });
});
