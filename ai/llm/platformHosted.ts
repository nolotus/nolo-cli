// packages/ai/llm/platformHosted.ts
// Platform catalog for hosted models (upstream provider is abstracted).
// Public provider id is `nolo` (see providers.ts MODEL_MAP).

import { asTrimmedLowercaseString } from "../../core/trimmedLowercaseString";
import {
  PLATFORM_HOSTED_KIMI_K26_MODEL,
  PLATFORM_HOSTED_KIMI_K3_MODEL,
} from "./kimi";
import {
  DEEPINFRA_CLAUDE_OPUS_PRICE,
  DEEPINFRA_CLAUDE_SONNET_PRICE,
} from "./deepinfra";

/**
 * Claude 模型（平台托管语义）：记录侧 provider=nolo（统一管理），实际上游
 * 仍是 deepinfra（URL 指向 deepinfra、key 用 DEEPINFRA_API_KEY）。价格沿用
 * deepinfra 人民币报价，见 deepinfra.ts 注释。
 * Claude Haiku 4.5 已下架（2026-08-14，无使用量），不再列入平台目录。
 */
export const PLATFORM_HOSTED_CLAUDE_SONNET_5_MODEL =
  "anthropic/claude-sonnet-5";
export const PLATFORM_HOSTED_CLAUDE_OPUS_4_8_MODEL =
  "anthropic/claude-opus-4-8";

export const PLATFORM_HOSTED_CLAUDE_MODELS = [
  PLATFORM_HOSTED_CLAUDE_SONNET_5_MODEL,
  PLATFORM_HOSTED_CLAUDE_OPUS_4_8_MODEL,
] as const;

export const isPlatformHostedClaudeModel = (
  model?: string | null,
): boolean =>
  PLATFORM_HOSTED_CLAUDE_MODELS.some(
    (m) => asTrimmedLowercaseString(model) === m,
  );

/**
 * Grok 4.6（平台托管语义）：记录侧 provider=nolo（统一管理），实际上游为
 * xAI 官方 API（api.x.ai，OpenAI 兼容 chat.completions，key 用 XAI_API_KEY）。
 */
export const PLATFORM_HOSTED_GROK_4_6_MODEL = "grok-4.6";

export const isPlatformHostedGrokModel = (model?: string | null): boolean =>
  asTrimmedLowercaseString(model) === PLATFORM_HOSTED_GROK_4_6_MODEL;

/**
 * nolo 平台内部价格单位：积分 / 1M tokens。
 * 外部美元 API 的统一销售口径是 8 折，再按 1 USD = 7 credits 记账。
 */
const PLATFORM_CREDITS_PER_USD = 7;
const EXTERNAL_API_DISCOUNT = 0.8;
const toPlatformCredits = (usdPerMillion: number): number =>
  Number(
    (usdPerMillion * EXTERNAL_API_DISCOUNT * PLATFORM_CREDITS_PER_USD).toFixed(
      6,
    ),
  );

/**
 * Kimi K2.6 官方 API $0.6/$2.4 per 1M，nolo 对外 8 折。
 */
export const PLATFORM_HOSTED_KIMI_PRICE = {
  input: toPlatformCredits(0.6),
  output: toPlatformCredits(2.4),
} as const;

/**
 * Kimi K3 走 crof 上游，硬编码 crof 报价 ×8（不走通用 toPlatformCredits）。
 * crof $2/$0.25/$8 per 1M ×8 = 16/2/64 credits。
 */
export const PLATFORM_HOSTED_KIMI_K3_PRICE = {
  input: 16, // crof $2 × 8，特殊价不走通用 0.8×7 换算
  inputCacheHit: 2, // crof $0.25 × 8
  output: 64, // crof $8 × 8
} as const;

/**
 * GLM 5.2 官方 Z.AI API $1.4/$4.4 per 1M，nolo 对外 8 折。
 */
export const PLATFORM_HOSTED_GLM_PRICE = {
  input: toPlatformCredits(1.4),
  inputCacheHit: toPlatformCredits(0.26),
  output: toPlatformCredits(4.4),
} as const;

/** Platform hosted model id for GLM 5.2 (platform catalog). */
export const PLATFORM_HOSTED_GLM_52_MODEL = "glm-5.2";

