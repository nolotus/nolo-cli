// ai/llm/providers.ts
import { anthropicModels } from "../../integrations/anthropic/anthropicModels";
import { anthropicOAuthModels } from "../../integrations/anthropic/anthropicOAuthModels";
import { googleModels } from "../../integrations/google/models";
import { openAIModels } from "../../integrations/openai/models";
import { openrouterModels } from "../llm/openrouterModels";
import { deepinfraModels } from "../llm/deepinfra";
import { xaiModels } from "../../integrations/xai/models";
import './fireworks'
import type { Model } from "./types";
import type { Agent } from "../../app/types";
import { fireworksModels } from "./fireworks";
import { platformHostedModels } from "./platformHosted";
import {
  cloudflareModels,
  getCloudflareWorkersAiChatCompletionsUrl,
} from "./cloudflare";
import { gmiModels, GMI_CHAT_COMPLETIONS_URL } from "./gmi";
import { zaiModels } from "./zai";
import { qwenModels, qwenTokenPlanModels } from "../../integrations/qwen/models";
import { moonshotModels, kimiCodeModels } from "../../integrations/moonshot/models";
import type { ModelPrice } from "./types";

/**
 * Moonshot provider 统一模型表：开放平台按量模型 + Kimi Code 会员订阅模型。
 * 两者 Base URL、模型 ID、计费不同，但同属 moonshot provider，合并进 MODEL_MAP
 * 以便 getModelConfig / 能力检测 / getProviderByModelName 覆盖订阅模型 ID（k3 等）。
 * agent 创建下拉用 registry 的 modelOptions（区分订阅/按量），不依赖此合并表。
 */
const moonshotAllModels: Model[] = [...moonshotModels, ...kimiCodeModels];

/**
 * Qwen provider 统一模型表：DashScope 按量模型 + Token Plan 订阅模型。
 * 两者模型范围/计费不同（Token Plan 含 qwen3.8-max、GLM、DeepSeek、万相等，
 * price 留 0 由 Credits 抵扣），但同属 qwen provider，合并进 MODEL_MAP 以便
 * getModelConfig / 能力检测 / getProviderByModelName 覆盖 Token Plan 模型 ID。
 * 与 moonshot 合并同理：agent 创建下拉用 registry 的 modelOptions（区分订阅/按量），
 * 不依赖此合并表；qwen/models.ts 里「不要混用」指的是创建下拉，不是这里的能力目录。
 * 两份清单模型 ID 不重名，合并不会产生计费错配。
 */
const qwenAllModels: Model[] = [...qwenModels, ...qwenTokenPlanModels];
import {
  PLATFORM_HOSTED_KIMI_K26_MODEL,
  PLATFORM_HOSTED_KIMI_PROVIDER,
} from "./kimi";
import { PLATFORM_HOSTED_DEEPSEEK_FLASH_VISION_EXP_MODEL } from "./platformHosted";
import { opencodeGoModels } from "../../integrations/opencode/models";
export { supportedReasoningModels } from "./reasoningModels";
export { getCloudflareWorkersAiChatCompletionsUrl } from "./cloudflare";

/* ──────────────────────────────────────────
 * 所有模型（仅用于功能过滤）
 * ────────────────────────────────────────── */

/* ──────────────────────────────────────────
 * Provider → 模型列表
 * ────────────────────────────────────────── */
const MODEL_MAP = {
  // anthropic: anthropicModels,
  google: googleModels,
  openai: openAIModels,
  deepinfra: deepinfraModels,
  openrouter: openrouterModels,
  fireworks: fireworksModels,
  nolo: platformHostedModels,
  cloudflare: cloudflareModels,
  gmi: gmiModels,
  zai: zaiModels,
  qwen: qwenAllModels,
  moonshot: moonshotAllModels,
} as const;

export const MODEL_LOOKUP_MAP = {
  anthropic: [...anthropicModels, ...anthropicOAuthModels],
  xai: xaiModels,
  "opencode-go": opencodeGoModels,
  opencode: opencodeGoModels,
  ...MODEL_MAP,
} as const;

export type LookupProvider = keyof typeof MODEL_LOOKUP_MAP;

