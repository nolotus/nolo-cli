// Ported from oh-my-pi/packages/ai/src/utils/oauth/cursor.ts (MIT).
// Cursor uses a poll-based device flow (no loopback callback):
//   1. Generate PKCE pair + random UUID.
//   2. Open https://cursor.com/loginDeepControl?challenge=<S256>&uuid=<uuid>&mode=login&redirectTarget=cli
//   3. Poll https://api2.cursor.sh/auth/poll?uuid=<uuid>&verifier=<verifier>
//      until it returns { accessToken, refreshToken }.
// Token refresh uses https://api2.cursor.sh/auth/exchange_user_api_key with
// the refresh token as a Bearer header (Cursor does not expose a public
// client_id-based refresh endpoint).

import { toErrorMessage } from "../core/errorMessage";

import type { OAuthCredential, OAuthRefreshFn } from "./oauthTokenStore";

export const CURSOR_LOGIN_URL = "https://cursor.com/loginDeepControl";
export const CURSOR_POLL_URL = "https://api2.cursor.sh/auth/poll";
export const CURSOR_REFRESH_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";

export const CURSOR_POLL_MAX_ATTEMPTS = 150;
export const CURSOR_POLL_BASE_DELAY_MS = 1000;
export const CURSOR_POLL_MAX_DELAY_MS = 10_000;
export const CURSOR_POLL_BACKOFF_MULTIPLIER = 1.2;
export const CURSOR_POLL_MAX_CONSECUTIVE_ERRORS = 3;

export const CURSOR_ACCESS_TOKEN_CLIENT_SKEW_MS = 5 * 60 * 1000;
export const CURSOR_TOKEN_REQUEST_TIMEOUT_MS = 30_000;

export type CursorPollResponse = {
  accessToken: string;
  refreshToken: string;
};

export type CursorRefreshResponse = {
  accessToken?: unknown;
  refreshToken?: unknown;
};

export type RefreshCursorTokenDeps = {
  fetchImpl?: typeof fetch;
  now?: () => number;
};

/**
 * Best-effort extraction of `exp` (seconds -> ms) from a JWT payload.
 * Returns null if the token is not a JWT or has no numeric `exp`.
 */
export function decodeJwtExp(token: string): number | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payloadJson = Buffer.from(parts[1], "base64url").toString("utf-8");
    const payload = JSON.parse(payloadJson);
    if (typeof payload.exp === "number" && Number.isFinite(payload.exp)) {
      return payload.exp * 1000;
    }
    return null;
  } catch {
    return null;
  }
}

export function normalizeCursorTokenPayload(args: {
  payload: CursorRefreshResponse;
  baseCredential?: OAuthCredential;
  now: number;
}): OAuthCredential {
  const { payload, baseCredential, now } = args;
  if (typeof payload.accessToken !== "string" || !payload.accessToken.trim()) {
    throw new Error("Cursor token refresh response missing accessToken");
  }
  const accessToken = payload.accessToken.trim();
  const expiresAt =
    decodeJwtExp(accessToken) ??
    now + 3600 * 1000 - CURSOR_ACCESS_TOKEN_CLIENT_SKEW_MS;
  const newRefresh =
    typeof payload.refreshToken === "string" && payload.refreshToken.trim()
      ? payload.refreshToken.trim()
      : baseCredential?.refreshToken;

  return {
    ...(baseCredential ?? {}),
    provider: "cursor",
    accessToken,
    ...(newRefresh ? { refreshToken: newRefresh } : {}),
    expiresAt,
    obtainedAt: now,
  };
}

export async function refreshCursorToken(
  credential: OAuthCredential,
  deps: RefreshCursorTokenDeps = {}
): Promise<OAuthCredential> {
  if (!credential.refreshToken) {
    throw new Error("Cursor credential has no refresh_token");
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(CURSOR_REFRESH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential.refreshToken}`,
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(CURSOR_TOKEN_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `Cursor token refresh failed: ${toErrorMessage(error)}`
    );
  }

  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).trim();
    } catch {
      // ignore body-read failures
    }
    throw new Error(
      `Cursor token refresh failed: ${response.status}${detail ? ` ${detail}` : ""}`
    );
  }

  let data: CursorRefreshResponse;
  try {
    data = (await response.json()) as CursorRefreshResponse;
  } catch {
    throw new Error("Cursor token refresh response is not valid JSON");
  }

  const now = deps.now?.() ?? Date.now();
  return normalizeCursorTokenPayload({
    payload: data,
    baseCredential: credential,
    now,
  });
}

export const cursorRefresh: OAuthRefreshFn = refreshCursorToken;
