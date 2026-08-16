// Ported from oh-my-pi/packages/ai/src/utils/oauth/cursor.ts (MIT).
// Cursor uses a poll-based device flow (no loopback callback):
//   1. Generate PKCE pair + random UUID.
//   2. Open https://cursor.com/loginDeepControl?challenge=<S256>&uuid=<uuid>&mode=login&redirectTarget=cli
//   3. Poll https://api2.cursor.sh/auth/poll?uuid=<uuid>&verifier=<verifier>
//      until it returns { accessToken, refreshToken }.
// Token refresh uses https://api2.cursor.sh/auth/exchange_user_api_key with
// the refresh token as a Bearer header (Cursor does not expose a public
// client_id-based refresh endpoint).

import {
  CURSOR_ACCESS_TOKEN_CLIENT_SKEW_MS,
  CURSOR_LOGIN_URL,
  CURSOR_POLL_BASE_DELAY_MS,
  CURSOR_POLL_BACKOFF_MULTIPLIER,
  CURSOR_POLL_MAX_ATTEMPTS,
  CURSOR_POLL_MAX_CONSECUTIVE_ERRORS,
  CURSOR_POLL_MAX_DELAY_MS,
  CURSOR_POLL_URL,
  CURSOR_REFRESH_URL,
  cursorRefresh,
  decodeJwtExp,
  normalizeCursorTokenPayload,
  refreshCursorToken,
  type CursorPollResponse,
  type CursorRefreshResponse,
  type RefreshCursorTokenDeps,
} from "../../agent-runtime/cursorOAuth";
import type { CliFetchImpl } from "../../cliFetch";
import { generatePkcePair } from "../pkce";
import type { OAuthCredential, OAuthFlowDeps } from "../types";

export {
  CURSOR_ACCESS_TOKEN_CLIENT_SKEW_MS,
  CURSOR_LOGIN_URL,
  CURSOR_POLL_BASE_DELAY_MS,
  CURSOR_POLL_BACKOFF_MULTIPLIER,
  CURSOR_POLL_MAX_ATTEMPTS,
  CURSOR_POLL_MAX_CONSECUTIVE_ERRORS,
  CURSOR_POLL_MAX_DELAY_MS,
  CURSOR_POLL_URL,
  CURSOR_REFRESH_URL,
  cursorRefresh,
  decodeJwtExp,
  normalizeCursorTokenPayload,
  refreshCursorToken,
};
export type { CursorPollResponse, CursorRefreshResponse, RefreshCursorTokenDeps };

const POLL_MAX_ATTEMPTS = CURSOR_POLL_MAX_ATTEMPTS;
const POLL_BASE_DELAY_MS = CURSOR_POLL_BASE_DELAY_MS;
const POLL_MAX_DELAY_MS = CURSOR_POLL_MAX_DELAY_MS;
const POLL_BACKOFF_MULTIPLIER = CURSOR_POLL_BACKOFF_MULTIPLIER;
const POLL_MAX_CONSECUTIVE_ERRORS = CURSOR_POLL_MAX_CONSECUTIVE_ERRORS;
const ACCESS_TOKEN_CLIENT_SKEW_MS = CURSOR_ACCESS_TOKEN_CLIENT_SKEW_MS;

export const pollCursorAuth = async (
  uuid: string,
  verifier: string,
  deps: { fetchImpl?: CliFetchImpl; sleepFn?: (ms: number) => Promise<void> } = {}
): Promise<CursorPollResponse> => {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleepFn = deps.sleepFn ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  let delay = POLL_BASE_DELAY_MS;
  let consecutiveErrors = 0;

  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    try {
      const url = `${CURSOR_POLL_URL}?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`;
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(10_000),
      });

      if (response.status === 200) {
        const data = (await response.json()) as CursorPollResponse;
        if (
          typeof data.accessToken === "string" &&
          data.accessToken &&
          typeof data.refreshToken === "string" &&
          data.refreshToken
        ) {
          return data;
        }
      }

      if (response.status === 404) {
        // Pending authorization, continue polling with backoff.
        consecutiveErrors = 0;
      } else {
        consecutiveErrors++;
        if (consecutiveErrors >= POLL_MAX_CONSECUTIVE_ERRORS) {
          throw new Error(`Cursor auth poll failed: ${response.status}`);
        }
      }
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        err.message.includes("Cursor auth poll failed")
      ) {
        throw err;
      }
      consecutiveErrors++;
      if (consecutiveErrors >= POLL_MAX_CONSECUTIVE_ERRORS) {
        throw new Error(
          `Cursor auth poll failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    await sleepFn(delay);
    delay = Math.min(delay * POLL_BACKOFF_MULTIPLIER, POLL_MAX_DELAY_MS);
  }

  throw new Error("Cursor auth timed out. Please try again.");
};

export async function runCursorOAuthLogin(
  deps: OAuthFlowDeps = {}
): Promise<OAuthCredential> {
  const output = deps.output ?? console;
  const fetchImpl = deps.fetchImpl ?? fetch;

  const pkce = await generatePkcePair();
  const uuid = crypto.randomUUID();

  const params = new URLSearchParams({
    challenge: pkce.challenge,
    uuid,
    mode: "login",
    redirectTarget: "cli",
  });
  const loginUrl = `${CURSOR_LOGIN_URL}?${params.toString()}`;

  output.log(
    `\nOpen this URL in your browser to authorize Cursor:\n${loginUrl}\n\n` +
      `Waiting for browser authentication... (polling ${CURSOR_POLL_URL})`
  );

  const openBrowser = deps.openBrowser;
  if (openBrowser) {
    try {
      await openBrowser(loginUrl);
    } catch {
      // Non-fatal: the URL is already printed above.
    }
  }

  const { accessToken, refreshToken } = await pollCursorAuth(uuid, pkce.verifier, {
    fetchImpl,
    ...(deps.sleep ? { sleepFn: deps.sleep } : {}),
  });

  const now = deps.now?.() ?? Date.now();
  const expiresAt = decodeJwtExp(accessToken) ?? now + 3600 * 1000 - ACCESS_TOKEN_CLIENT_SKEW_MS;

  return {
    provider: "cursor",
    accessToken,
    refreshToken,
    expiresAt,
    obtainedAt: now,
  };
}