type ModelLookupCandidate = Model & {
  id?: string;
  pricing?: ModelPrice;
  supportVision?: boolean;
  supportTool?: boolean;
  supportReasoning?: boolean;
  maxTokens?: number;
};

const ANTHROPIC_MODEL_ALIASES: Record<string, string> = {
  "claude-sonnet-4.6": "claude-3-7-sonnet-latest",
  "claude-sonnet-4.5": "claude-3-5-sonnet-latest",
};

const NOLO_MODEL_ALIASES: Record<string, string> = {
  "glm-5.2": "glm-5.3",
};

const normalizeLookupProvider = (provider?: string | null): LookupProvider | null => {
  if (!provider) return null;
  const normalized = provider.toLowerCase();
  // Legacy catalog id → public product provider id
  if (normalized === "ollama-cloud" || normalized === "deepseek") {
    return "nolo" as LookupProvider;
  }
  if (normalized in MODEL_LOOKUP_MAP) {
    return normalized as LookupProvider;
  }
  return null;
};

const normalizeLookupModelName = (
  provider: LookupProvider,
  name: string
): string => {
  if (provider === "anthropic") {
    return ANTHROPIC_MODEL_ALIASES[name] ?? name;
  }
  if (provider === "nolo") {
    return NOLO_MODEL_ALIASES[name] ?? name;
  }
  return name;
};

const toModel = (candidate: ModelLookupCandidate): Model => ({
  name:
    typeof candidate.id === "string" && candidate.id.trim()
      ? candidate.id
      : candidate.name,
  displayName:
    candidate.displayName ??
    (typeof candidate.id === "string" && candidate.id !== candidate.name
      ? candidate.name
      : undefined),
  hasVision:
    typeof candidate.hasVision === "boolean"
      ? candidate.hasVision
      : !!candidate.supportVision,
  contextWindow: candidate.contextWindow,
  price: candidate.price ?? candidate.pricing ?? { input: 0, output: 0 },
  peakPrice: candidate.peakPrice,
  offPeakPrice: candidate.offPeakPrice,
  pricingStrategy: candidate.pricingStrategy,
  serviceTierPriceMultipliers: candidate.serviceTierPriceMultipliers,
  maxOutputTokens: candidate.maxOutputTokens ?? candidate.maxTokens,
  jsonOutput: candidate.jsonOutput,
  fnCall:
    typeof candidate.fnCall === "boolean"
      ? candidate.fnCall
      : candidate.supportTool,
  provider: candidate.provider,
  description: candidate.description,
  hasAudio: candidate.hasAudio,
  maxImageResolution: candidate.maxImageResolution,
  canFineTune: candidate.canFineTune,
  hasImageOutput: candidate.hasImageOutput,
  supportsImageOutput: candidate.supportsImageOutput,
  supportsTool:
    typeof candidate.supportsTool === "boolean"
      ? candidate.supportsTool
      : candidate.supportTool,
  supportsImageConfig: candidate.supportsImageConfig,
  requiresImageModalities: candidate.requiresImageModalities,
  defaultModalities: candidate.defaultModalities,
  supportedAspectRatios: candidate.supportedAspectRatios,
  supportedImageSizes: candidate.supportedImageSizes,
  pricePerImage: candidate.pricePerImage,
  imagePricingNote: candidate.imagePricingNote,
  imageTokenPricePerMillion: candidate.imageTokenPricePerMillion,
  imageOutputTokenEstimateBySize: candidate.imageOutputTokenEstimateBySize,
  imageGenerationWaitTimeSeconds: candidate.imageGenerationWaitTimeSeconds,
  imageGenerationProfiles: candidate.imageGenerationProfiles,
  supportsReasoningEffort:
    typeof candidate.supportsReasoningEffort === "boolean"
      ? candidate.supportsReasoningEffort
      : candidate.supportReasoning,
  endpointKey: candidate.endpointKey,
});

const findCandidateInProvider = (
  provider: LookupProvider,
  name: string
): Model | null => {
  const normalizedName = normalizeLookupModelName(provider, name);
  const list = MODEL_LOOKUP_MAP[provider] as readonly ModelLookupCandidate[];
  const candidate = list.find(
    (item) =>
      item.name === normalizedName ||
      item.displayName === normalizedName ||
      item.id === normalizedName
  );
  return candidate ? toModel(candidate) : null;
};

