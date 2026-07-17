// Ported from NousResearch/hermes-agent (MIT) — hermes_cli/auth.py xAI sections
// (L93-111, L2979-3160, L5286-5469), via oh-my-pi/packages/ai/src/registry/oauth/xai-oauth.ts.
// Device-code path aligns with openclaw/openclaw extensions/xai/xai-oauth.ts (RFC 8628).
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
import { toErrorMessage } from "../../core/errorMessage";
import { isRecord } from "../../core/isRecord";
import { asOptionalFiniteNumber } from "../../core/optionalNumber";
import { asTrimmedString } from "../../core/trimmedString";


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

/** RFC 8628 device_code grant. */
const XAI_DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const XAI_DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000;
const XAI_DEVICE_CODE_MIN_INTERVAL_MS = 1_000;
const XAI_DEVICE_CODE_SLOW_DOWN_INCREMENT_MS = 5_000;
const XAI_DEVICE_CODE_DEFAULT_EXPIRES_MS = 5 * 60_000;

// Mirrors the 5-min skew used by other providers' refresh paths.
const ACCESS_TOKEN_CLIENT_SKEW_MS = 5 * 60 * 1000;

const DISCOVERY_TIMEOUT_MS = 15_000;
const TOKEN_REQUEST_TIMEOUT_MS = 20_000;

interface XAIOAuthDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  device_authorization_endpoint?: string;
}

type XAIDeviceCodeStart = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresInMs: number;
  intervalMs: number;
};

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

function isLikelyHtmlOrCloudflareChallenge(response: Response, bodyText: string): boolean {
  const contentType = response.headers.get("content-type") ?? "";
  return (
    response.headers.get("cf-mitigated") === "challenge" ||
    /text\/html/i.test(contentType) ||
    /<!doctype html|<html\b/i.test(bodyText) ||
    /\b(?:cloudflare|attention required|just a moment|enable javascript and cookies|challenge-platform)\b/i.test(
      bodyText
    )
  );
}

async function readJsonBody(
  response: Response,
  context: string
): Promise<Record<string, unknown>> {
  let text = "";
  try {
    text = await response.text();
  } catch (error) {
    throw new Error(
      `${context}: failed to read response body: ${toErrorMessage(error)}`
    );
  }
  if (!text.trim()) {
    if (!response.ok) {
      throw new Error(`${context} failed (${response.status}): empty response body`);
    }
    return {};
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) {
      throw new Error(`${context} returned non-object JSON`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(context)) {
      throw error;
    }
    if (isLikelyHtmlOrCloudflareChallenge(response, text)) {
      throw new Error(
        `${context} failed (${response.status}): xAI returned an HTML/Cloudflare challenge instead of OAuth JSON`
      );
    }
    throw new Error(
      `${context} returned invalid JSON: ${toErrorMessage(error)}`
    );
  }
}

/**
 * Fetch xAI's OIDC discovery document and validate endpoints.
 * Hermes `_xai_oauth_discovery` L3038-3084.
 * Device-code additionally requires `device_authorization_endpoint` when requested.
 */
