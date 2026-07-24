import {
  listFavoriteAgentIdsAcrossServers,
  listLocalCachedAgents,
  listRemoteAgents,
  listRemoteAgentsAcrossServers,
  type ListedAgent,
} from "../agentListHelpers";
import { getReadableCliDb } from "../agentCommandSupport";
import { queryUserRecords, readDbRecord } from "../agentRecordHelpers";
import type { CliFetchImpl } from "../cliFetch";
import {
  parseUserIdFromAuthToken,
  resolveAuthToken,
  resolveServerCandidates,
  resolveServerUrl,
} from "../cliEnvHelpers";
export const DEFAULT_TUI_AGENT_KEY = "agent-pub-01NOLOAPPBLD000000019KCKT0";

export type AgentCatalogEntry = {
  name: string;
  key: string;
  model: string;
  kind: "platform" | "private";
  description?: string;
  updatedAt?: number;
  /** 收藏时间戳（web 收藏功能）；有值时目录排序靠前并显示 ★。 */
  favoritedAt?: number;
  /** 执行来源：platform=平台API  custom=自定义API  cli=订阅制 CLI。 */
  apiSource?: string;
  /** apiSource=cli 时的具体 CLI（copilot/codex/claude 等）。 */
  cliProvider?: string;
};

/**
 * 来源标签：平台（平台 API）/ API（自定义 API）/ 订阅（订阅制 CLI 工具）。
 * 目录与 picker 统一使用。
 */
export function formatAgentSourceLabel(entry: AgentCatalogEntry): string {
  if (entry.kind === "platform" || entry.apiSource === "platform") return "平台";
  if (entry.apiSource === "cli") {
    return entry.cliProvider ? `订阅(${entry.cliProvider})` : "订阅";
  }
  if (entry.apiSource === "custom") return "API";
  return "平台";
}

export const PLATFORM_AGENTS: AgentCatalogEntry[] = [
  {
    name: "nolo",
    key: DEFAULT_TUI_AGENT_KEY,
    model: "-",
    kind: "platform",
    description: "one assistant that routes work across your agents and data",
  },
  {
    name: "app-builder",
    key: "agent-pub-01APPBUILDER00000001YAII3I",
    model: "-",
    kind: "platform",
    description: "builds web apps, tools, charts, and product prototypes",
  },
];

/**
 * 「auto」合成目录项：与 nolo 默认 agent 同 key。选择它 = 回到
 * 「无显式选择」状态，新对话首轮由 LLM 分类器在内置档间自动选
 * （镜像 web quick-chat 的 auto 模式）。仅自动路由开启时出现
 * （NOLO_AUTO_ROUTE=0 隐藏）。
 */
export const AUTO_ROUTE_CATALOG_ENTRY: AgentCatalogEntry = {
  name: "auto",
  key: DEFAULT_TUI_AGENT_KEY,
  model: "auto",
  kind: "platform",
  description:
    "auto-route each new dialog across flash / balanced / quality tiers",
};

/**
 * 目录展示用的平台 agent 列表：自动路由开启时用 auto 项替换 nolo 项
 * （同 key，语义等价），给用户一个显式回到自动模式的入口。
 */
export function resolveCatalogPlatformAgents(
  env: EnvLike = process.env,
): AgentCatalogEntry[] {
  if (env.NOLO_AUTO_ROUTE === "0") return PLATFORM_AGENTS;
  return [
    AUTO_ROUTE_CATALOG_ENTRY,
    ...PLATFORM_AGENTS.filter((entry) => entry.key !== DEFAULT_TUI_AGENT_KEY),
  ];
}

type EnvLike = Record<string, string | undefined>;

