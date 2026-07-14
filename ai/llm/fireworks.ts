// ai/llm/fireworks.ts
// Kimi + GLM removed from catalog — platform Kimi/GLM are nolo (Ollama Cloud) only.

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
];
