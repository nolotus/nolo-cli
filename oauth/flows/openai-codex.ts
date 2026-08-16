import { createHash } from "node:crypto";

import {
  OPENAI_CODEX_ACCESS_TOKEN_CLIENT_SKEW_MS,
  OPENAI_CODEX_AUTHORIZE_URL,
  OPENAI_CODEX_CALLBACK_PATH,
  OPENAI_CODEX_CALLBACK_PORT,
  OPENAI_CODEX_CALLBACK_URL,
  OPENAI_CODEX_CLIENT_ID,
  OPENAI_CODEX_DEVICE_AUTH_URL,
  OPENAI_CODEX_DEVICE_REDIRECT_URI,
  OPENAI_CODEX_DEVICE_TOKEN_URL,
  OPENAI_CODEX_DEVICE_VERIFICATION_URL,
  OPENAI_CODEX_ORIGINATOR,
  OPENAI_CODEX_SCOPES,
  OPENAI_CODEX_TOKEN_REQUEST_TIMEOUT_MS,
  OPENAI_CODEX_TOKEN_URL,
  decodeOpenAiIdToken,
  normalizeOpenAiCodexTokenPayload,
  normalizeOpenAiTokenPayload,
  openAiCodexRefresh,
  refreshOpenAiCodexToken as runtimeRefreshOpenAiCodexToken,
  type DecodedIdToken,
  type OpenAiTokenPayload,
  type RefreshOpenAiCodexTokenDeps,
} from "../../agent-runtime/openaiCodexOAuth";
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
import type { CliFetchImpl } from "../../cliFetch";

export {
  OPENAI_CODEX_ACCESS_TOKEN_CLIENT_SKEW_MS,
  OPENAI_CODEX_AUTHORIZE_URL,
  OPENAI_CODEX_CALLBACK_PATH,
  OPENAI_CODEX_CALLBACK_PORT,
  OPENAI_CODEX_CALLBACK_URL,
  OPENAI_CODEX_CLIENT_ID,
  OPENAI_CODEX_DEVICE_AUTH_URL,
  OPENAI_CODEX_DEVICE_REDIRECT_URI,
  OPENAI_CODEX_DEVICE_TOKEN_URL,
  OPENAI_CODEX_DEVICE_VERIFICATION_URL,
  OPENAI_CODEX_ORIGINATOR,
  OPENAI_CODEX_SCOPES,
  OPENAI_CODEX_TOKEN_REQUEST_TIMEOUT_MS,
  OPENAI_CODEX_TOKEN_URL,
  decodeOpenAiIdToken,
  normalizeOpenAiCodexTokenPayload,
  normalizeOpenAiTokenPayload,
  openAiCodexRefresh,
};
export type { DecodedIdToken, OpenAiTokenPayload, RefreshOpenAiCodexTokenDeps };

const AUTHORIZATION_CODE_GRANT_TYPE = "authorization_code";

const DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000;
const DEVICE_POLL_SAFETY_MARGIN_MS = 3_000;
/** Upper bound on device-code polls to avoid infinite loops on server errors. */
const DEVICE_MAX_POLLS = 120;

type Json = Record<string, unknown>;

async function postJson(
  fetchImpl: CliFetchImpl,
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
  fetchImpl: CliFetchImpl,
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
  try {
    return (await response.json()) as Json;
  } catch {
    return {};
  }
}

function scopeString(): string {
  return OPENAI_CODEX_SCOPES.join(" ");
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
  const now = (args.now ?? Date.now)();
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
  return normalizeOpenAiCodexTokenPayload({
    payload: data,
    now,
  });
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
  return runtimeRefreshOpenAiCodexToken(credential, {
    fetchImpl: deps.fetchImpl,
    now: deps.now,
  });
};

export const openAiCodexFlowController: OAuthFlowController = {
  runDeviceCode: (deps) => runOpenAiCodexDeviceCode(deps),
  runBrowserPkce: (deps) => runOpenAiCodexBrowserPkce(deps),
};

export function resolveOpenAiCodexCredential(deps: OAuthFlowDeps = {}): OAuthCredential | null {
  return createOAuthTokenStore().read("chatgpt");
}
