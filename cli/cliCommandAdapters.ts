import type { CliCommandHandler, CliRuntimeContext } from "./cliCommandTypes";

export function withCliEnv<TDeps extends { env: NodeJS.ProcessEnv }>(
  command: (args: string[], deps: TDeps) => Promise<number>
): CliCommandHandler {
  return (args: string[], ctx: CliRuntimeContext) =>
    command(args, { env: ctx.env } as TDeps);
}

export function withCliEnvAndScriptDir<TDeps extends { env: NodeJS.ProcessEnv; scriptDir: string }>(
  command: (args: string[], deps: TDeps) => Promise<number>
): CliCommandHandler {
  return (args: string[], ctx: CliRuntimeContext) =>
    command(args, {
      env: ctx.env,
      scriptDir: ctx.scriptDir,
    } as TDeps);
}

export function withCliEntrypointEnv<TDeps extends { env: NodeJS.ProcessEnv; cliEntrypointPath: string }>(
  command: (args: string[], deps: TDeps) => Promise<number>
): CliCommandHandler {
  return (args: string[], ctx: CliRuntimeContext) =>
    command(args, {
      env: ctx.env,
      cliEntrypointPath: ctx.entrypointPath,
    } as TDeps);
}
