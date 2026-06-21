// 路径: ai/token/calculatePrice.ts

import { nolotusId } from "../../core/init";
import { Model, ModelPrice } from "../llm/types";
import { findModelConfig, getModelConfig } from "../llm/providers";
import { getApproxPricePerImage } from "../llm/imagePricing";

// ==================== 接口定义 ====================

/**
 * 这里的 Usage 是「已经 normalize 过」的结构
 * ——来自 normalizeUsage，字段名统一成这几个
 */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  /**
   * 对于 OpenRouter 等支持 usage.cost 的 provider：
   * usage.cost 是 provider 返回的账户扣费金额。
   * OpenRouter 官方 credits 以 USD 为基准，本仓库仍需再换算成平台 credits。
   */
  cost?: number;
  billing_service_tier?: string;
  image_generation_count?: number;
}

export interface ExternalPrice {
  input: number;
  output: number;
  creatorId?: string;
}

interface CalculatePriceParams {
  modelName: string;
  usage: Usage;
  externalPrice?: ExternalPrice;
  /**
   * provider 名称（deepseek / openrouter / anthropic 等）。
   * apiSource="custom" 的 agent 不填此字段，传 undefined 即可。
   * 注意：不要依赖参数默认值，调用方应显式传值或不传。
   */
  provider?: string;
  billingServiceTier?: string;
  sharingLevel?: "default" | "split" | "full";
}

export interface PriceResult {
  cost: number;
  pay: Record<string, number>;
}

export interface CostBreakdown {
  regular: number;
  charge: number;
  details?: {
    inputCost: number;
    outputCost: number;
    cachingWriteCost: number;
    cachingReadCost: number;
  };
}

// ==================== 核心逻辑：阶梯定价解析 ====================

const resolveModelPrice = (model: Model, usage: Usage): ModelPrice => {
  let activePrice = { ...model.price };

  if (model.pricingStrategy?.type === "tiered_context") {
    const contextSize = usage.input_tokens || 0;
    const tiers = model.pricingStrategy.tiers || [];

    const sortedTiers = [...tiers].sort((a, b) => a.minContext - b.minContext);

    for (const tier of sortedTiers) {
      if (contextSize >= tier.minContext) {
        activePrice = { ...tier.price };
      }
    }
  }

  return activePrice;
};

const scaleModelPrice = (price: ModelPrice, multiplier: number): ModelPrice => ({
  input: price.input * multiplier,
  output: price.output * multiplier,
  ...(typeof price.cachingWrite === "number"
    ? { cachingWrite: price.cachingWrite * multiplier }
    : {}),
  ...(typeof price.cachingRead === "number"
    ? { cachingRead: price.cachingRead * multiplier }
    : {}),
  ...(typeof price.inputCacheHit === "number"
    ? { inputCacheHit: price.inputCacheHit * multiplier }
    : {}),
});

const scaleModelInputOutputPrice = (
  price: ModelPrice,
  multiplier: number
): ModelPrice => ({
  ...price,
  input: price.input * multiplier,
  output: price.output * multiplier,
});

const scaleModelServiceTierPrice = (
  price: ModelPrice,
  inputOutputMultiplier: number,
  cacheMultiplier?: number
): ModelPrice => ({
  ...price,
  input: price.input * inputOutputMultiplier,
  output: price.output * inputOutputMultiplier,
  ...(typeof cacheMultiplier === "number" && typeof price.cachingWrite === "number"
    ? { cachingWrite: price.cachingWrite * cacheMultiplier }
    : {}),
  ...(typeof cacheMultiplier === "number" && typeof price.cachingRead === "number"
    ? { cachingRead: price.cachingRead * cacheMultiplier }
    : {}),
});

