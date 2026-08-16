import { asOptionalFiniteNumber } from "../core/optionalNumber";

import type { OAuthCredential, OAuthRefreshFn } from "./oauthTokenStore";

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
export const ANTHROPIC_ACCESS_TOKEN_CLIENT_SKEW_MS = 5 * 60 * 1000;
export const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";

export type AnthropicTokenPayload = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  account?: { uuid?: unknown; email_address?: unknown };
  organization?: { uuid?: unknown; name?: unknown };
  error?: unknown;
  error_description?: unknown;
};

export type RefreshAnthropicTokenDeps = {
  fetchImpl?: typeof fetch;
  now?: () => number;
};

export function normalizeAnthropicTokenPayload(args: {
  payload: AnthropicTokenPayload;
  baseCredential?: Partial<OAuthCredential>;
  now?: number;
}): OAuthCredential {
  const { payload, baseCredential, now = Date.now() } = args;

  if (typeof payload.access_token !== "string" || !payload.access_token.trim()) {
    throw new Error("Claude OAuth token response missing access_token");
  }

  const expiresIn = asOptionalFiniteNumber(payload.expires_in);
  const accountId =
    typeof payload.account?.uuid === "string" && payload.account.uuid
      ? payload.account.uuid
      : baseCredential?.accountId;
  const email =
    typeof payload.account?.email_address === "string" && payload.account.email_address
      ? payload.account.email_address
      : (baseCredential?.metadata?.email as string | undefined);
  const organizationId =
    typeof payload.organization?.uuid === "string" && payload.organization.uuid
      ? payload.organization.uuid
      : (baseCredential?.metadata?.organizationId as string | undefined);
  const organizationName =
    typeof payload.organization?.name === "string" && payload.organization.name
      ? payload.organization.name
      : (baseCredential?.metadata?.organizationName as string | undefined);

  const refreshToken =
    typeof payload.refresh_token === "string" && payload.refresh_token.trim()
      ? payload.refresh_token.trim()
      : baseCredential?.refreshToken;

  const scope =
    typeof payload.scope === "string" && payload.scope
      ? payload.scope
      : baseCredential?.scope;

  const metadata: Record<string, unknown> = {
    ...(baseCredential?.metadata ?? {}),
    ...(email ? { email } : {}),
    ...(organizationId ? { organizationId } : {}),
    ...(organizationName ? { organizationName } : {}),
  };

  return {
    ...baseCredential,
    provider: "claude",
    accessToken: payload.access_token.trim(),
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresIn !== undefined
      ? { expiresAt: now + expiresIn * 1000 - ANTHROPIC_ACCESS_TOKEN_CLIENT_SKEW_MS }
      : baseCredential?.expiresAt !== undefined
        ? { expiresAt: baseCredential.expiresAt }
        : {}),
    ...(scope ? { scope } : {}),
    ...(accountId ? { accountId } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    obtainedAt: now,
  };
}

export async function refreshAnthropicToken(
  credential: OAuthCredential,
  deps: RefreshAnthropicTokenDeps = {}
): Promise<OAuthCredential> {
  if (!credential.refreshToken) {
    throw new Error("Claude credential has no refresh_token");
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const response = await fetchImpl(ANTHROPIC_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-beta": ANTHROPIC_OAUTH_BETA,
      "User-Agent": "nolo-cli userOAuthProvider",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
      refresh_token: credential.refreshToken,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = (await response.json().catch(() => ({}))) as AnthropicTokenPayload;
  if (!response.ok) {
    const detail =
      typeof payload.error_description === "string"
        ? payload.error_description
        : typeof payload.error === "string"
          ? payload.error
          : `HTTP ${response.status}`;
    throw new Error(`Claude token refresh failed: ${detail}`);
  }
  if (typeof payload.access_token !== "string" || !payload.access_token.trim()) {
    throw new Error("Claude token refresh response missing access_token");
  }
  const now = deps.now?.() ?? Date.now();
  return normalizeAnthropicTokenPayload({
    payload,
    baseCredential: credential,
    now,
  });
}

export const anthropicRefresh: OAuthRefreshFn = refreshAnthropicToken;
