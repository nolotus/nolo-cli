const REASONING_MODEL_NAMES = new Set([
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "gemini-3.5-flash",
  "gemini-3-flash-preview",
  "gemini-3-pro-preview",
  "gemini-3.1-pro-preview",
  "gpt-5.5-pro",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "glm-5.2",
  // Legacy OpenAI catalog ids — still support reasoning UI for agents that
  // were never re-seeded after GPT-5.4 / GPT-5 were retired from the picker.
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.4-pro",
  "gpt-5",
  "gpt-5-mini",
  // Legacy model ids from retired Fireworks/DeepInfra/GMI/CF/Z.AI catalog rows
  "@cf/zai-org/glm-5.2",
  "zai-org/GLM-5.2",
  "accounts/fireworks/models/glm-5p2",
  "zai-org/GLM-5.2-FP8",
]);

export const isModelSupportReasoningEffort = (model: string): boolean =>
  REASONING_MODEL_NAMES.has(model);

export const supportedReasoningModels = Array.from(REASONING_MODEL_NAMES);