/**
 * Gemini 3.7 Flash（平台托管语义）：官方促销定价（through 2026-12-31）
 * input $0.75 / output（含思考代币）$3.75 / 上下文缓存 $0.075 per 1M，
 * nolo 对外 8 折（toPlatformCredits = usd × 0.8 × 7）。
 * 2027-01-01 起官方正式价 input $1.50 / output $7.50 / 缓存 $0.15（届时
 * 对应 credits：8.4 / 42 / 0.84，需在生效时更新本常量）。
 * 目录约束：平台只托管 flash 文本模型 + 图片（image-preview）模型，
 * 不托管任何非图片的 gemini pro 文本模型。
 */
export const PLATFORM_HOSTED_GEMINI_37_FLASH_MODEL = "gemini-3.7-flash";
export const PLATFORM_HOSTED_GEMINI_37_FLASH_PRICE = {
  input: toPlatformCredits(0.75),
  output: toPlatformCredits(3.75),
  cachingWrite: toPlatformCredits(0.075),
  cachingRead: toPlatformCredits(0.075),
} as const;

/**
 * Platform hosted DeepSeek V4 Flash. Same model id as official DeepSeek so
 * fallback can reuse deepseek-v4-flash on api.deepseek.com.
 */
export const PLATFORM_HOSTED_DEEPSEEK_FLASH_MODEL = "deepseek-v4-flash";
export const PLATFORM_HOSTED_DEEPSEEK_PRO_MODEL = "deepseek-v4-pro";

/** DeepSeek V4 peak/off-peak pricing takes effect at 2026-08-17 00:00 Beijing time. */
export const DEEPSEEK_V4_PRICING_EFFECTIVE_AT_MS = Date.UTC(2026, 7, 16, 16);

/**
 * Peak pricing in yuan per million tokens, from the DeepSeek API pricing
 * notice shown in the official API Docs (effective 2026-08-17 00:00 Beijing).
 */
export const PLATFORM_HOSTED_DEEPSEEK_FLASH_PEAK_PRICE = {
  input: 3,
  inputCacheHit: 0.1,
  output: 9,
} as const;
export const PLATFORM_HOSTED_DEEPSEEK_PRO_PEAK_PRICE = {
  input: 9,
  inputCacheHit: 0.3,
  output: 27,
} as const;

/** Existing prices remain in effect until the announced effective time. */
export const PLATFORM_HOSTED_DEEPSEEK_FLASH_PRICE = {
  input: 1,
  inputCacheHit: 0.02,
  output: 2,
} as const;
export const PLATFORM_HOSTED_DEEPSEEK_PRO_PRICE = {
  input: 3,
  inputCacheHit: 0.025,
  output: 6,
} as const;

/** Off-peak pricing is half of the peak price. */
export const PLATFORM_HOSTED_DEEPSEEK_FLASH_OFF_PEAK_PRICE = {
  input: 1.5,
  inputCacheHit: 0.05,
  output: 4.5,
} as const;
export const PLATFORM_HOSTED_DEEPSEEK_PRO_OFF_PEAK_PRICE = {
  input: 4.5,
  inputCacheHit: 0.15,
  output: 13.5,
} as const;

export const getPlatformHostedDeepSeekV4Price = (
  model: string,
  nowMs = Date.now(),
) => {
  if (nowMs < DEEPSEEK_V4_PRICING_EFFECTIVE_AT_MS) {
    return model === PLATFORM_HOSTED_DEEPSEEK_PRO_MODEL
      ? PLATFORM_HOSTED_DEEPSEEK_PRO_PRICE
      : PLATFORM_HOSTED_DEEPSEEK_FLASH_PRICE;
  }

  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Shanghai",
      hour: "numeric",
      hourCycle: "h23",
    }).format(new Date(nowMs)),
  );
  const peak = (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
  if (!peak) {
    return model === PLATFORM_HOSTED_DEEPSEEK_PRO_MODEL
      ? PLATFORM_HOSTED_DEEPSEEK_PRO_OFF_PEAK_PRICE
      : PLATFORM_HOSTED_DEEPSEEK_FLASH_OFF_PEAK_PRICE;
  }
  return model === PLATFORM_HOSTED_DEEPSEEK_PRO_MODEL
    ? PLATFORM_HOSTED_DEEPSEEK_PRO_PEAK_PRICE
    : PLATFORM_HOSTED_DEEPSEEK_FLASH_PEAK_PRICE;
};

export const isPlatformHostedDeepSeekV4Model = (model: string): boolean =>
  model === PLATFORM_HOSTED_DEEPSEEK_FLASH_MODEL ||
  model === PLATFORM_HOSTED_DEEPSEEK_PRO_MODEL;

