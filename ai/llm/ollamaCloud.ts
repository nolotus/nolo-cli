// packages/ai/llm/ollamaCloud.ts
// Platform catalog for Ollama Cloud only (not local 127.0.0.1 Ollama).
// Public provider id is `nolo` (see providers.ts MODEL_MAP).

import { asTrimmedLowercaseString } from "../../core/trimmedLowercaseString";
import {
  OLLAMA_CLOUD_KIMI_K26_MODEL,
  OLLAMA_CLOUD_KIMI_K27_CODE_MODEL,
} from "./kimi";

/**
 * Ollama Cloud is a flat monthly plan, so cost per token is measured rather than
 * quoted: burn one token side until Weekly % moves, then 1% weekly ≈ $0.05.
 *
 * Credits carry the provider's margin the same way the metered catalogs do —
 * `USD * 8`, matching openai/fireworks (deepinfra uses 9). A bare `USD * 7` is the
 * zero-margin identity (1 USD = 7 credits) and would sell these at cost.
 *
 * 2026-07-14 split input/output calibration, Δweekly ≥ 0.5% per leg → ±20%:
 * Kimi INPUT 0.5% on ~2.58M prompt → $0.0097/1M; OUTPUT 0.8% on ~0.197M
 * completion → $0.2035/1M.
 *
 * The previous 0.18/0.18 came from a blended burn that was never split by leg.
 * Such a burn is dominated by prompt tokens, so the single number it produced was
 * effectively the input price — then applied to output, which costs ~20x more.
 */
export const OLLAMA_CLOUD_KIMI_PRICE = {
  input: 0.08,
  output: 1.65,
} as const;

/**
 * GLM 5.2, same split calibration (2026-07-14):
 * INPUT 0.6% on ~0.74M prompt → $0.0408/1M; OUTPUT 0.5% on ~0.098M completion
 * → $0.2543/1M. Previous 0.23/0.23 shares the blended-burn error described above.
 */
export const OLLAMA_CLOUD_GLM_PRICE = {
  input: 0.33,
  output: 2.05,
} as const;

/** Ollama Cloud model id for GLM 5.2 (platform catalog). */
export const OLLAMA_CLOUD_GLM_52_MODEL = "glm-5.2";

/**
 * DeepSeek V4 Flash on Ollama Cloud. Same model id as official DeepSeek so
 * fallback can reuse deepseek-v4-flash on api.deepseek.com.
 *
 * 2026-07-14 single-model Weekly-tick calibration (1% weekly ≈ $0.05):
 * INPUT leg 10.1→10.3% on ~2.65M prompt tokens → $0.0038/1M; OUTPUT leg
 * 10.3→10.5% on ~0.445M completion → $0.0225/1M. Priced `USD * 8` as above.
 *
 * Measured at Δweekly = 0.2%, which is ±50%: two UI reads at 0.1% precision put
 * ±0.1 on any Δ regardless of its size. The later Kimi/GLM legs used Δ ≥ 0.5%
 * (±20%); re-run this one the same way before leaning on these two numbers.
 */
export const OLLAMA_CLOUD_DEEPSEEK_FLASH_MODEL = "deepseek-v4-flash";
export const OLLAMA_CLOUD_DEEPSEEK_FLASH_PRICE = {
  input: 0.03,
  output: 0.18,
} as const;

export const OLLAMA_CLOUD_CHAT_COMPLETIONS_URL =
  "https://ollama.com/v1/chat/completions";

/** Official DeepSeek OpenAI-compatible chat endpoint (Flash fallback / Pro primary). */
export const DEEPSEEK_OFFICIAL_CHAT_COMPLETIONS_URL =
  "https://api.deepseek.com/chat/completions";

/** Statuses that allow Ollama Flash → official DeepSeek fallback. */
export const DEEPSEEK_FLASH_OLLAMA_FALLBACK_STATUSES = [
  401, 402, 429, 500, 502, 503, 504,
];

export const isOllamaCloudDeepseekFlashModel = (
  model?: string | null
): boolean => model === OLLAMA_CLOUD_DEEPSEEK_FLASH_MODEL;

/**
 * Platform DeepSeek Flash (hosted): nolo/ollama-cloud catalog or legacy
 * deepseek provider records still pointing at deepseek-v4-flash.
 * Custom / explicit user keys stay on official DeepSeek only.
 */
export const isPlatformDeepseekFlashHosted = (
  provider?: string | null,
  model?: string | null
): boolean => {
  if (!isOllamaCloudDeepseekFlashModel(model)) return false;
  const p = asTrimmedLowercaseString(provider);
  return (
    p === "nolo" ||
    p === "ollama-cloud" ||
    p === "deepseek"
  );
};

export const ollamaCloudModels = [
  {
    name: OLLAMA_CLOUD_KIMI_K26_MODEL,
    displayName: "Kimi K2.6",
    hasVision: true,
    price: { ...OLLAMA_CLOUD_KIMI_PRICE },
    maxOutputTokens: 262144,
    contextWindow: 262144,
    supportsTool: true,
  },
  {
    name: OLLAMA_CLOUD_KIMI_K27_CODE_MODEL,
    displayName: "Kimi K2.7 Coding",
    hasVision: true,
    price: { ...OLLAMA_CLOUD_KIMI_PRICE },
    maxOutputTokens: 262144,
    contextWindow: 256000,
    supportsTool: true,
  },
  {
    name: OLLAMA_CLOUD_GLM_52_MODEL,
    displayName: "GLM 5.2",
    hasVision: false,
    price: { ...OLLAMA_CLOUD_GLM_PRICE },
    maxOutputTokens: 131072,
    contextWindow: 1_000_000,
    supportsTool: true,
    supportsReasoningEffort: true,
  },
  {
    name: OLLAMA_CLOUD_DEEPSEEK_FLASH_MODEL,
    displayName: "DeepSeek V4 Flash",
    hasVision: false,
    price: { ...OLLAMA_CLOUD_DEEPSEEK_FLASH_PRICE },
    maxOutputTokens: 384_000,
    contextWindow: 1_000_000,
    supportsTool: true,
    supportsReasoningEffort: true,
  },
];
