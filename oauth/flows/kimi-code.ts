// Kimi Code OAuth (Kimi membership subscription) via RFC 8628 device-code flow.
//
// Mirrors opencode-kimi-full's device flow + token poll + refresh + listModels,
// ported onto nolo's existing OAuth infrastructure (oauthTokenStore.ts +
// oauthProviders.ts). The official kimi-code CLI (v1.41.0) uses device_code
// grant with only client_id (no scope), so we align 1:1 with that.
//
// Reference: opencode-kimi-full src/constants.ts + src/oauth.ts + src/headers.ts.

import { buildKimiCodeHeaders, KIMI_UPSTREAM_VERSION } from "../../agent-runtime/kimiHeaders";
import type { OAuthCredential, OAuthFlowDeps } from "../types";
import type { CliFetchImpl } from "../../cliFetch";
import { toErrorMessage } from "../../core/errorMessage";
import { isRecord } from "../../core/isRecord";
import { asOptionalFiniteNumber } from "../../core/optionalNumber";
import { asTrimmedString } from "../../core/trimmedString";

// --- Constants (1:1 from opencode-kimi-full src/constants.ts) ---

const USER_AGENT = `KimiCLI/${KIMI_UPSTREAM_VERSION}`;
const OAUTH_HOST = "https://auth.kimi.com";
const OAUTH_DEVICE_AUTH_URL = `${OAUTH_HOST}/api/oauth/device_authorization`;
const OAUTH_TOKEN_URL = `${OAUTH_HOST}/api/oauth/token`;
const OAUTH_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const OAUTH_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const OAUTH_REFRESH_GRANT = "refresh_token";
const API_BASE_URL = "https://api.kimi.com/coding/v1";

// Mirrors the 5-min skew used by other providers' refresh paths.
const ACCESS_TOKEN_CLIENT_SKEW_MS = 5 * 60 * 1000;
const TOKEN_REQUEST_TIMEOUT_MS = 20_000;
const DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000;
const DEVICE_CODE_SLOW_DOWN_INCREMENT_MS = 5_000;
const DEVICE_CODE_DEFAULT_EXPIRES_MS = 5 * 60_000;

// --- Types ---

export interface KimiDeviceAuthResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

export interface KimiTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

export interface KimiModelInfo {
  id: string;
  display_name?: string;
  context_length?: number;
  supports_reasoning?: boolean;
  supports_image_in?: boolean;
  supports_video_in?: boolean;
}

// --- Helpers ---

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
    throw new Error(`${context} returned invalid JSON: ${toErrorMessage(error)}`);
  }
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

// --- Device flow ---

/**
 * POST device authorization request to auth.kimi.com.
 * Body contains only client_id (no scope), aligning with kimi-cli v1.41.0.
 */
