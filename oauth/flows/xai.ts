// Ported from NousResearch/hermes-agent (MIT) — hermes_cli/auth.py xAI sections
// (L93-111, L2979-3160, L5286-5469), via oh-my-pi/packages/ai/src/registry/oauth/xai-oauth.ts.
import { startCallbackServer, type CallbackServerHandle } from "../callback-server";
import { generatePkcePair } from "../pkce";
import { createOAuthTokenStore } from "../token-store";
import type {
  OAuthCredential,
  OAuthFlowDeps,
  OAuthTokenResponse,
  PkcePair,
} from "../types";
import type { CliFetchImpl } from "../../cliFetch";


// Hermes hermes_cli/auth.py L93-111
const XAI_OAUTH_ISSUER = "https://auth.x.ai";
const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const XAI_OAUTH_REDIRECT_HOST = "127.0.0.1";
const XAI_OAUTH_REDIRECT_PORT = 56121;
const XAI_OAUTH_REDIRECT_PATH = "/callback";
const XAI_OAUTH_DOCS_URL =
  "https://hermes-agent.nousresearch.com/docs/guides/xai-grok-oauth";

// Mirrors the 5-min skew used by other providers' refresh paths.
const ACCESS_TOKEN_CLIENT_SKEW_MS = 5 * 60 * 1000;

const DISCOVERY_TIMEOUT_MS = 15_000;
const TOKEN_REQUEST_TIMEOUT_MS = 20_000;

interface XAIOAuthDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
}

/**
 * Validate an xAI OIDC discovery endpoint against scheme + host.
 * Hermes `_xai_validate_oauth_endpoint` L2997-3035.
 */
export function validateXAIEndpoint(url: string, field: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid xAI ${field}: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Invalid xAI ${field}: ${url}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (!host || (host !== "x.ai" && !host.endsWith(".x.ai"))) {
    throw new Error(`Invalid xAI ${field}: ${url}`);
  }
  return url;
}

/**
 * Fetch xAI's OIDC discovery document and validate both endpoints.
 * Hermes `_xai_oauth_discovery` L3038-3084.
 */
async function xaiOAuthDiscovery(
  fetchImpl: CliFetchImpl,
  timeoutMs: number = DISCOVERY_TIMEOUT_MS
): Promise<XAIOAuthDiscovery> {
  let response: Response;
  try {
    response = await fetchImpl(XAI_OAUTH_DISCOVERY_URL, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(
      `xAI OIDC discovery failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (response.status !== 200) {
    throw new Error(`xAI OIDC discovery returned status ${response.status}.`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(
      `xAI OIDC discovery returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("xAI OIDC discovery response was not a JSON object.");
  }
  const obj = payload as Record<string, unknown>;
  const authorizationEndpoint =
    typeof obj.authorization_endpoint === "string"
      ? obj.authorization_endpoint.trim()
      : "";
  const tokenEndpoint =
    typeof obj.token_endpoint === "string" ? obj.token_endpoint.trim() : "";
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new Error("xAI OIDC discovery response was missing required endpoints.");
  }
  validateXAIEndpoint(authorizationEndpoint, "authorization_endpoint");
  validateXAIEndpoint(tokenEndpoint, "token_endpoint");
  return {
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
  };
}

/**
 * Build the xAI authorization URL.
 * Hermes `_xai_oauth_build_authorize_url` L5286-5312. `plan=generic` opts the
 * consent screen into xAI's generic OAuth plan tier; without it,
 * `accounts.x.ai` rejects loopback OAuth from non-allowlisted clients.
 */
function buildXAIAuthorizeUrl(opts: {
  authorizationEndpoint: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  nonce: string;
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: XAI_OAUTH_CLIENT_ID,
    redirect_uri: opts.redirectUri,
    scope: XAI_OAUTH_SCOPE,
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
    state: opts.state,
    nonce: opts.nonce,
    plan: "generic",
    referrer: "nolo-cli",
  });
  return `${opts.authorizationEndpoint}?${params.toString()}`;
}

function generateState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map(value => value.toString(16).padStart(2, "0"))
    .join("");
}

async function exchangeXAIToken(
  fetchImpl: CliFetchImpl,
  code: string,
  redirectUri: string,
  verifier: string
): Promise<OAuthTokenResponse> {
  const discovery = await xaiOAuthDiscovery(fetchImpl);
  const tokenEndpoint = validateXAIEndpoint(discovery.token_endpoint, "token_endpoint");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: XAI_OAUTH_CLIENT_ID,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });

  const response = await fetchImpl(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).trim();
    } catch {
      // ignore body-read failures
    }
    throw new Error(
      `xAI token exchange failed: ${response.status}${detail ? ` ${detail}` : ""}`
    );
  }

  const data = (await response.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    scope?: unknown;
    id_token?: unknown;
  };

  if (typeof data.access_token !== "string" || !data.access_token) {
    throw new Error("xAI token exchange response missing access_token");
  }
  if (typeof data.refresh_token !== "string" || !data.refresh_token) {
    throw new Error("xAI token exchange response missing refresh_token");
  }
  if (typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in)) {
    throw new Error("xAI token exchange response missing expires_in");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    scope: typeof data.scope === "string" ? data.scope : undefined,
    idToken: typeof data.id_token === "string" ? data.id_token : undefined,
  };
}