async function xaiOAuthDiscovery(
  fetchImpl: CliFetchImpl,
  options: { requireDeviceAuthorization?: boolean; timeoutMs?: number } = {}
): Promise<XAIOAuthDiscovery> {
  const timeoutMs = options.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
  let response: Response;
  try {
    response = await fetchImpl(XAI_OAUTH_DISCOVERY_URL, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(
      `xAI OIDC discovery failed: ${toErrorMessage(error)}`
    );
  }
  if (response.status !== 200) {
    throw new Error(`xAI OIDC discovery returned status ${response.status}.`);
  }
  const obj = await readJsonBody(response, "xAI OIDC discovery");
  const authorizationEndpoint = asTrimmedString(obj.authorization_endpoint);
  const tokenEndpoint = asTrimmedString(obj.token_endpoint);
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new Error("xAI OIDC discovery response was missing required endpoints.");
  }
  validateXAIEndpoint(authorizationEndpoint, "authorization_endpoint");
  validateXAIEndpoint(tokenEndpoint, "token_endpoint");

  const deviceAuthorizationEndpoint = asTrimmedString(
    obj.device_authorization_endpoint
  );
  if (options.requireDeviceAuthorization) {
    if (!deviceAuthorizationEndpoint) {
      throw new Error(
        "xAI OIDC discovery response was missing device_authorization_endpoint."
      );
    }
    validateXAIEndpoint(deviceAuthorizationEndpoint, "device_authorization_endpoint");
  } else if (deviceAuthorizationEndpoint) {
    validateXAIEndpoint(deviceAuthorizationEndpoint, "device_authorization_endpoint");
  }

  return {
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
    ...(deviceAuthorizationEndpoint
      ? { device_authorization_endpoint: deviceAuthorizationEndpoint }
      : {}),
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

function parsePositiveSecondsToMs(value: unknown, fallbackMs: number): number {
  const sec =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : NaN;
  if (!Number.isFinite(sec) || sec <= 0) return fallbackMs;
  return Math.max(1, Math.floor(sec * 1000));
}

function parseOAuthTokenPayload(
  data: Record<string, unknown>,
  context: string,
  options: { requireRefreshToken?: boolean } = {}
): OAuthTokenResponse {
  if (typeof data.access_token !== "string" || !data.access_token) {
    throw new Error(`${context} missing access_token`);
  }
  const refreshToken =
    typeof data.refresh_token === "string" && data.refresh_token
      ? data.refresh_token
      : undefined;
  if (options.requireRefreshToken && !refreshToken) {
    throw new Error(`${context} missing refresh_token`);
  }
  const expiresIn = asOptionalFiniteNumber(data.expires_in);
  if (expiresIn === undefined) {
    throw new Error(`${context} missing expires_in`);
  }
  return {
    accessToken: data.access_token,
    ...(refreshToken ? { refreshToken } : {}),
    expiresIn,
    scope: typeof data.scope === "string" ? data.scope : undefined,
    idToken: typeof data.id_token === "string" ? data.id_token : undefined,
  };
}

function tokenToCredential(
  token: OAuthTokenResponse,
  now: number
): OAuthCredential {
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

  let response: Response;
  try {
    response = await fetchImpl(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `xAI token exchange failed: ${toErrorMessage(error)}`
    );
  }

  const data = await readJsonBody(response, "xAI token exchange");
  if (!response.ok) {
    const detail =
      (typeof data.error_description === "string" && data.error_description) ||
      (typeof data.error === "string" && data.error) ||
      "";
    throw new Error(
      `xAI token exchange failed: ${response.status}${detail ? ` ${detail}` : ""}`
    );
  }

  return parseOAuthTokenPayload(data, "xAI token exchange response", {
    requireRefreshToken: true,
  });
}

async function requestXaiDeviceCode(
  fetchImpl: CliFetchImpl,
  deviceAuthorizationEndpoint: string
): Promise<XAIDeviceCodeStart> {
  const endpoint = validateXAIEndpoint(
    deviceAuthorizationEndpoint,
    "device_authorization_endpoint"
  );
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        client_id: XAI_OAUTH_CLIENT_ID,
        scope: XAI_OAUTH_SCOPE,
      }),
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `xAI device code request failed: ${toErrorMessage(error)}`
    );
  }

  const data = await readJsonBody(response, "xAI device code request");
  if (!response.ok) {
    const detail =
      (typeof data.error_description === "string" && data.error_description) ||
      (typeof data.error === "string" && data.error) ||
      "";
    throw new Error(
      `xAI device code request failed (${response.status})${detail ? `: ${detail}` : ""}`
    );
  }

  const deviceCode = asTrimmedString(data.device_code);
  const userCode = asTrimmedString(data.user_code);
  const verificationUri = asTrimmedString(data.verification_uri);
  const verificationUriComplete = asTrimmedString(
    data.verification_uri_complete
  );

  if (!deviceCode || !userCode || !verificationUri) {
    throw new Error(
      "xAI device code response is missing device_code, user_code, or verification_uri"
    );
  }

  validateXAIEndpoint(verificationUri, "verification_uri");
  if (verificationUriComplete) {
    validateXAIEndpoint(verificationUriComplete, "verification_uri_complete");
  }

  return {
    deviceCode,
    userCode,
    verificationUri,
    ...(verificationUriComplete ? { verificationUriComplete } : {}),
    expiresInMs: parsePositiveSecondsToMs(
      data.expires_in,
      XAI_DEVICE_CODE_DEFAULT_EXPIRES_MS
    ),
    intervalMs: Math.max(
      parsePositiveSecondsToMs(data.interval, XAI_DEVICE_CODE_DEFAULT_INTERVAL_MS),
      XAI_DEVICE_CODE_MIN_INTERVAL_MS
    ),
  };
}

