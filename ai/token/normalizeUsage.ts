// 文件路径: ai/token/normalizeUsage.ts

import { asOptionalFiniteNumber } from "../../core/optionalNumber";
import { asOptionalTrimmedString } from "../../core/optionalString";
import { asTrimmedNonEmptyStringArray } from "../../core/stringArray";

import { RawUsage, NormalizedUsage } from "./types";

const normalizeStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const normalized = [...new Set(asTrimmedNonEmptyStringArray(value))];
  return normalized.length > 0 ? normalized : undefined;
};

const finiteTokenCount = (value: unknown): number | undefined => {
  const finite = asOptionalFiniteNumber(value);
  if (finite === undefined) return undefined;
  return Math.max(0, Math.floor(finite));
};

const readNestedTokenCount = (
  value: unknown,
  path: readonly string[]
): number | undefined => {
  let cursor = value;
  for (const key of path) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return finiteTokenCount(cursor);
};

const readFiniteNumberField = (
  usage: unknown,
  field: string
): number | undefined => {
  if (!usage || typeof usage !== "object") return undefined;
  if (!(field in usage)) return undefined;
  const candidate = (usage as Record<string, unknown>)[field];
  return asOptionalFiniteNumber(candidate);
};

const readCostInUsdTicks = (usage: unknown): number | undefined =>
  readFiniteNumberField(usage, "cost_in_usd_ticks");

export const normalizeUsage = (usage: RawUsage): NormalizedUsage => {
  const inputTokens =
    "input_tokens" in usage
      ? (usage.input_tokens ?? 0)
      : "prompt_tokens" in usage
        ? usage.prompt_tokens
        : 0;

  const outputTokens =
    "output_tokens" in usage
      ? (usage.output_tokens ?? 0)
      : "completion_tokens" in usage
        ? usage.completion_tokens
        : 0;

  const cacheCreationInputTokens =
    "cache_creation_input_tokens" in usage
      ? (usage.cache_creation_input_tokens ?? 0)
      : "prompt_cache_miss_tokens" in usage
        ? usage.prompt_cache_miss_tokens
        : 0;

  const cacheReadInputTokens =
    finiteTokenCount((usage as any).cache_read_input_tokens) ??
    finiteTokenCount((usage as any).prompt_cache_hit_tokens) ??
    readNestedTokenCount(usage, ["input_tokens_details", "cached_tokens"]) ??
    readNestedTokenCount(usage, ["prompt_tokens_details", "cached_tokens"]) ??
    0;

  // ✅ 如果 provider 返回 usage.cost，则先原样透传；
  // 后续由 calculatePrice 按各 provider 的账单单位再做换算。
  let cost = 0;
  const providedCost = readFiniteNumberField(usage, "cost");
  if (providedCost !== undefined) {
    cost = providedCost;
  }

  // xAI returns cost_in_usd_ticks (1 tick = 1e-10 USD). It reflects the
  // actual billed amount (includes reasoning tokens and any cache
  // discounts). Only apply it when the caller did not already supply a
  // `cost` value, to avoid silently overwriting a caller-converted value
  // in a different unit (e.g. credits).
  const xaiTicks = readCostInUsdTicks(usage);
  if (xaiTicks !== undefined && providedCost === undefined) {
    cost = xaiTicks / 1e10;
  }

  const billingProvider = asOptionalTrimmedString(usage.billing_provider);
  const billingModel = asOptionalTrimmedString(usage.billing_model);
  const billingServiceTier = asOptionalTrimmedString(usage.billing_service_tier);
  const billingEstimated =
    "billing_estimated" in usage && usage.billing_estimated === true;
  const imageGenerationCount =
    "image_generation_count" in usage
      ? asOptionalFiniteNumber(usage.image_generation_count)
      : undefined;
  const providerResponseIds = normalizeStringArray(
    (usage as any).provider_response_ids
  );
  const providerRequestIds = normalizeStringArray(
    (usage as any).provider_request_ids
  );

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheCreationInputTokens,
    cache_read_input_tokens: cacheReadInputTokens,
    cost,
    ...(typeof imageGenerationCount === "number"
      ? { image_generation_count: imageGenerationCount }
      : {}),
    ...(providerResponseIds
      ? { provider_response_ids: providerResponseIds }
      : {}),
    ...(providerRequestIds ? { provider_request_ids: providerRequestIds } : {}),
    ...(billingProvider ? { billing_provider: billingProvider } : {}),
    ...(billingModel ? { billing_model: billingModel } : {}),
    ...(billingServiceTier
      ? { billing_service_tier: billingServiceTier }
      : {}),
    ...(billingEstimated ? { billing_estimated: true } : {}),
    ...(xaiTicks !== undefined ? { cost_in_usd_ticks: xaiTicks } : {}),
  };
};
