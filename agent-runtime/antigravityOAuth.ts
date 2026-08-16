import { toErrorMessage } from "../core/errorMessage";
import { asOptionalFiniteNumber } from "../core/optionalNumber";
import { asOptionalTrimmedString } from "../core/optionalString";
import { asTrimmedLowercaseString } from "../core/trimmedLowercaseString";

import type { AgentRuntimeAgentConfig } from "./hostAdapter";
import type { OAuthCredential, OAuthRefreshFn } from "./oauthTokenStore";
import { trimTrailingSlash } from "./providerResolution";

// Antigravity (Google Cloud Code Assist) Installed-App OAuth Public Client Configuration.
//
// Antigravity is Google's Cloud Code Assist surface that fronts Gemini 3, Claude,
// and GPT-OSS models. In accordance with RFC 8252 (OAuth 2.0 for Native Apps),
// installed desktop / CLI applications cannot protect client secrets; the client ID
// and client secret below belong to Google's public Antigravity client distribution
// (extracted from the Antigravity internal CLI; MIT-licensed in oh-my-pi).
// They are public client credentials intended for native application OAuth loopback
// and refresh flows, NOT private server-side secrets.
// Browser-safe base64 decode: 浏览器用 atob，Node 用 Buffer。
// 这个文件会被打进 web bundle（OAuth 凭证是公开的 client credentials），
// 必须兼容浏览器环境（浏览器没有全局 Buffer）。
const decodeBase64 = (s: string): string =>
  typeof Buffer !== "undefined"
    ? Buffer.from(s, "base64").toString("utf8")
    : typeof atob === "function"
      ? atob(s)
      : s;

export const ANTIGRAVITY_CLIENT_ID = decodeBase64(
  "MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5h" +
  "cHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ=="
);
export const ANTIGRAVITY_CLIENT_SECRET = decodeBase64(
  "R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFE" +
  "QWY="
);

export const ANTIGRAVITY_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const ANTIGRAVITY_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const ANTIGRAVITY_USERINFO_URL =
  "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";

export const ANTIGRAVITY_CALLBACK_PORT = 51121;
export const ANTIGRAVITY_CALLBACK_PATH = "/oauth-callback";
export const ANTIGRAVITY_CALLBACK_URL = `http://127.0.0.1:${ANTIGRAVITY_CALLBACK_PORT}${ANTIGRAVITY_CALLBACK_PATH}`;

export const ANTIGRAVITY_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

