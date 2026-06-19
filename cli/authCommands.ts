import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { rmSync } from "node:fs";
import { spawn } from "node:child_process";

import {
  buildCliRuntimeEnv,
  getCurrentProfile,
  getDefaultProfileConfigPath,
  loadProfileConfig,
  saveDefaultProfile,
} from "./client/profileConfig";
import { DEFAULT_NOLO_SERVER_URL } from "./defaultServer";

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

  while (args.now() <= deadline) {
    const pollResponse = await postJson(
      args.fetchImpl,
      `${args.serverUrl}/api/v1/users/cli-login/poll`,
      { deviceCode: start.deviceCode }
    );
    const poll = await pollResponse.json().catch(() => ({} as any));

    if (pollResponse.status === 202) {
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
  const configPath = deps.configPath ?? getDefaultProfileConfigPath();
  const serverArg = getArg(args, "--server");
  const tokenArg = getArg(args, "--token");
  const noBrowser = args.includes("--no-browser");
  const outputTarget = deps.output ?? console;
  const errorTarget = deps.error ?? console;
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

export function runWhoamiCommand(deps: { configPath?: string; env?: NodeJS.ProcessEnv; output?: Pick<Console, "log"> } = {}) {
  const env = deps.env ?? process.env;
  const output = deps.output ?? console;
  const config = loadProfileConfig(deps.configPath);
  const profile = getCurrentProfile(config);
  if (!config || !profile) {
    output.log("Not logged in. Run: nolo login");
    return 1;
  }
  const runtimeEnv = buildCliRuntimeEnv(env, config);
  const effectiveServer = runtimeEnv.NOLO_SERVER ?? profile.serverUrl;
  const explicitServer = env.NOLO_SERVER || env.NOLO_SERVER_URL || env.BASE_URL;

  output.log(`profile: ${config.currentProfile}`);
  output.log(`profile server: ${profile.serverUrl}`);
  output.log(`effective server: ${effectiveServer}`);
  output.log(`server source: ${explicitServer ? "env" : "profile"}`);
  output.log(`token: ${profile.authToken.slice(0, 8)}...`);
  return 0;
}

export function runLogoutCommand() {
  const configPath = getDefaultProfileConfigPath();
  rmSync(configPath, { force: true });
  console.log("Logged out.");
  return 0;
}
