// packages/ai/llm/ollamaCloud.ts
// Legacy compatibility facade. The active nolo catalog lives in platformHosted.ts.

import { asTrimmedLowercaseString } from "../../core/trimmedLowercaseString";
import {
  PLATFORM_HOSTED_CHAT_COMPLETIONS_URL,
  PLATFORM_HOSTED_DEEPSEEK_FLASH_MODEL,
  PLATFORM_HOSTED_DEEPSEEK_FLASH_PRICE,
  PLATFORM_HOSTED_GLM_52_MODEL,
  PLATFORM_HOSTED_GLM_PRICE,
  PLATFORM_HOSTED_KIMI_K3_PRICE,
  PLATFORM_HOSTED_KIMI_PRICE,
  platformHostedModels,
} from "./platformHosted";
import {
  PLATFORM_HOSTED_KIMI_K26_MODEL,
  PLATFORM_HOSTED_KIMI_K3_MODEL,
} from "./kimi";

// Keep the old names available to existing imports. All values point to the
// active platform catalog so the pricing page and runtime cannot drift apart.
export const OLLAMA_CLOUD_KIMI_K3_MODEL = PLATFORM_HOSTED_KIMI_K3_MODEL;
export const OLLAMA_CLOUD_KIMI_K26_MODEL = PLATFORM_HOSTED_KIMI_K26_MODEL;
export const OLLAMA_CLOUD_KIMI_PRICE = PLATFORM_HOSTED_KIMI_PRICE;
export const OLLAMA_CLOUD_KIMI_K3_PRICE = PLATFORM_HOSTED_KIMI_K3_PRICE;
export const OLLAMA_CLOUD_DEEPSEEK_FLASH_MODEL =
  PLATFORM_HOSTED_DEEPSEEK_FLASH_MODEL;
// Legacy GLM exports restored: platform catalog hosts GLM 5.2 again, so the
// compatibility exports point at the platform truth (8 折 Z.AI 官方价).
export const OLLAMA_CLOUD_GLM_52_MODEL = PLATFORM_HOSTED_GLM_52_MODEL;
export const OLLAMA_CLOUD_GLM_PRICE = PLATFORM_HOSTED_GLM_PRICE;
export const OLLAMA_CLOUD_DEEPSEEK_FLASH_PRICE =
  PLATFORM_HOSTED_DEEPSEEK_FLASH_PRICE;
export const OLLAMA_CLOUD_CHAT_COMPLETIONS_URL =
  PLATFORM_HOSTED_CHAT_COMPLETIONS_URL;
// Legacy catalog names remain for compatibility; DeepSeek Flash now routes to the official API.
export const ollamaCloudModels = platformHostedModels;

export const isOllamaCloudDeepseekFlashModel = (
  model?: string | null,
): boolean => model === OLLAMA_CLOUD_DEEPSEEK_FLASH_MODEL;

/**
 * Platform DeepSeek Flash (hosted): nolo catalog or legacy `deepseek` provider
 * records still pointing at deepseek-v4-flash. The runtime routes it to the
 * official DeepSeek API while preserving these legacy catalog names.
 */
export const isPlatformDeepseekFlashHosted = (
  provider?: string | null,
  model?: string | null,
): boolean => {
  if (!isOllamaCloudDeepseekFlashModel(model)) return false;
  const p = asTrimmedLowercaseString(provider);
  return p === "nolo" || p === "ollama-cloud" || p === "deepseek";
};
