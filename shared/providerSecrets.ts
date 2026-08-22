/** Shared provider-key derivation used by web clients and server handlers. */
export const PROVIDER_KEY_PRESET_IDS = new Set([
  "token-plan",
  "qwen-token-plan",
  "opencode-go",
  "kimi-code-key",
  "zai-coding-plan",
  "bigmodel-coding-plan",
  "openai-api",
  "anthropic-api",
  "gemini-api",
  "xai-api",
  "qwen-api",
  "kimi-api",
  "minimax-api",
  "ollama-cloud",
  "glm-5.2:cloud",
  "deepseek-v4-flash:cloud",
  "deepseek-v4-pro:cloud",
  "kimi-k3:cloud",
]);

export function providerSecretKey(presetId: string): string {
  const normalized = presetId.trim().replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase();
  return `${normalized}_KEY`;
}

export function providerCredentialRef(presetId: string): string {
  return `provider-key:${presetId.trim()}`;
}
