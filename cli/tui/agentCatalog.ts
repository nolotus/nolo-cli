import {
  listFavoriteAgentIdsAcrossServers,
  listLocalCachedAgents,
  listRemoteAgents,
  listRemoteAgentsAcrossServers,
  normalizeListedAgent,
  type ListedAgent,
} from "../agentListHelpers";
import { getReadableCliDb } from "../agentCommandSupport";
import { queryUserRecords, readDbRecord } from "../agentRecordHelpers";
import { readLiveDbRecordAfterTombstoneMerge } from "../globalRecordOperations";
import type { CliFetchImpl } from "../cliFetch";
import {
  parseUserIdFromAuthToken,
  resolveAuthToken,
  resolveServerCandidates,
  resolveServerUrl,
} from "../cliEnvHelpers";
import { sortAgentsFavoriteOwnedPublic, type SortableAgentItem } from "../../ai/agent/utils/sortUtils";
import { t } from "./i18n";
import { NOLO_DEFAULT_AGENT_KEY } from "../agentAliases";
import {
  BUILTIN_NOLO_AGENT_MODEL,
  BUILTIN_NOLO_AGENT_NAME,
} from "../../core/builtinAgents";
import { builtinAgentCatalogEntryById } from "../../core/builtinAgentCatalog";
import { parsePublicAgentId } from "../../core/prefix";

// The TUI default is Nolo itself. App Builder is a separate platform agent and
// must never become the implicit fallback when profile/env resolution is absent.
export const DEFAULT_TUI_AGENT_KEY = NOLO_DEFAULT_AGENT_KEY;

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
  if (entry.kind === "platform" || entry.apiSource === "platform") return t("agentSourcePlatform");
  if (entry.apiSource === "cli") {
    return entry.cliProvider ? `${t("agentSourceSubscription")}(${entry.cliProvider})` : t("agentSourceSubscription");
  }
  if (entry.apiSource === "custom") return t("agentSourceApi");
  return t("agentSourcePlatform");
}

export const PLATFORM_AGENTS: AgentCatalogEntry[] = [
  {
    // 名称与模型都从 builtinAgentCatalog 派生：`/switch` 里的 nolo 项直接显示
    // 它实际指向的模型（当前 DeepSeek V4 Flash Vision Exp），换代自动跟随。
    name: BUILTIN_NOLO_AGENT_NAME,
    key: DEFAULT_TUI_AGENT_KEY,
    model: BUILTIN_NOLO_AGENT_MODEL,
    kind: "platform",
    description: "one assistant that routes work across your agents and data",
  },
];

/**
 * 目录展示用的平台 agent 列表：自动路由只剩 flash 一档，不再用合成
 * 「auto」项替换 nolo 项（该项曾用于表示「无显式选择」的 auto 模式），
 * 始终显示默认 agent 名 nolo。
 */
