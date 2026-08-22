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
  DEEPINFRA_CLAUDE_FABLE_PRICE,
} from "./deepinfra";

/**
 * Claude 模型（平台托管语义）：记录侧 provider=nolo（统一管理），实际上游
 * 仍是 deepinfra（URL 指向 deepinfra、key 用 DEEPINFRA_API_KEY）。
 */
export const PLATFORM_HOSTED_CLAUDE_SONNET_5_MODEL =
  "anthropic/claude-sonnet-5";
export const PLATFORM_HOSTED_CLAUDE_OPUS_5_MODEL = "anthropic/claude-opus-5";
export const PLATFORM_HOSTED_CLAUDE_FABLE_5_MODEL = "anthropic/claude-fable-5";

export const PLATFORM_HOSTED_CLAUDE_MODELS = [
  PLATFORM_HOSTED_CLAUDE_SONNET_5_MODEL,
  PLATFORM_HOSTED_CLAUDE_OPUS_5_MODEL,
  PLATFORM_HOSTED_CLAUDE_FABLE_5_MODEL,
] as const;

export const isPlatformHostedClaudeModel = (
  model?: string | null,
): boolean =>
  PLATFORM_HOSTED_CLAUDE_MODELS.some(
    (m) => asTrimmedLowercaseString(model) === m,
  );

/**
 * nolo 平台内部价格单位：积分 / 1M tokens。
 * 统一折算口径：上游美元 API 报价 × 8 折算积分（1 USD = 8 Credits）。
 */
export const PLATFORM_CREDITS_PER_USD = 8;
export const toPlatformCredits = (usdPerMillion: number): number =>
  Number((usdPerMillion * PLATFORM_CREDITS_PER_USD).toFixed(6));

/**
 * Grok 4.6（平台托管语义）：记录侧 provider=nolo（统一管理），实际上游为
 * xAI 官方 API（api.x.ai，OpenAI 兼容 chat.completions，key 用 XAI_API_KEY）。
 * 上游官方报价 $2/$6 per 1M × 8 = 16 / 48 credits。
 */
export const PLATFORM_HOSTED_GROK_4_6_MODEL = "grok-4.6";

export const isPlatformHostedGrokModel = (model?: string | null): boolean =>
  asTrimmedLowercaseString(model) === PLATFORM_HOSTED_GROK_4_6_MODEL;

export const PLATFORM_HOSTED_GROK_PRICE = {
  input: toPlatformCredits(2), // 16 credits
  output: toPlatformCredits(6), // 48 credits
} as const;

/**
 * Kimi K2.6（平台托管语义）：记录侧 provider=nolo，实际上游指向 OpenRouter 的
 * Qwen3.8 27B（qwen/qwen3.8-27b，key 用 OPENROUTER_API_KEY）。
 * 实际上游 OpenRouter Qwen 3.8 27B 定价 $0.40/$0.04/$3.00 per 1M × 8
 * = 3.2 / 0.32 / 24.0 credits（in / cache-read / out）。
 *
 * 缓存读取单价来自上游回报的实际账单反推（cost_details.upstream_inference_*）：
 * prompt 181357 tokens（其中 cached 180000）上游收 $0.0077428
 *   → miss 1357 × $0.40/M = $0.0005428
 *   → 余 $0.0072 / 180000 tokens = $0.04/M，即 input 价的 10%。
 * 同一条记录 completion 122 × $3.00/M = $0.000366，与上游回报逐位一致。
 */
export const PLATFORM_HOSTED_KIMI_K26_OPENROUTER_MODEL_ID = "qwen/qwen3.8-27b";
export const isPlatformHostedKimiK26Model = (
  model?: string | null,
): boolean => asTrimmedLowercaseString(model) === PLATFORM_HOSTED_KIMI_K26_MODEL;

export const PLATFORM_HOSTED_KIMI_PRICE = {
  input: toPlatformCredits(0.4), // 3.2 credits
  // 缺了这一项时 calculatePrice 的 nolo 分支会退回 calculateSimpleCost，
  // 把 cache_read_input_tokens 按 input 全价收 —— agentic 循环每轮重放整个
  // 上下文，实测 92% 的 input 是缓存读取，等于按原价重复收 10 倍以上。
  inputCacheHit: toPlatformCredits(0.04), // 0.32 credits
  output: toPlatformCredits(3.0), // 24.0 credits (3 * 8 = 24)
} as const;

/**
 * Kimi K3 走 crof 上游，crof 报价 $2/$0.25/$8 per 1M × 8 = 16/2/64 credits。
 */
export const PLATFORM_HOSTED_KIMI_K3_PRICE = {
  input: 16, // crof $2 × 8
  inputCacheHit: 2, // crof $0.25 × 8
  output: 64, // crof $8 × 8
} as const;

