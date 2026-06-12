// ai/llm/providers.ts
import { anthropicModels } from "../../integrations/anthropic/anthropicModels";
import { deepSeekModels } from "../../integrations/deepseek/models";
import { googleModels } from "../../integrations/google/models";
import { openAIModels } from "../../integrations/openai/models";
import { openrouterModels } from "../llm/openrouterModels";
import { deepinfraModels } from "../llm/deepinfra";
// import { xaiModels } from "../../integrations/xai/models";
import './fireworks'
import type { Model } from "./types";
import type { Agent } from "../../app/types";
import { fireworksModels } from "./fireworks";
import { mistralModels } from "./mistral";
import { mimoModels } from "./mimo";
import type { ModelPrice } from "./types";
import { FIREWORKS_KIMI_LATEST_MODEL } from "./kimi";
export { supportedReasoningModels } from "./reasoningModels";

/* ──────────────────────────────────────────
 * 所有模型（仅用于功能过滤）
 * ────────────────────────────────────────── */

/* ──────────────────────────────────────────
 * Provider → 模型列表
 * ────────────────────────────────────────── */
const MODEL_MAP = {
  // anthropic: anthropicModels,
  deepseek: deepSeekModels,
  google: googleModels,
  openai: openAIModels,
  deepinfra: deepinfraModels,
  openrouter: openrouterModels,
  fireworks: fireworksModels,
  mistral: mistralModels,
  mimo: mimoModels,
} as const;

const MODEL_LOOKUP_MAP = {
  anthropic: anthropicModels,
  ...MODEL_MAP,
} as const;

type LookupProvider = keyof typeof MODEL_LOOKUP_MAP;

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

const normalizeLookupProvider = (provider?: string | null): LookupProvider | null => {
  if (!provider) return null;
  const normalized = provider.toLowerCase();
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
  deepseek: {
    default: "https://api.deepseek.com/chat/completions",
  },
  deepinfra: {
    default: "https://api.deepinfra.com/v1/openai/chat/completions",
  },
  mistral: {
    default: "https://api.mistral.ai/v1/chat/completions",
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
  mimo: {
    default: "https://token-plan-cn.xiaomimimo.com/v1/chat/completions",
  }
} as const;

/* ──────────────────────────────────────────
 * 工具函数
 * ────────────────────────────────────────── */

/** 根据 provider & name 获取模型配置 */
export function getModelConfig(provider: Provider | "anthropic", name: string): Model {
  const model = findModelConfig(provider, name);
  if (!model) {
    throw new Error(`Model ${name} not found for provider ${provider}`);
  }
  return model;
}

/** 获取某 provider 全量模型 */
export function getModelsByProvider(provider: Provider): Model[] {
  return MODEL_MAP[provider] ?? [];
}

/** 通过模型名反查 provider（跨所有 provider 搜索） */
export function getProviderByModelName(modelName: string): Provider | undefined {
  for (const [provider, models] of Object.entries(MODEL_MAP)) {
    if (models.some((m) => m.name === modelName)) {
      return provider as Provider;
    }
  }
  return undefined;
}

/** 默认模型配置（provider + model 成对出现，避免分散硬编码） */
export const DEFAULT_MODEL = {
  provider: "fireworks" as Provider,
  name: FIREWORKS_KIMI_LATEST_MODEL,
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
   */
  if (
    !effectiveProvider ||
    effectiveProvider.toLowerCase() === "custom" ||
    (agent as any).apiSource === "custom"
  ) {
    if (agent.useServerProxy) {
      return "";
    }
    throw new Error(
      "Custom provider URL is required when apiSource is 'custom'."
    );
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
