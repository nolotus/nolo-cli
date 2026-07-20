import { toErrorMessage } from "../core/errorMessage";
import { asOptionalTrimmedString } from "../core/optionalString";
import { normalizeServerOrigin } from "../core/serverOrigin";
import { DEFAULT_NOLO_SERVER_URL } from "./defaultServer";
import type { CliFetchImpl } from "./cliFetch";

type EnvLike = Record<string, string | undefined>;

type OutputLike = {
  write(chunk: string): unknown;
};

type SetupOfflineMarxistsAgentDeps = {
  env?: EnvLike;
  output?: OutputLike;
  fetchImpl?: CliFetchImpl;
  now?: () => number;
};

type ParsedArgs = {
  serverUrl: string;
  authToken: string;
  userId: string;
  sourceAgentKey: string;
  targetAgentId: string;
  targetAgentKey: string;
  spaceId: string;
  name: string;
  publicAgent: boolean;
  json: boolean;
};

const DEFAULT_USER_ID = "0e95801d90";
const DEFAULT_SPACE_ID = "01KKY77TT0DA9NY7TNW3R7255N";
const DEFAULT_SOURCE_AGENT_HANDLE = "fullstack";
const DEFAULT_TARGET_AGENT_ID = "01OFFMARXBOOK000000010AHL1";
const DEFAULT_AGENT_NAME = "离线马克思主义文库书籍转换助手";
const TOOL_NAME = "convertMarxistsBookToOfflineHtml";
const AGENT_TOOLS = [TOOL_NAME];

function readFlagValue(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseUserIdFromToken(token: string) {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const parsed = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    return asOptionalTrimmedString(parsed?.userId);
  } catch {
    return undefined;
  }
}

function parseArgs(args: string[], env: EnvLike): ParsedArgs | null {
  if (args.includes("--help") || args.includes("-h")) return null;
  const serverUrl = normalizeServerOrigin(
    readFlagValue(args, "--server") ??
      readFlagValue(args, "--server-url") ??
      env.NOLO_SERVER ??
      env.BASE_URL ??
      DEFAULT_NOLO_SERVER_URL
  );
  const authToken = readFlagValue(args, "--token") ?? env.AUTH_TOKEN ?? env.NOLO_AUTH_TOKEN ?? "";
  const userId =
    readFlagValue(args, "--user-id") ??
    env.NOLO_USER_ID ??
    parseUserIdFromToken(authToken) ??
    DEFAULT_USER_ID;
  const sourceAgentKey =
    readFlagValue(args, "--source-agent") ??
    env.NOLO_FULLSTACK_SOURCE_AGENT_KEY ??
    DEFAULT_SOURCE_AGENT_HANDLE;
  const targetAgentId =
    readFlagValue(args, "--target-agent-id") ??
    env.NOLO_OFFLINE_MARXISTS_AGENT_ID ??
    DEFAULT_TARGET_AGENT_ID;
  const targetAgentKey =
    readFlagValue(args, "--target-agent") ??
    env.NOLO_OFFLINE_MARXISTS_AGENT_KEY ??
    `agent-${userId}-${targetAgentId}`;
  const spaceId =
    readFlagValue(args, "--space") ??
    env.NOLO_OFFLINE_MARXISTS_SPACE_ID ??
    DEFAULT_SPACE_ID;

  if (!authToken.trim()) return null;
  return {
    serverUrl,
    authToken,
    userId,
    sourceAgentKey,
    targetAgentId,
    targetAgentKey,
    spaceId,
    name: readFlagValue(args, "--name") ?? DEFAULT_AGENT_NAME,
    publicAgent: args.includes("--public"),
    json: args.includes("--json"),
  };
}

async function readDbRecord(args: {
  fetchImpl: CliFetchImpl;
  serverUrl: string;
  authToken: string;
  dbKey: string;
}) {
  const res = await args.fetchImpl(
    `${args.serverUrl}/api/v1/db/read/${encodeURIComponent(args.dbKey)}`,
    { headers: { Authorization: `Bearer ${args.authToken}` } }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`read ${args.dbKey} failed (${res.status}): ${JSON.stringify(data)}`);
  }
  return (data as any)?.data ?? data;
}

async function writeDbRecord(args: {
  fetchImpl: CliFetchImpl;
  serverUrl: string;
  authToken: string;
  userId: string;
  dbKey: string;
  data: Record<string, any>;
}) {
  const res = await args.fetchImpl(`${args.serverUrl}/api/v1/db/write/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.authToken}`,
    },
    body: JSON.stringify({
      customKey: args.dbKey,
      userId: args.userId,
      data: { ...args.data, dbKey: args.dbKey },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`write ${args.dbKey} failed (${res.status}): ${JSON.stringify(data)}`);
  }
}