async function pollXaiDeviceCodeToken(args: {
  fetchImpl: CliFetchImpl;
  tokenEndpoint: string;
  deviceCode: string;
  expiresInMs: number;
  intervalMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}): Promise<OAuthTokenResponse> {
  const tokenEndpoint = validateXAIEndpoint(args.tokenEndpoint, "token_endpoint");
  const deadlineMs = args.now() + args.expiresInMs;
  let intervalMs = args.intervalMs;

  while (args.now() < deadlineMs) {
    const remainingMs = Math.max(0, deadlineMs - args.now());
    const delayMs = Math.min(Math.max(intervalMs, XAI_DEVICE_CODE_MIN_INTERVAL_MS), remainingMs);
    if (delayMs > 0) {
      await args.sleep(delayMs);
    }
    if (args.now() >= deadlineMs) break;

    let response: Response;
    try {
      response = await args.fetchImpl(tokenEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: XAI_DEVICE_CODE_GRANT_TYPE,
          client_id: XAI_OAUTH_CLIENT_ID,
          device_code: args.deviceCode,
        }),
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const message = toErrorMessage(error);
      if (/abort|timeout/i.test(message)) {
        throw new Error(`xAI device token poll aborted or timed out: ${message}`);
      }
      throw new Error(`xAI device token poll failed: ${message}`);
    }

    let data: Record<string, unknown>;
    try {
      data = await readJsonBody(response, "xAI device token exchange");
    } catch (error) {
      // Malformed / HTML / CF challenge on poll is fatal for this attempt.
      throw error;
    }

    if (response.ok) {
      return parseOAuthTokenPayload(data, "xAI device token exchange response", {
        requireRefreshToken: true,
      });
    }

    const oauthError = typeof data.error === "string" ? data.error : "";
    if (oauthError === "authorization_pending") {
      continue;
    }
    if (oauthError === "slow_down") {
      intervalMs += XAI_DEVICE_CODE_SLOW_DOWN_INCREMENT_MS;
      continue;
    }
    if (oauthError === "access_denied" || oauthError === "authorization_denied") {
      throw new Error("xAI device authorization was denied");
    }
    if (oauthError === "expired_token") {
      throw new Error("xAI device code expired. Re-run the login.");
    }

    const detail =
      (typeof data.error_description === "string" && data.error_description) ||
      oauthError ||
      "";
    throw new Error(
      `xAI device token exchange failed (${response.status})${detail ? `: ${detail}` : ""}`
    );
  }

  throw new Error("xAI device authorization timed out");
}

/**
 * Login with xAI Grok OAuth (SuperGrok subscription) via loopback PKCE.
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
      `Failed to start xAI OAuth callback server on ${XAI_OAUTH_REDIRECT_PORT}: ${toErrorMessage(err)}`
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
          `Failed to open browser automatically: ${toErrorMessage(err)}`
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
    return tokenToCredential(token, now);
  } finally {
    await handle.close();
  }
}

/**
 * Login with xAI Grok OAuth via RFC 8628 device authorization (headless-friendly).
 * No localhost callback; user opens verification_uri and enters user_code.
 * Tokens are returned only as OAuthCredential — never logged.
 */
export async function runXaiOAuthDeviceCode(
  deps: OAuthFlowDeps = {}
): Promise<OAuthCredential> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const output = deps.output ?? console;
  const error = deps.error ?? console;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;

  const discovery = await xaiOAuthDiscovery(fetchImpl, {
    requireDeviceAuthorization: true,
  });
  const deviceAuthorizationEndpoint = discovery.device_authorization_endpoint;
  if (!deviceAuthorizationEndpoint) {
    throw new Error("xAI OIDC discovery missing device_authorization_endpoint");
  }

  const start = await requestXaiDeviceCode(fetchImpl, deviceAuthorizationEndpoint);

  const browserUrl = start.verificationUriComplete ?? start.verificationUri;
  const expiresMinutes = Math.max(1, Math.round(start.expiresInMs / 60_000));

  output.log("Authorize nolo-cli for xAI Grok (device code / headless):");
  output.log(`  URL: ${start.verificationUri}`);
  if (start.verificationUriComplete) {
    output.log(`  Complete URL: ${start.verificationUriComplete}`);
  }
  output.log(`  Code: ${start.userCode}`);
  output.log(
    `  Code expires in ~${expiresMinutes} minute(s). Never share the code or tokens.`
  );

  if (deps.openBrowser) {
    try {
      const opened = await deps.openBrowser(browserUrl);
      if (!opened) {
        output.log("Could not open a browser automatically. Open the URL above.");
      }
    } catch (err) {
      error.error(
        `Failed to open browser automatically: ${toErrorMessage(err)}`
      );
    }
  } else {
    output.log("Open the URL above in a browser and enter the code to approve.");
  }

  const token = await pollXaiDeviceCodeToken({
    fetchImpl,
    tokenEndpoint: discovery.token_endpoint,
    deviceCode: start.deviceCode,
    expiresInMs: start.expiresInMs,
    intervalMs: start.intervalMs,
    sleep,
    now,
  });

  return tokenToCredential(token, now());
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

  let response: Response;
  try {
    response = await fetchImpl(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `xAI token refresh failed: ${toErrorMessage(error)}`
    );
  }

  const data = await readJsonBody(response, "xAI token refresh");
  if (!response.ok) {
    const detail =
      (typeof data.error_description === "string" && data.error_description) ||
      (typeof data.error === "string" && data.error) ||
      "";
    throw new Error(
      `xAI token refresh failed: ${response.status}${detail ? ` ${detail}` : ""}`
    );
  }

  if (typeof data.access_token !== "string" || !data.access_token) {
    throw new Error("xAI token refresh response missing access_token");
  }
  const expiresIn = asOptionalFiniteNumber(data.expires_in);
  if (expiresIn === undefined) {
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
    expiresAt: now + expiresIn * 1000 - ACCESS_TOKEN_CLIENT_SKEW_MS,
    obtainedAt: now,
  };
}

export function resolveXaiCredential(): OAuthCredential | null {
  return createOAuthTokenStore().read("xai");
}
