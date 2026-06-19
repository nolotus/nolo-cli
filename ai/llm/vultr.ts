// ai/llm/vultr.ts
import { VULTR_KIMI_MODEL } from "./kimi";

export const vultrModels = [
  {
    name: VULTR_KIMI_MODEL,
    displayName: "MoonshotAI: Kimi K2.6 (Vultr)",
    hasVision: true,
    price: {
      input: 0.3 * 8,
      output: 1.2 * 8,
    },
    maxOutputTokens: 262144,
    contextWindow: 262144,
    supportsTool: true,
  },
];
