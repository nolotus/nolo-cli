import {
  hasFlag,
  hasHelpArg,
  readOption,
  cliApiRequest,
  printCliError,
  resolveCliContext,
  outputResult,
  formatFields,
  type AppCommandDeps,
} from "./appCommandShared";

function printAppDeployStatusUsage() {
  process.stdout.write(`Usage:
  nolo app deploy status --job-id <id> [--watch]

Options:
  --job-id <id>        Deploy job id (required)
  --watch              Poll until status is done or failed
  --interval-ms <ms>  Poll interval (default 2000)
  --json               Print machine-readable JSON
  --server <url>       Server to query
  --token <jwt>        Auth token. Required for reads.
`);
}

/**
 * 查询一次部署状态。纯 IO 封装，可被 --watch 或其他命令复用。
 */
export async function fetchDeployStatus(
  serverUrl: string,
  authToken: string,
  jobId: string,
): Promise<Record<string, unknown>> {
  return cliApiRequest({
    serverUrl,
    authToken,
    path: "/api/app/deploy/status",
    body: { jobId },
  });
}

export async function runAppDeployStatusCommand(args: string[], deps: AppCommandDeps): Promise<number> {
  if (hasHelpArg(args)) {
    printAppDeployStatusUsage();
    return 0;
  }

  const jobId = readOption(args, "--job-id");
  if (!jobId) {
    printAppDeployStatusUsage();
    process.stderr.write("\n错误: 必须提供 --job-id\n");
    return 1;
  }

  const shouldWatch = hasFlag(args, "--watch");
  const shouldOutputJson = hasFlag(args, "--json");
  const intervalMs = (() => {
    const raw = readOption(args, "--interval-ms");
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 2000;
  })();

  try {
    const { serverUrl, authToken } = resolveCliContext(args, deps.env);
    let data = await fetchDeployStatus(serverUrl, authToken, jobId);

    if (shouldWatch) {
      while (data.status !== "done" && data.status !== "failed") {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        data = await fetchDeployStatus(serverUrl, authToken, jobId);
      }
    }

    outputResult(data, shouldOutputJson, () => {
      process.stdout.write("部署状态\n\n");
      const fields: Array<[string, unknown]> = [
        ["jobId", data.jobId ?? jobId],
        ["status", data.status],
      ];
      if (data.summary) fields.push(["summary", data.summary]);
      if (data.url) fields.push(["url", data.url]);
      if (data.error) {
        const err = data.error as Record<string, unknown>;
        fields.push(["error", err.message ?? String(data.error)]);
      }
      process.stdout.write(formatFields(fields, "  "));
      if (Array.isArray(data.steps)) {
        process.stdout.write("\n  steps:\n");
        for (const step of data.steps as Array<Record<string, unknown>>) {
          process.stdout.write(`    - ${step.name ?? "?"}: ${step.status ?? "?"}\n`);
        }
      } else {
        process.stdout.write("\n");
      }
    });
    return data.status === "failed" ? 1 : 0;
  } catch (error) {
    printCliError(error);
    return 1;
  }
}