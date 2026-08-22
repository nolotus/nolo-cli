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
  isPlatformHostedDeepseekModel,
  isPlatformHostedGrokModel,
  isPlatformHostedKimiK26Model,
  isPlatformHostedGlmModel,
  isPlatformHostedGeminiModel,
} from "../ai/llm/platformHosted";
import { PLATFORM_HOSTED_KIMI_K3_MODEL } from "../ai/llm/kimi";

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
  // 平台托管 Kimi K3 的实际上游
  crof: "https://crof.ai/v1/chat/completions",
  // 无 nolo 默认上游：平台托管模型全部显式分流，未识别模型返回 undefined
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
  if (provider === "openai") {
    if (args.endpointKey === "responses") return true;
    if (!args.model) return false;
    try {
      return getModelConfig("openai", args.model).endpointKey === "responses";
    } catch {
      return false;
    }
  }
  if (
    provider === "deepseek" ||
    provider === "nolo" ||
    provider === "ollama-cloud"
  ) {
    if (isPlatformHostedDeepseekModel(args.model)) return true;
  }
  return false;
}

export function resolvePlatformResponsesEndpoint(
  provider: string,
  model?: string | null,
): string | undefined {
  const normalized = asTrimmedLowercaseString(provider);
  if (normalized === "openai") return OPENAI_RESPONSES_ENDPOINT;
  if (
    normalized === "deepseek" ||
    normalized === "nolo" ||
    normalized === "ollama-cloud"
  ) {
    if (!model || isPlatformHostedDeepseekModel(model)) {
      return DEEPSEEK_RESPONSES_ENDPOINT;
    }
  }
  return undefined;
}

/**
 * Legacy agent records may still store a provider id that has since been
 * retired. Alias those to `nolo` so the endpoint resolver never throws on
 * records that predate the change.
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
  // 平台托管 Claude（provider=nolo + anthropic/claude-*）：实际上游 deepinfra
  if (aliased === "nolo" && isPlatformHostedClaudeModel(model)) {
    return PLATFORM_CHAT_COMPLETIONS_ENDPOINTS.deepinfra;
  }
  // 平台托管 Grok（provider=nolo + grok-4.6）：实际上游 xAI
  if (aliased === "nolo" && isPlatformHostedGrokModel(model)) {
    return XAI_CHAT_COMPLETIONS_ENDPOINT;
  }
  // 平台托管 Kimi K2.6 & GLM 5.3 / 5.2：实际上游 OpenRouter
  if (
    aliased === "nolo" &&
    (isPlatformHostedKimiK26Model(model) || isPlatformHostedGlmModel(model))
  ) {
    return PLATFORM_CHAT_COMPLETIONS_ENDPOINTS.openrouter;
  }
  // 平台托管 Kimi K3：实际上游 crof
  if (
    aliased === "nolo" &&
    asTrimmedLowercaseString(model) === PLATFORM_HOSTED_KIMI_K3_MODEL
  ) {
    return PLATFORM_CHAT_COMPLETIONS_ENDPOINTS.crof;
  }
  // 平台托管 Gemini 3.7 Flash：实际上游 Google
  if (
    aliased === "nolo" &&
    isPlatformHostedGeminiModel(model)
  ) {
    return PLATFORM_CHAT_COMPLETIONS_ENDPOINTS.google;
  }
  // 平台托管 DeepSeek V4（走 Responses 端点，不走 chat.completions）
  if (aliased === "nolo" && isPlatformHostedDeepseekModel(model)) {
    return undefined;
  }
  // 平台托管（nolo 及 legacy ollama-cloud/deepseek 记录）未显式分流的模型：
  // 不再回退到默认上游（原 ollama.com 兜底已移除），显式返回 undefined 让上层报错。
  if (aliased === "nolo") {
    return undefined;
  }
  return PLATFORM_CHAT_COMPLETIONS_ENDPOINTS[aliased];
}

/**
 * 平台托管模型该用哪个 provider 的 key。
 *
 * 与上面的 `resolvePlatformChatCompletionsEndpoint` **逐条对应**——同一个模型，
 * 端点解析到谁家，key 就取谁家。两个函数必须放在一起改：历史上它们分处两个包
 * 各自手写，端点先去掉了 ollama 兜底、key 侧还在发 OLLAMA_API_KEY，于是「拿 A
 * 家的钥匙去开 B 家的门」连出两次线上 401（2026-08-13 / 2026-08-22）。
 *
 * 返回 undefined = 不是平台托管路由，调用方按记录里的 provider 自己取 key。
 */
export function resolvePlatformHostedCredentialProvider(
  provider: string,
  model?: string | null,
): string | undefined {
  const key = asTrimmedLowercaseString(provider);
  if (!key) return undefined;
  const aliased = PLATFORM_PROVIDER_ENDPOINT_ALIASES[key] ?? key;
  if (aliased !== "nolo") return undefined;
  if (isPlatformHostedClaudeModel(model)) return "deepinfra";
  if (isPlatformHostedGrokModel(model)) return "xai";
  if (isPlatformHostedKimiK26Model(model) || isPlatformHostedGlmModel(model)) {
    return "openrouter";
  }
  if (asTrimmedLowercaseString(model) === PLATFORM_HOSTED_KIMI_K3_MODEL) {
    return "crof";
  }
  if (isPlatformHostedGeminiModel(model)) {
    return "google";
  }
  if (isPlatformHostedDeepseekModel(model)) return "deepseek";
  return undefined;
}

/**
 * 平台托管请求能不能落到一个真实上游。
 *
 * 端点与凭据必须同源：`getNoloKey("nolo")` 已经不再兜底发 key，所以「解析不出
 * 端点」等价于「这个 model 没有上游」。调用方据此显式报错，而不是让请求带着
 * 客户端传来的 url 和一把不相干的 key 出门。
 */
export function hasPlatformHostedUpstreamRoute(
  provider: string,
  model?: string | null,
): boolean {
  return Boolean(
    resolvePlatformChatCompletionsEndpoint(provider, model) ??
      (isOpenAiResponsesModel({ provider, model: model ?? undefined })
        ? resolvePlatformResponsesEndpoint(provider, model)
        : undefined),
  );
}
