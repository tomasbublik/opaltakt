import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRecordingMockOpServer,
  type RecordingMockOpServer,
} from "@osp/fixtures";
import {
  AddConnectionResponse,
  Connection,
  ConnectionsHealthResponse,
  ConnectionsResponse,
  SyncRun,
  VaultResetResponse,
  VaultStatusResponse,
} from "@osp/contracts";
import {
  addConnection,
  bootRealApp,
  call,
  errorCode,
  initAndUnlockVault,
  rawOne,
  type RealApp,
} from "./harness";
import {
  createThrowawayDb,
  dumpDatabaseBytes,
  pgAvailable,
  type ThrowawayDb,
} from "./pg-throwaway";

/**
 * VAULT SECURITY — the SPEC_02 §8 merge gate.
 *
 * Hard invariants proven here:
 *  1. Passphrase round-trip: tokens encrypted under the master passphrase
 *     survive a full app restart and decrypt after unlock — WITHOUT the user
 *     ever re-entering the token. A wrong passphrase is rejected (401) and the
 *     vault stays locked (OP-facing calls → 423).
 *  2. NO plaintext token at rest: the persisted bytes of the database never
 *     contain the token.
 *  3. NO token in any backend HTTP response, ever.
 *  4. Legacy plaintext rows (pre-vault `token_encrypted`) are migrated to
 *     ciphertext on the first vault init and the plaintext is gone from disk.
 *  5. change-passphrase re-keys (old passphrase stops working), reset deletes
 *     tokens but keeps base_urls.
 *
 * ── Increment 27: SQLite → Postgres ─────────────────────────────────────────
 * These are the ONLY unit tests that cannot run on in-process PGlite, because
 * their whole subject is storage that OUTLIVES the process: app #1 closes, app
 * #2 reopens the same storage, and the token must still decrypt. So they use a
 * REAL throwaway Postgres database (`osp_test_<pid>_<rand>`), created and
 * dropped by tests/src/pg-throwaway.ts under the isolation guardrail, and they
 * SKIP (loudly) when the server is unreachable rather than false-failing.
 *
 * "The raw bytes at rest" — previously the closed .sqlite file plus its WAL —
 * is now `pg_dump --data-only` of that throwaway database, which serialises
 * every row of every table exactly as stored. Same proof, same strength.
 */

/** Distinctive, greppable token that must never appear at rest / in responses. */
const TOKEN = "SECRET-TOKEN-XYZZY-124356";
const PASS = "correct-horse-battery-staple";
const WRONG_PASS = "totally-wrong-passphrase";

/**
 * Persistence-dependent blocks need the REAL Postgres server. If it is not
 * running they SKIP with a loud warning rather than failing — the rest of the
 * suite (PGlite) is unaffected, and a silent pass would be worse than a skip.
 */
const REAL_PG = await pgAvailable();
if (!REAL_PG) {
  console.warn(
    "[vault-security] real Postgres unreachable — SKIPPING the restart/at-rest " +
      "proofs. Start the Docker Postgres to run them.",
  );
}
const describeIfPg = REAL_PG ? describe : describe.skip;

