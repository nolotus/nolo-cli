// packages/ai/llm/kimi.ts
// Platform Kimi is Ollama Cloud only. Legacy Fireworks/DeepInfra/Vultr model
// string helpers remain for request-body compatibility with old agent records.

import { asTrimmedLowercaseString } from "../../core/trimmedLowercaseString";

/** Platform-hosted Kimi models (catalog + routing). Upstream is private. */
export const PLATFORM_HOSTED_KIMI_K26_MODEL = "kimi-k2.6";
export const PLATFORM_HOSTED_KIMI_K27_CODE_MODEL = "kimi-k2.7-code";
/** @deprecated Kept for backward compatibility. */
export const OLLAMA_CLOUD_KIMI_K26_MODEL = PLATFORM_HOSTED_KIMI_K26_MODEL;
/** @deprecated Kept for backward compatibility. */
export const OLLAMA_CLOUD_KIMI_K27_CODE_MODEL = PLATFORM_HOSTED_KIMI_K27_CODE_MODEL;
/** User-facing / catalog provider id. */
export const PLATFORM_HOSTED_KIMI_PROVIDER = "nolo";
/** @deprecated Use PLATFORM_HOSTED_KIMI_PROVIDER ("nolo"). Kept as alias for imports. */
export const PLATFORM_HOSTED_PROVIDER = PLATFORM_HOSTED_KIMI_PROVIDER;
/** @deprecated Kept for backward compatibility. */
export const OLLAMA_CLOUD_PROVIDER = PLATFORM_HOSTED_PROVIDER;
/** Legacy agent records may still store this provider string. */
export const LEGACY_OLLAMA_CLOUD_PROVIDER = "ollama-cloud";

/**
 * User-facing copy when platform-hosted LLM (nolo → Ollama) is capacity-limited
 * (429/5xx/timeout/network). Client validation errors (4xx other than 429) must
 * surface the real upstream reason — do not blanket-map them here.
 */
export const PLATFORM_LLM_BUSY_USER_MESSAGE = "服务器紧张";

/** Capacity / transport failures that map to PLATFORM_LLM_BUSY_USER_MESSAGE. */
export const PLATFORM_LLM_CAPACITY_STATUSES = new Set([
  429, 500, 502, 503, 504,
]);

/** True for catalog provider id `nolo` and legacy `ollama-cloud` agent records. */
export const isNoloHostedProvider = (provider?: string | null): boolean => {
  const normalized = asTrimmedLowercaseString(provider);
  return (
    normalized === PLATFORM_HOSTED_KIMI_PROVIDER ||
    normalized === "nolo-hosted" ||
    normalized === LEGACY_OLLAMA_CLOUD_PROVIDER
  );
};

/**
 * Whether a nolo/Ollama failure should show the calm capacity message.
 * 400/401/403/404 etc. stay as real errors (e.g. invalid image payload).
 */
export const shouldMapToPlatformBusyMessage = (opts: {
  provider?: string | null;
  status?: number | null;
  errorName?: string | null;
  /** True for missing platform key / abort without HTTP status. */
  treatAsCapacity?: boolean;
}): boolean => {
  if (!isNoloHostedProvider(opts.provider)) return false;
  if (opts.treatAsCapacity) return true;
  const name = opts.errorName ?? "";
  if (name === "AbortError" || name === "TimeoutError") return true;
  if (opts.status != null && PLATFORM_LLM_CAPACITY_STATUSES.has(opts.status)) {
    return true;
  }
  return false;
};

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
  const normalizedProvider = asTrimmedLowercaseString(provider);
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