/**
 * Platform hosted chat completions upstream.
 *
 * Non-DeepSeek hosted models use Ollama Cloud's OpenAI-compatible endpoint
 * (https://ollama.com/v1/chat/completions), authenticated via OLLAMA_API_KEY.
 * DeepSeek Flash uses the official API below with DEEPSEEK_API_KEY.
 *
 * nolo 内部生产环境的上游路由（组合 ollama cloud + 自有机器等）不在开源
 * 仓库内。当前开源实现默认走 Ollama Cloud。
 */
export const PLATFORM_HOSTED_CHAT_COMPLETIONS_URL =
  "https://ollama.com/v1/chat/completions";
export const PLATFORM_HOSTED_DEEPSEEK_CHAT_COMPLETIONS_URL =
  "https://api.deepseek.com/chat/completions";
export const PLATFORM_HOSTED_DEEPSEEK_RESPONSES_URL =
  "https://api.deepseek.com/responses";

export type PlatformDeepseekFlashRoutePlan =
  | { kind: "configured" }
  | { kind: "missing_key" }
  | {
      kind: "hosted";
      primaryProvider: "nolo";
      credentialProvider: "deepseek";
      wire: "responses";
    };

export const isPlatformHostedDeepseekModel = (
  model?: string | null,
): boolean =>
  model === PLATFORM_HOSTED_DEEPSEEK_FLASH_MODEL ||
  model === PLATFORM_HOSTED_DEEPSEEK_PRO_MODEL;

/** @deprecated Use isPlatformHostedDeepseekModel for all hosted V4 models. */
export const isPlatformHostedDeepseekFlashModel = isPlatformHostedDeepseekModel;

/**
 * Platform DeepSeek Flash (hosted): nolo/platform-hosted catalog or legacy
 * `deepseek` provider records still pointing at deepseek-v4-flash. It uses
 * the official DeepSeek API while retaining nolo as the catalog identity.
 */
export const isPlatformDeepseekHosted = (
  provider?: string | null,
  model?: string | null,
): boolean => {
  if (!isPlatformHostedDeepseekModel(model)) return false;
  const p = asTrimmedLowercaseString(provider);
  return (
    p === "nolo" ||
    p === "ollama-cloud" || // Backward compatibility
    p === "deepseek"
  );
};

/**
 * True when the endpoint is the platform's own DeepSeek Responses URL.
 * Clients (web chat, agent-run) resolve provider=nolo + hosted V4 models to
 * this exact endpoint via resolvePlatformResponsesEndpoint("nolo") and pass
 * it as the request url — it is the hosted route's target, NOT a user-explicit
 * endpoint. Treating it as explicit here would skip the hosted branch and
 * fall back to the provider=nolo key (OLLAMA_API_KEY) against
 * api.deepseek.com, producing the 401 "api key is invalid" failure.
 */