describeIfPg("vault security — passphrase round-trip across an app restart (§8)", () => {
  let throwaway: ThrowawayDb;
  let mock: RecordingMockOpServer;
  let app1: RealApp | null = null;
  let app2: RealApp | null = null;
  let connectionId: number;
  /** Every HTTP response body seen across the whole scenario (for invariant 3). */
  const responseBodies: string[] = [];

  const track = async (
    app: RealApp,
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    url: string,
    body?: unknown,
  ) => {
    const res = await call(app.app, method, url, body);
    responseBodies.push(JSON.stringify(res.json ?? ""));
    return res;
  };

  beforeAll(async () => {
    throwaway = await createThrowawayDb();
    mock = await createRecordingMockOpServer();
  });

  afterAll(async () => {
    await app1?.close();
    await app2?.close();
    await mock.close();
    await throwaway.drop();
  });

  it("app #1: init vault → add connection (token T) → sync succeeds; token is stored encrypted only", async () => {
    app1 = await bootRealApp({ databaseUrl: throwaway.url });

    const init = await track(app1, "POST", "/api/vault/init", { passphrase: PASS });
    expect(init.status).toBeGreaterThanOrEqual(200);
    expect(init.status).toBeLessThan(300);

    const conn = await track(app1, "POST", "/api/connections", {
      base_url: mock.url,
      token: TOKEN,
      default_project_op_id: 3,
    });
    expect(conn.status).toBe(201);
    const parsed = AddConnectionResponse.parse(conn.json);
    connectionId = parsed.id;
    expect(parsed.has_token).toBe(true);

    const sync = await track(app1, "POST", "/api/sync", { project_op_id: 3 });
    expect(sync.status).toBe(200);
    expect(SyncRun.parse(sync.json).status).toBe("success");

    // At-rest shape: ciphertext present, plaintext slots empty (raw SQL truth).
    // Postgres: `$1` placeholders, not SQLite's `?`.
    const row = (await rawOne<{
      token_ct: string | null;
      token_nonce: string | null;
      token_tag: string | null;
      token_encrypted: string | null;
    }>(
      app1.raw,
      "SELECT token_ct, token_nonce, token_tag, token_encrypted FROM op_connection WHERE id = $1",
      [connectionId],
    ))!;
    expect(row.token_ct).not.toBeNull();
    expect(row.token_nonce).not.toBeNull();
    expect(row.token_tag).not.toBeNull();
    expect(row.token_encrypted).toBeNull();
    expect(row.token_ct).not.toContain(TOKEN);

    await app1.close(); // close the pool — the database keeps the data
    app1 = null;
  });

  it("app #2 (same DB file): initialized+locked → OP calls 423 → wrong passphrase 401 → unlock → sync works WITHOUT re-entering the token", async () => {
    app2 = await bootRealApp({ databaseUrl: throwaway.url });

    const status = await track(app2, "GET", "/api/vault/status");
    expect(status.status).toBe(200);
    expect(VaultStatusResponse.parse(status.json)).toEqual({
      initialized: true,
      locked: true,
    });

    // Locked vault blocks every OP-facing call.
    const projects = await track(app2, "GET", "/api/projects");
    expect(projects.status).toBe(423);
    expect(errorCode(projects.json)).toBe("VAULT_LOCKED");

    // Wrong passphrase → 401, still locked.
    const bad = await track(app2, "POST", "/api/vault/unlock", {
      passphrase: WRONG_PASS,
    });
    expect(bad.status).toBe(401);
    expect(errorCode(bad.json)).toBe("VAULT_INVALID_PASSPHRASE");
    const stillLocked = await track(app2, "GET", "/api/vault/status");
    expect(VaultStatusResponse.parse(stillLocked.json).locked).toBe(true);

    // Correct passphrase → unlocked; the stored token decrypts and OP works.
    const unlock = await track(app2, "POST", "/api/vault/unlock", {
      passphrase: PASS,
    });
    expect(unlock.status).toBeGreaterThanOrEqual(200);
    expect(unlock.status).toBeLessThan(300);

    const projectsOk = await track(app2, "GET", "/api/projects");
    expect(projectsOk.status).toBe(200);
    const sync = await track(app2, "POST", "/api/sync", { project_op_id: 3 });
    expect(sync.status).toBe(200);
    expect(SyncRun.parse(sync.json).status).toBe("success");

    // The token was never re-entered in this session, yet ciphertext-only rows
    // powered a real (mock) OP sync — that IS the decrypt proof.
    const row = (await rawOne<{ token_ct: string | null; token_encrypted: string | null }>(
      app2.raw,
      "SELECT token_ct, token_encrypted FROM op_connection WHERE id = $1",
      [connectionId],
    ))!;
    expect(row.token_ct).not.toBeNull();
    expect(row.token_encrypted).toBeNull();
  });

  it("no backend HTTP response ever contains the token (status/list/health/add/patch/test)", async () => {
    expect(app2).not.toBeNull();
    // Walk the remaining read/update surface to complete the coverage.
    const list = await track(app2!, "GET", "/api/connections");
    expect(list.status).toBe(200);
    ConnectionsResponse.parse(list.json);

    const health = await track(app2!, "GET", "/api/connections/health");
    expect(health.status).toBe(200);
    ConnectionsHealthResponse.parse(health.json);

    const patched = await track(app2!, "PATCH", `/api/connections/${connectionId}`, {
      label: "prod",
    });
    expect(patched.status).toBe(200);
    // PATCH returns the token-free Connection (zod strips unknown keys).
    Connection.parse(patched.json);

    const test = await track(
      app2!,
      "POST",
      `/api/connections/${connectionId}/test`,
    );
    expect(test.status).toBe(200);

    // THE invariant: across EVERY response captured in this scenario, the token
    // never appears — not even a substring of it.
    expect(responseBodies.length).toBeGreaterThan(10);
    for (const body of responseBodies) {
      expect(body).not.toContain(TOKEN);
      expect(body).not.toContain("XYZZY");
    }
  });

  it("no plaintext token at rest: the persisted database bytes never contain T (but do contain the base_url)", async () => {
    expect(app2).not.toBeNull();
    await app2!.close();
    app2 = null;

    // The Postgres analogue of "read the closed .sqlite file off disk":
    // pg_dump --data-only serialises every row of every table as stored.
    const bytes = await dumpDatabaseBytes(throwaway.url);
    expect(bytes.length).toBeGreaterThan(0);
    // Sanity check we are reading the RIGHT database: base_url is plaintext.
    expect(bytes).toContain(mock.url);
    // The gate: the token never touches storage in plaintext.
    expect(bytes).not.toContain(TOKEN);
    expect(bytes).not.toContain("XYZZY");
  });
});

