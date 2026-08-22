import type { CliKvDb } from "./client/hybridRecordStore";
import type { CliFetchImpl } from "./cliFetch";
import {
  toSafeAgentSummary,
  type SafeAgentSummary,
  type SafeAgentSummaryOptions,
} from "../ai/agent/safeAgentSummary";
export { isAgentUnavailableNow } from "../ai/agent/agentAvailabilityShared";
import {
  listUserRecordsFromServers,
  readLiveDbRecordAfterTombstoneMerge,
} from "./globalRecordOperations";
import { agentRecordHasConfiguredCredential } from "./agentRecordHelpers";
import {
  isOwnedAgentKey,
  ownedAgentKey,
  parseOwnedAgentId,
  publicAgentKey,
  PUBLIC_AGENT_KEY_PREFIX,
} from "../core/prefix";

export type ListedAgent = {
  id: string;
  privateKey: string;
  publicKey: string;
  name: string;
  model: string;
  handle?: string;
  introduction?: string;
  provider?: string;
  inputPrice?: number;
  outputPrice?: number;
  updatedAt: string | number | null;
  isPublicFlag: boolean;
  publicRecordExists: boolean;
  type: string | null;
  tools: string[];
  credentialConfigured: boolean;
  credentialRef?: string;
  apiKeyRef?: string;
  /** 执行来源：platform=平台API  custom=自定义API  cli=订阅制 CLI 工具。 */
  apiSource?: string;
  /** apiSource=cli 时的具体 CLI（copilot/codex/claude 等订阅）。 */
  cliProvider?: string;
  /** Epoch ms when the provider is expected to become available again. */
  nextAvailableAt?: number;
};

function parseAgentRecordId(privateKey: string, explicitId?: string) {
  if (explicitId) return explicitId;
  const agentMatch = privateKey.match(/^agent-[^-]+-(.+)$/i);
  return agentMatch?.[1] ?? "";
}

function buildCompanionKeys(rawId: string, userId: string) {
  return {
    privateKey: ownedAgentKey(userId, rawId),
    publicKey: publicAgentKey(rawId),
  };
}

export function normalizeListedAgent(record: any): ListedAgent | null {
  const privateKey = typeof record?.dbKey === "string" ? record.dbKey : "";
  const explicitId = typeof record?.id === "string" && record.id ? record.id : undefined;
  const ownerUserId = typeof record?.userId === "string" ? record.userId : "";
  const rawId = explicitId
    || (ownerUserId ? parseOwnedAgentId(privateKey, ownerUserId) : null)
    || parseAgentRecordId(privateKey, explicitId);
  if (!privateKey || !rawId || !ownerUserId) return null;
  const keys = buildCompanionKeys(rawId, ownerUserId);
  const credentialConfigured = agentRecordHasConfiguredCredential(record);
  const credentialRef = typeof record?.credentialRef === "string" && record.credentialRef
    ? record.credentialRef
    : undefined;
  const apiKeyRef = typeof record?.apiKeyRef === "string" && record.apiKeyRef
    ? record.apiKeyRef
    : undefined;

  return {
    id: rawId,
    privateKey,
    publicKey: keys.publicKey,
    name: typeof record?.name === "string" && record.name ? record.name : "(unnamed)",
    model: typeof record?.model === "string" && record.model ? record.model : "-",
    ...(typeof record?.handle === "string" && record.handle ? { handle: record.handle } : {}),
    ...(typeof record?.introduction === "string" && record.introduction
      ? { introduction: record.introduction }
      : typeof record?.description === "string" && record.description
        ? { introduction: record.description }
        : {}),
    ...(typeof record?.provider === "string" && record.provider ? { provider: record.provider } : {}),
    ...(typeof record?.inputPrice === "number" && Number.isFinite(record.inputPrice)
      ? { inputPrice: record.inputPrice }
      : {}),
    ...(typeof record?.outputPrice === "number" && Number.isFinite(record.outputPrice)
      ? { outputPrice: record.outputPrice }
      : {}),
    updatedAt:
      typeof record?.updatedAt === "string" || typeof record?.updatedAt === "number"
        ? record.updatedAt
        : typeof record?.createdAt === "string" || typeof record?.createdAt === "number"
          ? record.createdAt
          : typeof record?.created === "string" || typeof record?.created === "number"
            ? record.created
            : null,
    isPublicFlag: !!record?.isPublic,
    publicRecordExists: false,
    type: typeof record?.type === "string" ? record.type : null,
    tools: Array.isArray(record?.tools)
      ? record.tools.filter((tool: unknown): tool is string => typeof tool === "string")
      : [],
    credentialConfigured,
    credentialRef,
    apiKeyRef,
    ...(typeof record?.apiSource === "string" && record.apiSource
      ? { apiSource: record.apiSource }
      : {}),
    ...(typeof record?.cliProvider === "string" && record.cliProvider
      ? { cliProvider: record.cliProvider }
      : {}),
    ...(typeof record?.nextAvailableAt === "number" && Number.isFinite(record.nextAvailableAt)
      ? { nextAvailableAt: record.nextAvailableAt }
      : {}),
  };
}

