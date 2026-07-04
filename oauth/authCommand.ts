import {
  generateCloudflareEmailRoutingToken,
  runCloudflareOAuthLogin,
} from "./flows/cloudflare";
import { runAntigravityOAuthLogin } from "./flows/antigravity";
import { runXaiOAuthLogin } from "./flows/xai";

import type { CliRuntimeContext } from "../cliCommandTypes";
import { defaultOpenBrowser } from "../authCommands";
import type { OAuthFlowDeps, OAuthProvider } from "./types";
import type { OAuthCredential } from "../agent-runtime/oauthTokenStore";
import { createOAuthTokenStore, readOAuthCredential } from "./token-store";
import {
  runOpenAiCodexBrowserPkce,
  runOpenAiCodexDeviceCode,
} from "./flows/openai-codex";
import {
  loadProfileConfig,
  buildEnvFromProfile,
} from "../client/profileConfig";
import { parseFlagWithOptionalValue, upsertEnvVariable } from "./envFile";

export type AuthProviderCommandDeps = OAuthFlowDeps & {
  noBrowserByDefault?: boolean;
};

const SYNC_HELP_LINE = `  --sync-to-server  After local save, push the credential to your nolo server.
  --sync-only       Push ~/.nolo/credentials/<provider>.json to the server without re-login.`;

const CHATGPT_HELP_TEXT = `Authorize nolo-cli to call the OpenAI Codex / ChatGPT Plus API on your behalf.

Usage:
  nolo auth chatgpt [--browser] [--no-browser] [--sync-to-server] [--help]

Options:
  --browser         Use the local browser PKCE flow instead of the device-code flow.
  --no-browser      Print the authorization URL only (device-code flow).
${SYNC_HELP_LINE}
  --help, -h        Show this help and exit.

The default flow is device-code, which works headless: open the printed URL on any
machine with a browser where you are already logged into ChatGPT. After approval, the
access and refresh tokens are stored in ~/.nolo/credentials/chatgpt.json.

Agents can reference the stored token by setting apiKeyRef: "chatgpt" with
apiSource: "custom" and provider: "openai".
`;

const XAI_HELP_TEXT = `Authorize nolo-cli to call the xAI Grok API via your SuperGrok subscription.

Usage:
  nolo auth xai [--browser] [--no-browser] [--sync-to-server] [--help]

Opens a browser to https://auth.x.ai (OIDC PKCE loopback on 127.0.0.1:56121)
for SuperGrok / X Premium+ login. After approval, the access and refresh tokens
are stored in ~/.nolo/credentials/xai.json.

The OAuth client_id is the same fixed value used by NousResearch/hermes-agent
(MIT) and oh-my-pi; xAI does not publish a public client registration flow.

Options:
  --browser         Use the browser PKCE flow (default for xAI).
  --no-browser      Print the authorization URL only.
${SYNC_HELP_LINE}
  --help, -h        Show this help and exit.

Agents can reference the stored token by setting apiKeyRef: "xai" with
apiSource: "custom" and provider: "xai".
`;

const ANTIGRAVITY_HELP_TEXT = `Authorize nolo-cli to call Google Antigravity (Gemini 3, Claude, GPT-OSS) via your Google account.

Usage:
  nolo auth antigravity [--browser] [--no-browser] [--sync-to-server] [--help]

Opens a browser to https://accounts.google.com (OIDC PKCE loopback on 127.0.0.1:51121).
After approval, the flow provisions a Cloud Code Assist project and stores the
access and refresh tokens in ~/.nolo/credentials/antigravity.json.

The OAuth client_id/secret are the same base64-decoded values used by
oh-my-pi; Google does not publish a public Cloud Code Assist client registration.

Options:
  --browser         Use the browser PKCE flow (default for antigravity).
  --no-browser      Print the authorization URL only.
${SYNC_HELP_LINE}
  --help, -h        Show this help and exit.

Agents can reference the stored token by setting apiKeyRef: "antigravity" with
apiSource: "custom" and provider: "google-antigravity".
`;

const CLOUDFLARE_HELP_TEXT = `Authorize nolo-cli to manage Cloudflare resources on your behalf.

Usage:
  nolo auth cloudflare [--client-id <id>] [--scope <scopes>] [--generate-token] [--zone-name <domain>] [--token-name <label>] [--browser] [--no-browser] [--sync-to-server] [--help]

Opens a browser to https://dash.cloudflare.com (OAuth 2.0 PKCE loopback on
127.0.0.1:56122). After approval, the OAuth access token is stored locally in
~/.nolo/credentials/cloudflare.json.

To use this flow you must first create a Cloudflare OAuth client in the
Cloudflare Dashboard (Manage Account > OAuth clients) and obtain a client_id.
You can also create the client via the Cloudflare API:
  POST /accounts/{account_id}/oauth_clients

Set the client ID via the environment variable:
  CLOUDFLARE_OAUTH_CLIENT_ID

Override requested scopes via:
  CLOUDFLARE_OAUTH_SCOPE

Default scopes: account:read zone:read zone:edit user:read user:edit

With --generate-token, the command will also use the OAuth access token to
programmatically create a long-lived Cloudflare API token scoped to the
specified zone with the Email Routing Edit permission.

Options:
  --client-id <id>     Use this OAuth client ID for this run.
  --scope <scopes>     Space-separated scopes (overrides env var for this run).
  --generate-token     Also create a Zone:Email Routing:Edit API token.
  --zone-name <domain> Zone domain for token generation (default: nolo.chat).
  --token-name <label> Name for the generated API token.
  --write-to-env [path] Append or update CLOUDFLARE_EMAIL_ROUTING_API_TOKEN in the env file (default: .env).
  --browser            Use the browser PKCE flow (default for cloudflare).
  --no-browser         Print the authorization URL only.
${SYNC_HELP_LINE}
  --help, -h           Show this help and exit.
`;

