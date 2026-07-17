import type { Model } from "./types";

// ai/llm/zai.ts
// Z.AI direct catalog empty — platform GLM 5.2 is nolo (Ollama Cloud) only.
// See packages/ai/llm/ollamaCloud.ts (OLLAMA_CLOUD_GLM_52_MODEL).

/** @deprecated Platform GLM uses nolo / glm-5.2. Kept for legacy string compares. */
export const ZAI_GLM_5_2_MODEL = "glm-5.2";

export const zaiModels: Model[] = [];
