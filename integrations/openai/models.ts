// integrations/openai/models.ts
import type { Model, ModelPrice } from "../../ai/llm/types";

const scalePrice = (price: ModelPrice, multiplier: number): ModelPrice => ({
  input: price.input * multiplier,
  output: price.output * multiplier,
  ...(typeof price.cachingWrite === "number"
    ? { cachingWrite: price.cachingWrite * multiplier }
    : {}),
  ...(typeof price.cachingRead === "number"
    ? { cachingRead: price.cachingRead * multiplier }
    : {}),
  ...(typeof price.inputCacheHit === "number"
    ? { inputCacheHit: price.inputCacheHit * multiplier }
    : {}),
});

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
    name: "gpt-5.5-flex",
    displayName: "GPT-5.5 Flex",
    endpointKey: "responses",
    hasVision: true,
    contextWindow: 1_047_576,
    maxOutputTokens: 128_000,
    supportsReasoningEffort: true,
    price: scalePrice(GPT_5_5_STANDARD_PRICE, 0.5),
    pricingStrategy: {
      type: "tiered_context",
      tiers: [
        {
          minContext: 272_001,
          price: scalePrice(GPT_5_5_LONG_CONTEXT_PRICE, 0.5),
        },
      ],
    },
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
    name: "gpt-5.5-pro-flex",
    displayName: "GPT-5.5 Pro Flex",
    endpointKey: "responses",
    hasVision: true,
    contextWindow: 1_047_576,
    maxOutputTokens: 128_000,
    supportsReasoningEffort: true,
    price: scalePrice(GPT_5_4_PRO_STANDARD_PRICE, 0.5),
    pricingStrategy: {
      type: "tiered_context",
      tiers: [
        {
          minContext: 272_001,
          price: scalePrice(GPT_5_4_PRO_LONG_CONTEXT_PRICE, 0.5),
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
    // OpenAI's current public pricing page does not list GPT Image 2 separately.
    // Reuse GPT Image 1.5 pricing as a conservative placeholder until official
    // GPT Image 2 pricing is published.
    price: { input: 5 * 8, output: 10 * 8, inputCacheHit: 1.25 * 8 },
    pricePerImage: 0.04 * 8,
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
    name: "gpt-5.4-flex",
    displayName: "GPT-5.4 Flex",
    endpointKey: "responses",
    hasVision: true,
    contextWindow: 1_047_576,
    maxOutputTokens: 128_000,
    supportsReasoningEffort: true,
    price: scalePrice(GPT_5_4_STANDARD_PRICE, 0.5),
    pricingStrategy: {
      type: "tiered_context",
      tiers: [
        {
          minContext: 272_001,
          price: scalePrice(GPT_5_4_LONG_CONTEXT_PRICE, 0.5),
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
    name: "gpt-5.4-pro-flex",
    displayName: "GPT-5.4 Pro Flex",
    endpointKey: "responses",
    hasVision: true,
    contextWindow: 1_047_576,
    maxOutputTokens: 128_000,
    supportsReasoningEffort: true,
    price: scalePrice(GPT_5_4_PRO_STANDARD_PRICE, 0.5),
    pricingStrategy: {
      type: "tiered_context",
      tiers: [
        {
          minContext: 272_001,
          price: scalePrice(GPT_5_4_PRO_LONG_CONTEXT_PRICE, 0.5),
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
