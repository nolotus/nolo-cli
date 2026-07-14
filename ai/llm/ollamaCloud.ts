// packages/ai/llm/ollamaCloud.ts
// Platform catalog for Ollama Cloud only (not local 127.0.0.1 Ollama).
// Public provider id is `nolo` (see providers.ts MODEL_MAP).

import {
  OLLAMA_CLOUD_KIMI_K26_MODEL,
  OLLAMA_CLOUD_KIMI_K27_CODE_MODEL,
} from "./kimi";

/** Upper-bound platform prices from 2026-07-14 Ollama Cloud calibration ($/1M). */
export const OLLAMA_CLOUD_KIMI_PRICE = {
  input: 0.18,
  output: 0.18,
} as const;

/** GLM 5.2 upper-bound from sequential Weekly-% calibration (2026-07-14). */
export const OLLAMA_CLOUD_GLM_PRICE = {
  input: 0.23,
  output: 0.23,
} as const;

/** Ollama Cloud model id for GLM 5.2 (platform catalog). */
export const OLLAMA_CLOUD_GLM_52_MODEL = "glm-5.2";

/**
 * DeepSeek V4 Flash on Ollama Cloud. Same model id as official DeepSeek so
 * fallback can reuse deepseek-v4-flash on api.deepseek.com.
 *
 * 2026-07-14 single-model Weekly-tick calibration (credits = USD × 7,
 * 1% weekly ≈ $0.05): INPUT leg 10.1→10.3% on ~2.65M prompt tokens →
 * ~0.026 积分/1M; OUTPUT leg 10.3→10.5% on ~0.445M completion → ~0.157.
 * Catalog rounds slightly up for clean billing: 0.03 / 0.16.
 */
export const OLLAMA_CLOUD_DEEPSEEK_FLASH_MODEL = "deepseek-v4-flash";
export const OLLAMA_CLOUD_DEEPSEEK_FLASH_PRICE = {
  input: 0.03,
  output: 0.16,
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
  const p = provider?.trim().toLowerCase();
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
