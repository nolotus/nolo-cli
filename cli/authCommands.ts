import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { spawn } from "node:child_process";

import {
  buildCliRuntimeEnv,
  clearProfileAuthToken,
  getCurrentProfile,
  getDefaultProfileConfigPath,
  loadProfileConfig,
  saveDefaultProfile,
} from "./client/profileConfig";
import { resolveAuthTokenFromEnv } from "./cliEnvHelpers";
import { DEFAULT_NOLO_SERVER_URL } from "./defaultServer";

export const LOGIN_HELP_TEXT = `Log in to Nolo and save a local profile.

Usage:
  nolo login [--server <url>] [--no-browser] [--token <jwt>] [--manual]

Options:
  --server <url>   Nolo server URL (default: ${DEFAULT_NOLO_SERVER_URL})
  --no-browser     Print the authorization URL instead of opening a browser
  --token <jwt>    Save a token directly without browser authorization
  --manual         Prompt to paste a token interactively

By default, opens the Nolo website and polls until authorization completes.
In SSH sessions, use --no-browser and open the printed URL on a machine with a browser
where you are already logged into Nolo.
`;

export const LOGOUT_HELP_TEXT = `Log out of Nolo by clearing the saved auth token.

Usage:
  nolo logout

Keeps other profile settings such as server URL and default agent preferences.
Does not unset AUTH_TOKEN or other auth-related environment variables.
`;

export const WHOAMI_HELP_TEXT = `Show the current login state.

Usage:
  nolo whoami
`;

function wantsHelp(args: string[]) {
  return args.includes("--help") || args.includes("-h");
}

function formatDuration(ms: number) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatTokenPreview(token: string) {
  const trimmed = token.trim();
  if (!trimmed) return "";
  return `${trimmed.slice(0, 8)}...`;
}