function buildTargetAgent(args: {
  parsed: ParsedArgs;
  source: Record<string, any>;
  now: number;
}) {
  const { parsed, source, now } = args;
  if (!source.apiKey) {
    throw new Error(`source agent ${parsed.sourceAgentKey} has no apiKey`);
  }
  if (!source.customProviderUrl) {
    throw new Error(`source agent ${parsed.sourceAgentKey} has no customProviderUrl`);
  }
  return {
    id: parsed.targetAgentId,
    type: "agent",
    name: parsed.name,
    description:
      "把 Marxists.org 中文旧式书籍页面转换为可离线打开的单文件 HTML，保留原 CSS、表格排版和背景纹理。",
    prompt:
      "你是离线书籍转换助手。用户给出 Marxists.org 中文书籍页面或要求保存离线书籍时，只能调用 convertMarxistsBookToOfflineHtml，不要使用普通网页抓取流程。最终回答必须逐字给出 rawData.fileUrl、rawData.pageCount、rawData.hasNetworkUrls、rawData.byteLength。",
    isPublic: parsed.publicAgent,
    model: source.model ?? "mimo-v2.5-pro",
    provider: source.provider ?? "custom",
    apiSource: source.apiSource ?? "custom",
    apiKey: source.apiKey,
    customProviderUrl: source.customProviderUrl,
    apiKeyHeader: source.apiKeyHeader ?? "api-key",
    tools: AGENT_TOOLS,
    temperature: source.temperature ?? 0.2,
    maxTokens: source.maxTokens ?? 4096,
    category: "document-tools",
    tags: ["offline-book", "marxists", "mimo"],
    userId: parsed.userId,
    createdAt: source.createdAt ?? now,
    updatedAt: now,
  };
}

async function attachAgentToSpace(args: {
  fetchImpl: CliFetchImpl;
  parsed: ParsedArgs;
  contentKey: string;
  title: string;
  now: number;
}) {
  const spaceKey = `space-${args.parsed.spaceId}`;
  const space = await readDbRecord({
    fetchImpl: args.fetchImpl,
    serverUrl: args.parsed.serverUrl,
    authToken: args.parsed.authToken,
    dbKey: spaceKey,
  });
  await writeDbRecord({
    fetchImpl: args.fetchImpl,
    serverUrl: args.parsed.serverUrl,
    authToken: args.parsed.authToken,
    userId: args.parsed.userId,
    dbKey: spaceKey,
    data: {
      ...space,
      contents: {
        ...(space.contents ?? {}),
        [args.contentKey]: {
          ...(space.contents?.[args.contentKey] ?? {}),
          title: args.title,
          type: "agent",
          contentKey: args.contentKey,
          createdAt: space.contents?.[args.contentKey]?.createdAt ?? args.now,
          updatedAt: args.now,
        },
      },
      updatedAt: args.now,
    },
  });
}

function writeUsage(output: OutputLike) {
  output.write(
    "Usage: nolo agent setup-offline-marxists [--server https://nolo.chat] [--source-agent <key>] [--space <spaceId>] [--target-agent-id <id>] [--json]\n" +
      "Requires AUTH_TOKEN from `nolo login` or --token.\n"
  );
}

export async function runSetupOfflineMarxistsAgentCommand(
  args: string[],
  deps: SetupOfflineMarxistsAgentDeps = {}
) {
  const env = deps.env ?? process.env;
  const output = deps.output ?? process.stdout;
  const parsed = parseArgs(args, env);
  if (!parsed) {
    writeUsage(output);
    return 1;
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now?.() ?? Date.now();

  try {
    const source = await readDbRecord({
      fetchImpl,
      serverUrl: parsed.serverUrl,
      authToken: parsed.authToken,
      dbKey: parsed.sourceAgentKey,
    });
    const target = buildTargetAgent({ parsed, source, now });
    await writeDbRecord({
      fetchImpl,
      serverUrl: parsed.serverUrl,
      authToken: parsed.authToken,
      userId: parsed.userId,
      dbKey: parsed.targetAgentKey,
      data: target,
    });
    const publicKey = `agent-pub-${parsed.targetAgentId}`;
    if (parsed.publicAgent) {
      await writeDbRecord({
        fetchImpl,
        serverUrl: parsed.serverUrl,
        authToken: parsed.authToken,
        userId: parsed.userId,
        dbKey: publicKey,
        data: target,
      });
    }
    await attachAgentToSpace({
      fetchImpl,
      parsed,
      contentKey: parsed.publicAgent ? publicKey : parsed.targetAgentKey,
      title: parsed.name,
      now,
    });

    const result = {
      serverUrl: parsed.serverUrl,
      sourceAgentKey: parsed.sourceAgentKey,
      agentKey: parsed.targetAgentKey,
      agentUrl: `${parsed.serverUrl}/${parsed.targetAgentKey}`,
      publicKey: parsed.publicAgent ? publicKey : null,
      spaceId: parsed.spaceId,
      model: target.model,
      provider: target.provider,
      customProviderUrl: target.customProviderUrl,
      tools: target.tools,
    };
    if (parsed.json) {
      output.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      output.write(
        [
          `created/updated: ${result.agentKey}`,
          `url: ${result.agentUrl}`,
          `space: ${result.spaceId}`,
          `model: ${result.model}`,
          `tools: ${result.tools.join(", ")}`,
          "",
        ].join("\n")
      );
    }
    return 0;
  } catch (error) {
    output.write(
      `setup-offline-marxists failed: ${toErrorMessage(error)}\n`
    );
    return 1;
  }
}
