import { toErrorMessage } from "../../../core/errorMessage";
import { asOptionalFiniteNumber } from "../../../core/optionalNumber";
import { startCallbackServer, type CallbackServerHandle } from "../callback-server";
import { generatePkcePair } from "../pkce";
import type {
  OAuthCredential,
  OAuthFlowDeps,
  OAuthTokenResponse,
  PkcePair,
} from "../types";
import type { CliFetchImpl } from "../../cliFetch";

// Cloudflare self-managed OAuth endpoints. Documentation:
// https://developers.cloudflare.com/fundamentals/api/oauth/
const CLOUDFLARE_OAUTH_AUTH_ENDPOINT = "https://dash.cloudflare.com/oauth2/auth";
const CLOUDFLARE_OAUTH_TOKEN_ENDPOINT = "https://dash.cloudflare.com/oauth2/token";
const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

const CLOUDFLARE_OAUTH_REDIRECT_HOST = "127.0.0.1";
const CLOUDFLARE_OAUTH_REDIRECT_PORT = 56122;
const CLOUDFLARE_OAUTH_REDIRECT_PATH = "/callback";

const ACCESS_TOKEN_CLIENT_SKEW_MS = 5 * 60 * 1000;
const TOKEN_REQUEST_TIMEOUT_MS = 20_000;

// Default scopes request broad read/write access so the OAuth token can both
// manage zones and create long-lived API tokens. Exact scope identifiers may
// evolve; callers can override via CLOUDFLARE_OAUTH_SCOPE.
const DEFAULT_SCOPE = "account:read zone:read zone:edit user:read user:edit";

function generateState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function getClientId(args?: { clientId?: string }): string {
  const value =
    args?.clientId?.trim() || process.env.CLOUDFLARE_OAUTH_CLIENT_ID?.trim();
  if (!value) {
    throw new Error(
      "Cloudflare OAuth client ID is required. Set CLOUDFLARE_OAUTH_CLIENT_ID or pass --client-id."
    );
  }
  return value;
}

function getScope(args?: { scope?: string }): string {
  return (
    args?.scope?.trim() ||
    process.env.CLOUDFLARE_OAUTH_SCOPE?.trim() ||
    DEFAULT_SCOPE
  );
}

function buildCloudflareAuthorizeUrl(opts: {
  redirectUri: string;
  codeChallenge: string;
  state: string;
  clientId: string;
  scope: string;
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    scope: opts.scope,
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
    state: opts.state,
  });
  return `${CLOUDFLARE_OAUTH_AUTH_ENDPOINT}?${params.toString()}`;
}

async function exchangeCloudflareToken(
  fetchImpl: CliFetchImpl,
  code: string,
  redirectUri: string,
  verifier: string,
  clientId: string
): Promise<OAuthTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });

  const response = await fetchImpl(CLOUDFLARE_OAUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).trim();
    } catch {
      // ignore
    }
    throw new Error(
      `Cloudflare token exchange failed: ${response.status}${detail ? ` ${detail}` : ""}`
    );
  }

  const data = (await response.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    scope?: unknown;
    id_token?: unknown;
  };

  if (typeof data.access_token !== "string" || !data.access_token) {
    throw new Error("Cloudflare token exchange response missing access_token");
  }

  return {
    accessToken: data.access_token,
    refreshToken:
      typeof data.refresh_token === "string" ? data.refresh_token : undefined,
    expiresIn: asOptionalFiniteNumber(data.expires_in),
    scope: typeof data.scope === "string" ? data.scope : undefined,
    idToken: typeof data.id_token === "string" ? data.id_token : undefined,
  };
}

/**
 * Run the Cloudflare OAuth browser PKCE flow.
 *
 * Requires a Cloudflare OAuth client (created via the dashboard or
 * POST /accounts/{account_id}/oauth_clients). The client ID can be provided
 * via the CLOUDFLARE_OAUTH_CLIENT_ID environment variable or the deps override.
 */
