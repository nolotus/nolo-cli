import { PROVIDER_REASONING_EFFORT_VALUES, type ReasoningEffort } from "../agent/createAgentSchema";

/**
 * 支持 reasoning_effort 参数的模型名集合。
 * 只有在此集合中的模型才会在请求体中携带 reasoning_effort。
 *
 * 注意：Anthropic Claude 和 Google Gemini 不走 reasoning_effort 通道，
 * 它们使用 thinking.budget_tokens / thinking_config 机制。
 */
const REASONING_MODEL_NAMES = new Set([
  "deepseek-v4-flash",
  "deepseek-v4-flash-vision-exp",
  "deepseek-v4-pro",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  // Legacy Gemini ids — 已从模型注册表下线，保留只为存量 agent 的 reasoning UI。
  "gemini-3.5-flash",
  "gemini-3-flash-preview",
  "gemini-3-pro-preview",
  "gemini-3.1-pro-preview",
  "gpt-5.5-pro",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "glm-5.3",
  "glm-5.2",
  "kimi-k3",
  // Legacy OpenAI catalog ids — still support reasoning UI for agents that
  // were never re-seeded after GPT-5.4 / GPT-5 were retired from the picker.
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.4-pro",
  "gpt-5",
  "gpt-5-mini",
  // Legacy model ids from retired Fireworks/DeepInfra/GMI/CF/Z.AI catalog rows
  "@cf/zai-org/glm-5.2",
  "zai-org/GLM-5.2",
  "accounts/fireworks/models/glm-5p2",
  "zai-org/GLM-5.2-FP8",
]);

export const isModelSupportReasoningEffort = (model: string): boolean =>
  REASONING_MODEL_NAMES.has(model);

export const supportedReasoningModels = Array.from(REASONING_MODEL_NAMES);

/** 强度刻度：距离用绝对值；并列时取更高档（与下方 JSDoc 示例一致）。 */
const EFFORT_ORDER = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

function nearestSupportedEffort(
  effort: string,
  supported: readonly string[],
): string | undefined {
  const effortIdx = EFFORT_ORDER.indexOf(effort as (typeof EFFORT_ORDER)[number]);
  if (effortIdx === -1) return undefined;

  const supportedIdxs = supported
    .map((s) => EFFORT_ORDER.indexOf(s as (typeof EFFORT_ORDER)[number]))
    .filter((idx) => idx >= 0)
    .sort((a, b) => a - b);
  if (supportedIdxs.length === 0) return undefined;

  let best = supportedIdxs[0]!;
  let bestDist = Math.abs(best - effortIdx);
  for (const idx of supportedIdxs) {
    const dist = Math.abs(idx - effortIdx);
    // 更近优先；距离相同取更高档（向上）
    if (dist < bestDist || (dist === bestDist && idx > best)) {
      best = idx;
      bestDist = dist;
    }
  }
  return EFFORT_ORDER[best];
}

/**
 * 按 provider 做 reasoning_effort 降级（clamp）。
 * 找到 provider 支持的值集合中「距离最近」的那个；并列时取更高档。
 *
 * 例如：
 * - openai + "max" → "max"（全支持）
 * - deepseek + "xhigh" → "max"（xhigh 不支持，并列 high/max 取更高的 max）
 * - kimi + "medium" → "high"（kimi 没 medium，并列 low/high 取更高的 high）
 * - xai + "max" → "high"（xAI 最高 high）
 * - kimi + "none" → "none"（可关思考，必须透传给 kimi-code proxy）
 * - "off" → 视为 "none" 后再 clamp
 * - anthropic + anything → undefined（不走 reasoning_effort 通道）
 */
export function clampReasoningEffort(
  effort: string | null | undefined,
  provider: string | null | undefined,
): string | undefined {
  if (!effort) return undefined;

  // off 是历史/别名写法，统一成 schema 里的 none 再匹配。
  const normalized = effort === "off" ? "none" : effort;

  const providerLower = (provider ?? "").toLowerCase();
  if (providerLower === "anthropic" || providerLower === "google") {
    return undefined;
  }

  const supported = PROVIDER_REASONING_EFFORT_VALUES[providerLower];
  if (!supported || supported.length === 0) {
    // 未知 / 空集合 provider：保守只透传 low/medium/high
    if (normalized === "low" || normalized === "medium" || normalized === "high") {
      return normalized;
    }
    const effortIdx = EFFORT_ORDER.indexOf(
      normalized as (typeof EFFORT_ORDER)[number],
    );
    const highIdx = EFFORT_ORDER.indexOf("high");
    const lowIdx = EFFORT_ORDER.indexOf("low");
    if (effortIdx === -1) return undefined;
    if (effortIdx > highIdx) return "high";
    if (effortIdx < lowIdx) return "low";
    return normalized;
  }

  if ((supported as string[]).includes(normalized)) return normalized;

  return nearestSupportedEffort(normalized, supported);
}

export type { ReasoningEffort };
