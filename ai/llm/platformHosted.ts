// packages/ai/llm/platformHosted.ts
// Platform catalog for hosted models (upstream provider is abstracted).
// Public provider id is `nolo` (see providers.ts MODEL_MAP).

import { asTrimmedLowercaseString } from "../../core/trimmedLowercaseString";
import {
  PLATFORM_HOSTED_KIMI_K26_MODEL,
  PLATFORM_HOSTED_KIMI_K3_MODEL,
} from "./kimi";

/**
 * nolo 平台内部价格单位：积分 / 1M tokens。
 * 外部美元 API 的统一销售口径是 8 折，再按 1 USD = 7 credits 记账。
 */
const PLATFORM_CREDITS_PER_USD = 7;
const EXTERNAL_API_DISCOUNT = 0.8;
const toPlatformCredits = (usdPerMillion: number): number =>
  Number(
    (usdPerMillion * EXTERNAL_API_DISCOUNT * PLATFORM_CREDITS_PER_USD).toFixed(
      6,
    ),
  );

/**
 * Kimi K2.6 官方 API $0.6/$2.4 per 1M，nolo 对外 8 折。
 */
export const PLATFORM_HOSTED_KIMI_PRICE = {
  input: toPlatformCredits(0.6),
  output: toPlatformCredits(2.4),
} as const;

/**
 * Kimi K3 走 crof 上游，硬编码 crof 报价 ×8（不走通用 toPlatformCredits）。
 * crof $2/$0.25/$8 per 1M ×8 = 16/2/64 credits。
 */
export const PLATFORM_HOSTED_KIMI_K3_PRICE = {
  input: 16, // crof $2 × 8，特殊价不走通用 0.8×7 换算
  inputCacheHit: 2, // crof $0.25 × 8
  output: 64, // crof $8 × 8
} as const;

/**
 * GLM 5.2 官方 Z.AI API $1.4/$4.4 per 1M，nolo 对外 8 折。
 */
export const PLATFORM_HOSTED_GLM_PRICE = {
  input: toPlatformCredits(1.4),
  inputCacheHit: toPlatformCredits(0.26),
  output: toPlatformCredits(4.4),
} as const;

/** Platform hosted model id for GLM 5.2 (platform catalog). */
export const PLATFORM_HOSTED_GLM_52_MODEL = "glm-5.2";

/**
 * Platform hosted DeepSeek V4 Flash. Same model id as official DeepSeek so
 * fallback can reuse deepseek-v4-flash on api.deepseek.com.
 */
export const PLATFORM_HOSTED_DEEPSEEK_FLASH_MODEL = "deepseek-v4-flash";

/**
 * DeepSeek V4 Flash uses the official DeepSeek domestic RMB price directly;
 * it does not receive the nolo external-API conversion or discount rule.
 * Official: ¥1 input / ¥2 output per 1M tokens.
 */
export const PLATFORM_HOSTED_DEEPSEEK_FLASH_PRICE = {
  input: 1,
  inputCacheHit: 0.02,
  output: 2,
} as const;

/**
 * Platform hosted chat completions upstream.
 *
 * Open-source default: Ollama Cloud's OpenAI-compatible endpoint
 * (https://ollama.com/v1/chat/completions), authenticated via OLLAMA_API_KEY.
 *
 * nolo 内部生产环境的上游路由（组合 ollama cloud + 自有机器等）不在开源
 * 仓库内。当前开源实现默认走 Ollama Cloud。
 */
export const PLATFORM_HOSTED_CHAT_COMPLETIONS_URL =
  "https://ollama.com/v1/chat/completions";

export type PlatformDeepseekFlashRoutePlan =
  | { kind: "configured" }
  | { kind: "missing_key" }
  | { kind: "hosted"; primaryProvider: "nolo" };

export const isPlatformHostedDeepseekFlashModel = (
  model?: string | null,
): boolean => model === PLATFORM_HOSTED_DEEPSEEK_FLASH_MODEL;

/**
 * Platform DeepSeek Flash (hosted): nolo/platform-hosted catalog or legacy
 * `deepseek` provider records still pointing at deepseek-v4-flash. The official
 * DeepSeek provider was retired on 2026-08-08, so `deepseek` here only means
 * "stale record" — it resolves to the same nolo (Ollama Cloud) upstream.
 */
