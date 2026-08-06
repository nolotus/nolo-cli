import {
  hasFlag,
  hasHelpArg,
  readOption,
  cliApiRequest,
  printCliError,
  resolveCliContext,
  pickDefined,
  outputResult,
  formatFields,
  type AppCommandDeps,
} from "./appCommandShared";

function printAppListUsage() {
  process.stdout.write(`Usage:
  nolo app list [--scope owned|accessible] [--space-id <id>]

Options:
  --scope <type>          owned (default) or accessible
  --space-id <id>         List apps under a space
  --json                  Print machine-readable JSON
  --server <url>          Server to query
  --token <jwt>           Auth token. Required for reads.
`);
}

export async function runAppListCommand(args: string[], deps: AppCommandDeps): Promise<number> {
  if (hasHelpArg(args)) {
    printAppListUsage();
    return 0;
  }

  try {
    const { serverUrl, authToken } = resolveCliContext(args, deps.env);
    const body = pickDefined({
      scope: readOption(args, "--scope"),
      spaceId: readOption(args, "--space-id"),
    });

    const data = await cliApiRequest({ serverUrl, authToken, path: "/api/app/list", body });
    const workers = (data.workers as Array<Record<string, unknown>>) ?? [];

    outputResult(data, hasFlag(args, "--json"), () => {
      if (workers.length === 0) {
        process.stdout.write("没有应用\n");
        return;
      }
      process.stdout.write(`应用列表 (${workers.length})\n\n`);
      for (const app of workers) {
        process.stdout.write(`  ${app.userFriendlyName ?? "(unnamed)"}\n`);
        const fields: Array<[string, unknown]> = [
          ["appId", app.appId],
          ["appKey", app.appKey],
          ["url", app.url],
          ["framework", app.framework],
          ["visibility", app.visibility],
        ];
        if (app.customUrl) fields.push(["customUrl", app.customUrl]);
        if (app.modifiedOn) fields.push(["modified", app.modifiedOn]);
        process.stdout.write(formatFields(fields, "    "));
        process.stdout.write("\n\n");
      }
    });
    return 0;
  } catch (error) {
    printCliError(error);
    return 1;
  }
}