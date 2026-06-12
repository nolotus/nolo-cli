import {
  withCliEntrypointEnv,
  withCliEnv,
  withCliEnvAndScriptDir,
} from "./cliCommandAdapters";
import { withDaemonShortcutArgs } from "./cliCommandDispatch";
import {
  createInternalCommand,
  type CliRuntimeContext,
  type CliCommandHandler,
  type CommandEntry,
} from "./cliCommandTypes";

export function createEnvCommand<TDeps extends { env: NodeJS.ProcessEnv }>(
  path: string[],
  description: string,
  command: (args: string[], deps: TDeps) => Promise<number>
): CommandEntry {
  return createInternalCommand(path, description, withCliEnv(command) as CliCommandHandler);
}

export function createEnvScriptDirCommand<TDeps extends { env: NodeJS.ProcessEnv; scriptDir: string }>(
  path: string[],
  description: string,
  command: (args: string[], deps: TDeps) => Promise<number>
): CommandEntry {
  return createInternalCommand(path, description, withCliEnvAndScriptDir(command) as CliCommandHandler);
}

export function createEntrypointEnvCommand<TDeps extends { env: NodeJS.ProcessEnv; cliEntrypointPath: string }>(
  path: string[],
  description: string,
  command: (args: string[], deps: TDeps) => Promise<number>
): CommandEntry {
  return createInternalCommand(path, description, withCliEntrypointEnv(command) as CliCommandHandler);
}

export function createArgsCommand(
  path: string[],
  description: string,
  command: (args: string[]) => Promise<number>
): CommandEntry {
  return createInternalCommand(path, description, (args) => command(args));
}

export function createContextCommand(
  path: string[],
  description: string,
  command: (args: string[], ctx: CliRuntimeContext) => Promise<number>
): CommandEntry {
  return createInternalCommand(path, description, command as CliCommandHandler);
}

export function createDaemonShortcutCommand<TDeps extends { env: NodeJS.ProcessEnv; cliEntrypointPath: string }>(
  path: string[],
  description: string,
  command: (args: string[], deps: TDeps) => Promise<number>
): CommandEntry {
  return createInternalCommand(path, description, (args, ctx) => {
    const normalized = withDaemonShortcutArgs(args, ctx.env);
    return command(["--ws"], {
      env: normalized.envOverride ?? ctx.env,
      cliEntrypointPath: ctx.entrypointPath,
    } as TDeps);
  });
}
