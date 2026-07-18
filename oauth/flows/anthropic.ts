import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";

import { startCallbackServer } from "../callback-server";
import { generatePkcePair } from "../pkce";
import type { OAuthCredential, OAuthFlowDeps } from "../types";

export const ANTHROPIC_OAUTH_CLIENT_ID =
  "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const ANTHROPIC_OAUTH_AUTHORIZE_URL =
  "https://claude.ai/oauth/authorize";
export const ANTHROPIC_OAUTH_TOKEN_URL =
  "https://api.anthropic.com/v1/oauth/token";
export const ANTHROPIC_OAUTH_CALLBACK_PORT = 54545;
export const ANTHROPIC_OAUTH_REDIRECT_URI =
  `http://localhost:${ANTHROPIC_OAUTH_CALLBACK_PORT}/callback`;
export const ANTHROPIC_OAUTH_SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
];

const ACCESS_TOKEN_CLIENT_SKEW_MS = 5 * 60 * 1000;

type AnthropicTokenPayload = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  account?: { uuid?: unknown; email_address?: unknown };
  organization?: { uuid?: unknown; name?: unknown };
  error?: unknown;
  error_description?: unknown;
};

export function buildAnthropicAuthorizeUrl(args: {
  state: string;
  challenge: string;
  redirectUri?: string;
}): string {
  const params = new URLSearchParams({
    code: "true",
    client_id: ANTHROPIC_OAUTH_CLIENT_ID,
    response_type: "code",
    redirect_uri: args.redirectUri ?? ANTHROPIC_OAUTH_REDIRECT_URI,
    scope: ANTHROPIC_OAUTH_SCOPES.join(" "),
    code_challenge: args.challenge,
    code_challenge_method: "S256",
    state: args.state,
  });
  return `${ANTHROPIC_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

function parseManualAuthorization(raw: string, expectedState: string): {
  code: string;
  state: string;
} {
  const value = raw.trim();
  if (!value) throw new Error("No authorization code was provided.");
  try {
    const url = new URL(value);
    const code = url.searchParams.get("code")?.trim();
    const state = url.searchParams.get("state")?.trim();
    if (code && state === expectedState) return { code, state };
    throw new Error("Claude OAuth state verification failed.");
  } catch (error) {
    if (error instanceof Error && error.message.includes("state verification")) {
      throw error;
    }
  }
  const separator = value.lastIndexOf("#");
  if (separator < 0) return { code: value, state: expectedState };
  const code = value.slice(0, separator).trim();
  const returnedState = value.slice(separator + 1).trim();
  if (!code || returnedState !== expectedState) {
    throw new Error("Claude OAuth state verification failed.");
  }
  return { code, state: returnedState };
}

function tokenError(payload: AnthropicTokenPayload, status: number): string {
  const detail =
    typeof payload.error_description === "string"
      ? payload.error_description
      : typeof payload.error === "string"
        ? payload.error
        : `HTTP ${status}`;
  return `Claude OAuth token exchange failed: ${detail}`;
}

export async function exchangeAnthropicAuthorizationCode(args: {
  code: string;
  state: string;
  verifier: string;
  redirectUri?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<OAuthCredential> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const response = await fetchImpl(ANTHROPIC_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
      code: args.code,
      state: args.state,
      redirect_uri: args.redirectUri ?? ANTHROPIC_OAUTH_REDIRECT_URI,
      code_verifier: args.verifier,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = (await response.json().catch(() => ({}))) as AnthropicTokenPayload;
  if (!response.ok) throw new Error(tokenError(payload, response.status));
  if (typeof payload.access_token !== "string" || !payload.access_token) {
    throw new Error("Claude OAuth token exchange response missing access_token.");
  }

  const now = args.now?.() ?? Date.now();
  const expiresIn =
    typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
      ? payload.expires_in
      : undefined;
  const accountId =
    typeof payload.account?.uuid === "string" ? payload.account.uuid : undefined;
  const email =
    typeof payload.account?.email_address === "string"
      ? payload.account.email_address
      : undefined;
  const organizationId =
    typeof payload.organization?.uuid === "string"
      ? payload.organization.uuid
      : undefined;
  const organizationName =
    typeof payload.organization?.name === "string"
      ? payload.organization.name
      : undefined;

  return {
    provider: "claude",
    accessToken: payload.access_token,
    ...(typeof payload.refresh_token === "string" && payload.refresh_token
      ? { refreshToken: payload.refresh_token }
      : {}),
    ...(expiresIn !== undefined
      ? { expiresAt: now + expiresIn * 1000 - ACCESS_TOKEN_CLIENT_SKEW_MS }
      : {}),
    ...(typeof payload.scope === "string" ? { scope: payload.scope } : {}),
    ...(accountId ? { accountId } : {}),
    ...(email || organizationId || organizationName
      ? { metadata: { email, organizationId, organizationName } }
      : {}),
    obtainedAt: now,
  };
}

async function defaultReadLine(prompt: string): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await terminal.question(prompt);
  } finally {
    terminal.close();
  }
}

export async function runAnthropicOAuthLogin(
  deps: OAuthFlowDeps & {
    callbackPort?: number;
    callbackServerFactory?: typeof startCallbackServer;
  } = {}
): Promise<OAuthCredential> {
  const output = deps.output ?? console;
  const error = deps.error ?? console;
  const state = randomBytes(24).toString("base64url");
  const pkce = generatePkcePair();
  const preferredCallbackPort =
    deps.callbackPort ?? ANTHROPIC_OAUTH_CALLBACK_PORT;
  const callbackServerFactory =
    deps.callbackServerFactory ?? startCallbackServer;
  const callback = deps.manualCode
    ? null
    : await callbackServerFactory({
        port: preferredCallbackPort,
        hostname: "127.0.0.1",
        timeoutMs: 5 * 60_000,
        fallbackToRandomPort: true,
      });
  const redirectUri = callback
    ? `http://localhost:${callback.port}/callback`
    : `http://localhost:${preferredCallbackPort}/callback`;
  const authUrl = buildAnthropicAuthorizeUrl({
    state,
    challenge: pkce.challenge,
    redirectUri,
  });

  output.log(
    `Open this URL to authorize Claude Pro/Max:\n  ${authUrl}`
  );
  if (callback && callback.port !== preferredCallbackPort) {
    output.log(
      `Port ${preferredCallbackPort} is busy; using callback port ${callback.port}.`
    );
  }
  if (deps.openBrowser) {
    try {
      await deps.openBrowser(authUrl);
    } catch (cause) {
      error.error(`Could not open the browser automatically: ${String(cause)}`);
    }
  }
  let code = "";
  let returnedState = state;
  if (deps.manualCode) {
    const raw = await (deps.readLine ?? defaultReadLine)(
      "Paste the final callback URL or authorization code: "
    );
    ({ code, state: returnedState } = parseManualAuthorization(raw, state));
  } else {
    if (!callback) throw new Error("Claude OAuth callback server did not start.");
    try {
      const result = await callback.waitForCode();
      if (result.state !== state) {
        throw new Error("Claude OAuth state verification failed.");
      }
      code = result.code;
      returnedState = result.state;
    } finally {
      await callback.close().catch(() => undefined);
    }
  }
  return exchangeAnthropicAuthorizationCode({
    code,
    state: returnedState,
    verifier: pkce.verifier,
    redirectUri,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl as typeof fetch } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
}
