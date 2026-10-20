import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AddConnectionResponse,
  Connection,
  ConnectionsHealthResponse,
  ConnectionsResponse,
  ErrorResponse,
  VaultStatusResponse,
  type ConnectionStatus,
} from "@osp/contracts";
import type { OpClient, OpClientConfig } from "@osp/op-client";
import { computeAggregate } from "../health/index";
import {
  addConnection,
  buildTestApp,
  initVault,
  makeFakeOpClient,
  seedLegacyPlaintextConnection,
  TEST_PASSPHRASE,
  type TestApp,
} from "../test-utils";

/**
 * Increment 2 (SPEC_02): vault lifecycle, multi-server connection registry,
 * health aggregate + SSE. HARD INVARIANT under test everywhere: the OP token
 * never appears in any HTTP response and never rests in plaintext in the DB.
 */

const TOKEN = "secret-token";

async function inject(
  t: TestApp,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  payload?: unknown,
) {
  return t.app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

describe("vault lifecycle", () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
  });
  afterEach(async () => {
    await t.close();
  });

  it("status transitions: uninitialized → init → lock → wrong unlock → unlock", async () => {
    const fresh = VaultStatusResponse.parse(
      (await inject(t, "GET", "/api/vault/status")).json(),
    );
    expect(fresh).toEqual({ initialized: false, locked: true });

    // Unlock before init → VAULT_NOT_INITIALIZED.
    const early = await inject(t, "POST", "/api/vault/unlock", { passphrase: "whatever" });
    expect(early.statusCode).toBe(409);
    expect(ErrorResponse.parse(early.json()).error.code).toBe("VAULT_NOT_INITIALIZED");

    // Init → 201, unlocked.
    const init = await inject(t, "POST", "/api/vault/init", { passphrase: TEST_PASSPHRASE });
    expect(init.statusCode).toBe(201);
    expect(VaultStatusResponse.parse(init.json())).toEqual({ initialized: true, locked: false });

    // Second init → VAULT_ALREADY_INITIALIZED.
    const again = await inject(t, "POST", "/api/vault/init", { passphrase: TEST_PASSPHRASE });
    expect(again.statusCode).toBe(409);
    expect(ErrorResponse.parse(again.json()).error.code).toBe("VAULT_ALREADY_INITIALIZED");

    // Lock.
    const locked = VaultStatusResponse.parse((await inject(t, "POST", "/api/vault/lock")).json());
    expect(locked).toEqual({ initialized: true, locked: true });

    // Wrong passphrase → 401, still locked.
    const wrong = await inject(t, "POST", "/api/vault/unlock", { passphrase: "not-the-passphrase" });
    expect(wrong.statusCode).toBe(401);
    expect(ErrorResponse.parse(wrong.json()).error.code).toBe("VAULT_INVALID_PASSPHRASE");
    expect(t.deps.vault.isLocked()).toBe(true);

    // Right passphrase → unlocked.
    const unlocked = await inject(t, "POST", "/api/vault/unlock", { passphrase: TEST_PASSPHRASE });
    expect(unlocked.statusCode).toBe(200);
    expect(VaultStatusResponse.parse(unlocked.json()).locked).toBe(false);
  });

  it("init requires a passphrase of at least 8 chars (contract)", async () => {
    const res = await inject(t, "POST", "/api/vault/init", { passphrase: "short" });
    expect(res.statusCode).toBe(400);
    expect(ErrorResponse.parse(res.json()).error.code).toBe("VALIDATION_ERROR");
  });
});