/**
 * `--safe` 输出用的 agent 摘要：在 toSafeAgentSummary 基础上，对私有 agent
 * （publicRecordExists === false）省略 publicKey 字段。
 *
 * 私有 agent 的公开记录（agent-pub-<id>）在库里并不存在，但 toSafeAgentSummary
 * 会从 id 反推出一个 agent-pub-<id> 写进 publicKey。模型读到这个字段会拿它去
 * readAgent，必然失败。省略整个字段（而非输出 null）才能让模型不去用它。
 * publicRecordExists 为 true 或未知时保持 toSafeAgentSummary 的原有行为。
 */
export function toSafeListedAgentSummary(
  agent: ListedAgent,
  options?: SafeAgentSummaryOptions
): SafeAgentSummary {
  const summary = toSafeAgentSummary(agent, options);
  if (agent.publicRecordExists === false) {
    delete (summary as { publicKey?: unknown }).publicKey;
  }
  return summary;
}

export function sortListedAgents(agents: ListedAgent[]) {
  agents.sort((a, b) => {
    const ta = a.updatedAt == null ? 0 : new Date(a.updatedAt).getTime();
    const tb = b.updatedAt == null ? 0 : new Date(b.updatedAt).getTime();
    return tb - ta;
  });
  return agents;
}

export function parseAgentListArgs(args: string[]) {
  return {
    wantJson: args.includes("--json"),
    wantSafe: args.includes("--safe"),
    publicOnly: args.includes("--public-only"),
    idsOnly: args.includes("--ids-only"),
    showUnavailable: args.includes("--show-unavailable"),
  };
}

/** 429 限流中（nextAvailableAt 在未来）的 agent 是否仍可见。 */

export async function listLocalCachedAgents(args: {
  db: CliKvDb;
  userId: string;
}) {
  const privateRecords = new Map<string, any>();
  const publicKeys = new Set<string>();
  for await (const [key, value] of args.db.iterator({ gte: "", lte: "\uffff" })) {
    if (typeof key !== "string" || !value || typeof value !== "object") continue;
    if (isOwnedAgentKey(key, args.userId)) {
      privateRecords.set(key, { ...(value as Record<string, unknown>), dbKey: key });
      continue;
    }
    if (key.startsWith(PUBLIC_AGENT_KEY_PREFIX)) {
      publicKeys.add(key);
    }
  }

  const agents = sortListedAgents(
    [...privateRecords.values()]
      .map((record) => normalizeListedAgent(record))
      .filter((agent): agent is ListedAgent => agent != null)
  );

  for (const agent of agents) {
    agent.publicRecordExists = publicKeys.has(agent.publicKey);
  }
  return agents;
}

async function hasReadableRecord(args: {
  authToken: string;
  dbKey: string;
  fallbackFetchImpl?: CliFetchImpl;
  fetchImpl: CliFetchImpl;
  serverUrl: string;
  readDbRecord: (args: {
    authToken: string;
    dbKey: string;
    fallbackFetchImpl?: CliFetchImpl;
    fetchImpl: CliFetchImpl;
    serverUrl: string;
  }) => Promise<any>;
}) {
  try {
    await args.readDbRecord(args);
    return true;
  } catch {
    return false;
  }
}

