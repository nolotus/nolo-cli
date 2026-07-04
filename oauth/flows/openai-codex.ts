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
/** Device-code poll endpoint: returns authorization_code + code_verifier once approved. */
export const OPENAI_CODEX_DEVICE_TOKEN_URL =
  "https://auth.openai.com/api/accounts/deviceauth/token";
/** Page where the user enters the printed user_code. */
export const OPENAI_CODEX_DEVICE_VERIFICATION_URL =
  "https://auth.openai.com/codex/device";
/** redirect_uri used when exchanging a device-flow authorization_code. */
export const OPENAI_CODEX_DEVICE_REDIRECT_URI =
  "https://auth.openai.com/deviceauth/callback";
export const OPENAI_CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const OPENAI_CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
/** Originator tag the ChatGPT auth server expects for the Codex CLI login flow. */
export const OPENAI_CODEX_ORIGINATOR = "codex_cli_rs";
export const OPENAI_CODEX_CALLBACK_PORT = 1455;
export const OPENAI_CODEX_CALLBACK_PATH = "/auth/callback";
export const OPENAI_CODEX_CALLBACK_URL = `http://localhost:${OPENAI_CODEX_CALLBACK_PORT}${OPENAI_CODEX_CALLBACK_PATH}`;

const AUTHORIZATION_CODE_GRANT_TYPE = "authorization_code";
const REFRESH_TOKEN_GRANT_TYPE = "refresh_token";

const DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000;
const DEVICE_POLL_SAFETY_MARGIN_MS = 3_000;
/** Upper bound on device-code polls to avoid infinite loops on server errors. */
const DEVICE_MAX_POLLS = 120;

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

/**
 * OpenAI's OAuth token endpoint (`/oauth/token`) expects
 * `application/x-www-form-urlencoded`, matching the official Codex CLI. JSON
 * bodies are rejected, so token exchange/refresh must post form-encoded.
 */
async function postForm(
  fetchImpl: typeof fetch,
  url: string,
  body: Record<string, string>,
  deps?: OAuthFlowDeps
): Promise<Response> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(body).toString(),
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

/** Namespaced claims OpenAI embeds in the Codex access/id JWTs. */
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
const OPENAI_PROFILE_CLAIM = "https://api.openai.com/profile";

function readClaimString(claim: unknown, key: string): string | undefined {
  if (!claim || typeof claim !== "object") return undefined;
  const value = (claim as Record<string, unknown>)[key];
  return typeof value === "string" && value ? value : undefined;
}

/**
 * Decodes a Codex JWT (access or id token). `chatgpt_account_id` lives under the
 * namespaced `https://api.openai.com/auth` claim — not at the top level — so the
 * account id header can be attached to Codex Responses requests.
 */
export function decodeOpenAiIdToken(idToken?: string): DecodedIdToken {
  if (!idToken) return {};
  const parts = idToken.split(".");
  if (parts.length < 2) return {};
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1])) as Json;
    const authClaim = payload[OPENAI_AUTH_CLAIM];
    const profileClaim = payload[OPENAI_PROFILE_CLAIM];
    return {
      chatgptAccountId:
        readClaimString(authClaim, "chatgpt_account_id") ??
        (typeof payload["chatgpt_account_id"] === "string"
          ? (payload["chatgpt_account_id"] as string)
          : undefined),
      email:
        readClaimString(profileClaim, "email") ??
        (typeof payload["email"] === "string" ? (payload["email"] as string) : undefined),
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
  // Prefer the access token (always the credential actually used upstream), fall
  // back to the id token.
  const fromAccess = decodeOpenAiIdToken(token.accessToken);
  const fromId = decodeOpenAiIdToken(token.idToken);
  const decoded: DecodedIdToken = {
    chatgptAccountId: fromAccess.chatgptAccountId ?? fromId.chatgptAccountId,
    email: fromAccess.email ?? fromId.email,
  };
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

export type DeviceCodeStartResult = {
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
};

export async function startDeviceCodeFlow(deps: OAuthFlowDeps): Promise<DeviceCodeStartResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const response = await postJson(
    fetchImpl,
    OPENAI_CODEX_DEVICE_AUTH_URL,
    { client_id: OPENAI_CODEX_CLIENT_ID },
    deps
  );
  if (!response.ok) {
    const data = await parseJsonResponse(response);
    throw new Error(
      `OpenAI device-code start failed (HTTP ${response.status}): ${JSON.stringify(data)}`
    );
  }
  const data = await parseJsonResponse(response);
  const deviceAuthId = data["device_auth_id"];
  const userCode = data["user_code"];
  if (typeof deviceAuthId !== "string" || !deviceAuthId) {
    throw new Error("OpenAI device-code start response did not include a device_auth_id.");
  }
  if (typeof userCode !== "string" || !userCode) {
    throw new Error("OpenAI device-code start response did not include a user_code.");
  }
  const intervalRaw = data["interval"];
  const intervalSec =
    typeof intervalRaw === "number"
      ? intervalRaw
      : Number.parseInt(String(intervalRaw ?? "5"), 10) || 5;
  return {
    deviceAuthId,
    userCode,
    intervalMs: Math.max(1, intervalSec) * 1000 + DEVICE_POLL_SAFETY_MARGIN_MS,
  };
}

