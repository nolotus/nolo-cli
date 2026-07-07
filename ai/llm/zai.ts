// ai/llm/zai.ts
// Z.AI (z.ai) 官方模型注册表
// Docs: https://z.ai

export const ZAI_GLM_5_2_MODEL = "glm-5.2";

export const zaiModels = [
  {
    name: ZAI_GLM_5_2_MODEL,
    displayName: "Z.AI: GLM 5.2",
    hasVision: false,
    price: {
      input: 1.4,
      output: 4.4,
      inputCacheHit: 0.26,
    },
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    supportsTool: true,
    supportsReasoningEffort: true,
  },
];
