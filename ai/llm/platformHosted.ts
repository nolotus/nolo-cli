// packages/ai/llm/platformHosted.ts
// Platform catalog for hosted models (upstream provider is abstracted).
// Public provider id is `nolo` (see providers.ts MODEL_MAP).

import { asTrimmedLowercaseString } from "../../core/trimmedLowercaseString";
import {
  PLATFORM_HOSTED_KIMI_K26_MODEL,
  PLATFORM_HOSTED_KIMI_K27_CODE_MODEL,
} from "./kimi";

/**
 * Platform hosted Kimi price calibration configurations (measured per 1M tokens).
 */
export const PLATFORM_HOSTED_KIMI_PRICE = {
  input: 0.08,
  output: 1.65,
} as const;

/**
 * Platform hosted GLM price calibration configurations (measured per 1M tokens).
 */
export const PLATFORM_HOSTED_GLM_PRICE = {
  input: 0.33,
  output: 2.05,
} as const;

/** Platform hosted model id for GLM 5.2 (platform catalog). */
export const PLATFORM_HOSTED_GLM_52_MODEL = "glm-5.2";

/**
 * Platform hosted DeepSeek V4 Flash. Same model id as official DeepSeek so
 * fallback can reuse deepseek-v4-flash on api.deepseek.com.
 */
export const PLATFORM_HOSTED_DEEPSEEK_FLASH_MODEL = "deepseek-v4-flash";
export const PLATFORM_HOSTED_DEEPSEEK_FLASH_PRICE = {
  input: 0.03,
  output: 0.16,
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
  model?: string | null
): boolean => model === PLATFORM_HOSTED_DEEPSEEK_FLASH_MODEL;

/**
 * Platform DeepSeek Flash (hosted): nolo/platform-hosted catalog or legacy
 * deepseek provider records still pointing at deepseek-v4-flash.
 * Custom / explicit user keys stay on official DeepSeek only.
 */
export const isPlatformDeepseekFlashHosted = (
  provider?: string | null,
  model?: string | null
): boolean => {
  if (!isPlatformHostedDeepseekFlashModel(model)) return false;
  const p = asTrimmedLowercaseString(provider);
  return (
    p === "nolo" ||
    p === "nolo-hosted" ||
    p === "ollama-cloud" || // Backward compatibility
    p === "deepseek"
  );
};

export const platformHostedModels = [
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
    price: { ...PLATFORM_HOSTED_KIMI_PRICE },
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
export const OLLAMA_CLOUD_CHAT_COMPLETIONS_URL = PLATFORM_HOSTED_CHAT_COMPLETIONS_URL;
/** @deprecated Kept for backward compatibility. */
export const OLLAMA_CLOUD_DEEPSEEK_FLASH_MODEL = PLATFORM_HOSTED_DEEPSEEK_FLASH_MODEL;
/** @deprecated Kept for backward compatibility. */
export const OLLAMA_CLOUD_DEEPSEEK_FLASH_PRICE = PLATFORM_HOSTED_DEEPSEEK_FLASH_PRICE;
/** @deprecated Kept for backward compatibility. */
export const OLLAMA_CLOUD_GLM_52_MODEL = PLATFORM_HOSTED_GLM_52_MODEL;
/** @deprecated Kept for backward compatibility. */
export const OLLAMA_CLOUD_GLM_PRICE = PLATFORM_HOSTED_GLM_PRICE;
/** @deprecated Kept for backward compatibility. */
export const DEEPSEEK_FLASH_OLLAMA_FALLBACK_STATUSES = DEEPSEEK_FLASH_HOSTED_FALLBACK_STATUSES;
/** @deprecated Kept for backward compatibility. */
export const ollamaCloudModels = platformHostedModels;
