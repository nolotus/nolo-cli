import {
  hasFlag,
  hasHelpArg,
  readOption,
  cliApiRequest,
  printCliError,
  resolveCliContext,
  pickDefined,
  outputResult,
  type AppCommandDeps,
} from "./appCommandShared";

function printAppDeleteUsage() {
  process.stdout.write(`Usage:
  nolo app delete (--name <name> | --app-id <id>)

Options:
  --name <name>    App name to delete
  --app-id <id>    App id to delete
  --yes            Skip confirmation prompt
  --json           Print machine-readable JSON
  --server <url>   Server to query
  --token <jwt>    Auth token. Required for writes.
`);
}

export async function runAppDeleteCommand(args: string[], deps: AppCommandDeps): Promise<number> {
  if (hasHelpArg(args)) {
    printAppDeleteUsage();
    return 0;
  }

  const name = readOption(args, "--name");
  const appId = readOption(args, "--app-id");
  const skipConfirm = hasFlag(args, "--yes");
  const shouldOutputJson = hasFlag(args, "--json");

  if (!name && !appId) {
    printAppDeleteUsage();
    process.stderr.write("\n错误: 必须提供 --name 或 --app-id\n");
    return 1;
  }

  if (!skipConfirm) {
    const target = name ? `name="${name}"` : `appId="${appId}"`;
    process.stdout.write(`即将删除应用 (${target})，此操作不可撤销。确认？[y/N] `);
    const answer = await new Promise<string>((resolve) => {
      let data = "";
      process.stdin.setEncoding("utf-8");
      process.stdin.once("data", (chunk) => {
        data = chunk.toString();
        resolve(data.trim().toLowerCase());
      });
    });
    if (answer !== "y" && answer !== "yes") {
      process.stdout.write("已取消\n");
      return 0;
    }
  }

  try {
    const { serverUrl, authToken } = resolveCliContext(args, deps.env);
    const body = pickDefined({ name, appId });
    const data = await cliApiRequest({ serverUrl, authToken, path: "/api/app/delete", body });

    outputResult(data, shouldOutputJson, () => {
      const target = name ? `name="${name}"` : `appId="${appId}"`;
      process.stdout.write(`已删除应用 (${target})\n`);
    });
    return 0;
  } catch (error) {
    printCliError(error);
    return 1;
  }
}