import { runAntigravityOAuthLogin } from "./flows/antigravity";
import { runXaiOAuthLogin } from "./flows/xai";

import type { CliRuntimeContext } from "../cliCommandTypes";
import { defaultOpenBrowser } from "../authCommands";
import type { OAuthFlowDeps, OAuthProvider } from "./types";
import type { OAuthCredential } from "../../agent-runtime/oauthTokenStore";
import { createOAuthTokenStore } from "./token-store";
import {
  runOpenAiCodexBrowserPkce,
  runOpenAiCodexDeviceCode,
} from "./flows/openai-codex";
import {
  loadProfileConfig,
  buildEnvFromProfile,
} from "../client/profileConfig";

export type AuthProviderCommandDeps = OAuthFlowDeps & {
  noBrowserByDefault?: boolean;
};

const SYNC_HELP_LINE = `  --sync-to-server  After local save, push the credential to your nolo server.`;

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

const HELP_BY_PROVIDER: Record<OAuthProvider, string> = {
  chatgpt: CHATGPT_HELP_TEXT,
  xai: XAI_HELP_TEXT,
  antigravity: ANTIGRAVITY_HELP_TEXT,
};

function isOAuthProvider(value: string): value is OAuthProvider {
  return value === "chatgpt" || value === "xai" || value === "antigravity";
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

  // Fall back to profile config
  try {
    const config = loadProfileConfig();
    const profileEnv = buildEnvFromProfile(config) as Record<string, string | undefined>;
    const server = profileEnv.NOLO_SERVER?.trim() || "";
    const token = profileEnv.AUTH_TOKEN?.trim() || "";
    if (server && token) {
      return { serverOrigin: server.replace(/\/+$/, ""), authToken: token };
    }
  } catch {
    // Profile config not available
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
  const syncToServer = args.includes("--sync-to-server");
  const openBrowser = noBrowser ? undefined : (deps.openBrowser ?? defaultOpenBrowser);

  const flowDeps: OAuthFlowDeps = {
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    openBrowser,
    output,
    error,
  };
  try {
    let credential;
    if (provider === "chatgpt") {
      credential = useBrowser
        ? await runOpenAiCodexBrowserPkce(flowDeps)
        : await runOpenAiCodexDeviceCode(flowDeps);
    } else if (provider === "xai") {
      credential = await runXaiOAuthLogin(flowDeps);
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
