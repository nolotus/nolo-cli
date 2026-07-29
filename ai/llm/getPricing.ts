import type { Agent } from "../../app/types";
import { getModelConfig } from "../llm/providers";
import { getPublicImageAgentDefaultProfile } from "../agent/utils/publicImageAgentMode";
import { asOptionalFiniteNumber } from "../../core/optionalNumber";
import { asOptionalPositiveFiniteNumber } from "../../core/optionalPositiveNumber";
import { getApproxPricePerImage } from "./imagePricing";

interface ModelPricing {
  inputPrice: number;
  inputCacheHitPrice: number;
  outputPrice: number;
}

interface Prices {
  agentInput: number;
  agentOutput: number;
  serverInput: number;
  serverOutput: number;
}

const MAX_OUTPUT_TOKENS = 8192; // 单次返回最大 token 数

export const getModelPricing = (
  provider: string,
  modelName: string,
  _requestedServiceTier?: string
): ModelPricing | null => {
  let model;
  try {
    model = getModelConfig(provider as any, modelName);
  } catch {
    return null;
  }

  if (!model?.price) return null;

  return getModelPricingForModel(provider, modelName, model);
};

export const getModelPricingForModel = (
  provider: string,
  modelName: string,
  model: { price?: { input: number; inputCacheHit?: number; output: number } | null }
): ModelPricing | null => {
  if (!model.price) return null;

  return {
    inputPrice: model.price.input,
    inputCacheHitPrice:
      typeof model.price.inputCacheHit === "number"
        ? model.price.inputCacheHit
        : 0,
    outputPrice: model.price.output,
  };
};

export const hasExplicitAgentPricing = (config: any): boolean =>
  [config?.inputPrice, config?.outputPrice].some(
    (value) => asOptionalPositiveFiniteNumber(value) !== undefined
  );

export const getPrices = (config: any, serverPrices: any): Prices => ({
  agentInput: Number(config?.inputPrice ?? 0),
  agentOutput: Number(config?.outputPrice ?? 0),
  serverInput: Number(serverPrices?.inputPrice ?? 0),
  serverOutput: Number(serverPrices?.outputPrice ?? 0),
});

/**
 * 计算最终价格：
 * - 从所有价格中取「每百万 tokens 价格」的最大值
 * - 再换算成单 token 价格
 * - 再乘以最大输出 token 数
 */
export const getFinalPrice = (prices: Prices): number => {
  // 1. 取出所有价格字段
  const rawValues = Object.values(prices);

  // 2. 过滤出合法数字（去掉 NaN、Infinity、null/undefined 等）
  const validValues = rawValues.flatMap((value) => {
    const finite = asOptionalFiniteNumber(value);
    return finite === undefined ? [] : [finite];
  });

  // 3. 没有合法值时返回 0，避免 Math.max(...[]) 抛错
  if (validValues.length === 0) {
    return 0;
  }

  // 4. 找到每百万 token 的最高单价
  const maxPricePerMillion = Math.max(...validValues);

  // 5. 换算成单 token 价格
  const maxPricePerToken = maxPricePerMillion / 1_000_000;

  // 6. 计算 8192 个 token 的费用
  return maxPricePerToken * MAX_OUTPUT_TOKENS;
};

/**
 * 每次对话估算的典型 token 用量（输入含历史上下文，输出为单次回复）
 * 仅用于 UI 展示的估算，并非计费依据。
 */
const TYPICAL_INPUT_TOKENS = 500;
const TYPICAL_OUTPUT_TOKENS = 300;

export type AgentPriceHint =
  | {
      type: "per_image";
      amount: number;
      labelKey?: "defaultImageProfileEstimate";
      profileLabel?: string;
    }
  | { type: "per_turn"; amount: number };

export interface CompactTurnPriceDisplay {
  amountText: string;
  unitCount: number;
}

const trimTrailingZeros = (value: string): string => {
  if (!value.includes(".")) return value;
  return value.replace(/\.?0+$/, "");
};

/**
 * 根据 agent 配置返回用户可读的价格提示：
 * - 图像 agent（imageConfig.enabled）：从 model config 查 pricePerImage，以每张为单位
 * - 文字 agent：用典型 token 用量估算每次对话费用
 * - 无价格信息则返回 null
 */
export const getAgentPriceHint = (
  agent: Pick<
    Agent,
    | "inputPrice"
    | "outputPrice"
    | "model"
    | "imageModel"
    | "provider"
    | "imageConfig"
    | "imageWorkflow"
  >
): AgentPriceHint | null => {
  const imagePriceModel = agent.imageModel ?? agent.model;

  if (agent.imageConfig?.enabled && agent.provider && imagePriceModel) {
    try {
      const model = getModelConfig(agent.provider as any, imagePriceModel);
      const mode = agent.imageWorkflow;
      
      if (mode === "generate") {
        // For generator agents, always use the default profile price
        const defaultProfile = getPublicImageAgentDefaultProfile("generate");
        const pricePerImage = getApproxPricePerImage(model, "1K");
        if (typeof pricePerImage === "number") {
          return {
            type: "per_image",
            amount: pricePerImage,
            labelKey: "defaultImageProfileEstimate",
            profileLabel: `${defaultProfile.quality} · ${defaultProfile.size}`,
          };
        }
      } else {
        const pricePerImage = getApproxPricePerImage(
          model,
          agent.imageConfig?.imageSize
        );
        if (typeof pricePerImage === "number") {
          return { type: "per_image", amount: pricePerImage };
        }
      }
    } catch {
      // Fall through to token-based pricing or null.
    }
  }

  const inputPrice = agent.inputPrice ?? 0;
  const outputPrice = agent.outputPrice ?? 0;
  if (inputPrice === 0 && outputPrice === 0) return null;

  const amount =
    (inputPrice * TYPICAL_INPUT_TOKENS + outputPrice * TYPICAL_OUTPUT_TOKENS) /
    1_000_000;
  return { type: "per_turn", amount };
};

/** 将金额格式化为用户可读字符串（2 位有效数字，不使用科学计数法）*/
export const formatPriceAmount = (amount: number): string => {
  if (amount >= 0.1) return amount.toFixed(2);
  if (amount >= 0.01) return amount.toFixed(3);
  if (amount >= 0.001) return amount.toFixed(4);
  if (amount >= 0.0001) return amount.toFixed(5);
  return amount.toFixed(6);
};

export const formatModelCostPerMillion = (
  value?: number,
  creditsUnit = "积分"
): string => {
  const finite = asOptionalFiniteNumber(value);
  if (finite === undefined) return "未知";
  if (finite === 0) return "免费";
  const decimals = Math.abs(finite) < 1 ? 3 : 2;
  const amount = finite
    .toFixed(decimals)
    .replace(/\.0+$/, "")
    .replace(/(\.\d*?[1-9])0+$/, "$1");
  return `${amount} ${creditsUnit}`;
};

export const formatCompactTurnPrice = (
  amount: number
): CompactTurnPriceDisplay => {
  if (amount <= 0) {
    return { amountText: "0", unitCount: 1 };
  }

  if (amount >= 0.01) {
    return {
      amountText: trimTrailingZeros(formatPriceAmount(amount)),
      unitCount: 1,
    };
  }

  const perHundred = amount * 100;
  if (perHundred >= 0.01) {
    return {
      amountText: trimTrailingZeros(formatPriceAmount(perHundred)),
      unitCount: 100,
    };
  }

  return {
    amountText: trimTrailingZeros(formatPriceAmount(amount * 1000)),
    unitCount: 1000,
  };
};