const findOpenRouterUpstreamModel = (name: string): Model | null => {
  const slash = name.indexOf("/");
  if (slash <= 0) return null;
  const upstreamProvider = normalizeLookupProvider(name.slice(0, slash));
  if (!upstreamProvider) return null;
  const upstreamModelName = name.slice(slash + 1);
  return findCandidateInProvider(upstreamProvider, upstreamModelName);
};

export function findModelConfig(provider: string, name: string): Model | null {
  const normalizedProvider = normalizeLookupProvider(provider);
  if (!normalizedProvider) return null;

  const direct = findCandidateInProvider(normalizedProvider, name);
  if (direct) return direct;

  if (normalizedProvider === "openrouter") {
    return findOpenRouterUpstreamModel(name);
  }

  return null;
}

/* 自动推断 Provider 字面量类型 */
export const availableProviderOptions = Object.keys(MODEL_MAP) as Array<
  keyof typeof MODEL_MAP
>;
export type Provider = (typeof availableProviderOptions)[number];

/* ──────────────────────────────────────────
 * Provider → 命名端点
 * 统一用 endpointKey 提高可读性
 * ────────────────────────────────────────── */
type ProviderEndpointMap = Record<string, string>; // endpointKey → URL

const API_ENDPOINTS: Record<string, ProviderEndpointMap> = {
  openai: {
    completions: "https://api.openai.com/v1/chat/completions",
    responses: "https://api.openai.com/v1/responses",
  },
  xai: {
    default: "https://api.x.ai/v1/chat/completions",
  },
  deepinfra: {
    default: "https://api.deepinfra.com/v1/openai/chat/completions",
  },
  google: {
    default:
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  },
  openrouter: {
    default: "https://openrouter.ai/api/v1/chat/completions",
  },
  fireworks: {
    default: "https://api.fireworks.ai/inference/v1/chat/completions"
  },
  /* 平台托管 provider（nolo / legacy ollama-cloud / deepseek）不放本地默认端点：
   * 直连语义已移除（历史 ollama.com 兜底废弃），端点由服务端按模型决议；
   * getApiEndpoint 对它们直接返回 ""。 */
  cloudflare: {
    default: "__cloudflare_workers_ai_chat_completions__",
  },
  gmi: {
    default: GMI_CHAT_COMPLETIONS_URL,
  },
  qwen: {
    // 千问 AI 平台 OpenAI 兼容模式
    default: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
  },
  moonshot: {
    // Moonshot AI（月之暗面）开放平台 OpenAI 兼容模式（按量计费）
    default: "https://api.moonshot.cn/v1/chat/completions",
  },
} as const;

/* ──────────────────────────────────────────
 * 工具函数
 * ────────────────────────────────────────── */

/** 根据 provider & name 获取模型配置 */
export function getModelConfig(provider: Provider | LookupProvider | string, name: string): Model {
  const model = findModelConfig(provider, name);
  if (!model) {
    throw new Error(`Model ${name} not found for provider ${provider}`);
  }
  return model;
}

/** 获取某 provider 全量模型（支持 MODEL_LOOKUP_MAP 扩展 provider） */
export function getModelsByProvider(provider: Provider | LookupProvider | string): Model[] {
  const normalized = normalizeLookupProvider(provider);
  if (normalized && normalized in MODEL_LOOKUP_MAP) {
    return MODEL_LOOKUP_MAP[normalized] as unknown as Model[];
  }
  return [];
}

/** 通过模型名反查 provider（跨所有 provider 搜索） */
export function getProviderByModelName(modelName: string): LookupProvider | undefined {
  for (const [provider, models] of Object.entries(MODEL_LOOKUP_MAP)) {
    if (models.some((m) => m.name === modelName)) {
      return provider as LookupProvider;
    }
  }
  return undefined;
}

/** 默认模型配置（provider + model 成对出现，避免分散硬编码） */
export const DEFAULT_MODEL = {
  provider: PLATFORM_HOSTED_KIMI_PROVIDER as Provider,
  name: PLATFORM_HOSTED_DEEPSEEK_FLASH_VISION_EXP_MODEL,
} as const;