export async function runCloudflareOAuthLogin(
  deps: OAuthFlowDeps & { clientId?: string; scope?: string } = {}
): Promise<OAuthCredential> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const output = deps.output ?? console;
  const error = deps.error ?? console;

  const clientId = getClientId(deps);
  const scope = getScope(deps);
  const redirectUri = `http://${CLOUDFLARE_OAUTH_REDIRECT_HOST}:${CLOUDFLARE_OAUTH_REDIRECT_PORT}${CLOUDFLARE_OAUTH_REDIRECT_PATH}`;

  let handle: CallbackServerHandle;
  try {
    handle = await startCallbackServer({
      port: CLOUDFLARE_OAUTH_REDIRECT_PORT,
      hostname: CLOUDFLARE_OAUTH_REDIRECT_HOST,
      timeoutMs: 5 * 60_000,
    });
  } catch (err) {
    throw new Error(
      `Failed to start Cloudflare OAuth callback server on ${CLOUDFLARE_OAUTH_REDIRECT_PORT}: ${toErrorMessage(err)}`
    );
  }

  try {
    const state = generateState();
    const pkce: PkcePair = await generatePkcePair();

    const authUrl = buildCloudflareAuthorizeUrl({
      redirectUri,
      codeChallenge: pkce.challenge,
      state,
      clientId,
      scope,
    });

    output.log(
      `Open the following URL in your browser to authorize Cloudflare access:\n  ${authUrl}\n\nRequested scopes: ${scope}`
    );

    if (deps.openBrowser) {
      try {
        await deps.openBrowser(authUrl);
      } catch (err) {
        error.error(
          `Failed to open browser automatically: ${toErrorMessage(err)}`
        );
      }
    }

    const callback = await handle.waitForCode();

    const token = await exchangeCloudflareToken(
      fetchImpl,
      callback.code,
      redirectUri,
      pkce.verifier,
      clientId
    );

    const now = (deps.now ?? Date.now)();
    const expiresIn = token.expiresIn;
    return {
      provider: "cloudflare",
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt:
        typeof expiresIn === "number"
          ? now + expiresIn * 1000 - ACCESS_TOKEN_CLIENT_SKEW_MS
          : undefined,
      scope: token.scope,
      idToken: token.idToken,
      obtainedAt: now,
    };
  } finally {
    await handle.close();
  }
}

// ── Cloudflare API token generation via OAuth access token ───────────────────

export type CloudflareApiTokenPermission = {
  id: string;
  name?: string;
};

export type CloudflareApiTokenPolicy = {
  effect: "allow";
  resources: Record<string, string>;
  permission_groups: Array<{ id: string }>;
};

export type CloudflareApiTokenCreateInput = {
  name: string;
  policies: CloudflareApiTokenPolicy[];
  accessToken: string;
  fetchImpl?: CliFetchImpl;
};

/**
 * Create a long-lived Cloudflare API token using a short-lived OAuth access token.
 *
 * The OAuth token must have been granted a scope that permits the
 * `POST /client/v4/user/tokens` operation. This usually requires the
 * "Create Additional Tokens" permission template.
 */
export async function createCloudflareApiToken(
  input: CloudflareApiTokenCreateInput
): Promise<string> {
  const fetchImpl = input.fetchImpl ?? fetch;

  const response = await fetchImpl(`${CLOUDFLARE_API_BASE}/user/tokens`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.accessToken}`,
    },
    body: JSON.stringify({
      name: input.name,
      policies: input.policies,
    }),
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).trim();
    } catch {
      // ignore
    }
    throw new Error(
      `Cloudflare API token creation failed: ${response.status}${detail ? ` ${detail}` : ""}`
    );
  }

  const data = (await response.json()) as {
    result?: { value?: string } | null;
    success?: boolean;
    errors?: Array<{ message: string }>;
  };

  const tokenValue = data.result?.value;
  if (typeof tokenValue !== "string" || !tokenValue) {
    throw new Error(
      "Cloudflare API token creation response did not contain a token value"
    );
  }

  return tokenValue;
}

/**
 * Look up Cloudflare permission group IDs by name so callers can build API token
 * policies without hard-coding internal IDs.
 */
export async function listCloudflarePermissionGroups(
  accessToken: string,
  fetchImpl: CliFetchImpl = fetch
): Promise<Array<{ id: string; name: string; permissions: string[] }>> {
  const response = await fetchImpl(
    `${CLOUDFLARE_API_BASE}/user/tokens/permission_groups`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    }
  );

  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).trim();
    } catch {
      // ignore
    }
    throw new Error(
      `Cloudflare permission groups lookup failed: ${response.status}${detail ? ` ${detail}` : ""}`
    );
  }

  const data = (await response.json()) as {
    result?: Array<{
      id?: string;
      name?: string;
      permissions?: string[];
    }>;
  };
  if (!Array.isArray(data.result)) {
    throw new Error("Cloudflare permission groups response missing result array");
  }

  return data.result
    .filter(
      (group): group is { id: string; name: string; permissions: string[] } =>
        typeof group.id === "string" &&
        typeof group.name === "string" &&
        Array.isArray(group.permissions)
    )
    .map((group) => ({
      id: group.id,
      name: group.name,
      permissions: group.permissions,
    }));
}

export async function findCloudflareZoneIdByName(
  accessToken: string,
  zoneName: string,
  fetchImpl: CliFetchImpl = fetch
): Promise<string | null> {
  const response = await fetchImpl(
    `${CLOUDFLARE_API_BASE}/zones?name=${encodeURIComponent(zoneName)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    }
  );

  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).trim();
    } catch {
      // ignore
    }
    throw new Error(
      `Cloudflare zone lookup failed: ${response.status}${detail ? ` ${detail}` : ""}`
    );
  }

  const data = (await response.json()) as {
    result?: Array<{ id?: string; name?: string }>;
  };
  if (!Array.isArray(data.result)) {
    throw new Error("Cloudflare zone lookup response missing result array");
  }

  const zone = data.result.find((z) => z.name === zoneName);
  return zone?.id ?? null;
}

