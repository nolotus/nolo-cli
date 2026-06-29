import { createHash } from "node:crypto";

import { startCallbackServer } from "../callback-server";
import { generatePkcePair } from "../pkce";
import {
  createOAuthTokenStore,
  writeOAuthCredential,
} from "../token-store";
import type {
  OAuthCallbackResult,
  OAuthCredential,
  OAuthFlowController,
  OAuthFlowDeps,
  OAuthRefreshFn,
  OAuthTokenResponse,
  PkcePair,
} from "../types";

export const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_CODEX_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "api.connectors.read",
  "api.connectors.invoke",
];
export const OPENAI_CODEX_DEVICE_AUTH_URL =
  "https://auth.openai.com/api/accounts/deviceauth/usercode";
export const OPENAI_CODEX_TOKEN_URL = "https://auth.openai.com/api/accounts/token";
export const OPENAI_CODEX_AUTHORIZE_URL = "https://auth.openai.com/authorize";
export const OPENAI_CODEX_CALLBACK_PORT = 1455;
export const OPENAI_CODEX_CALLBACK_PATH = "/auth/callback";
export const OPENAI_CODEX_CALLBACK_URL = `http://localhost:${OPENAI_CODEX_CALLBACK_PORT}${OPENAI_CODEX_CALLBACK_PATH}`;

export const DEVICE_CODE_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:device_code";
const AUTHORIZATION_CODE_GRANT_TYPE = "authorization_code";
const REFRESH_TOKEN_GRANT_TYPE = "refresh_token";

const DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000;
const DEVICE_CODE_DEFAULT_TIMEOUT_MS = 15 * 60_000;

type Json = Record<string, unknown>;

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  body: Record<string, string>,
  deps?: OAuthFlowDeps
): Promise<Response> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  deps?.output?.log?.(`[oauth:openai-codex] POST ${url} -> ${response.status}`);
  return response;
}

async function parseJsonResponse(response: Response): Promise<Json> {
  const text = await response.text().catch(() => "");
  if (!text) return {};
  try {
    return JSON.parse(text) as Json;
  } catch {
    return {};
  }
}

function scopeString(scopes: string[] = OPENAI_CODEX_SCOPES): string {
  return scopes.join(" ");
}

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

export type DecodedIdToken = {
  chatgptAccountId?: string;
  email?: string;
  payload?: Json;
};

export function decodeOpenAiIdToken(idToken?: string): DecodedIdToken {
  if (!idToken) return {};
  const parts = idToken.split(".");
  if (parts.length < 2) return {};
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1])) as Json;
    return {
      chatgptAccountId:
        typeof payload["chatgpt_account_id"] === "string"
          ? (payload["chatgpt_account_id"] as string)
          : undefined,
      email:
        typeof payload["email"] === "string" ? (payload["email"] as string) : undefined,
      payload,
    };
  } catch {
    return {};
  }
}

function tokenResponseToCredential(
  token: OAuthTokenResponse,
  now: number
): OAuthCredential {
  const decoded = decodeOpenAiIdToken(token.idToken);
  const expiresAt =
    typeof token.expiresIn === "number" && token.expiresIn > 0
      ? now + token.expiresIn * 1000
      : undefined;
  return {
    provider: "chatgpt",
    accessToken: token.accessToken,
    ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(token.scope ? { scope: token.scope } : {}),
    ...(token.idToken ? { idToken: token.idToken } : {}),
    ...(decoded.chatgptAccountId ? { accountId: decoded.chatgptAccountId } : {}),
    obtainedAt: now,
  };
}

function extractTokenResponse(data: Json): OAuthTokenResponse | null {
  const accessToken = data["access_token"];
  if (typeof accessToken !== "string" || !accessToken) return null;
  const expiresInRaw = data["expires_in"];
  return {
    accessToken,
    ...(typeof data["refresh_token"] === "string"
      ? { refreshToken: data["refresh_token"] as string }
      : {}),
    ...(typeof expiresInRaw === "number"
      ? { expiresIn: expiresInRaw }
      : {}),
    ...(typeof data["scope"] === "string" ? { scope: data["scope"] as string } : {}),
    ...(typeof data["id_token"] === "string" ? { idToken: data["id_token"] as string } : {}),
  };
}

function buildDeviceCodePollBody(deviceCode: string): Record<string, string> {
  return {
    grant_type: DEVICE_CODE_GRANT_TYPE,
    device_code: deviceCode,
    client_id: OPENAI_CODEX_CLIENT_ID,
  };
}

export type DeviceCodeStartResult = {
  deviceCode: string;
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  intervalMs: number;
  expiresInMs: number;
};