/** 统一获取 ChatCompletion / Responses 等端点 */
export function getApiEndpoint(agent: Agent): string {
  const { provider, customProviderUrl, endpointKey, model } = agent;
  const effectiveProvider = provider;
  const effectiveModel = model;

  // CLI agents don't use HTTP API endpoints - should never reach here
  if ((agent as any).apiSource === "cli") {
    throw new Error(
      "Routing error: CLI agent should not call getApiEndpoint. Check streamAgentChatTurn."
    );
  }

  /* 手动覆盖：有自定义 URL 时直接用，但对只填了 base URL 的情况做兜底补全 */
  if (customProviderUrl) {
    const url = customProviderUrl.trim().replace(/\/$/, ""); // 去掉末尾斜杠
    // 如果 URL 末尾是 /v1 /v2 /v1beta /v3 等版本路径（典型 base URL），
    // 说明用户可能漏填了 /chat/completions，自动补全
    if (/\/v\d+(beta\d*)?$/.test(url)) {
      return `${url}/chat/completions`;
    }
    return url;
  }

  /* custom provider / apiSource=custom 但未给 URL 的兜底
   * 注意：apiSource="custom" 的 agent 不需要 provider 字段，
   * 使用 customProviderUrl + 自己的 apiKey，上面已经 return 了。
   * 只有 customProviderUrl 为空时才会走到这里报错。
   *
   * 降级路径：OAuth subscription agent（chatgpt/xai/antigravity/claude/cursor）
   * 创建时 apiSource="custom" 但 customProviderUrl 可为空——URL 在运行时
   * 由 provider endpoint 表解析。当 useServerProxy 未显式设置时，如果
   * agent 有 apiKeyRef（OAuth）或已知 platform provider，自动走 server proxy。
   * 这修复了 startAgentRun 派发子任务时 useServerProxy 未被传递导致的 crash。
   */
  const OAUTH_API_KEY_REFS = new Set([
    "chatgpt", "xai", "antigravity", "claude", "cursor",
  ]);
  // 平台托管（nolo）与 legacy（ollama-cloud / deepseek）供应商：本地无默认端点，
  // 统一由服务端按模型决议（chatHandler / loopUpstream 共享平台路由），直连返回 ""。
  if (
    effectiveProvider === "nolo" ||
    effectiveProvider === "ollama-cloud" ||
    effectiveProvider === "deepseek"
  ) {
    return "";
  }
  if (
    !effectiveProvider ||
    effectiveProvider.toLowerCase() === "custom" ||
    (agent as any).apiSource === "custom"
  ) {
    if (agent.useServerProxy) {
      return "";
    }
    // OAuth subscription agents always need server proxy (token never in browser).
    const apiKeyRef = (agent as any).apiKeyRef;
    if (apiKeyRef && OAUTH_API_KEY_REFS.has(apiKeyRef)) {
      return "";
    }
    // Graceful degradation: if the agent has a known platform provider,
    // assume server proxy is available even if not explicitly set.
    if (effectiveProvider && API_ENDPOINTS[effectiveProvider]) {
      return "";
    }
    throw new Error(
      "Custom provider URL is required when apiSource is 'custom'."
    );
  }

  if (effectiveProvider === "cloudflare") {
    return getCloudflareWorkersAiChatCompletionsUrl();
  }

  /* Provider 端点表 */
  const endpoints = API_ENDPOINTS[effectiveProvider];
  if (!endpoints) throw new Error(`Unsupported provider: ${provider}`);

  /* 1. Agent 显式 endpointKey 优先 */
  let key = endpointKey;

  /* 2. 未指定时，读取模型默认 endpointKey */
  if (!key && effectiveModel) {
    try {
      key = getModelConfig(effectiveProvider as Provider, effectiveModel).endpointKey;
    } catch {
      /* ignore */
    }
  }

  /* 3. 取 URL 顺序：指定 key → default → 第一个 */
  if (key && endpoints[key]) return endpoints[key];
  if (endpoints.default) return endpoints.default;

  const first = Object.values(endpoints)[0];
  if (first) return first;

  throw new Error(`No endpoint found for provider ${provider}`);
}