const HELP_BY_PROVIDER: Record<OAuthProvider, string> = {
  chatgpt: CHATGPT_HELP_TEXT,
  xai: XAI_HELP_TEXT,
  antigravity: ANTIGRAVITY_HELP_TEXT,
  cloudflare: CLOUDFLARE_HELP_TEXT,
};

function isOAuthProvider(value: string): value is OAuthProvider {
  return (
    value === "chatgpt" ||
    value === "xai" ||
    value === "antigravity" ||
    value === "cloudflare"
  );
}

// ── Server sync ───────────────────────────────────────────────────────────────

/**
 * Resolve the nolo server origin and auth token for --sync-to-server.
 * Priority: env vars (NOLO_SERVER, AUTH_TOKEN) → profile config.
 */
function resolveServerSyncConfig(): {
  serverOrigin: string;
  authToken: string;
} | null {
  const envServer =
    process.env.NOLO_SERVER?.trim() ||
    process.env.NOLO_SERVER_URL?.trim() ||
    process.env.BASE_URL?.trim() ||
    "";
  const envToken =
    process.env.AUTH_TOKEN?.trim() || process.env.NOLO_AUTH_TOKEN?.trim() || "";

  if (envServer && envToken) {
    return { serverOrigin: envServer.replace(/\/+$/, ""), authToken: envToken };
  }

  let profileServer = "";
  let profileToken = "";
  try {
    const config = loadProfileConfig();
    const profileEnv = buildEnvFromProfile(config) as Record<string, string | undefined>;
    profileServer = profileEnv.NOLO_SERVER?.trim() || "";
    profileToken = profileEnv.AUTH_TOKEN?.trim() || "";
  } catch {
    // Profile config not available
  }

  const serverOrigin = (envServer || profileServer).replace(/\/+$/, "");
  const authToken = envToken || profileToken;
  if (serverOrigin && authToken) {
    return { serverOrigin, authToken };
  }

  return null;
}

async function syncCredentialToServer(
  provider: OAuthProvider,
  credential: OAuthCredential,
  deps: AuthProviderCommandDeps
): Promise<void> {
  const output = deps.output ?? console;
  const fetchImpl = deps.fetchImpl ?? fetch;

  const syncConfig = resolveServerSyncConfig();
  if (!syncConfig) {
    output.log(
      `[nolo] Warning: --sync-to-server requires NOLO_SERVER and AUTH_TOKEN env vars, or a configured profile. Skipping server sync.`
    );
    return;
  }

  const { serverOrigin, authToken } = syncConfig;
  const url = `${serverOrigin}/api/oauth/${provider}/sync`;

  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        accessToken: credential.accessToken,
        refreshToken: credential.refreshToken,
        expiresAt: credential.expiresAt,
        scope: credential.scope,
        idToken: credential.idToken,
        accountId: credential.accountId,
        email: credential.metadata?.email,
        metadata: credential.metadata,
      }),
    });

    if (res.ok) {
      output.log(`[nolo] Synced to ${serverOrigin}`);
    } else {
      let errorDetail = "";
      try {
        const body = (await res.json()) as { error?: string };
        errorDetail = body?.error || "";
      } catch {
        // ignore
      }
      output.log(
        `[nolo] Warning: server sync failed (${res.status}${errorDetail ? `: ${errorDetail}` : ""}). Token saved locally.`
      );
    }
  } catch (err: any) {
    output.log(
      `[nolo] Warning: server sync failed (${err?.message ?? "network error"}). Token saved locally.`
    );
  }
}

// ── Main command ──────────────────────────────────────────────────────────────