/**
 * GLM 5.3（平台托管语义）：记录侧展示与主键为 `glm-5.3`（兼容历史 `glm-5.2`），
 * 实际上游指向 OpenRouter 的 Z.ai GLM 5.3（z-ai/glm-5.3，key 用 OPENROUTER_API_KEY）。
 * 实际上游 OpenRouter Z.ai GLM 5.3 定价 $1.40/$4.40 per 1M × 8 = 11.2 / 35.2 credits。
 */
export const PLATFORM_HOSTED_GLM_53_MODEL = "glm-5.3";
/** @deprecated Kept for backward compatibility with existing agent records. */
export const PLATFORM_HOSTED_GLM_52_MODEL = "glm-5.2";

export const PLATFORM_HOSTED_GLM_53_OPENROUTER_MODEL_ID = "z-ai/glm-5.3";
export const PLATFORM_HOSTED_GLM_52_OPENROUTER_MODEL_ID =
  PLATFORM_HOSTED_GLM_53_OPENROUTER_MODEL_ID;

export const isPlatformHostedGlmModel = (
  model?: string | null,
): boolean => {
  const m = asTrimmedLowercaseString(model);
  return m === PLATFORM_HOSTED_GLM_53_MODEL || m === PLATFORM_HOSTED_GLM_52_MODEL;
};
export const isPlatformHostedGlm52Model = isPlatformHostedGlmModel;
export const isPlatformHostedGlm53Model = isPlatformHostedGlmModel;

export const PLATFORM_HOSTED_GLM_PRICE = {
  input: toPlatformCredits(1.4), // 11.2 credits
  inputCacheHit: toPlatformCredits(0.26), // 2.08 credits
  output: toPlatformCredits(4.4), // 35.2 credits (4.4 * 8 = 35.2)
} as const;

/**
 * Gemini 3.7 Flash（平台托管语义）：直连 Google 官方原生 API（gemini-3.7-flash，
 * key 用 GEMINI_API_KEY / GOOGLE_API_KEY）。
 * 官方定价 input $0.75 / output $3.75 / 上下文缓存 $0.075 per 1M × 8 = 6.0 / 30.0 / 0.6 credits。
 */
export const PLATFORM_HOSTED_GEMINI_37_FLASH_MODEL = "gemini-3.7-flash";

export const PLATFORM_HOSTED_GEMINI_37_FLASH_PRICE = {
  input: toPlatformCredits(0.75), // 6.0 credits
  output: toPlatformCredits(3.75), // 30.0 credits
  cachingWrite: toPlatformCredits(0.075), // 0.6 credits
  cachingRead: toPlatformCredits(0.075), // 0.6 credits
} as const;

export const isPlatformHostedGeminiModel = (
  model?: string | null,
): boolean => asTrimmedLowercaseString(model) === PLATFORM_HOSTED_GEMINI_37_FLASH_MODEL;

/**
 * Platform hosted DeepSeek V4 Flash / Pro. Same model id as official DeepSeek.
 */
export const PLATFORM_HOSTED_DEEPSEEK_FLASH_MODEL = "deepseek-v4-flash";
export const PLATFORM_HOSTED_DEEPSEEK_FLASH_VISION_EXP_MODEL =
  "deepseek-v4-flash-vision-exp";
export const PLATFORM_HOSTED_DEEPSEEK_PRO_MODEL = "deepseek-v4-pro";

/** DeepSeek V4 peak/off-peak pricing (official DeepSeek pricing). */
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

export const isDeepSeekOffPeakBeijingTime = (nowMs = Date.now()): boolean => {
  // 旧实现只按北京钟点判断（00:00-08:00 为低谷），缺少星期维度，导致周末白天
  // 误按高峰计费。这里改用 +8h 后的 UTC 读取"北京日期/星期/小时"，确保星期与
  // 小时都取自北京时间。北京无夏令时（全年 UTC+8），该移位是精确的。
  const beijing = new Date(nowMs + 8 * 60 * 60 * 1000);
  const beijingDay = beijing.getUTCDay(); // 0=周日, 6=周六
  const beijingHour = beijing.getUTCHours();

  // 官方 2026-08-23（周日）00:00 起：周末（周六/周日）全天不再区分峰谷，
  // 统一按低谷价收费，故周末任何时刻都算低谷。
  if (beijingDay === 0 || beijingDay === 6) return true;

  // 工作日高峰时段为北京时间 9:00-12:00、14:00-18:00，其余为空闲时段；
  // 空闲时段价格 = 高峰价格的一半。
  const isPeakWindow =
    (beijingHour >= 9 && beijingHour < 12) ||
    (beijingHour >= 14 && beijingHour < 18);
  return !isPeakWindow;
};

export const getPlatformHostedDeepSeekV4Price = (
  model: string,
  nowMs = Date.now(),
) => {
  const isOffPeak = isDeepSeekOffPeakBeijingTime(nowMs);
  if (model === PLATFORM_HOSTED_DEEPSEEK_PRO_MODEL) {
    return isOffPeak
      ? PLATFORM_HOSTED_DEEPSEEK_PRO_OFF_PEAK_PRICE
      : PLATFORM_HOSTED_DEEPSEEK_PRO_PEAK_PRICE;
  }
  return isOffPeak
    ? PLATFORM_HOSTED_DEEPSEEK_FLASH_OFF_PEAK_PRICE
    : PLATFORM_HOSTED_DEEPSEEK_FLASH_PEAK_PRICE;
};