function toUpdatedAt(value: string | number | null | undefined) {
  if (value == null) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function listedAgentToCatalogEntry(agent: ListedAgent): AgentCatalogEntry {
  return {
    name: agent.name,
    key: agent.privateKey,
    model: agent.model,
    kind: "private",
    updatedAt: toUpdatedAt(agent.updatedAt),
    ...(agent.apiSource ? { apiSource: agent.apiSource } : {}),
    ...(agent.cliProvider ? { cliProvider: agent.cliProvider } : {}),
  };
}

export function mergeCatalogEntries(
  currentKey: string,
  platformAgents: AgentCatalogEntry[],
  privateAgents: AgentCatalogEntry[],
  favoritedAtByKey: Record<string, number> = {},
) {
  const seen = new Set<string>();
  const merged: AgentCatalogEntry[] = [];

  const push = (entry: AgentCatalogEntry) => {
    if (seen.has(entry.key)) return;
    seen.add(entry.key);
    const favoritedAt = favoritedAtByKey[entry.key];
    merged.push(favoritedAt ? { ...entry, favoritedAt } : entry);
  };

  const current =
    [...platformAgents, ...privateAgents].find((entry) => entry.key === currentKey) ??
    null;
  if (current) push(current);

  for (const entry of platformAgents) {
    if (entry.key !== currentKey) push(entry);
  }

  // 收藏的 agent 排在前面（按收藏时间倒序），其余按更新时间倒序。
  const sortedPrivate = [...privateAgents].sort((a, b) => {
    const fa = favoritedAtByKey[a.key] ?? 0;
    const fb = favoritedAtByKey[b.key] ?? 0;
    if (fa !== fb) return fb - fa;
    const tb = b.updatedAt ?? 0;
    const ta = a.updatedAt ?? 0;
    if (tb !== ta) return tb - ta;
    return a.name.localeCompare(b.name);
  });
  for (const entry of sortedPrivate) {
    if (entry.key !== currentKey) push(entry);
  }

  return merged;
}

type AgentCatalogCacheEntry = {
  cacheKey: string;
  at: number;
  entries: AgentCatalogEntry[];
};

let agentCatalogCache: AgentCatalogCacheEntry | null = null;
let agentCatalogRefreshInFlight: Promise<void> | null = null;

/** 缓存「新鲜」窗口：窗口内重复打开 /agent 不再触发后台刷新。 */
const AGENT_CATALOG_FRESH_MS = 15_000;

/** 清空目录缓存（测试与显式刷新用）。 */
export function invalidateAgentCatalogCache() {
  agentCatalogCache = null;
}

/**
 * SWR 目录加载：
 * - 无缓存 → 前台拉取（仅会话首次）；
 * - 有缓存 → 立即返回旧数据；超过新鲜窗口则在后台刷新，
 *   新建的 agent 最迟下次打开出现（不会永远看不到）。
 */
export async function loadAgentCatalog(args: {
  env?: EnvLike;
  currentKey: string;
  fetchImpl?: CliFetchImpl;
  fallbackFetchImpl?: CliFetchImpl;
}): Promise<AgentCatalogEntry[]> {
  const env = args.env ?? process.env;
  const authToken = resolveAuthToken([], env);
  const userId = authToken ? parseUserIdFromAuthToken(authToken) : null;
  const cacheKey = `${userId ?? "anon"}|${resolveServerUrl(env)}`;
  const cached =
    agentCatalogCache?.cacheKey === cacheKey ? agentCatalogCache : null;

  if (cached) {
    if (Date.now() - cached.at >= AGENT_CATALOG_FRESH_MS) {
      refreshAgentCatalogInBackground(args, env, cacheKey);
    }
    return cached.entries;
  }

  const entries = await fetchAgentCatalog(args, env);
  agentCatalogCache = { cacheKey, at: Date.now(), entries };
  return entries;
}

function refreshAgentCatalogInBackground(
  args: {
    env?: EnvLike;
    currentKey: string;
    fetchImpl?: CliFetchImpl;
    fallbackFetchImpl?: CliFetchImpl;
  },
  env: EnvLike,
  cacheKey: string,
) {
  if (agentCatalogRefreshInFlight) return;
  agentCatalogRefreshInFlight = fetchAgentCatalog(args, env)
    .then((entries) => {
      agentCatalogCache = { cacheKey, at: Date.now(), entries };
    })
    .catch(() => {
      // 后台刷新失败：保留旧缓存，下次打开再试。
    })
    .finally(() => {
      agentCatalogRefreshInFlight = null;
    });
}

/** 启动预热：后台填充目录缓存，首次 /agent 即命中（fire-and-forget）。 */
export function prefetchAgentCatalog(args: {
  env?: EnvLike;
  fetchImpl?: CliFetchImpl;
}) {
  void loadAgentCatalog({ ...args, currentKey: "" }).catch(() => {});
}

async function fetchAgentCatalog(
  args: {
    env?: EnvLike;
    currentKey: string;
    fetchImpl?: CliFetchImpl;
    fallbackFetchImpl?: CliFetchImpl;
  },
  env: EnvLike,
): Promise<AgentCatalogEntry[]> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const fallbackFetchImpl = args.fallbackFetchImpl;
  const authToken = resolveAuthToken([], env);
  const userId = authToken ? parseUserIdFromAuthToken(authToken) : null;

  if (!authToken || !userId) {
    return mergeCatalogEntries(
      args.currentKey,
      resolveCatalogPlatformAgents(env),
      [],
    );
  }

  const serverUrl = resolveServerUrl(env);
  const serverUrls = resolveServerCandidates([], env, serverUrl);
  let privateAgents: AgentCatalogEntry[] = [];
  // 收藏列表与 agent 目录并行拉取；失败降级为空（不影响目录展示）。
  const favoritesPromise = listFavoriteAgentIdsAcrossServers({
    authToken,
    fetchImpl,
    serverUrls,
  }).catch(() => ({} as Record<string, number>));

  try {
    const remoteResult = await listRemoteAgentsAcrossServers({
      authToken,
      fallbackFetchImpl,
      fetchImpl,
      serverUrls,
      userId,
    });
    privateAgents = remoteResult.agents.map(listedAgentToCatalogEntry);
  } catch {
    try {
      const db = await getReadableCliDb({ write: () => {} });
      const cached = await listLocalCachedAgents({ db, userId });
      privateAgents = cached.map(listedAgentToCatalogEntry);
    } catch {
      privateAgents = (
        await listRemoteAgents({
          authToken,
          fallbackFetchImpl,
          fetchImpl,
          serverUrl,
          userId,
          queryUserRecords,
          readDbRecord,
        })
      ).map(listedAgentToCatalogEntry);
    }
  }

  const favoritedAtByKey = await favoritesPromise;
  return mergeCatalogEntries(
    args.currentKey,
    resolveCatalogPlatformAgents(env),
    privateAgents,
    favoritedAtByKey,
  );
}

