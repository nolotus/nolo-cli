import { readFileSync } from "node:fs";
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

function printAppDeployUsage() {
  process.stdout.write(`Usage:
  nolo app deploy --name <name> [--code <text> | --code-file <path> | --files <json>]

Options:
  --name <name>           App name (required for new apps)
  --app-id <id>           Update an existing app by id
  --code <text>           Single-file worker source code
  --code-file <path>     Read single-file source from a file
  --files <json>          JSON array of {name, code} for multi-file apps
  --framework <type>      worker | react-spa | nolo-react
  --space-id <id>         Attach app to a space
  --deploy-target <t>     Deploy target hint
  --json                  Print machine-readable JSON
  --server <url>          Server to deploy to
  --token <jwt>           Auth token. Required for writes.
`);
}

/**
 * 解析 deploy 专用参数，返回构造好的 body 或 error。
 * 纯函数，不含 IO，可被其他命令（如 app deploy --wait）复用。
 */
export function parseDeployArgs(args: string[]): {
  body: Record<string, unknown>;
  error?: string;
} {
  const name = readOption(args, "--name");
  const appId = readOption(args, "--app-id");
  const codeFlag = readOption(args, "--code");
  const codeFile = readOption(args, "--code-file");
  const filesFlag = readOption(args, "--files");
  const framework = readOption(args, "--framework");
  const spaceId = readOption(args, "--space-id");
  const deployTarget = readOption(args, "--deploy-target");

  if (!name && !appId) {
    return { body: {}, error: "必须提供 --name 或 --app-id" };
  }

  let code: string | undefined;
  if (codeFlag) code = codeFlag;
  if (codeFile) {
    try {
      code = readFileSync(codeFile, "utf-8");
    } catch (error) {
      return { body: {}, error: `无法读取 --code-file: ${(error as Error).message}` };
    }
  }

  let files: Array<{ name: string; code: string }> | undefined;
  if (filesFlag) {
    try {
      const parsed = JSON.parse(filesFlag);
      if (!Array.isArray(parsed)) {
        return { body: {}, error: "--files 必须是 JSON 数组" };
      }
      files = parsed.map((f: Record<string, unknown>) => ({
        name: String(f.name ?? ""),
        code: String(f.code ?? ""),
      }));
    } catch (error) {
      return { body: {}, error: `--files 解析失败: ${(error as Error).message}` };
    }
  }

  if (!code && !files && !appId) {
    return { body: {}, error: "必须提供 --code / --code-file / --files 之一" };
  }

  const body = pickDefined({ name, appId, code, files, framework, spaceId, deployTarget });
  return { body };
}

export async function runAppDeployCommand(args: string[], deps: AppCommandDeps): Promise<number> {
  if (hasHelpArg(args)) {
    printAppDeployUsage();
    return 0;
  }

  const { body, error } = parseDeployArgs(args);
  if (error) {
    printAppDeployUsage();
    process.stderr.write(`\n错误: ${error}\n`);
    return 1;
  }

  try {
    const { serverUrl, authToken } = resolveCliContext(args, deps.env);
    const data = await cliApiRequest({ serverUrl, authToken, path: "/api/app/deploy", body });

    outputResult(data, hasFlag(args, "--json"), () => {
      process.stdout.write("部署成功\n");
      const fields: Array<[string, unknown]> = [];
      if (data.jobId) fields.push(["jobId", data.jobId]);
      if (data.url) fields.push(["url", data.url]);
      if (data.appId) fields.push(["appId", data.appId]);
      if (data.status) fields.push(["status", data.status]);
      if (fields.length > 0) {
        process.stdout.write(formatFields(fields, "  "));
        process.stdout.write("\n");
      }
    });
    return 0;
  } catch (error) {
    printCliError(error);
    return 1;
  }
}