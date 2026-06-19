export const FIREWORKS_KIMI_LATEST_MODEL = "accounts/fireworks/models/kimi-latest";
export const FIREWORKS_KIMI_CURRENT_MODEL = "accounts/fireworks/models/kimi-k2p7-code";
export const FIREWORKS_KIMI_K2P6_MODEL = "accounts/fireworks/models/kimi-k2p6";
export const DEEPINFRA_KIMI_FALLBACK_MODEL = "moonshotai/Kimi-K2.6";
export const VULTR_KIMI_MODEL = "moonshotai/Kimi-K2.6";
export const KIMI_PLATFORM_FALLBACK_STATUSES = [401, 402, 429, 500, 502, 503, 504];

export const isFireworksKimiModel = (model?: string | null): boolean =>
  model === FIREWORKS_KIMI_LATEST_MODEL ||
  model === FIREWORKS_KIMI_CURRENT_MODEL ||
  model === FIREWORKS_KIMI_K2P6_MODEL;

export const isDeepInfraKimiModel = (model?: string | null): boolean =>
  model === DEEPINFRA_KIMI_FALLBACK_MODEL;

export const isVultrKimiModel = (model?: string | null): boolean =>
  model === VULTR_KIMI_MODEL;

export const isPlatformKimiProviderModel = (
  provider?: string | null,
  model?: string | null
): boolean => {
  const normalizedProvider = provider?.trim().toLowerCase();
  if (normalizedProvider === "deepinfra") return isDeepInfraKimiModel(model);
  if (normalizedProvider === "fireworks") return isFireworksKimiModel(model);
  if (normalizedProvider === "vultr") return isVultrKimiModel(model);
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
