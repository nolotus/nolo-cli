/**
 * Pure platform provider endpoint map + OpenAI Responses model detection.
 *
 * Single seam for agentCallPlan (descriptor) and providerResolution (execution)
 * so the endpoint tables / responses heuristic cannot drift.
 */

import { asTrimmedLowercaseString } from "../core/trimmedLowercaseString";
import { getModelConfig } from "../ai/llm/providers";
import {
  isPlatformHostedClaudeModel,
  isPlatformHostedGrokModel,
} from "../ai/llm/platformHosted";

export const OPENAI_RESPONSES_ENDPOINT =
  "https://api.openai.com/v1/responses";
export const DEEPSEEK_RESPONSES_ENDPOINT =
  "https://api.deepseek.com/responses";
/** xAI 官方 OpenAI 兼容 chat.completions（平台托管 Grok 的实际上游）。 */
export const XAI_CHAT_COMPLETIONS_ENDPOINT =
  "https://api.x.ai/v1/chat/completions";

/** Known platform chat.completions endpoints keyed by provider id. */
export const PLATFORM_CHAT_COMPLETIONS_ENDPOINTS: Readonly<
  Record<string, string>
> = {
  deepinfra: "https://api.deepinfra.com/v1/openai/chat/completions",
  fireworks: "https://api.fireworks.ai/inference/v1/chat/completions",
  google:
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  openai: "https://api.openai.com/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  // 千问 AI 平台 OpenAI 兼容模式
  qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
  // Moonshot AI（月之暗面）开放平台 OpenAI 兼容模式（按量计费）
  moonshot: "https://api.moonshot.cn/v1/chat/completions",
  // Non-DeepSeek hosted models use Ollama Cloud. DeepSeek Flash is routed
  // separately to the official DeepSeek Responses endpoint.
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
  const provider = asTrimmedLowercaseString(args.provider);
  if (provider === "nolo" || provider === "deepseek") {
    const model = args.model?.trim().toLowerCase();
    return model === "deepseek-v4-flash" || model === "deepseek-v4-pro";
  }
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
  const normalized = asTrimmedLowercaseString(provider);
  if (normalized === "openai") return OPENAI_RESPONSES_ENDPOINT;
  if (normalized === "nolo" || normalized === "deepseek") {
    return DEEPSEEK_RESPONSES_ENDPOINT;
  }
  return undefined;
}

/**
 * Legacy agent records may still store a provider id that has since been
 * retired. Alias those to `nolo` so the endpoint resolver never throws on
 * records that predate the change:
 *
 * - `ollama-cloud`: the retired public product id, now canonicalised to `nolo`.
 *   The catalog/provider layer (`packages/ai/llm`) normalises it too; this
 *   keeps the execution seam consistent.
 * - `deepseek`: provider retired (2026-08-13) — records are migrated to `nolo`
 *   via MODEL_UPGRADE_TABLE, but chat.completions fallback aliases to `nolo`
 *   so any un-migrated legacy record still resolves (and DeepSeek V4 models
 *   keep routing to the official Responses endpoint via isOpenAiResponsesModel).
 */
const PLATFORM_PROVIDER_ENDPOINT_ALIASES: Readonly<Record<string, string>> = {
  "ollama-cloud": "nolo",
  deepseek: "nolo",
};

/** Lookup a known platform chat.completions endpoint; undefined if unknown. */
export function resolvePlatformChatCompletionsEndpoint(
  provider: string,
  model?: string | null,
): string | undefined {
  const key = asTrimmedLowercaseString(provider);
  if (!key) return undefined;
  const aliased = PLATFORM_PROVIDER_ENDPOINT_ALIASES[key] ?? key;
  // 平台托管 Claude（provider=nolo + anthropic/claude-*）：记录侧统一 nolo，
  // 实际上游仍是 deepinfra（URL + DEEPINFRA_API_KEY）。
  if (aliased === "nolo" && isPlatformHostedClaudeModel(model)) {
    return PLATFORM_CHAT_COMPLETIONS_ENDPOINTS.deepinfra;
  }
  // 平台托管 Grok（provider=nolo + grok-4.6）：记录侧统一 nolo，上游 xAI 官方 API。
  if (aliased === "nolo" && isPlatformHostedGrokModel(model)) {
    return XAI_CHAT_COMPLETIONS_ENDPOINT;
  }
  return PLATFORM_CHAT_COMPLETIONS_ENDPOINTS[aliased];
}
