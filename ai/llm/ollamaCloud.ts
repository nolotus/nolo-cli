// packages/ai/llm/ollamaCloud.ts
// Legacy compatibility facade. The active nolo catalog lives in platformHosted.ts.

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
export const OLLAMA_CLOUD_GLM_52_MODEL = PLATFORM_HOSTED_GLM_52_MODEL;
export const OLLAMA_CLOUD_GLM_PRICE = PLATFORM_HOSTED_GLM_PRICE;
export const OLLAMA_CLOUD_DEEPSEEK_FLASH_MODEL =
  PLATFORM_HOSTED_DEEPSEEK_FLASH_MODEL;
export const OLLAMA_CLOUD_DEEPSEEK_FLASH_PRICE =
  PLATFORM_HOSTED_DEEPSEEK_FLASH_PRICE;
export const OLLAMA_CLOUD_CHAT_COMPLETIONS_URL =
  PLATFORM_HOSTED_CHAT_COMPLETIONS_URL;
// Deprecated DeepSeek official API constants removed — provider was retired.
export const ollamaCloudModels = platformHostedModels;

export const isOllamaCloudDeepseekFlashModel = (
  model?: string | null,
): boolean => model === OLLAMA_CLOUD_DEEPSEEK_FLASH_MODEL;
