import type { Agent } from "../../app/types";
import { findModelConfig } from "./providers";
import type { Model } from "./types";

export type ImageSizeKey = "1K" | "2K" | "4K";
export type ImageQualityKey = "low" | "medium" | "high" | "auto";

type ImagePricingModel = Pick<
  Model,
  "pricePerImage" | "imageTokenPricePerMillion" | "imageOutputTokenEstimateBySize"
>;

const DEFAULT_IMAGE_SIZE: ImageSizeKey = "1K";
const DEFAULT_IMAGE_QUALITY: ImageQualityKey = "medium";

type ImageTokenEstimate =
  NonNullable<ImagePricingModel["imageOutputTokenEstimateBySize"]>[ImageSizeKey];

const hasEstimateForSize = (
  tokenEstimates: NonNullable<ImagePricingModel["imageOutputTokenEstimateBySize"]>,
  size: ImageSizeKey
): boolean => typeof tokenEstimates[size] !== "undefined";

const resolveTokenEstimate = (
  estimate: ImageTokenEstimate,
  requestedQuality?: ImageQualityKey
): number | undefined => {
  if (typeof estimate === "number") return estimate;
  if (!estimate) return undefined;

  const quality =
    requestedQuality && typeof estimate[requestedQuality] === "number"
      ? requestedQuality
      : DEFAULT_IMAGE_QUALITY;
  return estimate[quality];
};

export const getApproxPricePerImage = (
  model: ImagePricingModel | null | undefined,
  requestedSize?: ImageSizeKey,
  requestedQuality?: ImageQualityKey
): number | undefined => {
  if (!model) return undefined;

  if (typeof model.pricePerImage === "number") {
    return model.pricePerImage;
  }

  if (typeof model.imageTokenPricePerMillion !== "number") {
    return undefined;
  }

  const tokenEstimates = model.imageOutputTokenEstimateBySize;
  if (!tokenEstimates) return undefined;

  const resolvedSize =
    requestedSize && hasEstimateForSize(tokenEstimates, requestedSize)
      ? requestedSize
      : DEFAULT_IMAGE_SIZE;
  const outputTokens = resolveTokenEstimate(
    tokenEstimates[resolvedSize],
    requestedQuality
  );

  if (typeof outputTokens !== "number") {
    return undefined;
  }

  return (model.imageTokenPricePerMillion * outputTokens) / 1_000_000;
};

const OPENAI_IMAGE_FALLBACK_MODEL = "gpt-image-2";

export const getApproxAgentPricePerImage = (
  agent: Pick<Agent, "provider" | "model" | "imageConfig">
): number | undefined => {
  if (!agent.imageConfig?.enabled || !agent.provider || !agent.model) {
    return undefined;
  }

  const requestedSize = agent.imageConfig.imageSize as ImageSizeKey | undefined;
  const directModel = findModelConfig(agent.provider, agent.model);
  const directPrice = getApproxPricePerImage(directModel, requestedSize);
  if (typeof directPrice === "number") {
    return directPrice;
  }

  if (String(agent.provider).toLowerCase() !== "openai") {
    return undefined;
  }

  const fallbackModel = findModelConfig("openai", OPENAI_IMAGE_FALLBACK_MODEL);
  return getApproxPricePerImage(fallbackModel, requestedSize);
};
