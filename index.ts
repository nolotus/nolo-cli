import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createCliRuntimeContext,
  looksLikeDaemonShortcut,
  renderHelpText,
  resolveCommand,
  runResolvedCommand,
} from "./commandRegistry";
import { buildCliRuntimeEnv, loadProfileConfig } from "./client/profileConfig";
import { isCompiledBinary } from "./cliEnvHelpers";
import { spawnProcess } from "./processSpawn";
import { resolveTuiLaunchMode } from "./runtimeModeArgs";
import { readPackageInfo } from "./updateCommands";

const SOURCE_CLI_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_DIR = isCompiledBinary() ? dirname(process.execPath) : SOURCE_CLI_DIR;
const ROOT_DIR = join(CLI_DIR, "..", "..");
const SCRIPT_DIR = join(ROOT_DIR, "scripts");
const packageInfo = readPackageInfo();

async function runScript(script: string, forwardedArgs: string[], env: NodeJS.ProcessEnv) {
  const scriptPath = join(SCRIPT_DIR, script);
  const proc = spawnProcess({
    cmd: [process.execPath, scriptPath, ...forwardedArgs],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env,
  });
  return proc.exited;
}

/** TUI pulls agentRun → localRuntimeAdapter graph; only load when launching interactive shell. */
async function launchTuiWorkspace(args: { scriptDir: string; env: NodeJS.ProcessEnv }) {
  const { startTuiWorkspace } = await import("./tui/readlineWorkspace");
  return startTuiWorkspace(args);
}

const args = process.argv.slice(2);
const runtimeEnv = {
  ...buildCliRuntimeEnv(process.env, loadProfileConfig()),
  NOLO_CLI_VERSION: packageInfo.version,
};

const runtimeContext = createCliRuntimeContext({
  env: runtimeEnv,
  scriptDir: SCRIPT_DIR,
  entrypointPath: isCompiledBinary() ? process.execPath : fileURLToPath(import.meta.url),
  packageInfo,
});

if (args.length === 0) {
  if (process.stdin.isTTY) {
    await launchTuiWorkspace({ scriptDir: SCRIPT_DIR, env: runtimeEnv });
  } else {
    console.log(renderHelpText());
  }
  process.exit(0);
}

const tuiLaunchMode = resolveTuiLaunchMode(args);
if (tuiLaunchMode.shouldStartTui) {
  await launchTuiWorkspace({
    scriptDir: SCRIPT_DIR,
    env: { ...runtimeEnv, ...tuiLaunchMode.envPatch },
  });
  process.exit(0);
}

const commandArgs = looksLikeDaemonShortcut(args) ? ["daemon", ...args] : args;
const command = resolveCommand(commandArgs);
if (!command) {
  console.error(`Unknown command: ${args.join(" ")}`);
  console.error("");
  console.log(renderHelpText());
  process.exit(1);
}

const exitCode = await runResolvedCommand(command, commandArgs, runtimeContext, {
  runScript,
});
process.exit(exitCode);
