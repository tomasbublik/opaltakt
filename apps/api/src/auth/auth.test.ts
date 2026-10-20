import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { AuthMeResponse, ErrorResponse } from "@osp/contracts";
import { AuthConfigError, resolveAuthConfig, type EntraAuthConfig } from "./config";
import { createEntraOidcProvider, entraIssuer, type IdTokenClaims } from "./oidc";
import { sanitizeReturnTo } from "./returnTo";
import { createSealedCodec, LOGIN_COOKIE, SESSION_COOKIE, type SessionPayload } from "./session";
import { buildTestApp, entraTestAuth, fakeEntraConfig, fakeOidc, type TestApp } from "../test-utils";

/**
 * Increment 39 (docs/INCREMENT_39_CONTRACTS.md §1–§4) — auth config, session
 * cookies, returnTo sanitisation and the full login → callback → session flow.
 * No real network: the OIDC exchange is faked, and the "real openid-client"
 * block points the library's own fetch at an in-process fake IdP.
 */

const GOOD_SECRET = randomBytes(48).toString("base64");
const ENTRA_ENV = {
  OSP_AUTH: "entra",
  OSP_ENTRA_TENANT_ID: "00000000-0000-0000-0000-000000000000",
  OSP_ENTRA_CLIENT_ID: "11111111-1111-1111-1111-111111111111",
  OSP_ENTRA_CLIENT_SECRET: "s3cr3t-value-never-echoed",
  OSP_PUBLIC_URL: "https://planner.example.test",
  OSP_SESSION_SECRET: GOOD_SECRET,
};

describe("resolveAuthConfig — startup refuses a missing/invalid OSP_AUTH (§1)", () => {
  it("OSP_AUTH unset → throws, no default", () => {
    expect(() => resolveAuthConfig({})).toThrow(AuthConfigError);
    expect(() => resolveAuthConfig({})).toThrow(/OSP_AUTH is not set — refusing to start/);
  });

  it("unknown mode → throws", () => {
    expect(() => resolveAuthConfig({ OSP_AUTH: "basic" })).toThrow(/not a known mode/);
  });

  it("none → {mode:none} and needs nothing else", () => {
    expect(resolveAuthConfig({ OSP_AUTH: "none" })).toEqual({ mode: "none" });
  });

  it("entra with every var missing lists ALL of them", () => {
    let msg = "";
    try {
      resolveAuthConfig({ OSP_AUTH: "entra" });
    } catch (e) {
      msg = (e as Error).message;
    }
    for (const v of [
      "OSP_ENTRA_TENANT_ID",
      "OSP_ENTRA_CLIENT_ID",
      "OSP_ENTRA_CLIENT_SECRET",
      "OSP_PUBLIC_URL",
      "OSP_SESSION_SECRET",
    ]) {
      expect(msg).toContain(v);
    }
  });

  it("entra with one var missing names exactly that one", () => {
    const env = { ...ENTRA_ENV, OSP_ENTRA_CLIENT_SECRET: "" };
    expect(() => resolveAuthConfig(env)).toThrow(/not set: OSP_ENTRA_CLIENT_SECRET — refusing/);
  });

  it("entra rejects a short session secret / bad GUID / non-origin public URL, never echoing secrets", () => {
    const env = {
      ...ENTRA_ENV,
      OSP_SESSION_SECRET: Buffer.from("too-short").toString("base64"),
      OSP_ENTRA_TENANT_ID: "contoso.onmicrosoft.com",
      OSP_PUBLIC_URL: "https://planner.example.test/app",
    };
    let msg = "";
    try {
      resolveAuthConfig(env);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/OSP_SESSION_SECRET must be base64 of at least 32/);
    expect(msg).toMatch(/OSP_ENTRA_TENANT_ID must be a GUID/);
    expect(msg).toMatch(/OSP_PUBLIC_URL must be a bare origin/);
    expect(msg).not.toContain(ENTRA_ENV.OSP_ENTRA_CLIENT_SECRET);
    expect(msg).not.toContain(env.OSP_SESSION_SECRET);
  });

  it("valid entra env resolves (public URL normalised to its origin)", () => {
    const cfg = resolveAuthConfig({ ...ENTRA_ENV, OSP_PUBLIC_URL: "https://planner.example.test/" });
    expect(cfg.mode).toBe("entra");
    const e = cfg as EntraAuthConfig;
    expect(e.publicUrl).toBe("https://planner.example.test");
    expect(e.sessionSecret.length).toBe(48);
  });
});