describe("connections registry", () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
  });
  afterEach(async () => {
    await t.close();
  });

  it("POST /connections with a locked vault → 423 VAULT_LOCKED", async () => {
    // Never initialized → locked.
    const res = await inject(t, "POST", "/api/connections", {
      base_url: "https://op.example.com",
      token: TOKEN,
    });
    expect(res.statusCode).toBe(423);
    expect(ErrorResponse.parse(res.json()).error.code).toBe("VAULT_LOCKED");

    // Initialized but re-locked → also 423.
    await initVault(t);
    await inject(t, "POST", "/api/vault/lock");
    const res2 = await inject(t, "POST", "/api/connections", {
      base_url: "https://op.example.com",
      token: TOKEN,
    });
    expect(res2.statusCode).toBe(423);
  });

  it("duplicate base_url → 409 CONNECTION_EXISTS", async () => {
    await initVault(t);
    await addConnection(t);
    const dup = await inject(t, "POST", "/api/connections", {
      base_url: "https://op.example.com",
      token: "another-token",
    });
    expect(dup.statusCode).toBe(409);
    expect(ErrorResponse.parse(dup.json()).error.code).toBe("CONNECTION_EXISTS");
  });

  it("no response ever contains the token; the DB row is encrypted-only", async () => {
    await initVault(t);
    const created = await addConnection(t, { token: TOKEN });
    expect(JSON.stringify(created)).not.toContain(TOKEN);

    for (const url of ["/api/connections", "/api/connections/health"]) {
      const res = await inject(t, "GET", url);
      expect(res.statusCode).toBe(200);
      expect(JSON.stringify(res.json())).not.toContain(TOKEN);
    }

    const row = (await t.repos.connections.list())[0]!;
    expect(row.token_encrypted).toBeNull(); // no plaintext at rest
    expect(row.token_ct).not.toBeNull();
    expect(row.token_ct).not.toContain(TOKEN);
  });

  it("PATCH updates label/default project, current:true switches getCurrent", async () => {
    await initVault(t);
    const a = AddConnectionResponse.parse(await addConnection(t));
    const b = AddConnectionResponse.parse(
      await addConnection(t, { base_url: "https://op2.example.com", token: "t2" }),
    );
    // First row auto-became current.
    expect((await t.repos.connections.getCurrent())?.id).toBe(a.id);

    const patched = Connection.parse(
      (
        await inject(t, "PATCH", `/api/connections/${b.id}`, {
          label: "secondary",
          default_project_op_id: 200,
          current: true,
        })
      ).json(),
    );
    expect(patched.label).toBe("secondary");
    expect(patched.default_project_op_id).toBe(200);
    expect(patched.is_current).toBe(true);
    expect((await t.repos.connections.getCurrent())?.id).toBe(b.id);

    // Unknown id → 404.
    const nf = await inject(t, "PATCH", "/api/connections/9999", { label: "x" });
    expect(nf.statusCode).toBe(404);
    expect(ErrorResponse.parse(nf.json()).error.code).toBe("CONNECTION_NOT_FOUND");

    // Token replacement needs an unlocked vault.
    await inject(t, "POST", "/api/vault/lock");
    const lockedPatch = await inject(t, "PATCH", `/api/connections/${b.id}`, { token: "new" });
    expect(lockedPatch.statusCode).toBe(423);
  });

  it("DELETE removes the row and re-points current", async () => {
    await initVault(t);
    const a = AddConnectionResponse.parse(await addConnection(t));
    const b = AddConnectionResponse.parse(
      await addConnection(t, { base_url: "https://op2.example.com", token: "t2" }),
    );
    expect((await t.repos.connections.getCurrent())?.id).toBe(a.id);

    const del = await inject(t, "DELETE", `/api/connections/${a.id}`);
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ deleted: true });
    expect((await t.repos.connections.getCurrent())?.id).toBe(b.id);

    const nf = await inject(t, "DELETE", `/api/connections/${a.id}`);
    expect(nf.statusCode).toBe(404);
  });

  it("POST /connections/:id/test records a 'check' and returns the refreshed row", async () => {
    await initVault(t);
    const created = AddConnectionResponse.parse(await addConnection(t));
    expect(created.health.last_check_at).toBeNull();

    const res = await inject(t, "POST", `/api/connections/${created.id}/test`);
    expect(res.statusCode).toBe(200);
    const tested = Connection.parse(res.json());
    expect(tested.health.last_status).toBe("ok");
    expect(tested.health.last_check_at).not.toBeNull();
    expect(tested.health.last_latency_ms).not.toBeNull();

    // Locked vault → 423 (cannot decrypt the token for the probe).
    await inject(t, "POST", "/api/vault/lock");
    const locked = await inject(t, "POST", `/api/connections/${created.id}/test`);
    expect(locked.statusCode).toBe(423);
  });
});

