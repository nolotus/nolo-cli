import type { Agent } from "../../app/types";
import { findModelConfig } from "./providers";
import type { Model } from "./types";

export type ImageSizeKey = "1K" | "2K" | "4K";

type ImagePricingModel = Pick<
  Model,
  "pricePerImage" | "imageTokenPricePerMillion" | "imageOutputTokenEstimateBySize"
>;

const DEFAULT_IMAGE_SIZE: ImageSizeKey = "1K";

export const getApproxPricePerImage = (
  model: ImagePricingModel | null | undefined,
  requestedSize?: ImageSizeKey
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
    requestedSize && typeof tokenEstimates[requestedSize] === "number"
      ? requestedSize
      : DEFAULT_IMAGE_SIZE;
  const outputTokens = tokenEstimates[resolvedSize];

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