const isPlatformDefaultDeepseekResponsesEndpoint = (
  endpoint?: string | null,
): boolean => {
  if (typeof endpoint !== "string" || !endpoint.trim()) return false;
  const normalized = endpoint.split(/[?#]/)[0].replace(/\/+$/, "").toLowerCase();
  return (
    normalized ===
    PLATFORM_HOSTED_DEEPSEEK_RESPONSES_URL.split(/[?#]/)[0]
      .replace(/\/+$/, "")
      .toLowerCase()
  );
};

/**
 * Pure provider-ordering policy shared by chat proxy and agent-run.
 * Explicit Responses, custom providers, and user credentials stay on their
 * configured route; hosted DeepSeek Flash goes to the official DeepSeek API.
 */
export const resolvePlatformDeepseekRoute = (args: {
  provider?: string | null;
  model?: string | null;
  endpoint?: string | null;
  isCustomApi: boolean;
  hasExplicitCredential: boolean;
  hasDeepseekKey: boolean;
}): PlatformDeepseekFlashRoutePlan => {
  const usesResponsesApi =
    typeof args.endpoint === "string" &&
    /\/responses(?:[/?#]|$)/i.test(args.endpoint) &&
    !isPlatformDefaultDeepseekResponsesEndpoint(args.endpoint);
  const eligible =
    isPlatformDeepseekHosted(args.provider, args.model) &&
    !usesResponsesApi &&
    !args.isCustomApi &&
    !args.hasExplicitCredential;

  if (!eligible) return { kind: "configured" };
  if (args.hasDeepseekKey) {
    return {
      kind: "hosted",
      primaryProvider: "nolo",
      credentialProvider: "deepseek",
      wire: "responses",
    };
  }
  return { kind: "missing_key" };
};

/** @deprecated Use resolvePlatformDeepseekRoute for all hosted V4 models. */
export const resolvePlatformDeepseekFlashRoute = resolvePlatformDeepseekRoute;

export const platformHostedModels = [
  {
    name: PLATFORM_HOSTED_KIMI_K3_MODEL,
    displayName: "Kimi K3",
    hasVision: true,
    price: { ...PLATFORM_HOSTED_KIMI_K3_PRICE },
    maxOutputTokens: 262144,
    contextWindow: 1_000_000,
    supportsTool: true,
    supportsReasoningEffort: true,
  },
  {
    name: PLATFORM_HOSTED_KIMI_K26_MODEL,
    displayName: "Kimi K2.6",
    hasVision: true,
    price: { ...PLATFORM_HOSTED_KIMI_PRICE },
    maxOutputTokens: 262144,
    contextWindow: 262144,
    supportsTool: true,
  },
  {
    name: PLATFORM_HOSTED_GLM_52_MODEL,
    displayName: "GLM 5.2",
    hasVision: false,
    price: { ...PLATFORM_HOSTED_GLM_PRICE },
    maxOutputTokens: 131072,
    contextWindow: 1_000_000,
    supportsTool: true,
    supportsReasoningEffort: true,
  },
  {
    name: PLATFORM_HOSTED_GEMINI_37_FLASH_MODEL,
    displayName: "Gemini 3.7 Flash",
    hasVision: true,
    price: { ...PLATFORM_HOSTED_GEMINI_37_FLASH_PRICE },
    maxOutputTokens: 65536,
    contextWindow: 1_048_576,
    supportsTool: true,
    supportsReasoningEffort: true,
  },

  {
    name: PLATFORM_HOSTED_DEEPSEEK_FLASH_MODEL,
    displayName: "DeepSeek V4 Flash",
    hasVision: false,
    price: { ...PLATFORM_HOSTED_DEEPSEEK_FLASH_PRICE },
    maxOutputTokens: 384_000,
    contextWindow: 1_000_000,
    supportsTool: true,
    supportsReasoningEffort: true,
  },
  {
    name: PLATFORM_HOSTED_DEEPSEEK_PRO_MODEL,
    displayName: "DeepSeek V4 Pro",
    hasVision: false,
    price: { ...PLATFORM_HOSTED_DEEPSEEK_PRO_PRICE },
    maxOutputTokens: 384_000,
    contextWindow: 1_000_000,
    supportsTool: true,
    supportsReasoningEffort: true,
  },
  {
    name: PLATFORM_HOSTED_CLAUDE_SONNET_5_MODEL,
    displayName: "Claude Sonnet 5",
    hasVision: true,
    price: { ...DEEPINFRA_CLAUDE_SONNET_PRICE },
    maxOutputTokens: 4092,
    contextWindow: 976000,
    supportsTool: false,
  },
  {
    name: PLATFORM_HOSTED_CLAUDE_OPUS_4_8_MODEL,
    displayName: "Claude Opus 4.8",
    hasVision: true,
    price: { ...DEEPINFRA_CLAUDE_OPUS_PRICE },
    maxOutputTokens: 4092,
    contextWindow: 976000,
    supportsTool: false,
  },
  {
    name: PLATFORM_HOSTED_GROK_4_6_MODEL,
    displayName: "Grok 4.6",
    hasVision: true,
    // 上游 xAI 官方 API：$2/$6 per 1M ×7（同 xai/models.ts 报价口径）。
    price: { input: 2 * 7, output: 6 * 7 },
    maxOutputTokens: 100_000,
    contextWindow: 500000,
    supportsTool: true,
  },
];

/** @deprecated Kept for backward compatibility. */
export const OLLAMA_CLOUD_CHAT_COMPLETIONS_URL =
  PLATFORM_HOSTED_CHAT_COMPLETIONS_URL;
/** @deprecated Kept for backward compatibility. */
export const OLLAMA_CLOUD_DEEPSEEK_FLASH_MODEL =
  PLATFORM_HOSTED_DEEPSEEK_FLASH_MODEL;
/** @deprecated Kept for backward compatibility. */
export const OLLAMA_CLOUD_DEEPSEEK_FLASH_PRICE =
  PLATFORM_HOSTED_DEEPSEEK_FLASH_PRICE;
/** @deprecated Kept for backward compatibility. */
export const ollamaCloudModels = platformHostedModels;