describe("sanitizeReturnTo — open-redirect protection (§4)", () => {
  it.each([
    ["/sprints/3", "/sprints/3"],
    ["/reports?x=1#top", "/reports?x=1#top"],
    ["/", "/"],
    // percent-encoded CR/LF stays encoded — harmless in a Location path
    ["/%0d%0aSet-Cookie:x", "/%0d%0aSet-Cookie:x"],
  ])("keeps same-origin relative path %s", (input, out) => {
    expect(sanitizeReturnTo(input)).toBe(out);
  });

  it.each([
    "//evil.example",
    "/\\evil.example",
    "https://evil.example/x",
    "http:/evil.example",
    "javascript:alert(1)",
    "evil.example",
    "",
    "/a\r\nb",
    "/a\\b",
    " /x",
    undefined,
    ["/a", "/b"],
    "/" + "a".repeat(5000),
  ])("collapses %j to /", (input) => {
    expect(sanitizeReturnTo(input)).toBe("/");
  });
});

describe("sealed cookie codec (§2)", () => {
  const secret = randomBytes(32);
  const payload: SessionPayload = {
    sub: "s",
    oid: null,
    name: "N",
    email: null,
    roles: ["Viewer"],
    exp: 2_000,
  };

  it("round-trips while unexpired", () => {
    const c = createSealedCodec<SessionPayload>(secret, SESSION_COOKIE, () => 1_000);
    expect(c.open(c.seal(payload))).toEqual(payload);
  });

  it("rejects an expired payload", () => {
    const c = createSealedCodec<SessionPayload>(secret, SESSION_COOKIE, () => 2_000);
    expect(c.open(c.seal(payload))).toBeNull();
  });

  it("rejects any tampered byte", () => {
    const c = createSealedCodec<SessionPayload>(secret, SESSION_COOKIE, () => 1_000);
    const raw = Buffer.from(c.seal(payload), "base64url");
    for (const i of [0, 13, raw.length - 1]) {
      const t = Buffer.from(raw);
      t[i] = t[i]! ^ 0x01;
      expect(c.open(t.toString("base64url"))).toBeNull();
    }
    expect(c.open("garbage")).toBeNull();
    expect(c.open("")).toBeNull();
    expect(c.open(undefined)).toBeNull();
  });

  it("a different secret or a different purpose cannot open it", () => {
    const c = createSealedCodec<SessionPayload>(secret, SESSION_COOKIE, () => 1_000);
    const sealed = c.seal(payload);
    expect(createSealedCodec<SessionPayload>(randomBytes(32), SESSION_COOKIE, () => 1_000).open(sealed)).toBeNull();
    expect(createSealedCodec<SessionPayload>(secret, LOGIN_COOKIE, () => 1_000).open(sealed)).toBeNull();
  });
});

// ── HTTP flow ────────────────────────────────────────────────────────────────

function cookieFrom(res: { cookies: Array<{ name: string; value: string }> }, name: string): string | undefined {
  return res.cookies.find((c) => c.name === name)?.value;
}

