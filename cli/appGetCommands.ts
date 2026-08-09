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

function printAppGetUsage() {
  process.stdout.write(`Usage:
  nolo app get (--name <name> | --app-id <id> | --app-key <key>)

Options:
  --name <name>          App name
  --app-id <id>          App id
  --app-key <key>        Full app key
  --json                 Print machine-readable JSON
  --server <url>         Server to query
  --token <jwt>          Auth token. Required for reads.
`);
}

export async function runAppGetCommand(args: string[], deps: AppCommandDeps): Promise<number> {
  if (hasHelpArg(args)) {
    printAppGetUsage();
    return 0;
  }

  const name = readOption(args, "--name");
  const appId = readOption(args, "--app-id");
  const appKey = readOption(args, "--app-key");

  if (!name && !appId && !appKey) {
    printAppGetUsage();
    process.stderr.write("\n错误: 必须提供 --name / --app-id / --app-key 之一\n");
    return 1;
  }

  try {
    const { serverUrl, authToken } = resolveCliContext(args, deps.env);
    const body = pickDefined({ name, appId, appKey });

    const data = await cliApiRequest({ serverUrl, authToken, path: "/api/app/get", body });

    outputResult(data, hasFlag(args, "--json"), () => {
      process.stdout.write("应用详情\n\n");
      const fields: Array<[string, unknown]> = [
        ["name", data.name ?? data.userFriendlyName],
        ["appId", data.appId],
        ["appKey", data.appKey],
        ["framework", data.framework],
        ["visibility", data.visibility],
      ];
      if (data.url) fields.push(["url", data.url]);
      if (data.customUrl) fields.push(["customUrl", data.customUrl]);
      if (data.spaceId) fields.push(["spaceId", data.spaceId]);
      if (data.sourceStatus) fields.push(["source", data.sourceStatus]);
      process.stdout.write(formatFields(fields, "  "));
      process.stdout.write("\n");
    });
    return 0;
  } catch (error) {
    printCliError(error);
    return 1;
  }
}