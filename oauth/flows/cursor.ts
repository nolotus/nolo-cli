// Ported from oh-my-pi/packages/ai/src/utils/oauth/cursor.ts (MIT).
// Cursor uses a poll-based device flow (no loopback callback):
//   1. Generate PKCE pair + random UUID.
//   2. Open https://cursor.com/loginDeepControl?challenge=<S256>&uuid=<uuid>&mode=login&redirectTarget=cli
//   3. Poll https://api2.cursor.sh/auth/poll?uuid=<uuid>&verifier=<verifier>
//      until it returns { accessToken, refreshToken }.
// Token refresh uses https://api2.cursor.sh/auth/exchange_user_api_key with
// the refresh token as a Bearer header (Cursor does not expose a public
// client_id-based refresh endpoint).

import { generatePkcePair } from "../pkce";
import type { OAuthCredential, OAuthFlowDeps } from "../types";
import type { CliFetchImpl } from "../../cliFetch";

const CURSOR_LOGIN_URL = "https://cursor.com/loginDeepControl";
const CURSOR_POLL_URL = "https://api2.cursor.sh/auth/poll";
const CURSOR_REFRESH_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";

const POLL_MAX_ATTEMPTS = 150;
const POLL_BASE_DELAY_MS = 1000;
const POLL_MAX_DELAY_MS = 10_000;
const POLL_BACKOFF_MULTIPLIER = 1.2;
const POLL_MAX_CONSECUTIVE_ERRORS = 3;

const ACCESS_TOKEN_CLIENT_SKEW_MS = 5 * 60 * 1000;

type CursorPollResponse = {
  accessToken: string;
  refreshToken: string;
};

type CursorRefreshResponse = {
  accessToken: string;
  refreshToken?: string;
};

function decodeJwtExp(token: string): number | undefined {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    const payload = parts[1];
    if (!payload) return undefined;
    const decoded = JSON.parse(
      Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
    ) as { exp?: unknown };
    if (decoded && typeof decoded === "object" && typeof decoded.exp === "number") {
      return decoded.exp * 1000 - ACCESS_TOKEN_CLIENT_SKEW_MS;
    }
  } catch {
    // Ignore parsing errors
  }
  return undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("Aborted"));
        return;
      }
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("Aborted"));
        },
        { once: true }
      );
    });
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pollCursorAuth(
  uuid: string,
  verifier: string,
  deps: { fetchImpl?: CliFetchImpl; sleepFn?: (ms: number) => Promise<void> } = {}
): Promise<CursorPollResponse> {
  const fetchImpl = deps.fetchImpl ?? (fetch as CliFetchImpl);
  const sleepFn = deps.sleepFn ?? ((ms: number) => sleep(ms));

  let delay = POLL_BASE_DELAY_MS;
  let consecutiveErrors = 0;

  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await sleepFn(delay);

    let response: Response;
    try {
      response = await fetchImpl(
        `${CURSOR_POLL_URL}?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`
      );
    } catch {
      consecutiveErrors++;
      if (consecutiveErrors >= POLL_MAX_CONSECUTIVE_ERRORS) {
        throw new Error("Too many consecutive network errors during Cursor auth polling");
      }
      continue;
    }

    if (response.status === 404) {
      consecutiveErrors = 0;
      delay = Math.min(delay * POLL_BACKOFF_MULTIPLIER, POLL_MAX_DELAY_MS);
      continue;
    }

    if (response.ok) {
      const data = (await response.json()) as CursorPollResponse;
      if (typeof data.accessToken !== "string" || typeof data.refreshToken !== "string") {
        throw new Error("Cursor poll response missing accessToken or refreshToken");
      }
      return { accessToken: data.accessToken, refreshToken: data.refreshToken };
    }

    consecutiveErrors++;
    if (consecutiveErrors >= POLL_MAX_CONSECUTIVE_ERRORS) {
      throw new Error(`Cursor auth poll failed: ${response.status}`);
    }
  }

  throw new Error("Cursor authentication polling timed out");
}

export async function runCursorOAuthLogin(
  deps: OAuthFlowDeps = {}
): Promise<OAuthCredential> {
  const output = deps.output ?? console;
  const fetchImpl = deps.fetchImpl ?? (fetch as CliFetchImpl);
  const pkce = generatePkcePair();
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

export const cursorRefresh = async (
  credential: OAuthCredential,
  deps: { fetchImpl?: typeof fetch; now?: () => number } = {}
): Promise<OAuthCredential> => {
  if (!credential.refreshToken) {
    throw new Error("Cursor credential has no refresh_token");
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const response = await fetchImpl(CURSOR_REFRESH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credential.refreshToken}`,
      "Content-Type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(30_000),
  });

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

  const data = (await response.json()) as CursorRefreshResponse;
  if (typeof data.accessToken !== "string" || !data.accessToken) {
    throw new Error("Cursor token refresh response missing accessToken");
  }

  const now = deps.now?.() ?? Date.now();
  const expiresAt = decodeJwtExp(data.accessToken) ?? now + 3600 * 1000 - ACCESS_TOKEN_CLIENT_SKEW_MS;
  const newRefresh =
    typeof data.refreshToken === "string" && data.refreshToken
      ? data.refreshToken
      : credential.refreshToken;

  return {
    ...credential,
    provider: "cursor",
    accessToken: data.accessToken,
    refreshToken: newRefresh,
    expiresAt,
    obtainedAt: now,
  };
};