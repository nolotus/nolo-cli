import type { readPackageInfo } from "./updateCommands";

export type CliPackageInfo = ReturnType<typeof readPackageInfo>;

export type CliRuntimeContext = {
  env: NodeJS.ProcessEnv;
  scriptDir: string;
  entrypointPath: string;
  packageInfo: CliPackageInfo;
};

export type CliCommandHandler = (args: string[], ctx: CliRuntimeContext) => Promise<number>;

export type CommandEntry = {
  path: string[];
  description: string;
  kind: "internal" | "script";
  script?: string;
  fixedArgs?: string[];
  handler?: CliCommandHandler;
};

export function createScriptCommand(
  path: string[],
  script: string,
  description: string,
  fixedArgs?: string[]
): CommandEntry {
  return {
    path,
    kind: "script",
    script,
    description,
    ...(fixedArgs ? { fixedArgs } : {}),
  };
}

export function createInternalCommand(
  path: string[],
  description: string,
  handler: CliCommandHandler
): CommandEntry {
  return {
    path,
    kind: "internal",
    description,
    handler,
  };
}