export async function pollDeviceCodeToken(args: {
  deviceAuthId: string;
  userCode: string;
  deps?: OAuthFlowDeps;
  intervalMs?: number;
  maxPolls?: number;
  sleep?: (ms: number) => Promise<void>;
  onPending?: () => void;
}): Promise<{ authorizationCode: string; codeVerifier: string }> {
  const fetchImpl = args.deps?.fetchImpl ?? fetch;
  const sleep =
    args.sleep ??
    args.deps?.sleep ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const intervalMs = args.intervalMs ?? DEVICE_CODE_DEFAULT_INTERVAL_MS;
  const maxPolls = args.maxPolls ?? DEVICE_MAX_POLLS;

  for (let poll = 0; poll < maxPolls; poll++) {
    await sleep(poll === 0 ? Math.min(intervalMs, DEVICE_CODE_DEFAULT_INTERVAL_MS) : intervalMs);
    const response = await postJson(
      fetchImpl,
      OPENAI_CODEX_DEVICE_TOKEN_URL,
      { device_auth_id: args.deviceAuthId, user_code: args.userCode },
      args.deps
    );
    // 403/404 mean the user has not approved yet — keep polling.
    if (response.status === 403 || response.status === 404) {
      args.onPending?.();
      continue;
    }
    const data = await parseJsonResponse(response);
    if (!response.ok) {
      throw new Error(
        `OpenAI device-code poll failed (HTTP ${response.status}): ${JSON.stringify(data)}`
      );
    }
    const authorizationCode = data["authorization_code"];
    const codeVerifier = data["code_verifier"];
    if (typeof authorizationCode !== "string" || !authorizationCode) {
      throw new Error("OpenAI device-code poll response missing authorization_code.");
    }
    if (typeof codeVerifier !== "string" || !codeVerifier) {
      throw new Error("OpenAI device-code poll response missing code_verifier.");
    }
    return { authorizationCode, codeVerifier };
  }
  throw new Error("OpenAI device-code flow timed out waiting for user authorization.");
}

export async function runOpenAiCodexDeviceCode(
  deps: OAuthFlowDeps = {}
): Promise<OAuthCredential> {
  const now = deps.now ?? Date.now;
  const start = await startDeviceCodeFlow(deps);
  deps.output?.log?.("Authorize nolo-cli for ChatGPT / OpenAI Codex:");
  deps.output?.log?.(OPENAI_CODEX_DEVICE_VERIFICATION_URL);
  deps.output?.log?.(`Enter code: ${start.userCode}`);

  if (deps.openBrowser) {
    const opened = await deps.openBrowser(OPENAI_CODEX_DEVICE_VERIFICATION_URL);
    if (!opened) deps.output?.log?.("Could not open a browser automatically. Open the URL above.");
  } else {
    deps.output?.log?.("Open the URL above in a browser and enter the code to approve.");
  }

  const { authorizationCode, codeVerifier } = await pollDeviceCodeToken({
    deviceAuthId: start.deviceAuthId,
    userCode: start.userCode,
    deps,
    intervalMs: start.intervalMs,
    sleep: deps.sleep,
    onPending: () => {
      deps.output?.log?.("[oauth:openai-codex] Waiting for authorization...");
    },
  });
  const credential = await exchangeCodexAuthorizationCode({
    code: authorizationCode,
    codeVerifier,
    redirectUri: OPENAI_CODEX_DEVICE_REDIRECT_URI,
    deps,
    now,
  });
  writeOAuthCredential("chatgpt", credential);
  deps.output?.log?.(
    `Saved ChatGPT OAuth credential (account=${credential.accountId ?? "unknown"}).`
  );
  return credential;
}

/**
 * Exchange an authorization code (browser PKCE or device flow) for tokens at
 * OpenAI's `/oauth/token` endpoint (form-urlencoded, matching the official
 * Codex CLI). The `redirectUri` must match the one used to obtain the code.
 */
export async function exchangeCodexAuthorizationCode(args: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  deps?: OAuthFlowDeps;
  now?: () => number;
}): Promise<OAuthCredential> {
  const fetchImpl = args.deps?.fetchImpl ?? fetch;
  const now = args.now ?? Date.now;
  const response = await postForm(
    fetchImpl,
    OPENAI_CODEX_TOKEN_URL,
    {
      grant_type: AUTHORIZATION_CODE_GRANT_TYPE,
      code: args.code,
      redirect_uri: args.redirectUri,
      client_id: OPENAI_CODEX_CLIENT_ID,
      code_verifier: args.codeVerifier,
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

export async function exchangeAuthorizationCode(args: {
  code: string;
  state: string;
  pkce: PkcePair;
  deps?: OAuthFlowDeps;
  now?: () => number;
}): Promise<OAuthCredential> {
  return exchangeCodexAuthorizationCode({
    code: args.code,
    codeVerifier: args.pkce.verifier,
    redirectUri: OPENAI_CODEX_CALLBACK_URL,
    deps: args.deps,
    now: args.now,
  });
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
    // Required by the ChatGPT auth server to route through the Codex app consent
    // flow (rather than the generic ChatGPT Web account chooser, which loops).
    authorizeUrl.searchParams.set("id_token_add_organizations", "true");
    authorizeUrl.searchParams.set("codex_cli_simplified_flow", "true");
    authorizeUrl.searchParams.set("originator", OPENAI_CODEX_ORIGINATOR);
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
  const response = await postForm(
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