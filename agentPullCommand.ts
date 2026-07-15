import { toErrorMessage } from "./core/errorMessage";
import { getDefaultCliLocalRuntimeDb } from "./localRuntimeDb";
import type { CliLocalRuntimeDb } from "./client/localRuntimeAdapter";
import { resolveCliAgentKeyInput } from "./agentAliases";
import { resolveAuthToken, resolveServerUrl } from "./cliEnvHelpers";
import type { CliFetchImpl } from "./cliFetch";

type EnvLike = Record<string, string | undefined>;

type OutputLike = {
  write(chunk: string): unknown;
};

type AgentPullCommandDeps = {
  env?: EnvLike;
  output?: OutputLike;
  db?: CliLocalRuntimeDb;
  fetchImpl?: CliFetchImpl;
};

export type ParsedAgentPullArgs = {
  agentKey: string;
};

function readFlagValue(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function positionalArgs(args: string[]) {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--")) {
      index += 1;
      continue;
    }
    values.push(arg);
  }
  return values;
}

export function parseAgentPullArgs(args: string[]): ParsedAgentPullArgs | null {
  const agentKey = readFlagValue(args, "--agent") ?? positionalArgs(args)[0];
  if (!agentKey?.trim()) return null;
  return { agentKey: resolveCliAgentKeyInput(agentKey) };
}

function extractToolNames(record: any) {
  if (Array.isArray(record?.toolNames)) return record.toolNames.filter((tool: unknown) => typeof tool === "string");
  if (!Array.isArray(record?.tools)) return [];
  return record.tools
    .map((tool: any) => typeof tool === "string" ? tool : tool?.name || tool?.function?.name)
    .filter((tool: unknown): tool is string => typeof tool === "string" && tool.length > 0);
}

function normalizeAgentRecord(agentKey: string, record: any) {
  return {
    ...record,
    dbKey: record?.dbKey || record?.key || agentKey,
    key: record?.key || record?.dbKey || agentKey,
    ...(typeof record?.provider === "string"
      ? { provider: record.provider }
      : typeof record?.apiSource === "string"
        ? { provider: record.apiSource }
        : {}),
    toolNames: extractToolNames(record),
    cachedBy: "nolo-cli",
    cachedAt: new Date().toISOString(),
  };
}

async function readRemoteAgent(args: {
  agentKey: string;
  serverUrl: string;
  authToken: string;
  fetchImpl: CliFetchImpl;
}) {
  const res = await args.fetchImpl(
    `${args.serverUrl}/api/v1/db/read/${encodeURIComponent(args.agentKey)}`,
    {
      headers: {
        ...(args.authToken ? { Authorization: `Bearer ${args.authToken}` } : {}),
      },
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${JSON.stringify(data)}`);
  }
  return data?.data ?? data;
}

function writeUsage(output: OutputLike) {
  output.write(
    "Usage: nolo agent pull <agent>\n" +
      "       nolo agent pull --agent <agent>\n"
  );
}

export async function runAgentPullCommand(args: string[], deps: AgentPullCommandDeps = {}) {
  const output = deps.output ?? process.stdout;
  const env = deps.env ?? process.env;
  const parsed = parseAgentPullArgs(args);
  if (!parsed) {
    writeUsage(output);
    return 1;
  }

  const serverUrl = resolveServerUrl(args, env);
  const authToken =
    readFlagValue(args, "--token") ||
    readFlagValue(args, "--machine-key") ||
    resolveAuthToken(env, ["BENCHMARK_AUTH_TOKEN"]);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const db = deps.db ?? await getDefaultCliLocalRuntimeDb();

  let record: any;
  try {
    record = await readRemoteAgent({
      agentKey: parsed.agentKey,
      serverUrl,
      authToken,
      fetchImpl,
    });
  } catch (error) {
    output.write(
      `[nolo] Failed to pull ${parsed.agentKey} from ${serverUrl}: ${toErrorMessage(error)}\n`
    );
    return 1;
  }

  if (!record || typeof record !== "object") {
    output.write(`[nolo] Server returned an empty agent record for ${parsed.agentKey}.\n`);
    return 1;
  }

  const localRecord = normalizeAgentRecord(parsed.agentKey, record);
  await db.put(parsed.agentKey, localRecord);
  output.write(`[nolo] cached ${parsed.agentKey} in local LevelDB\n`);
  return 0;
}
