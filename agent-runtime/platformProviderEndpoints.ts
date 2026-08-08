/**
 * Pure platform provider endpoint map + OpenAI Responses model detection.
 *
 * Single seam for agentCallPlan (descriptor) and providerResolution (execution)
 * so the endpoint tables / responses heuristic cannot drift.
 */

import { asTrimmedLowercaseString } from "../core/trimmedLowercaseString";
import { getModelConfig } from "../ai/llm/providers";

export const OPENAI_RESPONSES_ENDPOINT =
  "https://api.openai.com/v1/responses";

/** Known platform chat.completions endpoints keyed by provider id. */
export const PLATFORM_CHAT_COMPLETIONS_ENDPOINTS: Readonly<
  Record<string, string>
> = {
  deepinfra: "https://api.deepinfra.com/v1/openai/chat/completions",
  // DeepSeek official API endpoint removed — all DeepSeek models now route
  // through the nolo provider (Ollama Cloud). See providerRegistry.ts.
  // deepseek: "https://api.deepseek.com/chat/completions",
  fireworks: "https://api.fireworks.ai/inference/v1/chat/completions",
  google:
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  openai: "https://api.openai.com/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  // 千问 AI 平台 OpenAI 兼容模式
  qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
  // Moonshot AI（月之暗面）开放平台 OpenAI 兼容模式（按量计费）
  moonshot: "https://api.moonshot.cn/v1/chat/completions",
  // Open-source default: nolo provider 中转 ollama cloud。
  // 内部多后端组合路由不开源，由内部 provider 路由层接管。
  nolo: "https://ollama.com/v1/chat/completions",
};

/**
 * Whether a model uses the OpenAI Responses wire format.
 * Mirrors isResponseAPIModel.ts logic without pulling heavier deps.
 */
export function isOpenAiResponsesModel(args: {
  provider?: string;
  model?: string;
  endpointKey?: string;
}): boolean {
  // Only OpenAI speaks the Responses wire format on the platform table.
  // (DeepSeek once did too, before that provider was retired in favour of
  // nolo/Ollama Cloud, which is plain chat.completions.)
  const provider = asTrimmedLowercaseString(args.provider);
  if (provider !== "openai") return false;
  if (args.endpointKey === "responses") return true;
  if (!args.model) return false;
  try {
    return getModelConfig("openai", args.model).endpointKey === "responses";
  } catch {
    return false;
  }
}

export function resolvePlatformResponsesEndpoint(provider: string): string | undefined {
  return asTrimmedLowercaseString(provider) === "openai"
    ? OPENAI_RESPONSES_ENDPOINT
    : undefined;
}

/**
 * Legacy agent records may still store a provider id that has since been
 * retired. Alias those to `nolo` so the endpoint resolver never throws on
 * records that predate the change:
 *
 * - `ollama-cloud`: the retired public product id, now canonicalised to `nolo`.
 *   The catalog/provider layer (`packages/ai/llm`) normalises it too; this
 *   keeps the execution seam consistent.
 * - `deepseek`: the official DeepSeek API provider, retired on 2026-08-08.
 *   Every DeepSeek model now runs on nolo (Ollama Cloud), so a stored
 *   `provider: "deepseek"` means "stale record", not "different upstream" —
 *   routing it to nolo is what the record already intended. Without this,
 *   such agents fail with `does not support provider "deepseek"`.
 */
const PLATFORM_PROVIDER_ENDPOINT_ALIASES: Readonly<Record<string, string>> = {
  "ollama-cloud": "nolo",
  deepseek: "nolo",
};

/** Lookup a known platform chat.completions endpoint; undefined if unknown. */
export function resolvePlatformChatCompletionsEndpoint(
  provider: string,
): string | undefined {
  const key = asTrimmedLowercaseString(provider);
  if (!key) return undefined;
  const aliased = PLATFORM_PROVIDER_ENDPOINT_ALIASES[key] ?? key;
  return PLATFORM_CHAT_COMPLETIONS_ENDPOINTS[aliased];
}