export async function runAuthProviderCommand(
  provider: OAuthProvider,
  args: string[],
  _ctx?: CliRuntimeContext,
  deps: AuthProviderCommandDeps = {}
): Promise<number> {
  const output = deps.output ?? console;
  const error = deps.error ?? console;

  if (args.includes("--help") || args.includes("-h")) {
    output.log(HELP_BY_PROVIDER[provider]);
    return 0;
  }

  const useBrowser = args.includes("--browser");
  const noBrowser = args.includes("--no-browser") || deps.noBrowserByDefault;
  const syncOnly = args.includes("--sync-only");
  const syncToServer = args.includes("--sync-to-server") || syncOnly;
  const generateToken = args.includes("--generate-token");
  const writeToEnvRaw = parseFlagWithOptionalValue(args, "--write-to-env");
  const writeToEnvPath =
    typeof writeToEnvRaw === "string"
      ? writeToEnvRaw
      : writeToEnvRaw === true
        ? ".env"
        : undefined;
  const openBrowser = noBrowser ? undefined : (deps.openBrowser ?? defaultOpenBrowser);

  if (syncOnly) {
    const credential = readOAuthCredential(provider);
    if (!credential) {
      error.error(
        `[nolo] No local ${provider} credential. Run: nolo auth ${provider}`
      );
      return 1;
    }
    await syncCredentialToServer(provider, credential, deps);
    return 0;
  }

  const flowDeps: OAuthFlowDeps = {
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    openBrowser,
    output,
    error,
  };

  // Extract cloudflare-specific flags from the raw args and pass them into the
  // flow via the deps object. We do not remove them from args here because the
  // auth command does not need to forward them elsewhere.
  const clientIdFlag = args.find((arg, index) => arg === "--client-id" && index + 1 < args.length)
    ? args[args.indexOf("--client-id") + 1]
    : undefined;
  const scopeFlag = args.find((arg, index) => arg === "--scope" && index + 1 < args.length)
    ? args[args.indexOf("--scope") + 1]
    : undefined;
  const zoneNameFlag = args.find((arg, index) => arg === "--zone-name" && index + 1 < args.length)
    ? args[args.indexOf("--zone-name") + 1]
    : undefined;
  const tokenNameFlag = args.find((arg, index) => arg === "--token-name" && index + 1 < args.length)
    ? args[args.indexOf("--token-name") + 1]
    : undefined;

  try {
    let credential;
    if (provider === "chatgpt") {
      credential = useBrowser
        ? await runOpenAiCodexBrowserPkce(flowDeps)
        : await runOpenAiCodexDeviceCode(flowDeps);
    } else if (provider === "xai") {
      credential = await runXaiOAuthLogin(flowDeps);
    } else if (provider === "cloudflare") {
      credential = await runCloudflareOAuthLogin({
        ...flowDeps,
        ...(clientIdFlag ? { clientId: clientIdFlag } : {}),
        ...(scopeFlag ? { scope: scopeFlag } : {}),
      });

      if (generateToken) {
        const zoneName = zoneNameFlag ?? process.env.CLOUDFLARE_ZONE_NAME ?? "nolo.chat";
        const tokenName = tokenNameFlag ?? `nolo-email-routing-${zoneName}`;
        const { token, zoneId } = await generateCloudflareEmailRoutingToken({
          accessToken: credential.accessToken,
          zoneName,
          tokenName,
          fetchImpl: deps.fetchImpl ?? fetch,
        });
        output.log(
          `[nolo] Generated Cloudflare API token for zone ${zoneName} (${zoneId}).\nStore it as CLOUDFLARE_EMAIL_ROUTING_API_TOKEN:\n  ${token}\n`
        );

        if (writeToEnvPath) {
          upsertEnvVariable(
            writeToEnvPath,
            "CLOUDFLARE_EMAIL_ROUTING_API_TOKEN",
            token
          );
          output.log(
            `[nolo] Updated ${writeToEnvPath} with CLOUDFLARE_EMAIL_ROUTING_API_TOKEN.`
          );
        }
      }
    } else {
      credential = await runAntigravityOAuthLogin(flowDeps);
    }
    createOAuthTokenStore().write(provider, credential);
    const accountLabel =
      (credential.metadata?.email as string | undefined) ??
      credential.accountId ??
      "";
    output.log(
      `[nolo] ${provider} authorization saved` +
        (accountLabel ? ` for ${accountLabel}` : "") +
        `.`
    );

    if (syncToServer) {
      await syncCredentialToServer(provider, credential, deps);
    }

    return 0;
  } catch (err) {
    error.error(
      `nolo auth ${provider} failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return 1;
  }
 }

export async function runAuthChatgptCommand(
  args: string[],
  ctx?: CliRuntimeContext,
  deps?: AuthProviderCommandDeps
): Promise<number> {
  return runAuthProviderCommand("chatgpt", args, ctx, deps);
}

export async function runAuthXaiCommand(
  args: string[],
  ctx?: CliRuntimeContext,
  deps?: AuthProviderCommandDeps
): Promise<number> {
  return runAuthProviderCommand("xai", args, ctx, deps);
}

export async function runAuthAntigravityCommand(
  args: string[],
  ctx?: CliRuntimeContext,
  deps?: AuthProviderCommandDeps
): Promise<number> {
  return runAuthProviderCommand("antigravity", args, ctx, deps);
}

export async function runAuthCloudflareCommand(
  args: string[],
  ctx?: CliRuntimeContext,
  deps?: AuthProviderCommandDeps
): Promise<number> {
  return runAuthProviderCommand("cloudflare", args, ctx, deps);
}