describe("OP-facing routes go through the vault (requireOpClient)", () => {
  it("locked vault → 423; missing token after reset → NO_CONNECTION", async () => {
    const t = await buildTestApp();
    await initVault(t);
    await addConnection(t);

    await inject(t, "POST", "/api/vault/lock");
    const locked = await inject(t, "GET", "/api/projects");
    expect(locked.statusCode).toBe(423);
    expect(ErrorResponse.parse(locked.json()).error.code).toBe("VAULT_LOCKED");

    await inject(t, "POST", "/api/vault/unlock", { passphrase: TEST_PASSPHRASE });
    // Reset wipes tokens (keeps the URL) and locks; re-init to get unlocked.
    const reset = await inject(t, "POST", "/api/vault/reset", { confirm: true });
    expect(reset.json()).toEqual({ cleared_tokens: 1 });
    await initVault(t);
    const noToken = await inject(t, "GET", "/api/projects");
    expect(noToken.statusCode).toBe(409);
    const err = ErrorResponse.parse(noToken.json()).error;
    expect(err.code).toBe("NO_CONNECTION");
    expect(err.message).toContain("no token stored");
    await t.close();
  });

  /**
   * Fake whose getProjects dispatches through this.request — the piggyback
   * instrumentation (instrumentOpClient) reports at the request level, exactly
   * like the real client does.
   */
  function fakeDispatchingViaRequest(failure?: Error): OpClient {
    const base = makeFakeOpClient();
    return {
      ...base,
      request: <T>() =>
        failure ? Promise.reject(failure) : (base.getProjects() as Promise<T>),
      getProjects(this: OpClient) {
        return this.request({ path: "/api/v3/projects" });
      },
    };
  }

  it("decrypts the stored token ad-hoc for every OP call and piggybacks health", async () => {
    const seenTokens: string[] = [];
    const t = await buildTestApp({
      opClientFactory: (config: OpClientConfig) => {
        seenTokens.push(config.token);
        return fakeDispatchingViaRequest();
      },
    });
    await initVault(t);
    await addConnection(t, { token: TOKEN });
    // Wipe the health the add-time probe recorded, so the assertions below can
    // only be satisfied by the piggyback of the /projects call itself.
    const id = (await t.repos.connections.list())[0]!.id;
    await t.repos.connections.updateHealth(id, {
      last_status: "unknown",
      last_activity_at: null,
      last_latency_ms: null,
    });

    const res = await inject(t, "GET", "/api/projects");
    expect(res.statusCode).toBe(200);
    // The client got the DECRYPTED token (round-trip through the vault).
    expect(seenTokens).toContain(TOKEN);

    // Piggyback: the successful call stamped activity health (SPEC_02 §4).
    const conn = (await t.repos.connections.list())[0]!;
    expect(conn.last_status).toBe("ok");
    expect(conn.last_activity_at).not.toBeNull();
    await t.close();
  });

  it("a failing OP call piggybacks a fail status with the error", async () => {
    const t = await buildTestApp({
      opClientFactory: () =>
        fakeDispatchingViaRequest(new Error("connect ECONNREFUSED")),
    });
    await initVault(t);
    await addConnection(t);
    const res = await inject(t, "GET", "/api/projects");
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    const conn = (await t.repos.connections.list())[0]!;
    expect(conn.last_status).toBe("fail");
    expect(conn.last_error).toContain("ECONNREFUSED");
    await t.close();
  });
});

