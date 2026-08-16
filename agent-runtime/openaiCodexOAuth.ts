import { toErrorMessage } from "../core/errorMessage";
import { asOptionalFiniteNumber } from "../core/optionalNumber";

import type { OAuthCredential, OAuthRefreshFn } from "./oauthTokenStore";

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

export const OPENAI_CODEX_ACCESS_TOKEN_CLIENT_SKEW_MS = 5 * 60 * 1000;
export const OPENAI_CODEX_TOKEN_REQUEST_TIMEOUT_MS = 30_000;

export type DecodedIdToken = {
  accountId?: string;
  email?: string;
};

export type OpenAiTokenPayload = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  id_token?: unknown;
  error?: unknown;
  error_description?: unknown;
};

export type RefreshOpenAiCodexTokenDeps = {
  fetchImpl?: typeof fetch;
  now?: () => number;
};

/**
 * Extracts `chatgpt_account_id` and/or `email` from a Codex JWT (access or id token).
 * Supports both base64 and base64url encoded payloads, top-level account/email claims,
 * and namespaced `https://api.openai.com/auth` claims.
 */
export function decodeOpenAiIdToken(idToken?: string): DecodedIdToken {
  if (!idToken || typeof idToken !== "string") return {};
  const parts = idToken.split(".");
  if (parts.length < 2) return {};
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf-8")
    ) as Record<string, unknown>;
    const authClaim = payload["https://api.openai.com/auth"];
    const nestedAccountId =
      authClaim && typeof authClaim === "object"
        ? (authClaim as Record<string, unknown>).chatgpt_account_id
        : undefined;
    const accountId =
      nestedAccountId ??
      (payload["chatgpt_account_id"] as string | undefined) ??
      (payload["account_id"] as string | undefined);
    const email = payload["email"] as string | undefined;
    return {
      ...(typeof accountId === "string" && accountId.trim()
        ? { accountId: accountId.trim() }
        : {}),
      ...(typeof email === "string" && email.trim()
        ? { email: email.trim() }
        : {}),
    };
  } catch {
    return {};
  }
}

export function normalizeOpenAiCodexTokenPayload(args: {
  payload: OpenAiTokenPayload;
  baseCredential?: Partial<OAuthCredential>;
  now?: number;
  clientSkewMs?: number;
}): OAuthCredential {
  const { payload, baseCredential, now = Date.now() } = args;

  if (
    typeof payload.access_token !== "string" ||
    !payload.access_token.trim()
  ) {
    throw new Error("OpenAI Codex token response missing access_token");
  }

  const accessToken = payload.access_token.trim();
  const expiresIn = asOptionalFiniteNumber(payload.expires_in);
  const clientSkewMs =
    args.clientSkewMs ?? OPENAI_CODEX_ACCESS_TOKEN_CLIENT_SKEW_MS;

  const expiresAt =
    expiresIn !== undefined
      ? now + expiresIn * 1000 - clientSkewMs
      : baseCredential?.expiresAt;

  const idTokenStr =
    typeof payload.id_token === "string" && payload.id_token.trim()
      ? payload.id_token.trim()
      : undefined;

  const fromAccess = decodeOpenAiIdToken(accessToken);
  const fromId = idTokenStr ? decodeOpenAiIdToken(idTokenStr) : {};

  const accountId =
    fromAccess.accountId ??
    fromId.accountId ??
    baseCredential?.accountId;

  const email =
    fromAccess.email ??
    fromId.email ??
    (baseCredential?.metadata?.email as string | undefined);

  const refreshToken =
    typeof payload.refresh_token === "string" && payload.refresh_token.trim()
      ? payload.refresh_token.trim()
      : baseCredential?.refreshToken;

  const scope =
    typeof payload.scope === "string" && payload.scope.trim()
      ? payload.scope.trim()
      : baseCredential?.scope;

  const metadata: Record<string, unknown> = {
    ...(baseCredential?.metadata ?? {}),
    ...(email ? { email } : {}),
  };

  return {
    ...(baseCredential ?? {}),
    provider: "chatgpt",
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    obtainedAt: now,
    ...(scope ? { scope } : {}),
    ...(accountId ? { accountId } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

export async function refreshOpenAiCodexToken(
  credential: OAuthCredential,
  deps: RefreshOpenAiCodexTokenDeps = {}
): Promise<OAuthCredential> {
  if (!credential.refreshToken) {
    throw new Error("Cannot refresh OpenAI Codex token without a refresh token.");
  }
  const fetchImpl = deps.fetchImpl ?? fetch;

  const body = new URLSearchParams({
    client_id: OPENAI_CODEX_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: credential.refreshToken,
  });

  let response: Response;
  try {
    response = await fetchImpl(OPENAI_CODEX_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(OPENAI_CODEX_TOKEN_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `OpenAI Codex token refresh failed: ${toErrorMessage(error)}`
    );
  }

  const payload = (await response.json().catch(() => ({}))) as OpenAiTokenPayload;
  if (!response.ok) {
    const detail =
      typeof payload.error_description === "string" && payload.error_description
        ? payload.error_description
        : typeof payload.error === "string" && payload.error
          ? payload.error
          : `HTTP ${response.status}`;
    throw new Error(`OpenAI Codex token refresh failed: ${detail}`);
  }

  if (
    typeof payload.access_token !== "string" ||
    !payload.access_token.trim()
  ) {
    throw new Error("OpenAI Codex token refresh response missing access_token");
  }

  const now = deps.now?.() ?? Date.now();
  return normalizeOpenAiCodexTokenPayload({
    payload,
    baseCredential: credential,
    now,
  });
}

export const openAiCodexRefresh: OAuthRefreshFn = refreshOpenAiCodexToken;
export { normalizeOpenAiCodexTokenPayload as normalizeOpenAiTokenPayload };