const resolveGoogleServiceTierPrice = (
  model: Model,
  price: ModelPrice,
  billingServiceTier?: string
): ModelPrice => {
  const normalizedTier =
    typeof billingServiceTier === "string"
      ? billingServiceTier.trim().toLowerCase()
      : "";
  const imageOutputPrice =
    typeof model.imageTokenPricePerMillion === "number"
      ? model.imageTokenPricePerMillion
      : undefined;
  const priceWithImageOutput =
    typeof imageOutputPrice === "number"
      ? { ...price, output: imageOutputPrice }
      : price;
  const serviceTierMultiplier =
    normalizedTier === "batch" ||
    normalizedTier === "flex" ||
    normalizedTier === "priority"
      ? model.serviceTierPriceMultipliers?.[normalizedTier]
      : undefined;

  if (serviceTierMultiplier) {
    return scaleModelServiceTierPrice(
      priceWithImageOutput,
      serviceTierMultiplier.inputOutput,
      serviceTierMultiplier.cache
    );
  }

  if (normalizedTier === "flex" || normalizedTier === "batch") {
    return scaleModelInputOutputPrice(priceWithImageOutput, 0.5);
  }

  if (normalizedTier === "priority") {
    return scaleModelInputOutputPrice(priceWithImageOutput, 1.8);
  }

  return priceWithImageOutput;
};

const resolveEffectiveModelPrice = ({
  model,
  usage,
  provider,
  billingServiceTier,
}: {
  model: Model;
  usage: Usage;
  provider: string;
  billingServiceTier?: string;
}): ModelPrice => {
  const resolvedPrice = resolveModelPrice(model, usage);
  if (provider === "google") {
    return resolveGoogleServiceTierPrice(model, resolvedPrice, billingServiceTier);
  }
  return resolvedPrice;
};

// ==================== 辅助逻辑：价格保护 ====================

const getEffectivePrices = (
  resolvedPrice: ModelPrice,
  externalPrice?: ExternalPrice
): {
  input: number;
  output: number;
  cachingWrite: number;
  cachingRead: number;
} => {
  const effectiveInputPrice = Math.max(
    externalPrice?.input || 0,
    resolvedPrice.input
  );
  const effectiveOutputPrice = Math.max(
    externalPrice?.output || 0,
    resolvedPrice.output
  );

  return {
    input: effectiveInputPrice,
    output: effectiveOutputPrice,
    cachingWrite: resolvedPrice.cachingWrite || 0,
    cachingRead: resolvedPrice.cachingRead || 0,
  };
};

// ==================== 具体计算函数 ====================

const calculateAnthropicCost = (
  resolvedPrice: ModelPrice,
  usage: Usage,
  externalPrice?: ExternalPrice
): CostBreakdown => {
  const {
    input_tokens,
    output_tokens,
    cache_creation_input_tokens,
    cache_read_input_tokens,
  } = usage;

  const {
    input: effectiveInputPrice,
    output: effectiveOutputPrice,
    cachingWrite: effectiveCachingWritePrice,
    cachingRead: effectiveCachingReadPrice,
  } = getEffectivePrices(resolvedPrice, externalPrice);

  const regularInputTokens = input_tokens - cache_read_input_tokens;

  const regularTotal =
    (regularInputTokens * resolvedPrice.input +
      output_tokens * resolvedPrice.output +
      cache_creation_input_tokens * (resolvedPrice.cachingWrite || 0) +
      cache_read_input_tokens * (resolvedPrice.cachingRead || 0)) /
    1_000_000;

  const chargeTotal =
    (regularInputTokens * effectiveInputPrice +
      output_tokens * effectiveOutputPrice +
      cache_creation_input_tokens * effectiveCachingWritePrice +
      cache_read_input_tokens * effectiveCachingReadPrice) /
    1_000_000;

  return {
    regular: regularTotal,
    charge: chargeTotal,
    details: {
      inputCost: (regularInputTokens * resolvedPrice.input) / 1_000_000,
      outputCost: (output_tokens * resolvedPrice.output) / 1_000_000,
      cachingWriteCost:
        (cache_creation_input_tokens * (resolvedPrice.cachingWrite || 0)) /
        1_000_000,
      cachingReadCost:
        (cache_read_input_tokens * (resolvedPrice.cachingRead || 0)) /
        1_000_000,
    },
  };
};