describe("`none` mode endpoints", () => {
  let t: TestApp;
  afterEach(async () => t.close());

  it("/me is the synthetic local Planner; /login → /; /logout → {logout_url:'/'}", async () => {
    t = await buildTestApp();
    const me = await t.app.inject({ method: "GET", url: "/api/auth/me" });
    expect(me.statusCode).toBe(200);
    expect(AuthMeResponse.parse(me.json())).toEqual({
      mode: "none",
      user: { name: "Local user", email: null, roles: ["Planner"] },
      role: "Planner",
    });
    const login = await t.app.inject({ method: "GET", url: "/api/auth/login?returnTo=/x" });
    expect(login.statusCode).toBe(302);
    expect(login.headers.location).toBe("/");
    const out = await t.app.inject({ method: "POST", url: "/api/auth/logout" });
    expect(out.json()).toEqual({ logout_url: "/" });
  });
});

describe("`entra` mode — login → callback → session cookie (§2/§4)", () => {
  let t: TestApp;
  afterEach(async () => t.close());

  const claims: IdTokenClaims = {
    sub: "sub-1",
    oid: "oid-1",
    name: "Ada Planner",
    preferred_username: "ada@example.test",
    roles: ["Viewer", "Planner"],
  };

  async function signIn(app: TestApp["app"], returnTo = "/sprints/7") {
    const login = await app.inject({
      method: "GET",
      url: `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
    });
    expect(login.statusCode).toBe(302);
    const loc = new URL(String(login.headers.location));
    const loginCookie = cookieFrom(login, LOGIN_COOKIE)!;
    expect(loginCookie).toBeTruthy();
    const cb = await app.inject({
      method: "GET",
      url: `/api/auth/callback?code=abc&state=${loc.searchParams.get("state")}`,
      cookies: { [LOGIN_COOKIE]: loginCookie },
    });
    return { login, loc, loginCookie, cb };
  }

  it("anonymous → /me 401 UNAUTHENTICATED; a viewer route 401", async () => {
    t = await buildTestApp({ auth: entraTestAuth() });
    const me = await t.app.inject({ method: "GET", url: "/api/auth/me" });
    expect(me.statusCode).toBe(401);
    expect(ErrorResponse.parse(me.json()).error.code).toBe("UNAUTHENTICATED");
    const s = await t.app.inject({ method: "GET", url: "/api/sprints" });
    expect(s.statusCode).toBe(401);
    // public stays public
    expect((await t.app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await t.app.inject({ method: "GET", url: "/api/version" })).statusCode).toBe(200);
  });

  it("full flow sets an httpOnly Lax session cookie and redirects to the sanitised returnTo", async () => {
    let seen: { url: string; state: string; nonce: string; verifier: string } | null = null;
    const auth = entraTestAuth({
      oidc: fakeOidc(async (url, checks) => {
        seen = { url: url.toString(), state: checks.state, nonce: checks.nonce, verifier: checks.codeVerifier };
        return claims;
      }),
    });
    t = await buildTestApp({ auth });
    const { loc, cb } = await signIn(t.app);

    // authorization URL carries PKCE + state + nonce + the configured redirect
    expect(loc.searchParams.get("redirect_uri")).toBe("http://localhost:5173/api/auth/callback");
    expect(loc.searchParams.get("code_challenge")).toBeTruthy();
    expect(seen).not.toBeNull();
    const s = seen!;
    expect(s.state).toBe(loc.searchParams.get("state"));
    expect(s.nonce).toBe(loc.searchParams.get("nonce"));
    // the verifier we pass to the exchange matches the challenge we sent
    expect(createHash("sha256").update(s.verifier).digest("base64url")).toBe(
      loc.searchParams.get("code_challenge"),
    );
    // callback URL is built from OSP_PUBLIC_URL, never the request Host
    expect(s.url.startsWith("http://localhost:5173/api/auth/callback?code=abc")).toBe(true);

    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe("/sprints/7");
    const sc = cb.cookies.find((c) => c.name === SESSION_COOKIE)!;
    expect(sc.httpOnly).toBe(true);
    expect(String(sc.sameSite).toLowerCase()).toBe("lax");
    expect(sc.path).toBe("/");
    expect(sc.secure).toBeFalsy(); // http public URL
    // login cookie cleared
    const lc = cb.cookies.find((c) => c.name === LOGIN_COOKIE);
    expect(lc?.value ?? "").toBe("");

    const me = await t.app.inject({
      method: "GET",
      url: "/api/auth/me",
      cookies: { [SESSION_COOKIE]: sc.value },
    });
    expect(me.statusCode).toBe(200);
    expect(AuthMeResponse.parse(me.json())).toEqual({
      mode: "entra",
      user: { name: "Ada Planner", email: "ada@example.test", roles: ["Viewer", "Planner"] },
      role: "Planner",
    });
    const sprints = await t.app.inject({
      method: "GET",
      url: "/api/sprints",
      cookies: { [SESSION_COOKIE]: sc.value },
    });
    expect(sprints.statusCode).toBe(200);
  });

  it("Secure cookie when OSP_PUBLIC_URL is https", async () => {
    t = await buildTestApp({
      auth: entraTestAuth({
        config: { publicUrl: "https://planner.example.test" },
        oidc: fakeOidc(async () => claims),
      }),
    });
    const { login, cb } = await signIn(t.app);
    expect(login.cookies.find((c) => c.name === LOGIN_COOKIE)!.secure).toBe(true);
    expect(cb.cookies.find((c) => c.name === SESSION_COOKIE)!.secure).toBe(true);
  });

  it("open-redirect: a hostile returnTo lands on /", async () => {
    t = await buildTestApp({ auth: entraTestAuth({ oidc: fakeOidc(async () => claims) }) });
    const { cb } = await signIn(t.app, "//evil.example/steal");
    expect(cb.headers.location).toBe("/");
  });

  it("tampered session cookie → 401", async () => {
    t = await buildTestApp({ auth: entraTestAuth({ oidc: fakeOidc(async () => claims) }) });
    const { cb } = await signIn(t.app);
    const value = cookieFrom(cb, SESSION_COOKIE)!;
    const raw = Buffer.from(value, "base64url");
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 0xff;
    const res = await t.app.inject({
      method: "GET",
      url: "/api/sprints",
      cookies: { [SESSION_COOKIE]: raw.toString("base64url") },
    });
    expect(res.statusCode).toBe(401);
    expect(ErrorResponse.parse(res.json()).error.code).toBe("UNAUTHENTICATED");
  });

  it("a login cookie replayed as a session cookie → 401", async () => {
    t = await buildTestApp({ auth: entraTestAuth({ oidc: fakeOidc(async () => claims) }) });
    const { loginCookie } = await signIn(t.app);
    const res = await t.app.inject({
      method: "GET",
      url: "/api/auth/me",
      cookies: { [SESSION_COOKIE]: loginCookie },
    });
    expect(res.statusCode).toBe(401);
  });

  it("expired session (8 h absolute) → 401", async () => {
    let now = 1_800_000_000;
    t = await buildTestApp({
      auth: entraTestAuth({ oidc: fakeOidc(async () => claims), nowSeconds: () => now }),
    });
    const { cb } = await signIn(t.app);
    const value = cookieFrom(cb, SESSION_COOKIE)!;
    now += 8 * 3600 - 1;
    expect(
      (await t.app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: value } }))
        .statusCode,
    ).toBe(200);
    now += 2;
    expect(
      (await t.app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: value } }))
        .statusCode,
    ).toBe(401);
  });

  it("callback errors redirect to /?auth_error=<code>, never a stack trace", async () => {
    let now = 1_800_000_000;
    t = await buildTestApp({
      auth: entraTestAuth({
        oidc: fakeOidc(async () => {
          throw Object.assign(new Error("unexpected JWT claim value: nonce"), { code: "OAUTH_JWT_CLAIM_COMPARISON_FAILED" });
        }),
        nowSeconds: () => now,
      }),
    });
    // exchange failure
    const { cb } = await signIn(t.app);
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe("/?auth_error=callback_failed");
    expect(cookieFrom(cb, SESSION_COOKIE)).toBeUndefined();

    // no pending login cookie
    const none = await t.app.inject({ method: "GET", url: "/api/auth/callback?code=x&state=y" });
    expect(none.headers.location).toBe("/?auth_error=login_expired");

    // pending login older than 10 min
    const login = await t.app.inject({ method: "GET", url: "/api/auth/login" });
    const lc = cookieFrom(login, LOGIN_COOKIE)!;
    now += 10 * 60 + 1;
    const stale = await t.app.inject({
      method: "GET",
      url: "/api/auth/callback?code=x&state=y",
      cookies: { [LOGIN_COOKIE]: lc },
    });
    expect(stale.headers.location).toBe("/?auth_error=login_expired");

    // IdP-reported error
    const denied = await t.app.inject({
      method: "GET",
      url: "/api/auth/callback?error=access_denied&error_description=nope",
    });
    expect(denied.headers.location).toBe("/?auth_error=access_denied");
  });

  it("signed in without a role → /me 200 role:null, protected route 403 NO_ROLE", async () => {
    t = await buildTestApp({
      auth: entraTestAuth({ oidc: fakeOidc(async () => ({ sub: "x", name: "No Role", roles: ["Other"] })) }),
    });
    const { cb } = await signIn(t.app);
    const cookies = { [SESSION_COOKIE]: cookieFrom(cb, SESSION_COOKIE)! };
    const me = await t.app.inject({ method: "GET", url: "/api/auth/me", cookies });
    expect(me.statusCode).toBe(200);
    expect(AuthMeResponse.parse(me.json()).role).toBeNull();
    const res = await t.app.inject({ method: "GET", url: "/api/sprints", cookies });
    expect(res.statusCode).toBe(403);
    expect(ErrorResponse.parse(res.json()).error.code).toBe("NO_ROLE");
  });

  it("logout clears the cookie and returns the Entra end-session URL", async () => {
    t = await buildTestApp({ auth: entraTestAuth() });
    const res = await t.app.inject({ method: "POST", url: "/api/auth/logout" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      logout_url: "https://idp.test/logout?post_logout_redirect_uri=http%3A%2F%2Flocalhost%3A5173%2F",
    });
    const cleared = res.cookies.find((c) => c.name === SESSION_COOKIE);
    expect(cleared?.value).toBe("");
  });
});

// ── the REAL openid-client pipeline against an in-process fake Entra ─────────

describe("createEntraOidcProvider — real openid-client validation, fake IdP (no network)", () => {
  const cfg: EntraAuthConfig = fakeEntraConfig();
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const KID = "test-kid";

  function signJwt(payload: Record<string, unknown>, key: KeyObject = privateKey): string {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const input = `${enc({ alg: "RS256", typ: "JWT", kid: KID })}.${enc(payload)}`;
    const sig = createSign("RSA-SHA256").update(input).sign(key).toString("base64url");
    return `${input}.${sig}`;
  }

  function fakeIdp(idToken: (body: URLSearchParams) => string, expectedChallenge: () => string) {
    const jwk = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };
    return async (url: string, init: { body?: unknown }): Promise<Response> => {
      if (url.endsWith("/discovery/v2.0/keys")) {
        return new Response(JSON.stringify({ keys: [jwk] }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/oauth2/v2.0/token")) {
        const body = new URLSearchParams(String(init.body));
        const verifier = body.get("code_verifier") ?? "";
        if (createHash("sha256").update(verifier).digest("base64url") !== expectedChallenge()) {
          return new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({ access_token: "at", token_type: "Bearer", expires_in: 3600, id_token: idToken(body) }),
          { headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    };
  }

  async function run(opts: {
    tamper?: (p: Record<string, unknown>) => Record<string, unknown>;
    key?: KeyObject;
    wrongVerifier?: boolean;
  }) {
    let challenge = "";
    const now = Math.floor(Date.now() / 1000);
    let nonce = "";
    const provider = createEntraOidcProvider(cfg, {
      fetch: fakeIdp(
        () =>
          signJwt(
            (opts.tamper ?? ((p) => p))({
              iss: entraIssuer(cfg.tenantId),
              aud: cfg.clientId,
              sub: "sub-x",
              oid: "oid-x",
              name: "Real Flow",
              roles: ["Viewer"],
              nonce,
              iat: now,
              nbf: now,
              exp: now + 3600,
            }),
            opts.key,
          ),
        () => challenge,
      ) as never,
    });
    const { pkce } = await import("./oidc");
    const verifier = pkce.verifier();
    challenge = await pkce.challenge(verifier);
    nonce = pkce.nonce();
    const state = pkce.state();
    const authUrl = new URL(
      provider.authorizationUrl({
        redirectUri: `${cfg.publicUrl}/api/auth/callback`,
        state,
        nonce,
        codeChallenge: challenge,
      }),
    );
    expect(authUrl.origin).toBe("https://login.microsoftonline.com");
    expect(authUrl.pathname).toBe(`/${cfg.tenantId}/oauth2/v2.0/authorize`);
    expect(authUrl.searchParams.get("client_id")).toBe(cfg.clientId);
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("scope")).toBe("openid profile email");
    return provider.exchange(
      new URL(`${cfg.publicUrl}/api/auth/callback?code=c0de&state=${state}`),
      { state, nonce, codeVerifier: opts.wrongVerifier ? pkce.verifier() : verifier },
    );
  }

  it("valid ID token → claims", async () => {
    const claims = await run({});
    expect(claims.sub).toBe("sub-x");
    expect(claims.roles).toEqual(["Viewer"]);
  });

  it("signature by a foreign key → rejected", async () => {
    await expect(run({ key: other.privateKey })).rejects.toThrow();
  });

  it("wrong issuer → rejected", async () => {
    await expect(run({ tamper: (p) => ({ ...p, iss: "https://login.microsoftonline.com/evil/v2.0" }) })).rejects.toThrow();
  });

  it("wrong audience → rejected", async () => {
    await expect(run({ tamper: (p) => ({ ...p, aud: "22222222-2222-2222-2222-222222222222" }) })).rejects.toThrow();
  });

  it("expired → rejected", async () => {
    const past = Math.floor(Date.now() / 1000) - 7200;
    await expect(run({ tamper: (p) => ({ ...p, iat: past, nbf: past, exp: past + 60 }) })).rejects.toThrow();
  });

  it("wrong nonce → rejected", async () => {
    await expect(run({ tamper: (p) => ({ ...p, nonce: "other" }) })).rejects.toThrow();
  });

  it("wrong PKCE verifier → rejected by the token endpoint", async () => {
    await expect(run({ wrongVerifier: true })).rejects.toThrow();
  });

  it("state mismatch → rejected", async () => {
    const provider = createEntraOidcProvider(cfg, { fetch: (async () => { throw new Error("must not fetch"); }) as never });
    await expect(
      provider.exchange(new URL(`${cfg.publicUrl}/api/auth/callback?code=c&state=forged`), {
        state: "expected",
        nonce: "n",
        codeVerifier: "v".repeat(43),
      }),
    ).rejects.toThrow();
  });

  it("end-session URL targets the tenant logout endpoint with post_logout_redirect_uri", () => {
    const provider = createEntraOidcProvider(cfg);
    const u = new URL(provider.endSessionUrl(`${cfg.publicUrl}/`));
    expect(`${u.origin}${u.pathname}`).toBe(
      `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/logout`,
    );
    expect(u.searchParams.get("post_logout_redirect_uri")).toBe("http://localhost:5173/");
  });
});