export async function startDeviceAuth(
  fetchImpl: CliFetchImpl
): Promise<KimiDeviceAuthResponse> {
  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    ...buildKimiCodeHeaders(),
    "User-Agent": USER_AGENT,
  };

  let response: Response;
  try {
    response = await fetchImpl(OAUTH_DEVICE_AUTH_URL, {
      method: "POST",
      headers,
      body: new URLSearchParams({
        client_id: OAUTH_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `Kimi Code device code request failed: ${toErrorMessage(error)}`
    );
  }

  const data = await readJsonBody(response, "Kimi Code device code request");
  if (!response.ok) {
    const detail =
      (typeof data.error_description === "string" && data.error_description) ||
      (typeof data.error === "string" && data.error) ||
      "";
    throw new Error(
      `Kimi Code device code request failed (${response.status})${detail ? `: ${detail}` : ""}`
    );
  }

  const device_code = asTrimmedString(data.device_code);
  const user_code = asTrimmedString(data.user_code);
  const verification_uri = asTrimmedString(data.verification_uri);
  const verification_uri_complete = asTrimmedString(
    data.verification_uri_complete
  );
  if (!device_code || !user_code || !verification_uri) {
    throw new Error(
      "Kimi Code device code response is missing device_code, user_code, or verification_uri"
    );
  }
  const expires_in = asOptionalFiniteNumber(data.expires_in);
  if (expires_in === undefined) {
    throw new Error("Kimi Code device code response missing expires_in");
  }
  const interval = asOptionalFiniteNumber(data.interval);
  if (interval === undefined) {
    throw new Error("Kimi Code device code response missing interval");
  }
  return {
    device_code,
    user_code,
    verification_uri,
    ...(verification_uri_complete ? { verification_uri_complete } : {}),
    expires_in,
    interval,
  };
}

/**
 * Poll the token endpoint until the user approves or the code expires.
 * Handles authorization_pending (continue), slow_down (interval += 5000),
 * and expired_token (throw).
 */
export async function pollDeviceToken(
  device: KimiDeviceAuthResponse,
  fetchImpl: CliFetchImpl,
  sleep: (ms: number) => Promise<void>,
  now: () => number
): Promise<KimiTokenResponse> {
  const deadlineMs = now() + device.expires_in * 1000;
  let intervalMs = Math.max(
    device.interval * 1000,
    DEVICE_CODE_DEFAULT_INTERVAL_MS
  );

  while (now() < deadlineMs) {
    const remainingMs = Math.max(0, deadlineMs - now());
    const delayMs = Math.min(intervalMs, remainingMs);
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    if (now() >= deadlineMs) break;

    let response: Response;
    try {
      response = await fetchImpl(OAUTH_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          ...buildKimiCodeHeaders(),
          "User-Agent": USER_AGENT,
        },
        body: new URLSearchParams({
          client_id: OAUTH_CLIENT_ID,
          device_code: device.device_code,
          grant_type: OAUTH_DEVICE_GRANT,
        }),
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const message = toErrorMessage(error);
      if (/abort|timeout/i.test(message)) {
        throw new Error(
          `Kimi Code device token poll aborted or timed out: ${message}`
        );
      }
      throw new Error(`Kimi Code device token poll failed: ${message}`);
    }

    const data = await readJsonBody(response, "Kimi Code device token poll");
    if (response.ok) {
      if (typeof data.access_token !== "string" || !data.access_token) {
        throw new Error("Kimi Code token response missing access_token");
      }
      if (typeof data.refresh_token !== "string" || !data.refresh_token) {
        throw new Error("Kimi Code token response missing refresh_token");
      }
      const expires_in = asOptionalFiniteNumber(data.expires_in);
      if (expires_in === undefined) {
        throw new Error("Kimi Code token response missing expires_in");
      }
      return {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        token_type:
          typeof data.token_type === "string" ? data.token_type : "Bearer",
        expires_in,
      };
    }

    const oauthError = typeof data.error === "string" ? data.error : "";
    if (oauthError === "authorization_pending") {
      continue;
    }
    if (oauthError === "slow_down") {
      intervalMs += DEVICE_CODE_SLOW_DOWN_INCREMENT_MS;
      continue;
    }
    if (oauthError === "expired_token") {
      throw new Error("Kimi Code device code expired. Re-run the login.");
    }
    const detail =
      (typeof data.error_description === "string" && data.error_description) ||
      oauthError ||
      "";
    throw new Error(
      `Kimi Code device token poll failed (${response.status})${detail ? `: ${detail}` : ""}`
    );
  }

  throw new Error("Kimi Code device authorization timed out");
}

/**
 * Run the full device-code login flow. Prints the verification URL + user_code,
 * optionally opens a browser, and returns the stored OAuthCredential.
 */
export async function runKimiCodeOAuthLogin(
  deps: OAuthFlowDeps = {}
): Promise<OAuthCredential> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const output = deps.output ?? console;
  const error = deps.error ?? console;
  const sleep =
    deps.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;

  const device = await startDeviceAuth(fetchImpl);

  const browserUrl =
    device.verification_uri_complete ?? device.verification_uri;
  const expiresMinutes = Math.max(1, Math.round(device.expires_in / 60));

  output.log("Authorize nolo-cli for Kimi Code (device code / headless):");
  output.log(`  URL: ${device.verification_uri}`);
  if (device.verification_uri_complete) {
    output.log(`  Complete URL: ${device.verification_uri_complete}`);
  }
  output.log(`  Code: ${device.user_code}`);
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

  const token = await pollDeviceToken(device, fetchImpl, sleep, now);
  const nowMs = now();

  // Discover available models and store them in credential metadata for
  // later use by the chat proxy (model slug resolution). Mirrors
  // opencode-kimi-full which calls listModels right after login.
  let models: KimiModelInfo[] = [];
  try {
    models = await listKimiCodeModels(token.access_token, fetchImpl);
  } catch (err) {
    // Non-fatal: login still succeeds, model discovery can be retried later.
    error.error(
      `Kimi Code model discovery failed (non-fatal): ${toErrorMessage(err)}`
    );
  }

  return {
    provider: "kimi-code",
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: nowMs + token.expires_in * 1000 - ACCESS_TOKEN_CLIENT_SKEW_MS,
    obtainedAt: nowMs,
    ...(models.length > 0 ? { metadata: { models } } : {}),
  };
}

/**
 * Refresh a Kimi Code OAuth access token using a stored refresh_token.
 * Preserves the old refresh_token if the response does not include a new one.
 */
export async function refreshKimiCodeOAuthToken(
  credential: OAuthCredential,
  fetchImpl: CliFetchImpl = fetch
): Promise<OAuthCredential> {
  if (!credential.refreshToken) {
    throw new Error("Kimi Code credential has no refresh_token");
  }

  let response: Response;
  try {
    response = await fetchImpl(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        ...buildKimiCodeHeaders(),
        "User-Agent": USER_AGENT,
      },
      body: new URLSearchParams({
        client_id: OAUTH_CLIENT_ID,
        grant_type: OAUTH_REFRESH_GRANT,
        refresh_token: credential.refreshToken,
      }),
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `Kimi Code token refresh failed: ${toErrorMessage(error)}`
    );
  }

  const data = await readJsonBody(response, "Kimi Code token refresh");
  if (!response.ok) {
    const detail =
      (typeof data.error_description === "string" && data.error_description) ||
      (typeof data.error === "string" && data.error) ||
      "";
    throw new Error(
      `Kimi Code token refresh failed: ${response.status}${detail ? ` ${detail}` : ""}`
    );
  }

  if (typeof data.access_token !== "string" || !data.access_token) {
    throw new Error("Kimi Code token refresh response missing access_token");
  }
  const expiresIn = asOptionalFiniteNumber(data.expires_in);
  if (expiresIn === undefined) {
    throw new Error("Kimi Code token refresh response missing expires_in");
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

/**
 * List available models from the Kimi Code API.
 * GET ${API_BASE_URL}/models with Bearer token + kimi headers.
 */
export async function listKimiCodeModels(
  accessToken: string,
  fetchImpl: CliFetchImpl
): Promise<KimiModelInfo[]> {
  let response: Response;
  try {
    response = await fetchImpl(`${API_BASE_URL}/models`, {
      method: "GET",
      headers: {
        ...buildKimiCodeHeaders(),
        "User-Agent": USER_AGENT,
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `Kimi Code list models failed: ${toErrorMessage(error)}`
    );
  }

  const data = await readJsonBody(response, "Kimi Code list models");
  if (!response.ok) {
    const detail =
      (typeof data.error_description === "string" && data.error_description) ||
      (typeof data.error === "string" && data.error) ||
      "";
    throw new Error(
      `Kimi Code list models failed (${response.status})${detail ? `: ${detail}` : ""}`
    );
  }

  const models = data.models;
  if (!Array.isArray(models)) {
    throw new Error("Kimi Code list models response missing models array");
  }
  return models.map((raw: unknown): KimiModelInfo => {
    if (!isRecord(raw)) {
      throw new Error("Kimi Code model entry is not an object");
    }
    const id = asTrimmedString(raw.id);
    if (!id) {
      throw new Error("Kimi Code model entry missing id");
    }
    return {
      id,
      display_name:
        typeof raw.display_name === "string" ? raw.display_name : undefined,
      context_length: asOptionalFiniteNumber(raw.context_length) ?? undefined,
      supports_reasoning:
        typeof raw.supports_reasoning === "boolean"
          ? raw.supports_reasoning
          : undefined,
      supports_image_in:
        typeof raw.supports_image_in === "boolean"
          ? raw.supports_image_in
          : undefined,
      supports_video_in:
        typeof raw.supports_video_in === "boolean"
          ? raw.supports_video_in
          : undefined,
    };
  });
}
/**
 * Query Kimi Code subscription usage.
 *
 * GET ${API_BASE_URL}/usage with Bearer token + kimi headers.
 * Returns usage info or throws. If the endpoint returns 404, the error
 * message indicates the usage query is not available for this plan.
 *
 * NOTE: The exact endpoint is inferred from opencode-kimi-full's /kimi:usage
 * TUI command. If Kimi's API doesn't expose this yet, the 404 path gives a
 * clear user-facing message.
 */
export type KimiCodeUsage = {
  remaining_requests?: number;
  total_requests?: number;
  reset_at?: string;
  raw?: Record<string, unknown>;
};

export async function getKimiCodeUsage(
  accessToken: string,
  fetchImpl: CliFetchImpl
): Promise<KimiCodeUsage> {
  let response: Response;
  try {
    response = await fetchImpl(`${API_BASE_URL}/usage`, {
      method: "GET",
      headers: {
        ...buildKimiCodeHeaders(),
        "User-Agent": USER_AGENT,
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `Kimi Code usage query failed: ${toErrorMessage(error)}`
    );
  }

  if (response.status === 404) {
    throw new Error("Usage query not available for this Kimi Code plan.");
  }

  const data = await readJsonBody(response, "Kimi Code usage");
  if (!response.ok) {
    const detail =
      (typeof data.error_description === "string" && data.error_description) ||
      (typeof data.error === "string" && data.error) ||
      "";
    throw new Error(
      `Kimi Code usage query failed (${response.status})${detail ? `: ${detail}` : ""}`
    );
  }

  return {
    ...(typeof data.remaining_requests === "number"
      ? { remaining_requests: data.remaining_requests }
      : {}),
    ...(typeof data.total_requests === "number"
      ? { total_requests: data.total_requests }
      : {}),
    ...(typeof data.reset_at === "string" ? { reset_at: data.reset_at } : {}),
    raw: data,
  };
}
