/**
 * CLI 版 quick-chat 自动路由：每条消息先过一个小模型分类器，
 * 在 flash / balanced / quality 三个内置档间选择 tier agent。
 *
 * 与 web 端共享纯逻辑（agent-runtime/quickChatIntentCore）；
 * 分类调用走平台代理通道 /api/v1/chat（与 local runtime 同一通道）。
 * 任何失败（未登录、超时、坏 JSON）都静默回退到复杂度 regex 兜底。
 */

import {
  PUBLIC_DEEPSEEK_V4_FLASH_AGENT_KEY,
  PUBLIC_DEEPSEEK_V4_PRO_AGENT_KEY,
  PUBLIC_GLM_52_AGENT_KEY,
} from "../../core/builtinAgents";
import {
  INTENT_MODEL,
  INTENT_PROVIDER,
  QUICK_CHAT_INTENT_TIMEOUT_MS,
  TIER_DESCRIPTIONS,
  buildQuickChatIntentSystemPrompt,
  estimateComplexity,
  isShortGreeting,
  parseQuickChatIntentResult,
  type TierAgentOption,
} from "../../agent-runtime/quickChatIntentCore";
import {
  buildPlatformChatCompletionRequest,
  parsePlatformChatCompletionData,
} from "../../agent-runtime/platformChatProvider";
import { resolvePlatformChatCompletionsEndpoint } from "../../agent-runtime/platformProviderEndpoints";
import type { AgentRuntimeChatMessage } from "../../agent-runtime/types";
import type { CliFetchImpl } from "../cliFetch";

/** CLI 自动路由的三档 tier agent（与 web quickChatTierDefaults 对齐；image 档不接入 CLI）。 */
export const CLI_AUTO_TIER_AGENT_KEYS = {
  flash: PUBLIC_DEEPSEEK_V4_FLASH_AGENT_KEY,
  balanced: PUBLIC_DEEPSEEK_V4_PRO_AGENT_KEY,
  quality: PUBLIC_GLM_52_AGENT_KEY,
} as const;

export type CliAutoTier = keyof typeof CLI_AUTO_TIER_AGENT_KEYS;

export interface CliAutoRouteResult {
  /** 命中的 tier agent key（内置档）。 */
  agentKey: string;
  tier: CliAutoTier;
  /** LLM 分类是否成功；false 表示走了 regex 兜底。 */
  classified: boolean;
  confidence?: number;
}

export interface ClassifyCliAutoRouteOptions {
  serverUrl: string;
  authToken: string;
  /** 测试注入用；默认全局 fetch。 */
  fetchImpl?: CliFetchImpl;
  /** 覆盖默认超时（仅测试用）。 */
  timeoutMs?: number;
}

const buildRouteOptions = (): TierAgentOption[] =>
  (["flash", "balanced", "quality"] as const).map((tier) => ({
    tier,
    agentKey: CLI_AUTO_TIER_AGENT_KEYS[tier],
    description: TIER_DESCRIPTIONS[tier],
  }));

const tierForAgentKey = (agentKey: string): CliAutoTier | null => {
  for (const tier of ["flash", "balanced", "quality"] as const) {
    if (CLI_AUTO_TIER_AGENT_KEYS[tier] === agentKey) return tier;
  }
  return null;
};

/** LLM 失败时的复杂度启发式兜底。 */
export function resolveCliAutoFallbackTier(text: string): CliAutoTier {
  switch (estimateComplexity(text)) {
    case "complex":
      return "quality";
    case "medium":
      return "balanced";
    case "simple":
    default:
      return "flash";
  }
}

/**
 * 对一条用户消息做自动路由分类。
 * 快速通道：空文本/短问候 → flash（不调 LLM）；未登录 → 直接兜底。
 */
export async function classifyCliAutoRoute(
  text: string,
  options: ClassifyCliAutoRouteOptions,
): Promise<CliAutoRouteResult> {
  const timeoutMs = options.timeoutMs ?? QUICK_CHAT_INTENT_TIMEOUT_MS;
  const fallbackTier = resolveCliAutoFallbackTier(text);
  const fallback = (): CliAutoRouteResult => ({
    agentKey: CLI_AUTO_TIER_AGENT_KEYS[fallbackTier],
    tier: fallbackTier,
    classified: false,
  });

  if (!text.trim()) return fallback();

  // 快速通道：明显的短问候/闲聊 → flash 档，跳过 LLM。
  if (isShortGreeting(text)) {
    return {
      agentKey: CLI_AUTO_TIER_AGENT_KEYS.flash,
      tier: "flash",
      classified: true,
    };
  }

  // 未登录没有代理通道，直接兜底（本地执行不受影响）。
  if (!options.authToken) return fallback();

  const fetchImpl: CliFetchImpl =
    options.fetchImpl ?? (globalThis.fetch as unknown as CliFetchImpl);

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const routeOptions = buildRouteOptions();
    const messages: AgentRuntimeChatMessage[] = [
      { role: "system", content: buildQuickChatIntentSystemPrompt(routeOptions) },
      { role: "user", content: text },
    ];
    const { url, init } = buildPlatformChatCompletionRequest({
      providerConfig: {
        serverUrl: options.serverUrl,
        authToken: options.authToken,
        agentKey: CLI_AUTO_TIER_AGENT_KEYS.flash,
        model: INTENT_MODEL,
        provider: INTENT_PROVIDER,
        endpoint: resolvePlatformChatCompletionsEndpoint(INTENT_PROVIDER) ?? "",
        requestOptions: {},
      },
      messages,
      stream: false,
    });

    const response = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
    if (!response.ok) return fallback();

    const data = parsePlatformChatCompletionData(await response.text());
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) return fallback();

    const parsed = parseQuickChatIntentResult(content, routeOptions);
    if (!parsed) return fallback();

    const tier = tierForAgentKey(parsed.agentKey) ?? fallbackTier;
    return {
      agentKey: parsed.agentKey,
      tier,
      classified: true,
      confidence: parsed.confidence,
    };
  } catch {
    // 超时 / 网络错误 / 解析异常 → 静默兜底，不阻塞发送。
    return fallback();
  } finally {
    clearTimeout(timeoutHandle);
  }
}