describe("legacy plaintext migration (SPEC_02 §2)", () => {
  it("vault init encrypts token_encrypted rows and OP calls use the decrypted value", async () => {
    const seenTokens: string[] = [];
    const t = await buildTestApp({
      opClientFactory: (config: OpClientConfig) => {
        seenTokens.push(config.token);
        return makeFakeOpClient();
      },
    });
    await seedLegacyPlaintextConnection(t, "https://legacy.example.com", "legacy-token");

    await initVault(t);
    const row = (await t.repos.connections.list())[0]!;
    expect(row.token_encrypted).toBeNull(); // plaintext wiped
    expect(row.token_ct).not.toBeNull();
    expect(row.token_ct).not.toContain("legacy-token");

    const res = await inject(t, "GET", "/api/projects");
    expect(res.statusCode).toBe(200);
    expect(seenTokens).toContain("legacy-token"); // decrypt round-trip works
    await t.close();
  });
});

describe("change-passphrase & reset", () => {
  it("change-passphrase re-keys tokens: old passphrase dies, OP calls still work", async () => {
    const seenTokens: string[] = [];
    const t = await buildTestApp({
      opClientFactory: (config: OpClientConfig) => {
        seenTokens.push(config.token);
        return makeFakeOpClient();
      },
    });
    await initVault(t);
    await addConnection(t, { token: TOKEN });
    const ctBefore = (await t.repos.connections.list())[0]!.token_ct;

    const change = await inject(t, "POST", "/api/vault/change-passphrase", {
      old_passphrase: TEST_PASSPHRASE,
      new_passphrase: "brand-new-passphrase",
    });
    expect(change.statusCode).toBe(200);
    // Re-keyed: the stored ciphertext changed.
    expect((await t.repos.connections.list())[0]!.token_ct).not.toBe(ctBefore);

    await inject(t, "POST", "/api/vault/lock");
    const old = await inject(t, "POST", "/api/vault/unlock", { passphrase: TEST_PASSPHRASE });
    expect(old.statusCode).toBe(401);
    const fresh = await inject(t, "POST", "/api/vault/unlock", {
      passphrase: "brand-new-passphrase",
    });
    expect(fresh.statusCode).toBe(200);

    seenTokens.length = 0;
    const res = await inject(t, "GET", "/api/projects");
    expect(res.statusCode).toBe(200);
    expect(seenTokens).toContain(TOKEN); // token survives the re-key
    await t.close();
  });

  it("wrong old passphrase → 401 and nothing changes", async () => {
    const t = await buildTestApp();
    await initVault(t);
    const res = await inject(t, "POST", "/api/vault/change-passphrase", {
      old_passphrase: "wrong-wrong-wrong",
      new_passphrase: "brand-new-passphrase",
    });
    expect(res.statusCode).toBe(401);
    const unlock = await inject(t, "POST", "/api/vault/unlock", { passphrase: TEST_PASSPHRASE });
    expect(unlock.statusCode).toBe(200);
    await t.close();
  });

  it("reset clears tokens but keeps base_url; confirm is mandatory", async () => {
    const t = await buildTestApp();
    await initVault(t);
    await addConnection(t);

    const bad = await inject(t, "POST", "/api/vault/reset", {});
    expect(bad.statusCode).toBe(400);

    const res = await inject(t, "POST", "/api/vault/reset", { confirm: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cleared_tokens: 1 });

    const list = ConnectionsResponse.parse(
      (await inject(t, "GET", "/api/connections")).json(),
    );
    expect(list).toHaveLength(1);
    expect(list[0]!.base_url).toBe("https://op.example.com"); // URL survives
    expect(list[0]!.has_token).toBe(false);

    const status = VaultStatusResponse.parse(
      (await inject(t, "GET", "/api/vault/status")).json(),
    );
    expect(status).toEqual({ initialized: false, locked: true });
    await t.close();
  });
});