export const ANTIGRAVITY_ACCESS_TOKEN_CLIENT_SKEW_MS = 5 * 60 * 1000;
export const ANTIGRAVITY_TOKEN_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Cloud Code Assist base URL used by Antigravity OAuth direct chat.
 *
 * Must be the Antigravity production host `daily-cloudcode-pa`, NOT the generic
 * `cloudcode-pa`. The Antigravity subscription quota is served on
 * `daily-cloudcode-pa`; the generic host meters requests against the small
 * per-project individual quota and 429s with "upgrade your subscription" even
 * for paid users. (Matches oh-my-pi's ANTIGRAVITY_DAILY_ENDPOINT.)
 */
export const ANTIGRAVITY_CLOUD_CODE_BASE_URL =
  "https://daily-cloudcode-pa.googleapis.com";

/** Generic legacy host; kept for detection (daily host contains it as substring). */
const ANTIGRAVITY_CLOUD_CODE_HOST = "cloudcode-pa.googleapis.com";
/** Exact generic host to upgrade to the production Antigravity host. */
const ANTIGRAVITY_LEGACY_GENERIC_BASE_RE =
  /^https?:\/\/cloudcode-pa\.googleapis\.com$/i;

export type AntigravityTokenPayload = {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  scope?: unknown;
  token_type?: unknown;
  id_token?: unknown;
  error?: unknown;
  error_description?: unknown;
};

export type RefreshAntigravityTokenDeps = {
  fetchImpl?: typeof fetch;
  now?: () => number;
};

export function getAntigravityUserAgent(): string {
  const version = process.env.NOLO_ANTIGRAVITY_VERSION || "2.1.4";
  const os = process.platform === "win32" ? "windows" : process.platform;
  const arch =
    process.arch === "x64" ? "amd64" : process.arch === "ia32" ? "386" : process.arch;
  return `antigravity/hub/${version} ${os}/${arch}`;
}

export function resolveAntigravityCloudCodeBaseUrl(
  customProviderUrl?: string | null
): string {
  const raw = (customProviderUrl ?? "").trim();
  if (!raw) return ANTIGRAVITY_CLOUD_CODE_BASE_URL;
  const trimmed = trimTrailingSlash(raw);
  if (trimmed.includes(ANTIGRAVITY_CLOUD_CODE_HOST)) {
    const base = trimmed.replace(/\/v1internal:.*$/i, "").replace(/\/$/, "");
    // Upgrade legacy agent records pinned to the generic host so paid users
    // hit the Antigravity subscription quota instead of 429ing on the generic
    // per-project individual quota.
    if (ANTIGRAVITY_LEGACY_GENERIC_BASE_RE.test(base)) {
      return ANTIGRAVITY_CLOUD_CODE_BASE_URL;
    }
    return base;
  }
  return ANTIGRAVITY_CLOUD_CODE_BASE_URL;
}

export function isAntigravityOAuthAgent(
  agentConfig: AgentRuntimeAgentConfig | null | undefined
): boolean {
  if (!agentConfig) return false;
  const apiKeyRef = asTrimmedLowercaseString(agentConfig.apiKeyRef);
  const provider = asTrimmedLowercaseString(agentConfig.provider);
  const url = asTrimmedLowercaseString(agentConfig.customProviderUrl);
  return (
    apiKeyRef === "antigravity" ||
    provider === "google-antigravity" ||
    url.includes(ANTIGRAVITY_CLOUD_CODE_HOST)
  );
}

export function readAntigravityProjectId(
  metadata: Record<string, unknown> | undefined | null
): string | undefined {
  return asOptionalTrimmedString(metadata?.projectId);
}

export function normalizeAntigravityTokenPayload(args: {
  payload: AntigravityTokenPayload;
  baseCredential?: Partial<OAuthCredential>;
  now?: number;
  clientSkewMs?: number;
}): OAuthCredential {
  const {
    payload,
    baseCredential,
    now = Date.now(),
    clientSkewMs = ANTIGRAVITY_ACCESS_TOKEN_CLIENT_SKEW_MS,
  } = args;

  if (typeof payload.access_token !== "string" || !payload.access_token.trim()) {
    throw new Error("Antigravity token response missing access_token");
  }

  const accessToken = payload.access_token.trim();
  const expiresIn = asOptionalFiniteNumber(payload.expires_in);
  const expiresAt =
    expiresIn !== undefined
      ? now + expiresIn * 1000 - clientSkewMs
      : baseCredential?.expiresAt;

  const refreshToken =
    typeof payload.refresh_token === "string" && payload.refresh_token.trim()
      ? payload.refresh_token.trim()
      : baseCredential?.refreshToken;

  const scope =
    typeof payload.scope === "string" && payload.scope.trim()
      ? payload.scope.trim()
      : baseCredential?.scope;

  return {
    ...(baseCredential ?? {}),
    provider: baseCredential?.provider ?? "antigravity",
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(scope ? { scope } : {}),
    obtainedAt: now,
  };
}

export async function refreshAntigravityToken(
  credential: OAuthCredential,
  deps: RefreshAntigravityTokenDeps = {}
): Promise<OAuthCredential> {
  if (!credential.refreshToken || !credential.refreshToken.trim()) {
    throw new Error("Antigravity credential has no refresh_token");
  }
  const fetchImpl = deps.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(ANTIGRAVITY_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        client_id: ANTIGRAVITY_CLIENT_ID,
        client_secret: ANTIGRAVITY_CLIENT_SECRET,
        refresh_token: credential.refreshToken.trim(),
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(ANTIGRAVITY_TOKEN_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `Antigravity token refresh failed: ${toErrorMessage(error)}`
    );
  }

  let rawBodyText = "";
  let payload: AntigravityTokenPayload;
  try {
    rawBodyText = await response.text();
    payload = (rawBodyText ? JSON.parse(rawBodyText) : {}) as AntigravityTokenPayload;
  } catch {
    payload = {};
  }

  if (!response.ok) {
    const detail =
      typeof payload.error_description === "string" && payload.error_description.trim()
        ? payload.error_description.trim()
        : typeof payload.error === "string" && payload.error.trim()
          ? payload.error.trim()
          : rawBodyText.trim() || `HTTP ${response.status}`;
    throw new Error(`Antigravity token refresh failed: ${detail}`);
  }

  if (typeof payload.access_token !== "string" || !payload.access_token.trim()) {
    throw new Error("Antigravity token refresh response missing access_token");
  }

  const now = deps.now?.() ?? Date.now();
  return normalizeAntigravityTokenPayload({
    payload,
    baseCredential: credential,
    now,
  });
}

export const antigravityRefresh: OAuthRefreshFn = refreshAntigravityToken;
