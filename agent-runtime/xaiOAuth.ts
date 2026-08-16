// Ported from NousResearch/hermes-agent (MIT) — hermes_cli/auth.py xAI sections
// (L93-111, L2979-3160, L5286-5469), via oh-my-pi/packages/ai/src/registry/oauth/xai-oauth.ts.
// Device-code path aligns with openclaw/openclaw extensions/xai/xai-oauth.ts (RFC 8628).
import { toErrorMessage } from "../core/errorMessage";
import { isRecord } from "../core/isRecord";
import { asOptionalFiniteNumber } from "../core/optionalNumber";
import { asTrimmedString } from "../core/trimmedString";

import type { OAuthCredential, OAuthRefreshFn } from "./oauthTokenStore";

export const XAI_OAUTH_ISSUER = "https://auth.x.ai";
export const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
export const XAI_OAUTH_REDIRECT_HOST = "127.0.0.1";
export const XAI_OAUTH_REDIRECT_PORT = 56121;
export const XAI_OAUTH_REDIRECT_PATH = "/callback";
export const XAI_OAUTH_REDIRECT_URI = `http://${XAI_OAUTH_REDIRECT_HOST}:${XAI_OAUTH_REDIRECT_PORT}${XAI_OAUTH_REDIRECT_PATH}`;
export const XAI_OAUTH_DOCS_URL =
  "https://hermes-agent.nousresearch.com/docs/guides/xai-grok-oauth";

/** RFC 8628 device_code grant. */
export const XAI_DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
export const XAI_DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000;
export const XAI_DEVICE_CODE_MIN_INTERVAL_MS = 1_000;
export const XAI_DEVICE_CODE_SLOW_DOWN_INCREMENT_MS = 5_000;
export const XAI_DEVICE_CODE_DEFAULT_EXPIRES_MS = 5 * 60_000;

export const XAI_ACCESS_TOKEN_CLIENT_SKEW_MS = 5 * 60 * 1000;
export const XAI_DISCOVERY_TIMEOUT_MS = 15_000;
export const XAI_TOKEN_REQUEST_TIMEOUT_MS = 20_000;

export interface XAIOAuthDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  device_authorization_endpoint?: string;
}

export type XAITokenPayload = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  id_token?: unknown;
  error?: unknown;
  error_description?: unknown;
};

export type RefreshXaiTokenDeps = {
  fetchImpl?: typeof fetch;
  now?: () => number;
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

export function isLikelyHtmlOrCloudflareChallenge(
  response: Response,
  bodyText: string
): boolean {
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

export async function readJsonBody(
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
export async function xaiOAuthDiscovery(
  fetchImpl: typeof fetch = fetch,
  options: { requireDeviceAuthorization?: boolean; timeoutMs?: number } = {}
): Promise<XAIOAuthDiscovery> {
  const timeoutMs = options.timeoutMs ?? XAI_DISCOVERY_TIMEOUT_MS;
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
    if (
      isLikelyHtmlOrCloudflareChallenge(
        response,
        await response.clone().text().catch(() => "")
      )
    ) {
      throw new Error(
        `xAI OIDC discovery failed (${response.status}): xAI returned an HTML/Cloudflare challenge instead of OAuth JSON`
      );
    }
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

export function normalizeXaiTokenPayload(args: {
  payload: XAITokenPayload | Record<string, unknown>;
  baseCredential?: Partial<OAuthCredential>;
  now?: number;
  requireRefreshToken?: boolean;
  context?: string;
}): OAuthCredential {
  const {
    payload,
    baseCredential,
    now = Date.now(),
    requireRefreshToken = false,
    context = "xAI OAuth token response",
  } = args;

  const accessToken =
    typeof payload.access_token === "string" ? payload.access_token.trim() : "";
  if (!accessToken) {
    throw new Error(`${context} missing access_token`);
  }

  const rawRefreshToken =
    typeof payload.refresh_token === "string" && payload.refresh_token.trim()
      ? payload.refresh_token.trim()
      : undefined;

  if (requireRefreshToken && !rawRefreshToken) {
    throw new Error(`${context} missing refresh_token`);
  }

  const expiresIn = asOptionalFiniteNumber(payload.expires_in);
  if (expiresIn === undefined) {
    throw new Error(`${context} missing expires_in`);
  }

  const refreshToken = rawRefreshToken ?? baseCredential?.refreshToken;

  const scope =
    typeof payload.scope === "string" && payload.scope.trim()
      ? payload.scope.trim()
      : baseCredential?.scope;

  const idToken =
    typeof payload.id_token === "string" && payload.id_token.trim()
      ? payload.id_token.trim()
      : baseCredential?.idToken;

  const accountId =
    typeof (payload as Record<string, unknown>).account_id === "string" &&
    (payload as Record<string, unknown>).account_id
      ? ((payload as Record<string, unknown>).account_id as string)
      : baseCredential?.accountId;

  return {
    ...baseCredential,
    provider: "xai",
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    expiresAt: now + expiresIn * 1000 - XAI_ACCESS_TOKEN_CLIENT_SKEW_MS,
    ...(scope ? { scope } : {}),
    ...(idToken ? { idToken } : {}),
    ...(accountId ? { accountId } : {}),
    obtainedAt: now,
  };
}

/**
 * Refresh an xAI OAuth access token using a stored refresh_token.
 * Hermes `refresh_xai_oauth_pure` L3087-3160. Re-runs OIDC discovery and
 * re-validates the cached `token_endpoint` on the refresh hot path so a
 * cached-but-poisoned endpoint cannot silently leak a refresh_token.
 */
export async function refreshXaiToken(
  credential: OAuthCredential,
  deps: RefreshXaiTokenDeps = {}
): Promise<OAuthCredential> {
  if (!credential.refreshToken) {
    throw new Error("xAI credential has no refresh_token");
  }
  const fetchImpl = deps.fetchImpl ?? fetch;

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
      signal: AbortSignal.timeout(XAI_TOKEN_REQUEST_TIMEOUT_MS),
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

  const now = deps.now?.() ?? Date.now();
  return normalizeXaiTokenPayload({
    payload: data,
    baseCredential: credential,
    now,
    context: "xAI token refresh response",
  });
}

export const xaiRefresh: OAuthRefreshFn = refreshXaiToken;
