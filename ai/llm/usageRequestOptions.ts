import { asTrimmedLowercaseString } from "../../core/trimmedLowercaseString";

export interface UsageRequestOptions {
  stream_options?: {
    include_usage: true;
  };
  usage?: {
    include: true;
  };
}

export type UsageRequestApi = "chat-completions" | "responses";

const STREAM_USAGE_PROVIDERS = new Set([
  "google",
  "openrouter",
  "xai",
  "openai",
  "fireworks",
  "mistral",
  "cloudflare",
  "gmi",
]);

const EXTRA_USAGE_FIELD_PROVIDERS = new Set(["openrouter"]);

const normalizeProviderName = (providerName?: string | null) =>
  asTrimmedLowercaseString(providerName);

export const getUsageRequestOptions = (
  providerName?: string | null,
  options?: { api?: UsageRequestApi }
): UsageRequestOptions => {
  const normalizedProvider = normalizeProviderName(providerName);
  const api = options?.api ?? "chat-completions";

  if (api === "responses") {
    return EXTRA_USAGE_FIELD_PROVIDERS.has(normalizedProvider)
      ? {
          usage: {
            include: true as const,
          },
        }
      : {};
  }

  return {
    ...(STREAM_USAGE_PROVIDERS.has(normalizedProvider)
      ? {
          stream_options: {
            include_usage: true as const,
          },
        }
      : {}),
    ...(EXTRA_USAGE_FIELD_PROVIDERS.has(normalizedProvider)
      ? {
          usage: {
            include: true as const,
          },
        }
      : {}),
  };
};