export const isPlatformHostedDeepSeekV4Model = (model: string): boolean =>
  model === PLATFORM_HOSTED_DEEPSEEK_FLASH_MODEL ||
  model === PLATFORM_HOSTED_DEEPSEEK_FLASH_VISION_EXP_MODEL ||
  model === PLATFORM_HOSTED_DEEPSEEK_PRO_MODEL;

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
  model === PLATFORM_HOSTED_DEEPSEEK_FLASH_VISION_EXP_MODEL ||
  model === PLATFORM_HOSTED_DEEPSEEK_PRO_MODEL;

export const isPlatformHostedDeepseekFlashModel = isPlatformHostedDeepseekModel;

export const isPlatformDeepseekHosted = (
  provider?: string | null,
  model?: string | null,
): boolean => {
  if (!isPlatformHostedDeepseekModel(model)) return false;
  const p = asTrimmedLowercaseString(provider);
  return (
    p === "nolo" ||
    p === "ollama-cloud" ||
    p === "deepseek"
  );
};

const isPlatformDefaultDeepseekResponsesEndpoint = (
  endpoint?: string | null,
): boolean => {
  if (!endpoint || !endpoint.trim()) return false;
  const normalized = endpoint.split(/[?#]/)[0].replace(/\/+$/, "").toLowerCase();
  return (
    normalized ===
    PLATFORM_HOSTED_DEEPSEEK_RESPONSES_URL.split(/[?#]/)[0]
      .replace(/\/+$/, "")
      .toLowerCase()
  );
};

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
    name: PLATFORM_HOSTED_GLM_53_MODEL,
    displayName: "GLM 5.3",
    hasVision: false,
    price: { ...PLATFORM_HOSTED_GLM_PRICE },
    maxOutputTokens: 131072,
    contextWindow: 1_050_000,
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
    price: { ...PLATFORM_HOSTED_DEEPSEEK_FLASH_PEAK_PRICE },
    peakPrice: { ...PLATFORM_HOSTED_DEEPSEEK_FLASH_PEAK_PRICE },
    offPeakPrice: { ...PLATFORM_HOSTED_DEEPSEEK_FLASH_OFF_PEAK_PRICE },
    maxOutputTokens: 384_000,
    contextWindow: 1_000_000,
    supportsTool: true,
    supportsReasoningEffort: true,
  },
  {
    name: PLATFORM_HOSTED_DEEPSEEK_FLASH_VISION_EXP_MODEL,
    displayName: "DeepSeek V4 Flash Vision Exp",
    hasVision: true,
    price: { ...PLATFORM_HOSTED_DEEPSEEK_FLASH_PEAK_PRICE },
    peakPrice: { ...PLATFORM_HOSTED_DEEPSEEK_FLASH_PEAK_PRICE },
    offPeakPrice: { ...PLATFORM_HOSTED_DEEPSEEK_FLASH_OFF_PEAK_PRICE },
    maxOutputTokens: 384_000,
    contextWindow: 1_000_000,
    supportsTool: true,
    supportsReasoningEffort: true,
  },
  {
    name: PLATFORM_HOSTED_DEEPSEEK_PRO_MODEL,
    displayName: "DeepSeek V4 Pro",
    hasVision: false,
    price: { ...PLATFORM_HOSTED_DEEPSEEK_PRO_PEAK_PRICE },
    peakPrice: { ...PLATFORM_HOSTED_DEEPSEEK_PRO_PEAK_PRICE },
    offPeakPrice: { ...PLATFORM_HOSTED_DEEPSEEK_PRO_OFF_PEAK_PRICE },
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
    name: PLATFORM_HOSTED_CLAUDE_OPUS_5_MODEL,
    displayName: "Claude Opus 5",
    hasVision: true,
    price: { ...DEEPINFRA_CLAUDE_OPUS_PRICE },
    maxOutputTokens: 4092,
    contextWindow: 976000,
    supportsTool: false,
  },
  {
    name: PLATFORM_HOSTED_CLAUDE_FABLE_5_MODEL,
    displayName: "Claude Fable 5",
    hasVision: true,
    price: { ...DEEPINFRA_CLAUDE_FABLE_PRICE },
    maxOutputTokens: 4092,
    contextWindow: 976000,
    supportsTool: false,
  },
  {
    name: PLATFORM_HOSTED_GROK_4_6_MODEL,
    displayName: "Grok 4.6",
    hasVision: true,
    price: { ...PLATFORM_HOSTED_GROK_PRICE },
    maxOutputTokens: 100_000,
    contextWindow: 500000,
    supportsTool: true,
  },
];