const calculateCacheBasedCost = (
  resolvedPrice: ModelPrice,
  usage: Usage,
  externalPrice?: ExternalPrice
): CostBreakdown => {
  const { input_tokens, output_tokens, cache_read_input_tokens } = usage;
  const { input: effectiveInputPrice, output: effectiveOutputPrice } =
    getEffectivePrices(resolvedPrice, externalPrice);

  const cacheMissTokens = input_tokens - cache_read_input_tokens;
  const cacheHitPrice = resolvedPrice.inputCacheHit || 0;

  const regularTotal =
    (cacheMissTokens * resolvedPrice.input +
      cache_read_input_tokens * cacheHitPrice +
      output_tokens * resolvedPrice.output) /
    1_000_000;

  const chargeTotal =
    (cacheMissTokens * effectiveInputPrice +
      cache_read_input_tokens * cacheHitPrice +
      output_tokens * effectiveOutputPrice) /
    1_000_000;

  return {
    regular: regularTotal,
    charge: chargeTotal,
    details: {
      inputCost: (cacheMissTokens * resolvedPrice.input) / 1_000_000,
      outputCost: (output_tokens * resolvedPrice.output) / 1_000_000,
      cachingReadCost: (cache_read_input_tokens * cacheHitPrice) / 1_000_000,
      cachingWriteCost: 0,
    },
  };
};

const calculateSimpleCost = (
  resolvedPrice: ModelPrice,
  usage: Usage,
  externalPrice?: ExternalPrice
): CostBreakdown => {
  const { input_tokens, output_tokens } = usage;
  const { input: effectiveInputPrice, output: effectiveOutputPrice } =
    getEffectivePrices(resolvedPrice, externalPrice);

  const regularTotal =
    (input_tokens * resolvedPrice.input +
      output_tokens * resolvedPrice.output) /
    1_000_000;

  const chargeTotal =
    (input_tokens * effectiveInputPrice +
      output_tokens * effectiveOutputPrice) /
    1_000_000;

  return {
    regular: regularTotal,
    charge: chargeTotal,
    details: {
      inputCost: (input_tokens * resolvedPrice.input) / 1_000_000,
      outputCost: (output_tokens * resolvedPrice.output) / 1_000_000,
      cachingWriteCost: 0,
      cachingReadCost: 0,
    },
  };
};

const calculateOpenRouterFallbackCost = (
  resolvedPrice: ModelPrice,
  usage: Usage,
  externalPrice?: ExternalPrice
): CostBreakdown => {
  if (
    typeof resolvedPrice.cachingWrite === "number" ||
    typeof resolvedPrice.cachingRead === "number"
  ) {
    return calculateAnthropicCost(resolvedPrice, usage, externalPrice);
  }

  if (typeof resolvedPrice.inputCacheHit === "number") {
    return calculateCacheBasedCost(resolvedPrice, usage, externalPrice);
  }

  return calculateSimpleCost(resolvedPrice, usage, externalPrice);
};

// OpenRouter usage.cost 是按其账户 credit（USD 基准）返回，
// OpenRouter belongs to the non-GPT/non-Claude bucket: 1 USD = 7 credits.
const OPENROUTER_COST_MULTIPLIER = 7;

const calculateOpenRouterCost = (usage: Usage): CostBreakdown => {
  if (!usage || typeof usage.cost !== "number" || usage.cost <= 0) {
    return {
      regular: 0,
      charge: 0,
      details: {
        inputCost: 0,
        outputCost: 0,
        cachingWriteCost: 0,
        cachingReadCost: 0,
      },
    };
  }

  const regular = usage.cost * OPENROUTER_COST_MULTIPLIER;

  return {
    regular,
    charge: regular,
    details: {
      inputCost: regular,
      outputCost: 0,
      cachingWriteCost: 0,
      cachingReadCost: 0,
    },
  };
};

const resolveOpenAIBuiltInImageSurcharge = (
  model: Model,
  usage: Usage
): number => {
  const imageGenerationCount =
    typeof usage.image_generation_count === "number" &&
    Number.isFinite(usage.image_generation_count)
      ? usage.image_generation_count
      : 0;
  const pricePerImage =
    getApproxPricePerImage(model) ??
    getApproxPricePerImage(findModelConfig("openai", "gpt-image-2")) ??
    0;

  if (imageGenerationCount <= 0 || pricePerImage <= 0) return 0;
  return imageGenerationCount * pricePerImage;
};

// ==================== 路由与分发 ====================

