import { getModelInfo } from "../llm/getModelContextWindow";
import { countImageParts } from "../../chat/messages/messageContract";

type AgentLike = {
  provider?: string | null;
  model?: string | null;
  imageConfig?: { enabled?: boolean } | null;
};

type UsageLike = Record<string, any> | null | undefined;

type TraceMessageLike = {
  role?: string;
  content?: string | any[] | null;
};

export const isOpenAIBuiltInImageGenerationAgent = (
  agentConfig: AgentLike | null | undefined
): boolean =>
  String(agentConfig?.provider || "").toLowerCase() === "openai" &&
  !getModelInfo(String(agentConfig?.model || ""))?.hasImageOutput &&
  !!agentConfig?.imageConfig?.enabled;

export const withImageGenerationCount = <T extends UsageLike>(
  usage: T,
  imageGenerationCount: number
): T => {
  if (!usage || !Number.isFinite(imageGenerationCount) || imageGenerationCount <= 0) {
    return usage;
  }

  const existingCount =
    typeof usage.image_generation_count === "number" &&
    Number.isFinite(usage.image_generation_count)
      ? usage.image_generation_count
      : 0;

  return {
    ...usage,
    image_generation_count: Math.max(existingCount, imageGenerationCount),
  };
};

export const countAssistantImageGenerationOutputs = (
  trace: TraceMessageLike[] | null | undefined
): number => {
  if (!Array.isArray(trace)) return 0;
  return trace.reduce((total, message) => {
    if (message?.role !== "assistant") return total;
    return total + countImageParts(message.content ?? null);
  }, 0);
};

export const countImageGenerationOutputsInContent = (
  content: string | any[] | null | undefined
): number => countImageParts(content);
