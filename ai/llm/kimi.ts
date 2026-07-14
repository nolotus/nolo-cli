// packages/ai/llm/kimi.ts
// Platform Kimi is Ollama Cloud only. Legacy Fireworks/DeepInfra/Vultr model
// string helpers remain for request-body compatibility with old agent records.

/** Platform-hosted Kimi models (catalog + routing). Upstream is private. */
export const OLLAMA_CLOUD_KIMI_K26_MODEL = "kimi-k2.6";
export const OLLAMA_CLOUD_KIMI_K27_CODE_MODEL = "kimi-k2.7-code";
/** User-facing / catalog provider id — never show "ollama" to end users. */
export const PLATFORM_HOSTED_KIMI_PROVIDER = "nolo";
/** @deprecated Use PLATFORM_HOSTED_KIMI_PROVIDER ("nolo"). Kept as alias for imports. */
export const OLLAMA_CLOUD_PROVIDER = PLATFORM_HOSTED_KIMI_PROVIDER;
/** Legacy agent records may still store this provider string. */
export const LEGACY_OLLAMA_CLOUD_PROVIDER = "ollama-cloud";

/** @deprecated Legacy Fireworks model ids — not listed in catalog. */
export const FIREWORKS_KIMI_LATEST_MODEL = "accounts/fireworks/models/kimi-latest";
/** @deprecated */
export const FIREWORKS_KIMI_CURRENT_MODEL =
  "accounts/fireworks/models/kimi-k2p7-code";
/** @deprecated */
export const FIREWORKS_KIMI_K2P6_MODEL = "accounts/fireworks/models/kimi-k2p6";
/** @deprecated */
export const DEEPINFRA_KIMI_FALLBACK_MODEL = "moonshotai/Kimi-K2.6";
/** @deprecated */
export const VULTR_KIMI_MODEL = "moonshotai/Kimi-K2.6";

export const KIMI_PLATFORM_FALLBACK_STATUSES = [
  401, 402, 429, 500, 502, 503, 504,
];

export const isOllamaCloudKimiModel = (model?: string | null): boolean =>
  model === OLLAMA_CLOUD_KIMI_K26_MODEL ||
  model === OLLAMA_CLOUD_KIMI_K27_CODE_MODEL;

export const isFireworksKimiModel = (model?: string | null): boolean =>
  model === FIREWORKS_KIMI_LATEST_MODEL ||
  model === FIREWORKS_KIMI_CURRENT_MODEL ||
  model === FIREWORKS_KIMI_K2P6_MODEL;

export const isDeepInfraKimiModel = (model?: string | null): boolean =>
  model === DEEPINFRA_KIMI_FALLBACK_MODEL;

export const isVultrKimiModel = (model?: string | null): boolean =>
  model === VULTR_KIMI_MODEL;

/** Platform catalog + proxy: only nolo-hosted Kimi (legacy ollama-cloud id accepted). */
export const isPlatformKimiProviderModel = (
  provider?: string | null,
  model?: string | null
): boolean => {
  const normalizedProvider = provider?.trim().toLowerCase();
  if (
    normalizedProvider === PLATFORM_HOSTED_KIMI_PROVIDER ||
    normalizedProvider === LEGACY_OLLAMA_CLOUD_PROVIDER
  ) {
    return isOllamaCloudKimiModel(model);
  }
  return false;
};

export const resolveFireworksKimiModel = (model?: string | null): string => {
  if (model === FIREWORKS_KIMI_LATEST_MODEL) {
    return FIREWORKS_KIMI_CURRENT_MODEL;
  }
  return model ?? "";
};

export const shouldHideKimiAliasFromPricing = (
  provider?: string | null,
  model?: string | null
): boolean => provider === "fireworks" && model === FIREWORKS_KIMI_LATEST_MODEL;
