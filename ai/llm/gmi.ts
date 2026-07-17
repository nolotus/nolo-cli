import type { Model } from "./types";

// ai/llm/gmi.ts
// Docs: https://docs.gmicloud.ai/inference-engine/api-reference/llm-api-reference
// GLM removed — platform GLM 5.2 is nolo (Ollama Cloud) only.

export const GMI_CHAT_COMPLETIONS_URL =
  "https://api.gmi-serving.com/v1/chat/completions";

/** @deprecated Platform GLM uses nolo / glm-5.2. */
export const GMI_GLM_5_2_MODEL = "zai-org/GLM-5.2-FP8";

export const gmiModels: Model[] = [];
