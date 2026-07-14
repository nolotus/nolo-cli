// ai/llm/cloudflare.ts
// Docs: https://developers.cloudflare.com/workers-ai/models/glm-5.2/
// GLM removed — platform GLM 5.2 is nolo (Ollama Cloud) only.

/** @deprecated Platform GLM uses nolo / glm-5.2. */
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

export const cloudflareModels: Array<Record<string, unknown>> = [];
