const REASONING_MODEL_NAMES = new Set([
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "gemini-2.5-pro",
  "gemini-3.5-flash",
  "gemini-3-flash-preview",
  "gemini-3-pro-preview",
  "gemini-3.1-pro-preview",
  "gpt-5.5",
  "gpt-5.5-flex",
  "gpt-5.5-pro",
  "gpt-5.5-pro-flex",
  "gpt-5.4",
  "gpt-5.4-flex",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.4-pro",
  "gpt-5.4-pro-flex",
  "gpt-5",
  "gpt-5-mini",
  "o3-pro",
]);

export const isModelSupportReasoningEffort = (model: string): boolean =>
  REASONING_MODEL_NAMES.has(model);

export const supportedReasoningModels = Array.from(REASONING_MODEL_NAMES);
