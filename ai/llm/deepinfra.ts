// ai/llm/deepinfra.ts
// Kimi removed from catalog — platform Kimi is ollama-cloud only.

export const deepinfraModels = [
  {
    name: "zai-org/GLM-5.2",
    displayName: "Z.AI: GLM 5.2 (DeepInfra)",
    hasVision: false,
    price: {
      input: 1.4 * 7,
      output: 4.4 * 7,
      inputCacheHit: 0.25 * 7,
    },
    contextWindow: 1048576,
    maxOutputTokens: 1048576,
    supportsTool: true,
    supportsReasoningEffort: true,
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
    name: "anthropic/claude-opus-4-8",
    displayName: "Anthropic: Claude Opus 4.8",
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