describe("aggregate health color (SPEC_02 §4)", () => {
  it("computeAggregate matrix", () => {
    const s = (...xs: ConnectionStatus[]): ConnectionStatus[] => xs;
    expect(computeAggregate([], false)).toBe("neutral"); // nothing configured
    expect(computeAggregate(s("ok"), true)).toBe("neutral"); // vault locked
    expect(computeAggregate(s("ok", "ok"), false)).toBe("green");
    expect(computeAggregate(s("ok", "fail"), false)).toBe("orange");
    expect(computeAggregate(s("ok", "unknown"), false)).toBe("orange");
    expect(computeAggregate(s("fail", "fail"), false)).toBe("red");
    expect(computeAggregate(s("fail", "unknown"), false)).toBe("red");
    expect(computeAggregate(s("unknown", "unknown"), false)).toBe("neutral");
  });

  it("GET /connections/health reflects statuses + lock state end-to-end", async () => {
    const t = await buildTestApp();
    await initVault(t);

    const health = async () =>
      ConnectionsHealthResponse.parse(
        (await inject(t, "GET", "/api/connections/health")).json(),
      );

    expect((await health()).aggregate).toBe("neutral"); // no connections

    const a = AddConnectionResponse.parse(await addConnection(t));
    const b = AddConnectionResponse.parse(
      await addConnection(t, { base_url: "https://op2.example.com", token: "t2" }),
    );
    expect((await health()).aggregate).toBe("green"); // both probed ok

    await t.repos.connections.updateHealth(b.id, { last_status: "fail" });
    expect((await health()).aggregate).toBe("orange"); // mix

    await t.repos.connections.updateHealth(a.id, { last_status: "fail" });
    expect((await health()).aggregate).toBe("red"); // all fail

    await inject(t, "POST", "/api/vault/lock");
    expect((await health()).aggregate).toBe("neutral"); // locked wins
    await t.close();
  });

  it("SPEC_10 §a: a DISCONNECTED server counts as not-ok, not as excluded — 1-of-2 disabled is orange, not green", async () => {
    const t = await buildTestApp();
    await initVault(t);

    const health = async () =>
      ConnectionsHealthResponse.parse(
        (await inject(t, "GET", "/api/connections/health")).json(),
      );

    const a = AddConnectionResponse.parse(await addConnection(t));
    const b = AddConnectionResponse.parse(
      await addConnection(t, { base_url: "https://op2.example.com", token: "t2" }),
    );
    expect((await health()).aggregate).toBe("green"); // both connected + ok

    // Disconnect b — its last_status is still "ok" (stale), but a disabled
    // connection must count as NOT-ok for the aggregate regardless.
    await inject(t, "PATCH", `/api/connections/${b.id}`, { enabled: false });
    expect((await health()).aggregate).toBe("orange"); // a ok, b disconnected

    await inject(t, "PATCH", `/api/connections/${a.id}`, { enabled: false });
    expect((await health()).aggregate).toBe("red"); // both disconnected → none ok

    await inject(t, "PATCH", `/api/connections/${b.id}`, { enabled: true });
    expect((await health()).aggregate).toBe("orange"); // b reconnected → back to mix
    await t.close();
  });
});

describe("GET /connections/health/stream (SSE)", () => {
  it("sends the current health payload immediately as an SSE data event", async () => {
    const t = await buildTestApp();
    await initVault(t);
    await addConnection(t);

    const res = await t.app.inject({
      method: "GET",
      url: "/api/connections/health/stream",
      payloadAsStream: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");

    const stream = res.stream();
    const first = await new Promise<string>((resolve, reject) => {
      stream.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8")));
      stream.once("error", reject);
    });
    expect(first).toMatch(/^data: /);
    const payload = ConnectionsHealthResponse.parse(
      JSON.parse(first.replace(/^data: /, "").trim()),
    );
    expect(payload.aggregate).toBe("green");
    expect(payload.connections).toHaveLength(1);
    expect(first).not.toContain(TOKEN); // no token on the wire
    stream.destroy();
    await t.close();
  });
});
