// packages/ai/llm/platformHosted.ts
// Platform catalog for hosted models (upstream provider is abstracted).
// Public provider id is `nolo` (see providers.ts MODEL_MAP).

import { asTrimmedLowercaseString } from "../../core/trimmedLowercaseString";
import {
  PLATFORM_HOSTED_KIMI_K26_MODEL,
  PLATFORM_HOSTED_KIMI_K27_CODE_MODEL,
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
 * Kimi K2.7 Coding 官方 API $1.2/$4.8 per 1M，nolo 对外 8 折。
 */
export const PLATFORM_HOSTED_KIMI_K27_CODE_PRICE = {
  input: toPlatformCredits(1.2),
  output: toPlatformCredits(4.8),
} as const;

/**
 * Kimi K3 官方 API $3/$15 per 1M，nolo 对外 8 折。
 */
export const PLATFORM_HOSTED_KIMI_K3_PRICE = {
  input: toPlatformCredits(3),
  output: toPlatformCredits(15),
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
 * nolo 内部生产环境的上游路由（组合 ollama cloud + 自有机器 + 官方 DeepSeek 等）
 * 不在开源仓库内——这部分由内部 provider 路由层接管，不暴露具体后端组合。
 * 当前开源实现只做单一中转：nolo provider → ollama cloud。
 */
export const PLATFORM_HOSTED_CHAT_COMPLETIONS_URL =
  "https://ollama.com/v1/chat/completions";

/** Official DeepSeek OpenAI-compatible chat endpoint (Flash fallback / Pro primary). */
export const DEEPSEEK_OFFICIAL_CHAT_COMPLETIONS_URL =
  "https://api.deepseek.com/chat/completions";

/** Statuses that allow Platform Flash -> official DeepSeek fallback. */
export const DEEPSEEK_FLASH_HOSTED_FALLBACK_STATUSES = [
  401, 402, 429, 500, 502, 503, 504,
];

export const isPlatformHostedDeepseekFlashModel = (
  model?: string | null,
): boolean => model === PLATFORM_HOSTED_DEEPSEEK_FLASH_MODEL;

/**
 * Platform DeepSeek Flash (hosted): nolo/platform-hosted catalog or legacy
 * deepseek provider records still pointing at deepseek-v4-flash.
 * Custom / explicit user keys stay on official DeepSeek only.
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
    name: PLATFORM_HOSTED_KIMI_K27_CODE_MODEL,
    displayName: "Kimi K2.7 Coding",
    hasVision: true,
    price: { ...PLATFORM_HOSTED_KIMI_K27_CODE_PRICE },
    maxOutputTokens: 262144,
    contextWindow: 256000,
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
export const DEEPSEEK_FLASH_OLLAMA_FALLBACK_STATUSES =
  DEEPSEEK_FLASH_HOSTED_FALLBACK_STATUSES;
/** @deprecated Kept for backward compatibility. */
export const ollamaCloudModels = platformHostedModels;
