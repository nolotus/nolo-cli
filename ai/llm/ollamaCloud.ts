// packages/ai/llm/ollamaCloud.ts
// Platform catalog for Ollama Cloud only (not local 127.0.0.1 Ollama).

import {
  OLLAMA_CLOUD_KIMI_K26_MODEL,
  OLLAMA_CLOUD_KIMI_K27_CODE_MODEL,
} from "./kimi";

/** Upper-bound platform prices from 2026-07-14 Ollama Cloud calibration ($/1M). */
export const OLLAMA_CLOUD_KIMI_PRICE = {
  input: 0.18,
  output: 0.18,
} as const;

export const OLLAMA_CLOUD_CHAT_COMPLETIONS_URL =
  "https://ollama.com/v1/chat/completions";

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
];