/**
 * Convenience helper that finds the zone ID, resolves the Email Routing Edit
 * permission group, and creates a long-lived API token scoped to that zone.
 *
 * INTENDED USE (future Cloudflare-customer flow): this powers the eventual
 * "connect your Cloudflare account" experience, where a customer authorizes
 * nolo via Cloudflare's self-managed OAuth (GA 2026-06) and we provision the
 * scoped credentials they need. It is NOT the recommended path for a local
 * operator today: Cloudflare OAuth access tokens are meant to be used directly
 * against the API within their granted scopes, and may not carry a scope that
 * permits minting long-lived tokens via POST /user/tokens — in which case this
 * call will 403. For local setup, create an API token in the dashboard and set
 * CLOUDFLARE_EMAIL_ROUTING_API_TOKEN instead.
 */
export async function generateCloudflareEmailRoutingToken(input: {
  accessToken: string;
  zoneName: string;
  tokenName?: string;
  fetchImpl?: CliFetchImpl;
}): Promise<{ token: string; zoneId: string }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const zoneId = await findCloudflareZoneIdByName(
    input.accessToken,
    input.zoneName,
    fetchImpl
  );
  if (!zoneId) {
    throw new Error(`Cloudflare zone "${input.zoneName}" not found`);
  }

  const groups = await listCloudflarePermissionGroups(
    input.accessToken,
    fetchImpl
  );
  const emailRoutingGroup = groups.find((g) =>
    g.name.toLowerCase().includes("email routing")
  );
  if (!emailRoutingGroup) {
    throw new Error(
      "Cloudflare Email Routing Edit permission group not found for this account."
    );
  }

  const token = await createCloudflareApiToken({
    name:
      input.tokenName ??
      `nolo-email-routing-${input.zoneName}-${Date.now()}`,
    policies: [buildEmailRoutingPolicy(zoneId, [emailRoutingGroup.id])],
    accessToken: input.accessToken,
    fetchImpl,
  });

  return { token, zoneId };
}

/**
 * Build a standard Email Routing API token policy for a single zone.
 * Permission group IDs must be resolved dynamically via
 * {@link listCloudflarePermissionGroups}.
 */
export function buildEmailRoutingPolicy(
  zoneId: string,
  emailRoutingPermissionGroupIds: string[]
): CloudflareApiTokenPolicy {
  if (emailRoutingPermissionGroupIds.length === 0) {
    throw new Error(
      "Email routing permission group IDs are required. Resolve them with listCloudflarePermissionGroups."
    );
  }
  return {
    effect: "allow",
    resources: {
      "com.cloudflare.api.account": "*",
      "com.cloudflare.api.zone": zoneId,
    },
    permission_groups: emailRoutingPermissionGroupIds.map((id) => ({ id })),
  };
}
