import type { Agent } from "../../../app/types";
import { getModelInfo } from "../../llm/getModelContextWindow";
import { toTrimmedString } from "../../../core/toTrimmedString";
import { getPublicImageAgentMode } from "./publicImageAgentMode";

const LEGACY_IMAGE_MODELS = new Set([
  "google/gemini-3-pro-image-preview",
  "google/gemini-3.1-flash-image-preview",
]);

export function supportsImageGeneration(agent: Agent): boolean {
  if ((agent as any).hasImageOutput === true) return true;

  // Move continuous-agent check before model registry early return
  if (getPublicImageAgentMode(agent as any) === "continuous") return true;

  const modelName = toTrimmedString(agent.model);
  if (!modelName) return false;

  const modelInfo = getModelInfo(modelName);
  if (modelInfo) {
    return !!(modelInfo.hasImageOutput ?? (modelInfo as any).supportsImageOutput);
  }

  const normalized = modelName.toLowerCase();
  if (LEGACY_IMAGE_MODELS.has(normalized)) return true;

  if ((agent as any).imageConfig?.enabled && agent.hasVision) return true;

  if (getPublicImageAgentMode(agent as any) === "continuous") return true;

  return (
    normalized.includes("image-preview") ||
    normalized.includes("flash-image") ||
    normalized.includes("seedream") ||
    normalized.includes("flux.")
  );
}