export function resolveCatalogPlatformAgents(
  _env: EnvLike = process.env,
): AgentCatalogEntry[] {
  return PLATFORM_AGENTS;
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
    [...platformAgents, ...privateAgents].find((entry) => entry.key === currentKey) ?? null;
  if (current) push(current);

  // Always keep the explicit auto/platform choices available. User-owned
  // agents are shown regardless of favorite state; favorites only affect
  // ordering and the star marker.
  for (const entry of platformAgents) {
    if (entry.key !== currentKey) push(entry);
  }

  // The switcher includes every user-owned agent. Favorites are sorted first,
  // followed by the remaining owned agents by their update time.
  const sortablePrivate: SortableAgentItem[] = privateAgents.map((entry) => ({
    key: entry.key,
    ...(favoritedAtByKey[entry.key] !== undefined
      ? { favoritedAt: favoritedAtByKey[entry.key] }
      : {}),
    isOwned: true,
    updatedAt: entry.updatedAt ?? 0,
  }));
  const sortedKeys = sortAgentsFavoriteOwnedPublic(sortablePrivate);
  const sortedKeyOrder = new Map(sortedKeys.map((item, i) => [item.key, i]));
  const sortedPrivate = [...privateAgents].sort(
    (a, b) => (sortedKeyOrder.get(a.key) ?? 0) - (sortedKeyOrder.get(b.key) ?? 0)
  );
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

/** 原始目录数据（网络拉取结果，不含 currentKey 排序）。 */
type RawCatalogData = {
  privateAgents: AgentCatalogEntry[];
  favoritedAtByKey: Record<string, number>;
};

let agentCatalogCache: AgentCatalogCacheEntry | null = null;
let agentCatalogRefreshInFlight: Promise<void> | null = null;
/** 首次加载的 in-flight Promise（原始数据层，不含 currentKey 排序）。 */
let agentCatalogRawLoadInFlight: Promise<RawCatalogData> | null = null;

/** 缓存「新鲜」窗口：窗口内重复打开 /agent 不再触发后台刷新。 */
const AGENT_CATALOG_FRESH_MS = 15_000;

/** 清空目录缓存（测试与显式刷新用）。 */
export function invalidateAgentCatalogCache() {
  agentCatalogCache = null;
  agentCatalogRawLoadInFlight = null;
}

/**
 * SWR 目录加载：
 * - 无缓存 → 前台拉取（仅会话首次），复用 in-flight Promise 避免重复请求；
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

  // 复用已有的原始数据请求（prefetch 触发后用户很快 /switch 时命中），
  // 然后用调用方自己的 currentKey 做排序合并——避免 prefetch 的空 key 影响排序。
  let rawData: RawCatalogData;
  if (agentCatalogRawLoadInFlight) {
    rawData = await agentCatalogRawLoadInFlight;
  } else {
    const promise = fetchRawCatalogData(args, env);
    agentCatalogRawLoadInFlight = promise;
    try {
      rawData = await promise;
    } catch (error) {
      agentCatalogRawLoadInFlight = null;
      throw error;
    }
    agentCatalogRawLoadInFlight = null;
  }

  const entries = mergeCatalogEntries(
    args.currentKey,
    resolveCatalogPlatformAgents(env),
    rawData.privateAgents,
    rawData.favoritedAtByKey,
  );
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
  agentCatalogRefreshInFlight = fetchRawCatalogData(args, env)
    .then((rawData) => {
      const entries = mergeCatalogEntries(
        args.currentKey,
        resolveCatalogPlatformAgents(env),
        rawData.privateAgents,
        rawData.favoritedAtByKey,
      );
      agentCatalogCache = { cacheKey, at: Date.now(), entries };
    })
    .catch(() => {
      // 后台刷新失败：保留旧缓存，下次打开再试。
    })
    .finally(() => {
      agentCatalogRefreshInFlight = null;
    });
}

/**
 * Local DB prefill is intentionally disabled for the favorites-only switcher.
 * Cached Agent records do not contain authoritative favorite metadata, so using
 * them would briefly show agents the user did not select.
 */
export async function prefillCatalogFromLocalDb(_args: {
  env?: EnvLike;
  getDb?: () => Promise<unknown>;
}): Promise<void> {
  // Keep the hook for startup callers; the server response is the source of truth.
}

/** 启动预热：后台刷新收藏目录缓存（fire-and-forget）。 */
export function prefetchAgentCatalog(args: {
  env?: EnvLike;
  fetchImpl?: CliFetchImpl;
  /** 测试注入：用假的 DB 替代 getReadableCliDb。生产中 undefined。 */
  getDb?: () => Promise<unknown>;
}) {
  void (async () => {
    // 收藏元数据必须来自服务器；本地缓存不能作为 favorites-only 列表来源。
    await prefillCatalogFromLocalDb({ env: args.env, getDb: args.getDb }).catch(() => {});
    // 后台网络请求刷新收藏目录缓存（SWR，后台失败静默）
    void loadAgentCatalog({ ...args, currentKey: "" }).catch(() => {});
  })();
}

/**
 * 原始数据拉取：只做网络请求，不做 currentKey 排序。
 * in-flight dedup 作用在这一层，保证不同 currentKey 的调用者都能复用同一次网络请求。
 */
async function fetchRawCatalogData(
  args: {
    env?: EnvLike;
    currentKey: string;
    fetchImpl?: CliFetchImpl;
    fallbackFetchImpl?: CliFetchImpl;
  },
  env: EnvLike,
): Promise<RawCatalogData> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const fallbackFetchImpl = args.fallbackFetchImpl;
  const authToken = resolveAuthToken([], env);
  const userId = authToken ? parseUserIdFromAuthToken(authToken) : null;

  if (!authToken || !userId) {
    return { privateAgents: [], favoritedAtByKey: {} };
  }

  const serverUrl = resolveServerUrl(env);
  const serverUrls = resolveServerCandidates([], env, serverUrl);
  // 保留原始 ListedAgent[]，供 orphan hydrate 做三键（privateKey/publicKey/id）去重，
  // 与 agentListCommands.ts 的 `nolo agent list --safe` 对齐，避免同一 agent 重复入目。
  let listedAgents: ListedAgent[] = [];
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
    listedAgents = remoteResult.agents;
  } catch {
    try {
      const db = await getReadableCliDb({ write: () => {} });
      listedAgents = await listLocalCachedAgents({ db, userId });
    } catch {
      listedAgents = await listRemoteAgents({
        authToken,
        fallbackFetchImpl,
        fetchImpl,
        serverUrl,
        userId,
        queryUserRecords,
        readDbRecord,
      });
    }
  }
  const privateAgents = listedAgents.map(listedAgentToCatalogEntry);

  const favoritedAtByKey = await favoritesPromise;
  // A favorite may be keyed by publicKey while the switcher uses privateKey.
  for (const agent of listedAgents) {
    const favoritedAt = [agent.privateKey, agent.publicKey, agent.id]
      .map((key) => favoritedAtByKey[key])
      .find((value) => value !== undefined);
    if (favoritedAt !== undefined) favoritedAtByKey[agent.privateKey] = favoritedAt;
  }
  // orphan favorite hydrate：把「已收藏但不在 listRemoteAgentsAcrossServers 返回里」
  // 的 agent（典型是收藏的别人/公开 agent，或跨服务器、刚收藏未同步的记录）从各服务器
  // 按 dbKey 重新读回并并入目录，对齐 web 端 useAgentPickerCandidates 与 CLI
  // `nolo agent list --safe`（agentListCommands.ts）的兜底行为，避免 /switch 漏项。
  // 单个 orphan 读取失败静默跳过，不阻塞目录加载。
  // 三键去重：与 agentListCommands.ts 一致，privateKey/publicKey/id 任一命中即视为已存在，
  // 防止「自有 public agent 以 publicKey 形态被收藏」时同一 agent 重复入目。
  const existingKeys = new Set<string>();
  for (const agent of listedAgents) {
    existingKeys.add(agent.privateKey);
    existingKeys.add(agent.publicKey);
    existingKeys.add(agent.id);
  }

  await Promise.all(
    Object.keys(favoritedAtByKey).map(async (favKey) => {
      if (existingKeys.has(favKey)) return;
      try {
        const favRead = await readLiveDbRecordAfterTombstoneMerge({
          authToken,
          dbKey: favKey,
          fallbackFetchImpl,
          fetchImpl,
          serverUrls,
        });
        const record = favRead.record;
        if (!record || (record.type && record.type !== "agent")) return;
        const norm = normalizeListedAgent(record);
        if (!norm) return;
        // 同源去重：normalize 后的 privateKey/publicKey/id 任一已存在则跳过
        if (
          existingKeys.has(norm.privateKey) ||
          existingKeys.has(norm.publicKey) ||
          existingKeys.has(norm.id)
        ) {
          return;
        }
        existingKeys.add(norm.privateKey);
        existingKeys.add(norm.publicKey);
        existingKeys.add(norm.id);
        privateAgents.push(listedAgentToCatalogEntry(norm));
      } catch {
        // orphan favorite key, skip it.
      }
    }),
  );

  return { privateAgents, favoritedAtByKey };
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

