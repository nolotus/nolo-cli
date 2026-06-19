// ai/llm/cloudflare.ts
// Docs: https://developers.cloudflare.com/workers-ai/models/glm-5.2/

export const CF_GLM_5_2_MODEL = "@cf/zai-org/glm-5.2";

export const getCloudflareWorkersAiChatCompletionsUrl = (
  accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim()
): string => {
  if (!accountId) {
    throw new Error(
      "CLOUDFLARE_ACCOUNT_ID is required for Cloudflare Workers AI chat completions"
    );
  }
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;
};

export const cloudflareModels = [
  {
    name: CF_GLM_5_2_MODEL,
    displayName: "Z.AI: GLM 5.2 (Cloudflare)",
    hasVision: false,
    price: {
      input: 1.4 * 8,
      output: 4.4 * 8,
      inputCacheHit: 0.26 * 8,
    },
    contextWindow: 262144,
    maxOutputTokens: 262144,
    supportsTool: true,
    supportsReasoningEffort: true,
  },
];