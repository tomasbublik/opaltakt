import * as client from "openid-client";
import type { EntraAuthConfig } from "./config";

/**
 * Increment 39 §1/§4 — the OIDC seam. Routes only ever talk to this interface,
 * so tests inject a fake (no network) while production uses `openid-client`.
 *
 * Design decision (documented in README "Authentication"): NO discovery
 * request. Entra ID's v2 endpoints follow a fixed, documented pattern per
 * tenant, so the Configuration is built from static metadata. Consequences:
 *  - `/api/auth/login` works without any outbound call (it only builds a URL),
 *    so a transient Entra outage or a typo'd tenant surfaces at the IdP's own
 *    page instead of as a 500 from our server;
 *  - the only network traffic is in `/callback` (token endpoint + JWKS), whose
 *    failures redirect to `/?auth_error=…` per §4.
 * ID-token signatures are verified against the tenant JWKS
 * (`enableNonRepudiationChecks`); issuer, audience, expiry, nonce, state and
 * PKCE are verified by `authorizationCodeGrant`.
 */

export interface IdTokenClaims {
  sub: string;
  oid?: string;
  name?: string;
  preferred_username?: string;
  email?: string;
  roles?: unknown;
  [k: string]: unknown;
}

export interface OidcProvider {
  /** Build the IdP authorization URL (no network). */
  authorizationUrl(params: {
    redirectUri: string;
    state: string;
    nonce: string;
    codeChallenge: string;
  }): string;
  /**
   * Exchange the code from the callback URL and return VALIDATED ID-token
   * claims. Throws on any validation/network failure.
   */
  exchange(
    callbackUrl: URL,
    checks: { state: string; nonce: string; codeVerifier: string },
  ): Promise<IdTokenClaims>;
  /** The IdP end-session URL (no network). */
  endSessionUrl(postLogoutRedirectUri: string): string;
}

export const ENTRA_SCOPES = "openid profile email";

export function entraIssuer(tenantId: string): string {
  return `https://login.microsoftonline.com/${tenantId}/v2.0`;
}

export function entraServerMetadata(tenantId: string): client.ServerMetadata {
  const base = `https://login.microsoftonline.com/${tenantId}`;
  return {
    issuer: entraIssuer(tenantId),
    authorization_endpoint: `${base}/oauth2/v2.0/authorize`,
    token_endpoint: `${base}/oauth2/v2.0/token`,
    jwks_uri: `${base}/discovery/v2.0/keys`,
    end_session_endpoint: `${base}/oauth2/v2.0/logout`,
    id_token_signing_alg_values_supported: ["RS256"],
    code_challenge_methods_supported: ["S256"],
  };
}

export interface EntraProviderOptions {
  /**
   * TEST SEAM — replaces outbound HTTP (token endpoint + JWKS) so the REAL
   * openid-client validation pipeline can run against an in-process fake IdP.
   * Never set in production.
   */
  fetch?: client.CustomFetch;
}

export function createEntraOidcProvider(
  cfg: EntraAuthConfig,
  options: EntraProviderOptions = {},
): OidcProvider {
  const config = new client.Configuration(
    entraServerMetadata(cfg.tenantId),
    cfg.clientId,
    { client_secret: cfg.clientSecret, id_token_signed_response_alg: "RS256" },
    client.ClientSecretPost(cfg.clientSecret),
  );
  client.enableNonRepudiationChecks(config);
  if (options.fetch) config[client.customFetch] = options.fetch;

  return {
    authorizationUrl({ redirectUri, state, nonce, codeChallenge }) {
      return client
        .buildAuthorizationUrl(config, {
          redirect_uri: redirectUri,
          response_type: "code",
          response_mode: "query",
          scope: ENTRA_SCOPES,
          state,
          nonce,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
        })
        .toString();
    },
    async exchange(callbackUrl, { state, nonce, codeVerifier }) {
      const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: codeVerifier,
        expectedState: state,
        expectedNonce: nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims) throw new Error("no ID token in the token response");
      return claims as unknown as IdTokenClaims;
    },
    endSessionUrl(postLogoutRedirectUri) {
      return client
        .buildEndSessionUrl(config, { post_logout_redirect_uri: postLogoutRedirectUri })
        .toString();
    },
  };
}

/** PKCE/state/nonce generators, re-exported so routes don't import the lib. */
export const pkce = {
  verifier: (): string => client.randomPKCECodeVerifier(),
  challenge: (verifier: string): Promise<string> => client.calculatePKCECodeChallenge(verifier),
  state: (): string => client.randomState(),
  nonce: (): string => client.randomNonce(),
};