export async function listRemoteAgents(args: {
  authToken: string;
  fallbackFetchImpl?: CliFetchImpl;
  fetchImpl: CliFetchImpl;
  serverUrl: string;
  userId: string;
  queryUserRecords: (args: {
    authToken: string;
    fallbackFetchImpl?: CliFetchImpl;
    fetchImpl: CliFetchImpl;
    serverUrl: string;
    userId: string;
    type: "agent";
  }) => Promise<any[]>;
  readDbRecord: (args: {
    authToken: string;
    dbKey: string;
    fallbackFetchImpl?: CliFetchImpl;
    fetchImpl: CliFetchImpl;
    serverUrl: string;
  }) => Promise<any>;
}) {
  const recordGroups = [await args.queryUserRecords({ ...args, type: "agent" as const })];
  const agents = sortListedAgents(
    recordGroups
      .flat()
      .map((record) => normalizeListedAgent(record))
      .filter((agent): agent is ListedAgent => agent != null)
  );
  await Promise.all(
    agents.map(async (agent) => {
      agent.publicRecordExists = await hasReadableRecord({
        authToken: args.authToken,
        dbKey: agent.publicKey,
        fallbackFetchImpl: args.fallbackFetchImpl,
        fetchImpl: args.fetchImpl,
        serverUrl: args.serverUrl,
        readDbRecord: args.readDbRecord,
      });
    })
  );
  return agents;
}

export async function listRemoteAgentsAcrossServers(args: {
  authToken: string;
  fallbackFetchImpl?: CliFetchImpl;
  fetchImpl: CliFetchImpl;
  serverUrls: string[];
  userId: string;
}) {
  const remoteResult = await listUserRecordsFromServers({
    authToken: args.authToken,
    fallbackFetchImpl: args.fallbackFetchImpl,
    fetchImpl: args.fetchImpl,
    label: "agent query",
    serverUrls: args.serverUrls,
    type: "agent",
    userId: args.userId,
  });
  const agents = sortListedAgents(
    remoteResult.records
      .map((record) => normalizeListedAgent(record))
      .filter((agent): agent is ListedAgent => agent != null)
  );
  return { agents, failures: remoteResult.failures };
}

/**
 * 拉取用户收藏的 agent（web 收藏功能的同一 RPC：POST /rpc/listFavorites）。
 * 返回 agentKey → favoritedAt；多服务器合并取最新，无时间戳时以 1 标记。
 * 单个服务器失败静默跳过（目录展示不阻塞）。
 */
export async function listFavoriteAgentIdsAcrossServers(args: {
  authToken: string;
  fetchImpl: CliFetchImpl;
  serverUrls: string[];
}): Promise<Record<string, number>> {
  const favoritedAtByKey: Record<string, number> = {};
  await Promise.all(
    args.serverUrls.map(async (serverUrl) => {
      try {
        const res = await args.fetchImpl(`${serverUrl}/rpc/listFavorites`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${args.authToken}`,
          },
          body: JSON.stringify({ targetType: "agent" }),
        });
        if (!res.ok) return;
        const data: any = await res.json().catch(() => ({}));
        const items = Array.isArray(data?.items) ? data.items : [];
        for (const item of items) {
          const id = typeof item?.id === "string" ? item.id : "";
          if (!id) continue;
          const at = Number(item?.favoritedAt) || 0;
          favoritedAtByKey[id] = Math.max(
            favoritedAtByKey[id] ?? 0,
            at || Date.now(),
          );
        }
        const ids = Array.isArray(data?.ids) ? data.ids : [];
        for (const id of ids) {
          if (typeof id === "string" && id && !(id in favoritedAtByKey)) {
            favoritedAtByKey[id] = 1;
          }
        }
      } catch {
        // 单服务器失败不阻塞目录
      }
    }),
  );
  return favoritedAtByKey;
}

export async function decorateAgentsWithPublicStatusAcrossServers(args: {
  agents: ListedAgent[];
  authToken: string;
  fallbackFetchImpl?: CliFetchImpl;
  fetchImpl: CliFetchImpl;
  serverUrls: string[];
}) {
  await Promise.all(
    args.agents.map(async (agent) => {
      try {
        const result = await readLiveDbRecordAfterTombstoneMerge({
          authToken: args.authToken,
          dbKey: agent.publicKey,
          fallbackFetchImpl: args.fallbackFetchImpl,
          fetchImpl: args.fetchImpl,
          serverUrls: args.serverUrls,
        });
        agent.publicRecordExists = result.record?.isPublic === true;
      } catch {
        agent.publicRecordExists = false;
      }
    })
  );
  return args.agents;
}