function getArg(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

type LoginCommandDeps = {
  configPath?: string;
  fetchImpl?: typeof fetch;
  openBrowser?: (url: string) => Promise<boolean> | boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  question?: (prompt: string) => Promise<string>;
  output?: Pick<Console, "log">;
  error?: Pick<Console, "error">;
};

const postJson = async (
  fetchImpl: typeof fetch,
  url: string,
  body: Record<string, unknown>
) =>
  fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const defaultOpenBrowser = async (url: string) => {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args =
    process.platform === "win32" ? ["/c", "start", "", url] : [url];

  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
};

async function saveTokenLogin(args: {
  configPath: string;
  serverUrl: string;
  authToken: string;
  output: Pick<Console, "log">;
  error: Pick<Console, "error">;
}) {
  if (!args.authToken.trim()) {
    args.error.error("No auth token provided.");
    return 1;
  }

  saveDefaultProfile(args.configPath, {
    serverUrl: args.serverUrl,
    authToken: args.authToken.trim(),
  });
  args.output.log(`Saved profile default -> ${args.serverUrl}`);
  return 0;
}

async function runWebLogin(args: {
  configPath: string;
  serverUrl: string;
  fetchImpl: typeof fetch;
  openBrowser: (url: string) => Promise<boolean> | boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  output: Pick<Console, "log">;
  error: Pick<Console, "error">;
  noBrowser: boolean;
}) {
  const startResponse = await postJson(
    args.fetchImpl,
    `${args.serverUrl}/api/v1/users/cli-login/start`,
    { clientName: "nolo-cli" }
  );
  const start = await startResponse.json().catch(() => ({} as any));
  if (!startResponse.ok || !start?.deviceCode || !start?.verificationUriComplete) {
    args.error.error(
      `Failed to start web login (${startResponse.status}). Use --token to paste a token manually.`
    );
    return 1;
  }

  args.output.log("Open this URL to authorize nolo-cli:");
  args.output.log(start.verificationUriComplete);
  args.output.log(`Code: ${start.userCode}`);

  if (!args.noBrowser) {
    const opened = await args.openBrowser(start.verificationUriComplete);
    if (!opened) {
      args.output.log("Could not open a browser automatically. Paste the URL above.");
    }
  }

  const intervalMs = Math.max(1, Number(start.interval) || 2) * 1000;
  const timeoutMs = Math.max(1, Number(start.expiresIn) || 600) * 1000;
  const deadline = args.now() + timeoutMs;
  const statusLogIntervalMs = 15_000;
  let lastStatusLogAt = 0;

  args.output.log(
    `[nolo] Waiting for browser authorization (${formatDuration(timeoutMs)} remaining)...`
  );

  while (args.now() <= deadline) {
    const pollResponse = await postJson(
      args.fetchImpl,
      `${args.serverUrl}/api/v1/users/cli-login/poll`,
      { deviceCode: start.deviceCode }
    );
    const poll = await pollResponse.json().catch(() => ({} as any));

    if (pollResponse.status === 202) {
      const currentTime = args.now();
      if (
        lastStatusLogAt > 0 &&
        currentTime - lastStatusLogAt >= statusLogIntervalMs
      ) {
        const remainingMs = Math.max(0, deadline - currentTime);
        args.output.log(
          `[nolo] Still waiting... (${formatDuration(remainingMs)} remaining)`
        );
        lastStatusLogAt = currentTime;
      } else if (lastStatusLogAt === 0) {
        lastStatusLogAt = currentTime;
      }
      await args.sleep(intervalMs);
      continue;
    }

    if (pollResponse.ok && poll?.token) {
      const approvedServer =
        typeof poll.serverUrl === "string" && poll.serverUrl.trim()
          ? poll.serverUrl.trim().replace(/\/+$/, "")
          : args.serverUrl;
      return saveTokenLogin({
        configPath: args.configPath,
        serverUrl: approvedServer,
        authToken: poll.token,
        output: args.output,
        error: args.error,
      });
    }

    args.error.error(
      `Web login failed: ${poll?.error || `HTTP ${pollResponse.status}`}. Use --token to paste a token manually.`
    );
    return 1;
  }

  args.error.error("Web login timed out. Run `nolo login` again or use --token.");
  return 1;
}

export async function runLoginCommand(args: string[], deps: LoginCommandDeps = {}) {
  const outputTarget = deps.output ?? console;
  const errorTarget = deps.error ?? console;
  if (wantsHelp(args)) {
    outputTarget.log(LOGIN_HELP_TEXT);
    return 0;
  }

  const configPath = deps.configPath ?? getDefaultProfileConfigPath();
  const serverArg = getArg(args, "--server");
  const tokenArg = getArg(args, "--token");
  const noBrowser = args.includes("--no-browser");
  const serverUrl = (serverArg || DEFAULT_NOLO_SERVER_URL).replace(/\/+$/, "");

  if (tokenArg) {
    return saveTokenLogin({
      configPath,
      serverUrl,
      authToken: tokenArg,
      output: outputTarget,
      error: errorTarget,
    });
  }

  if (args.includes("--manual")) {
    const rl = createInterface({ input, output });
    const question = deps.question ?? ((prompt: string) => rl.question(prompt));
    try {
      const authToken = await question("paste auth token: ");
      return saveTokenLogin({
        configPath,
        serverUrl,
        authToken,
        output: outputTarget,
        error: errorTarget,
      });
    } finally {
      rl.close();
    }
  }

  return runWebLogin({
    configPath,
    serverUrl,
    fetchImpl: deps.fetchImpl ?? fetch,
    openBrowser: deps.openBrowser ?? defaultOpenBrowser,
    sleep: deps.sleep ?? defaultSleep,
    now: deps.now ?? Date.now,
    output: outputTarget,
    error: errorTarget,
    noBrowser,
  });
}

export function runWhoamiCommand(
  deps: {
    configPath?: string;
    env?: NodeJS.ProcessEnv;
    output?: Pick<Console, "log">;
    args?: string[];
  } = {}
) {
  const output = deps.output ?? console;
  if (wantsHelp(deps.args ?? [])) {
    output.log(WHOAMI_HELP_TEXT);
    return 0;
  }

  const env = deps.env ?? process.env;
  const config = loadProfileConfig(deps.configPath);
  const profile = getCurrentProfile(config);
  const profileToken = profile?.authToken?.trim() ?? "";
  const envToken = resolveAuthTokenFromEnv(env);

  if (!profileToken && !envToken) {
    output.log("Not logged in. Run: nolo login");
    return 1;
  }

  const runtimeEnv = buildCliRuntimeEnv(env, config);
  const explicitServer = env.NOLO_SERVER || env.NOLO_SERVER_URL || env.BASE_URL;

  if (!profileToken && envToken) {
    output.log("profile: not logged in (no saved token)");
    if (profile?.serverUrl) {
      output.log(`profile server: ${profile.serverUrl}`);
    }
    output.log(`effective server: ${runtimeEnv.NOLO_SERVER ?? resolveServerUrlFallback(profile)}`);
    output.log(`server source: ${explicitServer ? "env" : profile?.serverUrl ? "profile" : "default"}`);
    output.log(`env token: ${formatTokenPreview(envToken)} (source: environment)`);
    return 0;
  }

  const effectiveServer = runtimeEnv.NOLO_SERVER ?? profile!.serverUrl;

  output.log(`profile: ${config!.currentProfile}`);
  output.log(`profile server: ${profile!.serverUrl}`);
  output.log(`effective server: ${effectiveServer}`);
  output.log(`server source: ${explicitServer ? "env" : "profile"}`);
  output.log(`token: ${formatTokenPreview(profileToken)} (source: profile)`);
  if (envToken && envToken !== profileToken) {
    output.log(`env token: ${formatTokenPreview(envToken)} (source: environment, unused while profile token is set)`);
  }
  return 0;
}

function resolveServerUrlFallback(profile: { serverUrl?: string } | null) {
  return profile?.serverUrl ?? DEFAULT_NOLO_SERVER_URL;
}

export function runLogoutCommand(
  deps: {
    configPath?: string;
    env?: NodeJS.ProcessEnv;
    output?: Pick<Console, "log">;
    args?: string[];
  } = {}
) {
  const output = deps.output ?? console;
  if (wantsHelp(deps.args ?? [])) {
    output.log(LOGOUT_HELP_TEXT);
    return 0;
  }

  const env = deps.env ?? process.env;
  const configPath = deps.configPath ?? getDefaultProfileConfigPath();
  if (!clearProfileAuthToken(configPath)) {
    output.log("Not logged in.");
    return 0;
  }
  output.log("Logged out.");
  if (resolveAuthTokenFromEnv(env)) {
    output.log(
      "Note: AUTH_TOKEN in the environment is unchanged and may still authenticate commands."
    );
  }
  return 0;
}