export async function startDeviceCodeFlow(deps: OAuthFlowDeps): Promise<DeviceCodeStartResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const response = await postJson(
    fetchImpl,
    OPENAI_CODEX_DEVICE_AUTH_URL,
    {
      client_id: OPENAI_CODEX_CLIENT_ID,
      scope: scopeString(),
    },
    deps
  );
  if (!response.ok) {
    const data = await parseJsonResponse(response);
    throw new Error(
      `OpenAI device-code start failed (HTTP ${response.status}): ${JSON.stringify(data)}`
    );
  }
  const data = await parseJsonResponse(response);
  const deviceCode = data["device_code"];
  if (typeof deviceCode !== "string" || !deviceCode) {
    throw new Error("OpenAI device-code start response did not include a device_code.");
  }
  const intervalSec = typeof data["interval"] === "number" ? (data["interval"] as number) : 5;
  const expiresInSec =
    typeof data["expires_in"] === "number" ? (data["expires_in"] as number) : 900;
  return {
    deviceCode,
    ...(typeof data["user_code"] === "string" ? { userCode: data["user_code"] as string } : {}),
    ...(typeof data["verification_uri"] === "string"
      ? { verificationUri: data["verification_uri"] as string }
      : {}),
    ...(typeof data["verification_uri_complete"] === "string"
      ? { verificationUriComplete: data["verification_uri_complete"] as string }
      : {}),
    intervalMs: Math.max(1, intervalSec) * 1000,
    expiresInMs: Math.max(1, expiresInSec) * 1000,
  };
}

export async function pollDeviceCodeToken(args: {
  deviceCode: string;
  deps?: OAuthFlowDeps;
  intervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onPending?: (remainingMs: number) => void;
}): Promise<OAuthTokenResponse> {
  const fetchImpl = args.deps?.fetchImpl ?? fetch;
  const now = args.now ?? Date.now;
  const sleep = args.sleep ?? (args.deps?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))));
  const intervalMs = args.intervalMs ?? DEVICE_CODE_DEFAULT_INTERVAL_MS;
  const timeoutMs = args.timeoutMs ?? DEVICE_CODE_DEFAULT_TIMEOUT_MS;
  const deadline = now() + timeoutMs;
  let lastPendingLog = 0;

  while (now() <= deadline) {
    const response = await postJson(
      fetchImpl,
      OPENAI_CODEX_TOKEN_URL,
      buildDeviceCodePollBody(args.deviceCode),
      args.deps
    );
    const data = await parseJsonResponse(response);
    const token = extractTokenResponse(data);
    if (token) return token;

    const errorCode = typeof data["error"] === "string" ? (data["error"] as string) : "";
    if (response.status === 200 && !errorCode) {
      throw new Error(`OpenAI device-code poll returned no token: ${JSON.stringify(data)}`);
    }
    if (
      errorCode === "authorization_pending" ||
      errorCode === "slow_down" ||
      response.status === 429
    ) {
      const remainingMs = Math.max(0, deadline - now());
      if (now() - lastPendingLog >= 15_000) {
        lastPendingLog = now();
        args.onPending?.(remainingMs);
      }
      await sleep(errorCode === "slow_down" ? intervalMs * 2 : intervalMs);
      continue;
    }
    throw new Error(
      `OpenAI device-code poll failed (HTTP ${response.status}): ${JSON.stringify(data)}`
    );
  }
  throw new Error("OpenAI device-code flow timed out waiting for user authorization.");
}

export async function runOpenAiCodexDeviceCode(
  deps: OAuthFlowDeps = {}
): Promise<OAuthCredential> {
  const now = deps.now ?? Date.now;
  const start = await startDeviceCodeFlow(deps);
  const verificationUrl =
    start.verificationUriComplete ?? start.verificationUri ?? "https://auth.openai.com/device";
  deps.output?.log?.("Authorize nolo-cli for ChatGPT / OpenAI Codex:");
  deps.output?.log?.(verificationUrl);
  if (start.userCode) deps.output?.log?.(`Code: ${start.userCode}`);

  if (!deps.openBrowser) {
    deps.output?.log?.("Open the URL above in a browser to approve the device code.");
  } else {
    const opened = await deps.openBrowser(verificationUrl);
    if (!opened) deps.output?.log?.("Could not open a browser automatically. Open the URL above.");
  }

  const token = await pollDeviceCodeToken({
    deviceCode: start.deviceCode,
    deps,
    intervalMs: start.intervalMs,
    timeoutMs: start.expiresInMs,
    now,
    sleep: deps.sleep,
    onPending: (remainingMs) => {
      deps.output?.log?.(`[oauth:openai-codex] Waiting for authorization (${Math.round(remainingMs / 1000)}s remaining)...`);
    },
  });
  const credential = tokenResponseToCredential(token, now());
  writeOAuthCredential("chatgpt", credential);
  deps.output?.log?.(
    `Saved ChatGPT OAuth credential (account=${credential.accountId ?? "unknown"}).`
  );
  return credential;
}

