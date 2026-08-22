// ai/llm/deepinfra.ts
// Kimi + GLM removed from catalog — platform Kimi/GLM are nolo (Ollama Cloud) only.
// Claude models: 记录侧统一走 nolo provider（平台代理），实际上游仍是 deepinfra，
// 价格沿用 deepinfra 人民币报价（haiku/sonnet ×9，opus/fable ×8）。platformHosted.ts
// 复用本文件的价格常量，避免两处魔法数字漂移。

export const DEEPINFRA_CLAUDE_HAIKU_PRICE = {
  input: 1 * 9,
  output: 5 * 9,
} as const;

export const DEEPINFRA_CLAUDE_SONNET_PRICE = {
  input: 3 * 9,
  output: 15 * 9,
} as const;

export const DEEPINFRA_CLAUDE_OPUS_PRICE = {
  input: 5 * 8,
  output: 25 * 8,
} as const;

export const DEEPINFRA_CLAUDE_FABLE_PRICE = {
  input: 10 * 8,
  output: 50 * 8,
} as const;

export const deepinfraModels = [
  {
    name: "anthropic/claude-haiku-4-5",
    displayName: "Anthropic: Claude Haiku 4.5",
    hasVision: true,
    price: { ...DEEPINFRA_CLAUDE_HAIKU_PRICE },
    contextWindow: 195000,
    maxOutputTokens: 4092,
    supportsTool: false,
  },
  {
    name: "anthropic/claude-sonnet-5",
    displayName: "Anthropic: Claude Sonnet 5",
    hasVision: true,
    price: { ...DEEPINFRA_CLAUDE_SONNET_PRICE },
    contextWindow: 976000,
    maxOutputTokens: 4092,
    supportsTool: false,
  },
  {
    name: "anthropic/claude-opus-5",
    displayName: "Anthropic: Claude Opus 5",
    hasVision: true,
    price: { ...DEEPINFRA_CLAUDE_OPUS_PRICE },
    contextWindow: 976000,
    maxOutputTokens: 4092,
    supportsTool: false,
  },
  {
    name: "anthropic/claude-fable-5",
    displayName: "Anthropic: Claude Fable 5",
    hasVision: true,
    price: { ...DEEPINFRA_CLAUDE_FABLE_PRICE },
    contextWindow: 976000,
    maxOutputTokens: 4092,
    supportsTool: false,
  },
];
