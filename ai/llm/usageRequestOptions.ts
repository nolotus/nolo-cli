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
  // OpenAI-compatible hosted providers expose the terminal usage chunk when
  // requested, including DeepInfra and Vultr. Keep this capability decision
  // in the shared seam so proxy and local runtimes cannot drift.
  "deepinfra",
  "vultr",
  // Explicit local-runtime providers with OpenAI-compatible streaming: both
  // DeepSeek official and Ollama honor stream_options.include_usage on their
  // chat.completions endpoints. Without them, locally-configured agents lose
  // token statistics / local billing (the whitelist replaced the previous
  // always-on include_usage).
  "deepseek",
  "ollama",
  // Platform Kimi K3 remap (provider=nolo + kimi-k3) routes to crof.ai, an
  // OpenAI-compatible /v1/chat/completions endpoint; the hosted branch passes
  // "crof" as the usage provider so K3 streams request the terminal usage
  // chunk (same capability decision as deepinfra/vultr).
  "crof",
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