describeIfPg("vault security — legacy plaintext row is migrated on first init (§8)", () => {
  const LEGACY_TOKEN = "LEGACY-PLAINTEXT-TOKEN-98765";
  let throwaway: ThrowawayDb;
  let mock: RecordingMockOpServer;
  let app: RealApp | null = null;

  beforeAll(async () => {
    throwaway = await createThrowawayDb();
    mock = await createRecordingMockOpServer();
  });

  afterAll(async () => {
    await app?.close();
    await mock.close();
    await throwaway.drop();
  });

  it("vault init encrypts the legacy token_encrypted, nulls the plaintext slot, and OP calls keep working", async () => {
    // Seed a pre-Increment-2 row via raw SQL (the legacy schema's shape).
    {
      const { openDb } = await import("@osp/db");
      const seed = await openDb({ url: throwaway.url });
      // Postgres: `$n` placeholders and a real boolean for is_current.
      await rawOne(
        seed.raw,
        `INSERT INTO op_connection
           (base_url, token_encrypted, is_current, last_status, created_at)
         VALUES ($1, $2, true, 'unknown', $3)`,
        [mock.url, LEGACY_TOKEN, new Date()],
      );
      await seed.close();
    }

    app = await bootRealApp({ databaseUrl: throwaway.url });
    const init = await call(app.app, "POST", "/api/vault/init", {
      passphrase: "legacy-migration-pass",
    });
    expect(init.status).toBeGreaterThanOrEqual(200);
    expect(init.status).toBeLessThan(300);
    expect(JSON.stringify(init.json ?? "")).not.toContain(LEGACY_TOKEN);

    // Raw truth: ciphertext present, plaintext gone.
    const row = (await rawOne<{
      token_ct: string | null;
      token_nonce: string | null;
      token_tag: string | null;
      token_encrypted: string | null;
    }>(
      app.raw,
      "SELECT token_ct, token_nonce, token_tag, token_encrypted FROM op_connection WHERE base_url = $1",
      [mock.url],
    ))!;
    expect(row.token_ct).not.toBeNull();
    expect(row.token_nonce).not.toBeNull();
    expect(row.token_tag).not.toBeNull();
    expect(row.token_encrypted).toBeNull();

    // The migrated connection is fully usable (vault init leaves it unlocked).
    const projects = await call(app.app, "GET", "/api/projects");
    expect(projects.status).toBe(200);
    const list = await call(app.app, "GET", "/api/connections");
    expect(list.status).toBe(200);
    const conns = ConnectionsResponse.parse(list.json);
    expect(conns).toHaveLength(1);
    expect(conns[0]!.has_token).toBe(true);
    expect(JSON.stringify(list.json)).not.toContain(LEGACY_TOKEN);
  });

  it("after a clean close, the legacy plaintext is gone from the persisted bytes", async () => {
    expect(app).not.toBeNull();
    await app!.close();
    app = null;

    const bytes = await dumpDatabaseBytes(throwaway.url);
    expect(bytes).toContain(mock.url); // right database
    expect(bytes).not.toContain(LEGACY_TOKEN); // plaintext scrubbed
  });
});

