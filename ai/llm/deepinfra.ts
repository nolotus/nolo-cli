// ai/llm/deepinfra.ts
import { DEEPINFRA_KIMI_FALLBACK_MODEL } from "./kimi";

export const deepinfraModels = [
  {
    name: DEEPINFRA_KIMI_FALLBACK_MODEL,
    displayName: "MoonshotAI: Kimi K2.6 (DeepInfra)",
    hasVision: true,
    price: {
      input: 0.6 * 7,
      output: 2.5 * 7,
      inputCacheHit: 0.06 * 7,
    },
    maxOutputTokens: 262144,
    contextWindow: 262144,
    supportsTool: true,
  },
  {
    name: "moonshotai/Kimi-K2.5",
    displayName: "MoonshotAI: Kimi K2.5 (DeepInfra)",
    hasVision: true,
    price: {
      input: 0.45 * 7,
      output: 2.25 * 7,
      inputCacheHit: 0.07 * 7,
    },
    maxOutputTokens: 262144,
    contextWindow: 262144,
    supportsTool: true,
  },
  {
    name: "zai-org/GLM-5.1",
    displayName: "Z.AI: GLM 5.1 (DeepInfra)",
    hasVision: false,
    price: {
      input: 1.26 * 7,
      output: 3.96 * 7,
      inputCacheHit: 0.26 * 7,
    },
    contextWindow: 202752,
    supportsTool: true,
  },
  {
    name: "anthropic/claude-haiku-4-5",
    displayName: "Anthropic: Claude Haiku 4.5",
    hasVision: true,
    price: {
      input: 1 * 9,
      output: 5 * 9,
    },
    contextWindow: 195000,
    maxOutputTokens: 4092,
    supportsTool: false,
  },
  {
    name: "anthropic/claude-sonnet-4-6",
    displayName: "Anthropic: Claude Sonnet 4.6",
    hasVision: true,
    price: {
      input: 3 * 9,
      output: 15 * 9,
    },
    contextWindow: 976000,
    maxOutputTokens: 4092,
    supportsTool: false,
  },
  {
    name: "anthropic/claude-opus-4-7",
    displayName: "Anthropic: Claude Opus 4.7",
    hasVision: true,
    price: {
      input: 5 * 9,
      output: 25 * 9,
    },
    contextWindow: 976000,
    maxOutputTokens: 4092,
    supportsTool: false,
  },
];