/**
 * `/switch <target>` 解析出的切换目标。
 *
 * 显式写出返回类型，而不是让 4 个分支各自推断出一个联合类型——改这个函数的人
 * （或 AI）不该被迫读完所有分支才知道契约。`model` / `apiSource` 可缺省：
 * 目录外的陌生 key 只能给出 key 本身。
 */
export type AgentSwitchTarget = {
  name: string;
  key: string;
  model?: string;
  apiSource?: string;
};

/**
 * 目录条目的来源标记：显式 apiSource 优先，其次平台条目算 "platform"，
 * 其余（用户自建、来源未知）不标。三个分支曾各自内联同一段三元表达式。
 */
function resolveEntryApiSource(entry: {
  apiSource?: string;
  kind?: string;
}): string | undefined {
  if (entry.apiSource) return entry.apiSource;
  return entry.kind === "platform" ? "platform" : undefined;
}

function toSwitchTarget(entry: AgentCatalogEntry): AgentSwitchTarget {
  const apiSource = resolveEntryApiSource(entry);
  return {
    name: entry.name,
    key: entry.key,
    model: entry.model,
    ...(apiSource ? { apiSource } : {}),
  };
}

export function findAgentCatalogEntry(
  entries: AgentCatalogEntry[],
  rawTarget: string
): AgentSwitchTarget | null {
  const target = rawTarget.trim();
  if (!target) return null;

  // 1) 列表序号
  if (/^\d+$/.test(target)) {
    const entry = entries[Number(target) - 1];
    return entry ? toSwitchTarget(entry) : null;
  }

  // 2) 名字 / key / key 后缀
  const lower = target.toLowerCase();
  const byName = entries.find(
    (entry) =>
      entry.name.toLowerCase() === lower ||
      entry.key.toLowerCase() === lower ||
      entry.key.toLowerCase().endsWith(`-${lower}`)
  );
  if (byName) return toSwitchTarget(byName);

  // 3) 目录里没有的 agent key（未登录、目录还没加载完、或切的是别人的 agent）。
  //    平台内置 agent 仍能从 builtinAgentCatalog 拿到真名与模型——直接把 key
  //    当显示名会连着 persistAgentSelection 一起把裸 key 写进 profile 的
  //    agentName，状态行随后显示一长串 `agent-pub-01…`。
  if (target.startsWith("agent-") || target.startsWith("agent-pub-")) {
    const builtin = builtinAgentCatalogEntryById(parsePublicAgentId(target));
    if (builtin) {
      return {
        name: builtin.name,
        key: target,
        model: builtin.model,
        apiSource: builtin.apiSource ?? "platform",
      };
    }
    return { name: target, key: target };
  }

  return null;
}