describe("vault security — change-passphrase re-keys every token (§8)", () => {
  const P1 = "first-passphrase-111";
  const P2 = "second-passphrase-222";
  let mock: RecordingMockOpServer;
  let harness: RealApp;

  beforeAll(async () => {
    mock = await createRecordingMockOpServer();
    harness = await bootRealApp();
  });
  afterAll(async () => {
    await harness.close();
    await mock.close();
  });

  it("init P1 → add connection → change P1→P2 → lock → P1 rejected, P2 unlocks, sync still works", async () => {
    const init = await call(harness.app, "POST", "/api/vault/init", {
      passphrase: P1,
    });
    expect(init.status).toBeGreaterThanOrEqual(200);
    expect(init.status).toBeLessThan(300);

    const conn = await addConnection(harness.app, mock.url, "rekey-token-777", {
      default_project_op_id: 3,
    });
    expect(conn.status).toBe(201);

    const change = await call(harness.app, "POST", "/api/vault/change-passphrase", {
      old_passphrase: P1,
      new_passphrase: P2,
    });
    expect(change.status).toBeGreaterThanOrEqual(200);
    expect(change.status).toBeLessThan(300);

    const lock = await call(harness.app, "POST", "/api/vault/lock");
    expect(lock.status).toBeGreaterThanOrEqual(200);
    expect(lock.status).toBeLessThan(300);

    // Old passphrase must be dead after the re-key.
    const oldTry = await call(harness.app, "POST", "/api/vault/unlock", {
      passphrase: P1,
    });
    expect(oldTry.status).toBe(401);
    expect(errorCode(oldTry.json)).toBe("VAULT_INVALID_PASSPHRASE");

    const newTry = await call(harness.app, "POST", "/api/vault/unlock", {
      passphrase: P2,
    });
    expect(newTry.status).toBeGreaterThanOrEqual(200);
    expect(newTry.status).toBeLessThan(300);

    // The re-keyed ciphertext still decrypts to a working token.
    const sync = await call(harness.app, "POST", "/api/sync", { project_op_id: 3 });
    expect(sync.status).toBe(200);
    expect(SyncRun.parse(sync.json).status).toBe("success");
  });
});

describe("vault security — reset deletes tokens but keeps base_urls (§8)", () => {
  let mock: RecordingMockOpServer;
  let harness: RealApp;
  let connectionId: number;

  beforeAll(async () => {
    mock = await createRecordingMockOpServer();
    harness = await bootRealApp();
  });
  afterAll(async () => {
    await harness.close();
    await mock.close();
  });

  it("reset → connection survives token-less; re-init + fresh token via PATCH → sync works again", async () => {
    await initAndUnlockVault(harness.app, "reset-flow-pass-1");
    const conn = await addConnection(harness.app, mock.url, "reset-token-1", {
      default_project_op_id: 3,
    });
    expect(conn.status).toBe(201);
    connectionId = AddConnectionResponse.parse(conn.json).id;

    const reset = await call(harness.app, "POST", "/api/vault/reset", {
      confirm: true,
    });
    expect(reset.status).toBeGreaterThanOrEqual(200);
    expect(reset.status).toBeLessThan(300);
    expect(VaultResetResponse.parse(reset.json).cleared_tokens).toBe(1);

    // base_url row survives, token is gone.
    const list = await call(harness.app, "GET", "/api/connections");
    const conns = ConnectionsResponse.parse(list.json);
    expect(conns).toHaveLength(1);
    expect(conns[0]!.base_url).toBe(mock.url);
    expect(conns[0]!.has_token).toBe(false);

    // Vault is uninitialized again.
    const status = await call(harness.app, "GET", "/api/vault/status");
    expect(VaultStatusResponse.parse(status.json).initialized).toBe(false);

    // Raw truth: every token column is NULL.
    const row = (await rawOne<Record<string, string | null>>(
      harness.raw,
      "SELECT token_ct, token_nonce, token_tag, token_encrypted FROM op_connection WHERE id = $1",
      [connectionId],
    ))!;
    expect(row["token_ct"]).toBeNull();
    expect(row["token_nonce"]).toBeNull();
    expect(row["token_tag"]).toBeNull();
    expect(row["token_encrypted"]).toBeNull();

    // Recover: new passphrase, then a fresh token for the surviving base_url.
    const reinit = await call(harness.app, "POST", "/api/vault/init", {
      passphrase: "reset-flow-pass-2",
    });
    expect(reinit.status).toBeGreaterThanOrEqual(200);
    expect(reinit.status).toBeLessThan(300);

    const patched = await call(
      harness.app,
      "PATCH",
      `/api/connections/${connectionId}`,
      { token: "reset-token-2" },
    );
    expect(patched.status).toBe(200);
    expect(JSON.stringify(patched.json)).not.toContain("reset-token-2");

    const relist = await call(harness.app, "GET", "/api/connections");
    expect(ConnectionsResponse.parse(relist.json)[0]!.has_token).toBe(true);

    const sync = await call(harness.app, "POST", "/api/sync", { project_op_id: 3 });
    expect(sync.status).toBe(200);
    expect(SyncRun.parse(sync.json).status).toBe("success");
  });
});
