// ai/llm/fireworks.ts
// Kimi removed from catalog — platform Kimi is ollama-cloud only.

export const fireworksModels = [
  {
    name: "accounts/fireworks/models/minimax-m3",
    displayName: "MiniMax: MiniMax M3",
    hasVision: true,
    price: {
      input: 0.3 * 8,
      output: 1.2 * 8,
      cachingRead: 0.06 * 8,
    },
    contextWindow: 512000,
    supportsTool: true,
  },
  {
    name: "accounts/fireworks/models/glm-5p2",
    displayName: "Z.AI: GLM 5.2",
    hasVision: false,
    price: {
      input: 1.4 * 8,
      output: 4.4 * 8,
      cachingRead: 0.25 * 8,
    },
    contextWindow: 1048576,
    maxOutputTokens: 1048576,
    supportsTool: true,
    supportsReasoningEffort: true,
  },
];