const calculateBasicCost = (
  model: Model,
  usage: Usage,
  provider: string,
  externalPrice?: ExternalPrice,
  billingServiceTier?: string
): CostBreakdown => {
  if (!usage || typeof usage.input_tokens !== "number") {
    throw new Error("Invalid usage data");
  }

  const resolvedPrice = resolveEffectiveModelPrice({
    model,
    usage,
    provider,
    billingServiceTier,
  });

  switch (provider) {
    case "deepseek":
    case "openai":
    case "deepinfra":
      return calculateCacheBasedCost(resolvedPrice, usage, externalPrice);

    case "anthropic":
      return calculateAnthropicCost(resolvedPrice, usage, externalPrice);

    case "google":
      if (model.name.includes("gemini-3")) {
        return calculateAnthropicCost(resolvedPrice, usage, externalPrice);
      }
      return calculateSimpleCost(resolvedPrice, usage, externalPrice);

    case "openrouter": {
      const orCost = calculateOpenRouterCost(usage);
      if (orCost.regular > 0) return orCost;
      return calculateOpenRouterFallbackCost(
        resolvedPrice,
        usage,
        externalPrice
      );
    }

    case "mistral":
    case "xai":
    case "fireworks":
    default:
      return calculateSimpleCost(resolvedPrice, usage, externalPrice);
  }
};

const calculatePayDistribution = (
  costs: CostBreakdown,
  externalPrice?: ExternalPrice,
  sharingLevel: "default" | "split" | "full"
): Record<string, number> => {
  const pay: Record<string, number> = {};

  pay[nolotusId] = costs.regular;

  const sharingRatios = {
    default: 0,
    split: 0.5,
    full: 1,
  };

  if (externalPrice?.creatorId) {
    const profit = Math.max(0, costs.charge - costs.regular);

    if (profit > 0) {
      switch (sharingLevel) {
        case "split":
          pay[externalPrice.creatorId] = profit * sharingRatios.split;
          break;
        case "full":
          pay[externalPrice.creatorId] = profit;
          break;
        default:
          break;
      }
    }
  }

  return Object.fromEntries(
    Object.entries(pay).map(([key, value]) => [
      key,
      Number(value.toFixed(6)),
    ])
  );
};

export const calculatePrice = ({
  modelName,
  usage,
  externalPrice,
  // 不设默认值，undefined 表示 custom/未知 provider，走 zeroCostModel 路径
  provider,
  billingServiceTier,
  sharingLevel = "default",
}: CalculatePriceParams): PriceResult => {
  // apiSource="custom" 的 agent 不一定有 provider，或 provider 不在 MODEL_MAP 里。
  // 此时平台不承担 API 成本（由 agent owner 自费），但 agent 可能对外设有 inputPrice/outputPrice，
  // 仍需走 externalPrice 计费路径向用户收费并分成给创作者。
  // 用零成本的虚拟 model 代替，让 calculateBasicCost 正常走 externalPrice 分支。
  let model: ReturnType<typeof getModelConfig>;
  try {
    model = getModelConfig(provider, modelName);
  } catch {
    const zeroCostModel: Model = {
      name: modelName,
      hasVision: false,
      price: { input: 0, output: 0 },
    };
    const costs = calculateBasicCost(
      zeroCostModel,
      usage,
      "custom",
      externalPrice,
      billingServiceTier
    );
    const pay = calculatePayDistribution(costs, externalPrice, sharingLevel);
    return { cost: Number(costs.charge.toFixed(6)), pay };
  }

  const costs = calculateBasicCost(
    model,
    usage,
    provider,
    externalPrice,
    billingServiceTier
  );
  const openAIImageSurcharge =
    provider === "openai" ? resolveOpenAIBuiltInImageSurcharge(model, usage) : 0;
  const adjustedCosts =
    openAIImageSurcharge > 0
      ? {
          ...costs,
          regular: costs.regular + openAIImageSurcharge,
          charge: costs.charge + openAIImageSurcharge,
          details: costs.details
            ? {
                ...costs.details,
                outputCost: costs.details.outputCost + openAIImageSurcharge,
              }
            : costs.details,
        }
      : costs;
  const pay = calculatePayDistribution(adjustedCosts, externalPrice, sharingLevel);

  return {
    cost: Number(adjustedCosts.charge.toFixed(6)),
    pay,
  };
};