export function renderAgentCatalogList(entries: AgentCatalogEntry[], currentKey: string) {
  const lines = ["Agents:"];
  entries.forEach((entry, index) => {
    const current = entry.key === currentKey ? " (current)" : "";
    const favorite = entry.favoritedAt ? " ★" : "";
    const detail = entry.description ? ` — ${entry.description}` : "";
    lines.push(
      `  ${String(index + 1).padStart(2)}  ${entry.name.padEnd(18)} ${entry.model.padEnd(14)} ${formatAgentSourceLabel(entry)}${favorite}${detail}${current}`
    );
  });
  lines.push("");
  lines.push("Tip: run /switch in an interactive terminal to pick with ↑↓.");
  return lines.join("\n");
}

export function findAgentCatalogEntry(
  entries: AgentCatalogEntry[],
  rawTarget: string
) {
  const target = rawTarget.trim();
  if (!target) return null;

  if (/^\d+$/.test(target)) {
    const entry = entries[Number(target) - 1];
    return entry ? { name: entry.name, key: entry.key } : null;
  }

  const lower = target.toLowerCase();
  const byName = entries.find(
    (entry) =>
      entry.name.toLowerCase() === lower ||
      entry.key.toLowerCase() === lower ||
      entry.key.toLowerCase().endsWith(`-${lower}`)
  );
  if (byName) return { name: byName.name, key: byName.key };

  if (target.startsWith("agent-") || target.startsWith("agent-pub-")) {
    return { name: target, key: target };
  }

  return null;
}