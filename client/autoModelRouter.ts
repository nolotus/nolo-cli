/**
 * CLI 版 quick-chat 自动路由：纯二选一。
 * 有图 → Kimi K2.6（vision 档）；无图 → flash 档。
 * 不再调 LLM 分类器，无复杂度兜底、无专职 agent 路由。
 */

import {
  PUBLIC_DEEPSEEK_V4_FLASH_AGENT_KEY,
  PUBLIC_KIMI_K26_IMAGE_AGENT_KEY,
} from "../core/builtinAgents";

/**
 * CLI 自动路由的 tier agent（与 web quickChatTierDefaults 对齐）。
 * 无图时一律走 flash 档；balanced/quality 保留别名以兼容下游查表
 * （CLI_AUTO_TIER_AGENT_KEY_TABLE / resolveCliAutoAgentModel）。
 */
export const CLI_AUTO_TIER_AGENT_KEYS = {
  flash: PUBLIC_DEEPSEEK_V4_FLASH_AGENT_KEY,
  balanced: PUBLIC_DEEPSEEK_V4_FLASH_AGENT_KEY,
  quality: PUBLIC_DEEPSEEK_V4_FLASH_AGENT_KEY,
} as const;

/**
 * Tier agent → catalog model id. Used by TUI context-window resolution so
 * status chips show the routed model's window (e.g. flash → 1M) instead of
 * falling back through the default "nolo" display name to 256k.
 */
export const CLI_AUTO_TIER_MODELS = {
  flash: "deepseek-v4-flash",
  balanced: "deepseek-v4-flash",
  quality: "deepseek-v4-flash",
} as const;

/** 图片输入时自动切换到的 vision agent key（Kimi K2.6）。 */
export const CLI_IMAGE_AGENT_KEY = PUBLIC_KIMI_K26_IMAGE_AGENT_KEY;

/** Vision auto-switch target model id (paired with CLI_IMAGE_AGENT_KEY). */
export const CLI_IMAGE_AGENT_MODEL = "kimi-k2.6";

/** 所有 tier agent key 的查表（用于判断是否为自动路由的内置档）。
 *  三档当前均指向 flash key，去重为一个条目（balanced/quality 同键）。 */
export const CLI_AUTO_TIER_AGENT_KEY_TABLE: Record<string, true> = {
  [CLI_AUTO_TIER_AGENT_KEYS.flash]: true,
};

/** Resolve the catalog model id for a known auto-route / image-tier agent key. */
export function resolveCliAutoAgentModel(agentKey: string): string | undefined {
  if (agentKey === CLI_AUTO_TIER_AGENT_KEYS.flash) return CLI_AUTO_TIER_MODELS.flash;
  if (agentKey === CLI_AUTO_TIER_AGENT_KEYS.balanced) {
    return CLI_AUTO_TIER_MODELS.balanced;
  }
  if (agentKey === CLI_AUTO_TIER_AGENT_KEYS.quality) {
    return CLI_AUTO_TIER_MODELS.quality;
  }
  if (agentKey === CLI_IMAGE_AGENT_KEY) return CLI_IMAGE_AGENT_MODEL;
  return undefined;
}

export type CliAutoTier = keyof typeof CLI_AUTO_TIER_AGENT_KEYS | "image";

export interface CliAutoRouteResult {
  /** 命中的 agent key（内置档 / vision 档）。 */
  agentKey: string;
  tier: CliAutoTier;
  /** 协议保留字段：纯二选一路由恒为 true（非兜底结果）。 */
  classified: boolean;
}

export interface ClassifyCliAutoRouteOptions {
  /** 保留以兼容调用方签名；纯二选一路由不再使用代理通道。 */
  serverUrl: string;
  /** 保留以兼容调用方签名；纯二选一路由不再需要鉴权。 */
  authToken: string;
  /** 消息是否带图片；true → kimi vision 档，缺省/无图 → flash 档。 */
  hasImages?: boolean;
}

/**
 * 纯二选一自动路由：有图 → kimi，无图 → flash。
 * 同步执行（无 I/O），不调 LLM 分类器、无复杂度兜底、无专职路由。
 * 调用方保留 `await` 亦可（await 同步值等价直接返回）。
 */
export function classifyCliAutoRoute(
  _text: string,
  options: ClassifyCliAutoRouteOptions,
): CliAutoRouteResult {
  if (options.hasImages) {
    return { agentKey: CLI_IMAGE_AGENT_KEY, tier: "image", classified: true };
  }
  return {
    agentKey: CLI_AUTO_TIER_AGENT_KEYS.flash,
    tier: "flash",
    classified: true,
  };
}
