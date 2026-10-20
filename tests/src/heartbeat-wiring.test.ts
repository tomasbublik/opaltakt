import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb, type DbHandle } from "@osp/db";
import {
  createRecordingMockOpServer,
  type RecordingMockOpServer,
} from "@osp/fixtures";
// apps/api + packages/crypto sources are imported by relative path (the same
// pattern harness.ts uses for apps/api): they are side-effect-free and not
// declared dependencies of @osp/tests.
import {
  startHeartbeat,
  type HeartbeatDeps,
} from "../../apps/api/src/scheduler/heartbeat";
import { createVault, type Vault } from "../../packages/crypto/src/index";

/**
 * HEARTBEAT ↔ DB WIRING (SPEC_02 §4/§8, integration level).
 *
 * Agent A's unit tests cover the tick math; THIS suite proves the real-world
 * composition: heartbeat deps wired to a REAL @osp/db connection repository and
 * a REAL @osp/crypto vault persisted through the vault_meta repository.
 * No wall-clock sleeps — every tick is driven via tickNow() with real rows.
 *
 *   - an idle connection (no activity) gets checked: last_check_at set, ok
 *   - fresh last_activity_at suppresses the check (no useless pings)
 *   - locked vault → the tick is a no-op (zero requests to OP)
 *   - the probe itself is GET-only (read-only invariant holds in the scheduler)
 */

const HB_TOKEN = "hb-token-secret-31337";
const PASSPHRASE = "heartbeat-wiring-pass";

describe("heartbeat wired to a real DB + real vault", () => {
  let mock: RecordingMockOpServer;
  let db: DbHandle;
  let vault: Vault;
  let connectionId: number;
  let deps: HeartbeatDeps;

  beforeAll(async () => {
    mock = await createRecordingMockOpServer();
    db = await openDb({ ephemeral: true }); // in-process PGlite, migrations applied
    const repos = db.repositories;

    // Real vault persisted through the real vault_meta repository.
    vault = createVault({
      get: async () => {
        const meta = await repos.vaultMeta.get();
        return meta === null
          ? null
          : {
              kdf_algo: meta.kdf_algo,
              kdf_salt: meta.kdf_salt,
              kdf_params_json: meta.kdf_params_json,
              verifier_ct: meta.verifier_ct,
              verifier_nonce: meta.verifier_nonce,
            };
      },
      save: async (meta) => {
        await repos.vaultMeta.save(meta);
      },
      delete: async () => repos.vaultMeta.delete(),
    });
    await vault.init(PASSPHRASE);

    // Real connection row carrying the ENCRYPTED token only.
    const blob = vault.encryptToken(HB_TOKEN);
    const created = await repos.connections.create({
      base_url: mock.url,
      label: null,
      token_ct: blob.ct,
      token_nonce: blob.nonce,
      token_tag: blob.tag,
      default_project_op_id: null,
    });
    connectionId = created.id;

    // Heartbeat deps composed EXACTLY the way the API scheduler will wire them.
    deps = {
      listConnections: async () =>
        (await repos.connections.list()).map((c) => ({
          id: c.id,
          base_url: c.base_url,
          last_activity_at: c.last_activity_at,
          last_check_at: c.last_check_at,
          has_token: c.token_ct !== null,
          enabled: c.enabled,
        })),
      isVaultLocked: () => vault.isLocked(),
      getClientConfig: async (id) => {
        const c = await repos.connections.getById(id);
        if (!c || c.token_ct === null) return null;
        return {
          baseUrl: c.base_url,
          token: vault.decryptToken({
            ct: c.token_ct,
            nonce: c.token_nonce!,
            tag: c.token_tag!,
          }),
        };
      },
      recordCheck: async (id, result) => {
        await repos.connections.updateHealth(id, {
          last_check_at: new Date().toISOString(),
          last_status: result.ok ? "ok" : "fail",
          last_latency_ms: result.latency_ms,
          last_error: result.error,
        });
      },
      tickMs: 3_600_000, // interval never fires in-test; tickNow() drives it
      timeoutMs: 2_000,
    };
  });

  afterAll(async () => {
    await db.close();
    await mock.close();
  });

  it("the vault round-trips the token through the real vault_meta store (sanity)", async () => {
    const c = await db.repositories.connections.getById(connectionId);
    expect(c?.token_ct).not.toBeNull();
    expect(c?.token_encrypted).toBeNull(); // never plaintext in the DB
    expect(
      vault.decryptToken({
        ct: c!.token_ct!,
        nonce: c!.token_nonce!,
        tag: c!.token_tag!,
      }),
    ).toBe(HB_TOKEN);
  });

  it("an idle connection gets health-checked on a tick (last_check_at set, status ok, GET only)", async () => {
    mock.reset();
    const hb = startHeartbeat(deps);
    try {
      await hb.tickNow();
    } finally {
      hb.stop();
    }

    const c = await db.repositories.connections.getById(connectionId);
    expect(c?.last_check_at).not.toBeNull();
    expect(c?.last_status).toBe("ok");
    expect(c?.last_latency_ms).not.toBeNull();
    expect(c?.last_error).toBeNull();

    // The probe hit /users/me with GET and nothing else.
    expect(mock.requests.length).toBeGreaterThan(0);
    expect(mock.methodSet()).toEqual(new Set(["GET"]));
    expect(mock.requests.every((r) => r.path === "/api/v3/users/me")).toBe(true);
  });

  it("fresh last_activity_at suppresses the check (busy servers are not pinged)", async () => {
    // Piggyback traffic just happened; wipe the check marker to make suppression visible.
    await db.repositories.connections.updateHealth(connectionId, {
      last_activity_at: new Date().toISOString(),
      last_check_at: null,
    });
    mock.reset();

    const hb = startHeartbeat(deps);
    try {
      await hb.tickNow();
    } finally {
      hb.stop();
    }

    expect(mock.requests).toHaveLength(0); // no probe fired
    const c = await db.repositories.connections.getById(connectionId);
    expect(c?.last_check_at).toBeNull(); // untouched
  });

  it("locked vault → the tick is a complete no-op (no decryption possible, zero OP traffic)", async () => {
    // Make the connection maximally idle again so ONLY the lock can stop the probe.
    await db.repositories.connections.updateHealth(connectionId, {
      last_activity_at: null,
      last_check_at: null,
    });
    vault.lock();
    mock.reset();

    const hb = startHeartbeat(deps);
    try {
      await hb.tickNow();
    } finally {
      hb.stop();
    }

    expect(mock.requests).toHaveLength(0);
    const c = await db.repositories.connections.getById(connectionId);
    expect(c?.last_check_at).toBeNull();

    // Unlock with the SAME passphrase (round-trip through vault_meta) → the next
    // tick probes again.
    await vault.unlock(PASSPHRASE);
    const hb2 = startHeartbeat(deps);
    try {
      await hb2.tickNow();
    } finally {
      hb2.stop();
    }
    expect(mock.requests.length).toBeGreaterThan(0);
    expect(mock.methodSet()).toEqual(new Set(["GET"]));
    expect(
      (await db.repositories.connections.getById(connectionId))?.last_status,
    ).toBe("ok");
  });
});
