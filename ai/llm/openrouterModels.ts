import type { Model } from "./types";

const OPENROUTER_PRICE_MULTIPLIER = 7;

export const OPENROUTER_MODELS: Model[] = [
  {
    name: "x-ai/grok-4.3",
    displayName: "xAI: Grok 4.3",
    hasVision: true,
    contextWindow: 1_000_000,
    supportsTool: true,
    supportsReasoningEffort: true,
    price: {
      input: 1.25 * OPENROUTER_PRICE_MULTIPLIER,
      output: 2.5 * OPENROUTER_PRICE_MULTIPLIER,
    },
  },
  {
    name: "minimax/minimax-m3",
    displayName: "MiniMax: MiniMax M3",
    hasVision: true,
    contextWindow: 1_000_000,
    supportsTool: true,
    price: {
      input: 0.3 * OPENROUTER_PRICE_MULTIPLIER,
      output: 1.2 * OPENROUTER_PRICE_MULTIPLIER,
    },
  },
];

export const openrouterModels = OPENROUTER_MODELS;
