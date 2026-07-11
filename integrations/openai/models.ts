// integrations/openai/models.ts
import type { Model, ModelPrice } from "../../ai/llm/types";

const GPT_5_4_STANDARD_PRICE: ModelPrice = {
  input: 2.5 * 8,
  output: 15 * 8,
  inputCacheHit: 0.25 * 8,
};

const GPT_5_5_STANDARD_PRICE: ModelPrice = {
  input: 5 * 8,
  output: 30 * 8,
  inputCacheHit: 0.5 * 8,
};

const GPT_5_4_LONG_CONTEXT_PRICE: ModelPrice = {
  input: 5 * 8,
  output: 22.5 * 8,
  inputCacheHit: 0.5 * 8,
};

const GPT_5_5_LONG_CONTEXT_PRICE: ModelPrice = {
  input: 10 * 8,
  output: 45 * 8,
  inputCacheHit: 1 * 8,
};

const GPT_5_4_PRO_STANDARD_PRICE: ModelPrice = {
  input: 30 * 8,
  output: 180 * 8,
  inputCacheHit: 0,
};

const GPT_5_4_PRO_LONG_CONTEXT_PRICE: ModelPrice = {
  input: 60 * 8,
  output: 270 * 8,
  inputCacheHit: 0,
};
const GPT_5_6_SOL_STANDARD_PRICE: ModelPrice = {
  input: 5 * 8,
  output: 30 * 8,
  inputCacheHit: 0.5 * 8,
};

const GPT_5_6_SOL_LONG_CONTEXT_PRICE: ModelPrice = {
  input: 10 * 8,
  output: 45 * 8,
  inputCacheHit: 1 * 8,
};

const GPT_5_6_TERRA_STANDARD_PRICE: ModelPrice = {
  input: 2.5 * 8,
  output: 15 * 8,
  inputCacheHit: 0.25 * 8,
};

const GPT_5_6_TERRA_LONG_CONTEXT_PRICE: ModelPrice = {
  input: 5 * 8,
  output: 22.5 * 8,
  inputCacheHit: 0.5 * 8,
};

const GPT_5_6_LUNA_PRICE: ModelPrice = {
  input: 1 * 8,
  output: 6 * 8,
  inputCacheHit: 0.1 * 8,
};