/**
 * Login with xAI Grok OAuth (SuperGrok subscription).
 * Hermes `_xai_oauth_loopback_login` L5315-5469.
 */
export async function runXaiOAuthLogin(
  deps: OAuthFlowDeps = {}
): Promise<OAuthCredential> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const output = deps.output ?? console;
  const error = deps.error ?? console;

  const redirectUri = `http://${XAI_OAUTH_REDIRECT_HOST}:${XAI_OAUTH_REDIRECT_PORT}${XAI_OAUTH_REDIRECT_PATH}`;

  // Start callback server first so we know the actual redirect URI.
  let handle: CallbackServerHandle;
  try {
    handle = await startCallbackServer({
      port: XAI_OAUTH_REDIRECT_PORT,
      hostname: XAI_OAUTH_REDIRECT_HOST,
      timeoutMs: 5 * 60_000,
    });
  } catch (err) {
    throw new Error(
      `Failed to start xAI OAuth callback server on ${XAI_OAUTH_REDIRECT_PORT}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  try {
    const state = generateState();
    const pkce: PkcePair = await generatePkcePair();
    const nonce = crypto.randomUUID().replace(/-/g, "");

    const discovery = await xaiOAuthDiscovery(fetchImpl);
    const authUrl = buildXAIAuthorizeUrl({
      authorizationEndpoint: discovery.authorization_endpoint,
      redirectUri,
      codeChallenge: pkce.challenge,
      state,
      nonce,
    });

    output.log(
      `Open the following URL in your browser to log in to xAI Grok (SuperGrok):\n  ${authUrl}\n\nDocs: ${XAI_OAUTH_DOCS_URL}`
    );

    if (deps.openBrowser) {
      try {
        await deps.openBrowser(authUrl);
      } catch (err) {
        error.error(
          `Failed to open browser automatically: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    const callback = await handle.waitForCode();

    const token = await exchangeXAIToken(
      fetchImpl,
      callback.code,
      redirectUri,
      pkce.verifier
    );

    const now = (deps.now ?? Date.now)();
    const expiresIn = token.expiresIn as number;
    return {
      provider: "xai",
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: now + expiresIn * 1000 - ACCESS_TOKEN_CLIENT_SKEW_MS,
      scope: token.scope,
      idToken: token.idToken,
      obtainedAt: now,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Refresh an xAI OAuth access token using a stored refresh_token.
 * Hermes `refresh_xai_oauth_pure` L3087-3160. Re-runs OIDC discovery and
 * re-validates the cached `token_endpoint` on the refresh hot path so a
 * cached-but-poisoned endpoint cannot silently leak a refresh_token.
 */
export async function refreshXaiOAuthToken(
  credential: OAuthCredential
): Promise<OAuthCredential> {
  if (!credential.refreshToken) {
    throw new Error("xAI credential has no refresh_token");
  }
  const fetchImpl = fetch;

  const discovery = await xaiOAuthDiscovery(fetchImpl);
  const tokenEndpoint = validateXAIEndpoint(discovery.token_endpoint, "token_endpoint");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: XAI_OAUTH_CLIENT_ID,
    refresh_token: credential.refreshToken,
  });

  const response = await fetchImpl(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).trim();
    } catch {
      // ignore
    }
    throw new Error(
      `xAI token refresh failed: ${response.status}${detail ? ` ${detail}` : ""}`
    );
  }

  const data = (await response.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  };

  if (typeof data.access_token !== "string" || !data.access_token) {
    throw new Error("xAI token refresh response missing access_token");
  }
  if (typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in)) {
    throw new Error("xAI token refresh response missing expires_in");
  }

  const newRefresh =
    typeof data.refresh_token === "string" && data.refresh_token
      ? data.refresh_token
      : credential.refreshToken;

  const now = Date.now();
  return {
    ...credential,
    accessToken: data.access_token,
    refreshToken: newRefresh,
    expiresAt: now + data.expires_in * 1000 - ACCESS_TOKEN_CLIENT_SKEW_MS,
    obtainedAt: now,
  };
}

export function resolveXaiCredential(): OAuthCredential | null {
  return createOAuthTokenStore().read("xai");
}
