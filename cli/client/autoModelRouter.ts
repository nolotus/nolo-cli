/**
 * CLI 版 quick-chat 自动路由。
 * 图片档已移除：有图无图都走 flash 档，vision 预处理管道负责把图片描述成文字。
 * 不再调 LLM 分类器，无复杂度兜底、无专职 agent 路由。
 */

import {
  PUBLIC_DEEPSEEK_V4_FLASH_AGENT_KEY,
} from "../../core/builtinAgents";

/**
 * CLI 自动路由的 tier agent（与 web quickChatTierDefaults 对齐）。
 * 无图时一律走 flash 档；balanced/quality 保留别名以兼容下游查表
 * （resolveCliAutoAgentModel）。
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

/** Resolve the catalog model id for a known auto-route agent key. */
export function resolveCliAutoAgentModel(agentKey: string): string | undefined {
  if (agentKey === CLI_AUTO_TIER_AGENT_KEYS.flash) return CLI_AUTO_TIER_MODELS.flash;
  if (agentKey === CLI_AUTO_TIER_AGENT_KEYS.balanced) {
    return CLI_AUTO_TIER_MODELS.balanced;
  }
  if (agentKey === CLI_AUTO_TIER_AGENT_KEYS.quality) {
    return CLI_AUTO_TIER_MODELS.quality;
  }
  return undefined;
}

export type CliAutoTier = keyof typeof CLI_AUTO_TIER_AGENT_KEYS;

export interface CliAutoRouteResult {
  /** 命中的 agent key（内置档）。 */
  agentKey: string;
  tier: CliAutoTier;
  /** 协议保留字段：恒为 true（非兜底结果）。 */
  classified: boolean;
}

export interface ClassifyCliAutoRouteOptions {
  /** 保留以兼容调用方签名。 */
  serverUrl: string;
  /** 保留以兼容调用方签名。 */
  authToken: string;
  /** @deprecated 图片档已移除，有图无图都走 flash。保留以兼容调用方签名。 */
  hasImages?: boolean;
}

/**
 * 自动路由：有图无图都走 flash 档。
 * 图片由 vision 预处理管道处理（localLoop 中的 preprocessImagesForTextOnlyAgent）。
 * 同步执行（无 I/O），不调 LLM 分类器。
 */
export function classifyCliAutoRoute(
  _text: string,
  options: ClassifyCliAutoRouteOptions,
): CliAutoRouteResult {
  return {
    agentKey: CLI_AUTO_TIER_AGENT_KEYS.flash,
    tier: "flash",
    classified: true,
  };
}