export async function exchangeAuthorizationCode(args: {
  code: string;
  state: string;
  pkce: PkcePair;
  deps?: OAuthFlowDeps;
  now?: () => number;
}): Promise<OAuthCredential> {
  const fetchImpl = args.deps?.fetchImpl ?? fetch;
  const now = args.now ?? Date.now;
  const response = await postJson(
    fetchImpl,
    OPENAI_CODEX_TOKEN_URL,
    {
      grant_type: AUTHORIZATION_CODE_GRANT_TYPE,
      code: args.code,
      redirect_uri: OPENAI_CODEX_CALLBACK_URL,
      client_id: OPENAI_CODEX_CLIENT_ID,
      code_verifier: args.pkce.verifier,
    },
    args.deps
  );
  const data = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(
      `OpenAI authorization-code exchange failed (HTTP ${response.status}): ${JSON.stringify(data)}`
    );
  }
  const token = extractTokenResponse(data);
  if (!token) {
    throw new Error(`OpenAI authorization-code exchange returned no token: ${JSON.stringify(data)}`);
  }
  return tokenResponseToCredential(token, now());
}

export async function runOpenAiCodexBrowserPkce(
  deps: OAuthFlowDeps = {}
): Promise<OAuthCredential> {
  const now = deps.now ?? Date.now;
  const pkce = generatePkcePair();
  const state = createHash("sha256").update(`${now()}-${Math.random()}`).digest("base64url");

  const callback = await startCallbackServer({
    port: OPENAI_CODEX_CALLBACK_PORT,
    now,
    sleep: deps.sleep,
  });
  try {
    const authorizeUrl = new URL(OPENAI_CODEX_AUTHORIZE_URL);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", OPENAI_CODEX_CLIENT_ID);
    authorizeUrl.searchParams.set("redirect_uri", OPENAI_CODEX_CALLBACK_URL);
    authorizeUrl.searchParams.set("scope", scopeString());
    authorizeUrl.searchParams.set("code_challenge", pkce.challenge);
    authorizeUrl.searchParams.set("code_challenge_method", pkce.method);
    authorizeUrl.searchParams.set("state", state);

    const authorizeUrlString = authorizeUrl.toString();
    deps.output?.log?.("Authorize nolo-cli for ChatGPT / OpenAI Codex:");
    deps.output?.log?.(authorizeUrlString);
    if (deps.openBrowser) {
      const opened = await deps.openBrowser(authorizeUrlString);
      if (!opened) deps.output?.log?.("Could not open a browser automatically. Open the URL above.");
    }

    const result: OAuthCallbackResult = await callback.waitForCode();
    if (result.state && result.state !== state) {
      throw new Error("OpenAI browser PKCE flow state mismatch.");
    }
    const credential = await exchangeAuthorizationCode({
      code: result.code,
      state,
      pkce,
      deps,
      now,
    });
    writeOAuthCredential("chatgpt", credential);
    deps.output?.log?.(
      `Saved ChatGPT OAuth credential (account=${credential.accountId ?? "unknown"}).`
    );
    return credential;
  } finally {
    await callback.close().catch(() => {});
  }
}

export const refreshOpenAiCodexToken: OAuthRefreshFn = async (credential, deps = {}) => {
  if (!credential.refreshToken) {
    throw new Error("Cannot refresh ChatGPT OAuth token without a refresh_token.");
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const response = await postJson(
    fetchImpl,
    OPENAI_CODEX_TOKEN_URL,
    {
      grant_type: REFRESH_TOKEN_GRANT_TYPE,
      refresh_token: credential.refreshToken,
      client_id: OPENAI_CODEX_CLIENT_ID,
      scope: scopeString(),
    },
    deps
  );
  const data = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(
      `OpenAI token refresh failed (HTTP ${response.status}): ${JSON.stringify(data)}`
    );
  }
  const token = extractTokenResponse(data);
  if (!token) {
    throw new Error(`OpenAI token refresh returned no token: ${JSON.stringify(data)}`);
  }
  const refreshed = tokenResponseToCredential(token, now());
  return {
    ...refreshed,
    refreshToken: refreshed.refreshToken ?? credential.refreshToken,
    accountId: refreshed.accountId ?? credential.accountId,
  };
};

export const openAiCodexFlowController: OAuthFlowController = {
  runDeviceCode: (deps) => runOpenAiCodexDeviceCode(deps),
  runBrowserPkce: (deps) => runOpenAiCodexBrowserPkce(deps),
};

export function resolveOpenAiCodexCredential(deps: OAuthFlowDeps = {}): OAuthCredential | null {
  return createOAuthTokenStore().read("chatgpt");
}