export const isPlatformDeepseekFlashHosted = (
  provider?: string | null,
  model?: string | null,
): boolean => {
  if (!isPlatformHostedDeepseekFlashModel(model)) return false;
  const p = asTrimmedLowercaseString(provider);
  return (
    p === "nolo" ||
    p === "ollama-cloud" || // Backward compatibility
    p === "deepseek"
  );
};

/**
 * Pure provider-ordering policy shared by chat proxy and agent-run.
 * Explicit Responses, custom providers, and user credentials stay on their
 * configured route; hosted Chat Completions goes to Ollama Cloud. There is no
 * official-DeepSeek fallback any more — that provider was retired.
 */
export const resolvePlatformDeepseekFlashRoute = (args: {
  provider?: string | null;
  model?: string | null;
  endpoint?: string | null;
  isCustomApi: boolean;
  hasExplicitCredential: boolean;
  hasOllamaKey: boolean;
}): PlatformDeepseekFlashRoutePlan => {
  const usesResponsesApi =
    typeof args.endpoint === "string" &&
    /\/responses(?:[/?#]|$)/i.test(args.endpoint);
  const eligible =
    isPlatformDeepseekFlashHosted(args.provider, args.model) &&
    !usesResponsesApi &&
    !args.isCustomApi &&
    !args.hasExplicitCredential;

  if (!eligible) return { kind: "configured" };
  if (args.hasOllamaKey) return { kind: "hosted", primaryProvider: "nolo" };
  return { kind: "missing_key" };
};

export const platformHostedModels = [
  {
    name: PLATFORM_HOSTED_KIMI_K3_MODEL,
    displayName: "Kimi K3",
    hasVision: true,
    price: { ...PLATFORM_HOSTED_KIMI_K3_PRICE },
    maxOutputTokens: 262144,
    contextWindow: 1_000_000,
    supportsTool: true,
    supportsReasoningEffort: true,
  },
  {
    name: PLATFORM_HOSTED_KIMI_K26_MODEL,
    displayName: "Kimi K2.6",
    hasVision: true,
    price: { ...PLATFORM_HOSTED_KIMI_PRICE },
    maxOutputTokens: 262144,
    contextWindow: 262144,
    supportsTool: true,
  },

  {
    name: PLATFORM_HOSTED_GLM_52_MODEL,
    displayName: "GLM 5.2",
    hasVision: false,
    price: { ...PLATFORM_HOSTED_GLM_PRICE },
    maxOutputTokens: 131072,
    contextWindow: 1_000_000,
    supportsTool: true,
    supportsReasoningEffort: true,
  },
  {
    name: PLATFORM_HOSTED_DEEPSEEK_FLASH_MODEL,
    displayName: "DeepSeek V4 Flash",
    hasVision: false,
    price: { ...PLATFORM_HOSTED_DEEPSEEK_FLASH_PRICE },
    maxOutputTokens: 384_000,
    contextWindow: 1_000_000,
    supportsTool: true,
    supportsReasoningEffort: true,
  },
];

/** @deprecated Kept for backward compatibility. */
export const OLLAMA_CLOUD_CHAT_COMPLETIONS_URL =
  PLATFORM_HOSTED_CHAT_COMPLETIONS_URL;
/** @deprecated Kept for backward compatibility. */
export const OLLAMA_CLOUD_DEEPSEEK_FLASH_MODEL =
  PLATFORM_HOSTED_DEEPSEEK_FLASH_MODEL;
/** @deprecated Kept for backward compatibility. */
export const OLLAMA_CLOUD_DEEPSEEK_FLASH_PRICE =
  PLATFORM_HOSTED_DEEPSEEK_FLASH_PRICE;
/** @deprecated Kept for backward compatibility. */
export const OLLAMA_CLOUD_GLM_52_MODEL = PLATFORM_HOSTED_GLM_52_MODEL;
/** @deprecated Kept for backward compatibility. */
export const OLLAMA_CLOUD_GLM_PRICE = PLATFORM_HOSTED_GLM_PRICE;
/** @deprecated Kept for backward compatibility. */
export const ollamaCloudModels = platformHostedModels;
