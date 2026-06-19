// ai/llm/gmi.ts
// Docs: https://docs.gmicloud.ai/inference-engine/api-reference/llm-api-reference

export const GMI_CHAT_COMPLETIONS_URL =
  "https://api.gmi-serving.com/v1/chat/completions";

export const GMI_GLM_5_2_MODEL = "zai-org/GLM-5.2-FP8";

export const gmiModels = [
  {
    name: GMI_GLM_5_2_MODEL,
    displayName: "Z.AI: GLM 5.2 (GMI)",
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
];