export const openAIModels: Model[] = [
  {
    name: "gpt-5.5",
    displayName: "GPT-5.5 Standard",
    endpointKey: "responses",
    hasVision: true,
    contextWindow: 1_047_576,
    maxOutputTokens: 128_000,
    supportsReasoningEffort: true,
    price: GPT_5_5_STANDARD_PRICE,
    pricingStrategy: {
      type: "tiered_context",
      tiers: [
        {
          minContext: 272_001,
          price: GPT_5_5_LONG_CONTEXT_PRICE,
        },
      ],
    },
  },
  {
    name: "gpt-5.6-sol",
    displayName: "GPT-5.6 Sol (Flagship)",
    endpointKey: "responses",
    hasVision: true,
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    supportsReasoningEffort: true,
    price: GPT_5_6_SOL_STANDARD_PRICE,
    pricingStrategy: {
      type: "tiered_context",
      tiers: [
        {
          minContext: 272_001,
          price: GPT_5_6_SOL_LONG_CONTEXT_PRICE,
        },
      ],
    },
  },
  {
    name: "gpt-5.6-terra",
    displayName: "GPT-5.6 Terra (Balanced)",
    endpointKey: "responses",
    hasVision: true,
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    supportsReasoningEffort: true,
    price: GPT_5_6_TERRA_STANDARD_PRICE,
    pricingStrategy: {
      type: "tiered_context",
      tiers: [
        {
          minContext: 272_001,
          price: GPT_5_6_TERRA_LONG_CONTEXT_PRICE,
        },
      ],
    },
  },
  {
    name: "gpt-5.6-luna",
    displayName: "GPT-5.6 Luna (Fast)",
    endpointKey: "responses",
    hasVision: true,
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    supportsReasoningEffort: true,
    price: GPT_5_6_LUNA_PRICE,
  },
  {
    name: "gpt-5.5-pro",
    displayName: "GPT-5.5 Pro",
    endpointKey: "responses",
    hasVision: true,
    contextWindow: 1_047_576,
    maxOutputTokens: 128_000,
    supportsReasoningEffort: true,
    price: GPT_5_4_PRO_STANDARD_PRICE,
    pricingStrategy: {
      type: "tiered_context",
      tiers: [
        {
          minContext: 272_001,
          price: GPT_5_4_PRO_LONG_CONTEXT_PRICE,
        },
      ],
    },
  },
  {
    name: "gpt-image-2",
    displayName: "GPT Image 2",
    endpointKey: "responses",
    hasVision: true,
    hasImageOutput: true,
    supportsImageOutput: true,
    supportsTool: false,
    contextWindow: 128_000,
    maxOutputTokens: 32_768,
    price: { input: 5 * 8, output: 0, inputCacheHit: 1.25 * 8 },
    pricePerImage: undefined, // Dynamic cost via imageTokenPricePerMillion and quality/size
    imageTokenPricePerMillion: 30 * 8, // $30.00 per 1M output tokens
    // Official GPT Image 2 output estimates from the OpenAI image guide:
    // low/medium/high cost by size divided by $30 per 1M output tokens.
    imageOutputTokenEstimateBySize: {
      "1K": { low: 200, medium: 1766, high: 7033 },
      "2K": { low: 166, medium: 1366, high: 5500 },
      "4K": { low: 166, medium: 1366, high: 5500 },
    },
  },
  {
    name: "gpt-5.4",
    displayName: "GPT-5.4 Standard",
    endpointKey: "responses",
    hasVision: true,
    contextWindow: 1_047_576,
    maxOutputTokens: 128_000,
    supportsReasoningEffort: true,
    price: GPT_5_4_STANDARD_PRICE,
    pricingStrategy: {
      type: "tiered_context",
      tiers: [
        {
          minContext: 272_001,
          price: GPT_5_4_LONG_CONTEXT_PRICE,
        },
      ],
    },
  },
  {
    name: "gpt-5.4-mini",
    displayName: "GPT-5.4 Mini",
    endpointKey: "responses",
    hasVision: true,
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    supportsReasoningEffort: true,
    price: { input: 0.75 * 8, output: 4.5 * 8, inputCacheHit: 0.075 * 8 },
  },
  {
    name: "gpt-5.4-nano",
    displayName: "GPT-5.4 Nano",
    endpointKey: "responses",
    hasVision: true,
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    supportsReasoningEffort: true,
    price: { input: 0.2 * 8, output: 1.25 * 8, inputCacheHit: 0.02 * 8 },
  },
  {
    name: "gpt-5.4-pro",
    displayName: "GPT-5.4 Pro",
    endpointKey: "responses",
    hasVision: true,
    contextWindow: 1_047_576,
    maxOutputTokens: 128_000,
    supportsReasoningEffort: true,
    price: GPT_5_4_PRO_STANDARD_PRICE,
    pricingStrategy: {
      type: "tiered_context",
      tiers: [
        {
          minContext: 272_001,
          price: GPT_5_4_PRO_LONG_CONTEXT_PRICE,
        },
      ],
    },
  },
  {
    name: "gpt-5",
    displayName: "GPT-5",
    hasVision: true,
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    supportsReasoningEffort: true,
    price: { input: 1.25 * 8, output: 10 * 8, inputCacheHit: 0.125 * 8 },
  },
  {
    name: "gpt-5-mini",
    displayName: "GPT-5 mini",
    hasVision: true,
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    supportsReasoningEffort: true,
    price: { input: 0.25 * 8, output: 2 * 8, inputCacheHit: 0.025 * 8 },
  },
];
