import { fileURLToPath } from "node:url";
import type { CliPackageInfo, CliRuntimeContext, CommandEntry } from "./cliCommandTypes";

export async function runResolvedCommand(
  command: CommandEntry,
  originalArgs: string[],
  ctx: CliRuntimeContext,
  deps: {
    runScript: (script: string, forwardedArgs: string[], env: NodeJS.ProcessEnv) => Promise<number>;
  }
) {
  if (command.kind === "internal") {
    if (!command.handler) {
      throw new Error(`Internal command ${command.path.join(" ")} is missing a handler.`);
    }
    return command.handler(originalArgs.slice(command.path.length), ctx);
  }

  if (!command.script) {
    throw new Error(`Script command ${command.path.join(" ")} is missing a script.`);
  }

  const forwardedArgs = [...(command.fixedArgs ?? []), ...originalArgs.slice(command.path.length)];
  return deps.runScript(command.script, forwardedArgs, ctx.env);
}

function readOption(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function buildDaemonEnv(args: string[], runtimeEnv: NodeJS.ProcessEnv) {
  const serverUrl = readOption(args, "--server-url") || readOption(args, "--server");
  const apiKey = readOption(args, "--machine-key") || readOption(args, "--token");
  return {
    ...runtimeEnv,
    ...(serverUrl ? { NOLO_SERVER: serverUrl } : {}),
    ...(apiKey ? { AUTH_TOKEN: apiKey } : {}),
  };
}

export function looksLikeDaemonShortcut(args: string[]) {
  return args.includes("--server-url") || args.includes("--machine-key");
}

export function createCliRuntimeContext(args: {
  env: NodeJS.ProcessEnv;
  scriptDir: string;
  entrypointPath?: string;
  packageInfo: CliPackageInfo;
}): CliRuntimeContext {
  return {
    env: args.env,
    scriptDir: args.scriptDir,
    entrypointPath: args.entrypointPath ?? fileURLToPath(import.meta.url),
    packageInfo: args.packageInfo,
  };
}

export function withDaemonShortcutArgs(args: string[], runtimeEnv: NodeJS.ProcessEnv) {
  if (!looksLikeDaemonShortcut(args)) return { commandArgs: args, envOverride: null as NodeJS.ProcessEnv | null };
  return {
    commandArgs: ["daemon", ...args],
    envOverride: buildDaemonEnv(args, runtimeEnv),
  };
}
