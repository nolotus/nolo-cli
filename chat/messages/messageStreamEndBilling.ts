// Wave17 — pure billing usage shaping for messageStreamEnd (Redux-free).

import { estimateMissingUsage } from "../../ai/token/missingUsageEstimate";
import type { MessageContentPart } from "./types";
import {
  countImageGenerationOutputsInContent,
  isOpenAIBuiltInImageGenerationAgent,
  withImageGenerationCount,
} from "../../ai/token/openaiImageGenerationUsage";
import { serializeMessageContent } from "./messageContent";

export type StreamEndBillingUsages = {
  imageGenerationCount: number;
  billedUsage: unknown;
  billedEstimatedUsage: unknown;
  hasReportedUsage: boolean;
  /** Non-empty text/image placeholder content suitable for updateDialogTitle. */
  titleEligible: boolean;
};

/**
 * Shape provider usage (or an estimate) for updateTokens, applying image
 * generation count only for OpenAI built-in image agents.
 */
export function resolveStreamEndBillingUsages(input: {
  agentConfig: any;
  totalUsage: any;
  /**
   * 就是 Message.content：字符串或 OpenAI 风格的多模态数组。以前写的是 unknown，
   * 比调用方实际传的更宽，导致往下传给 countImageGenerationOutputsInContent
   * （其签名是 string | any[] | null | undefined）时类型对不上。
   */
  finalVisibleContent: string | MessageContentPart[];
}): StreamEndBillingUsages {
  const { agentConfig, totalUsage, finalVisibleContent } = input;
  const imageGenerationCount =
    countImageGenerationOutputsInContent(finalVisibleContent);
  const billedUsage = isOpenAIBuiltInImageGenerationAgent(agentConfig)
    ? withImageGenerationCount(totalUsage, imageGenerationCount)
    : totalUsage;
  const estimatedUsage = estimateMissingUsage({
    content: finalVisibleContent,
  });
  const billedEstimatedUsage = isOpenAIBuiltInImageGenerationAgent(agentConfig)
    ? withImageGenerationCount(estimatedUsage, imageGenerationCount)
    : estimatedUsage;
  const titleEligibleContent =
    serializeMessageContent(finalVisibleContent, "[图片]") ?? "";

  return {
    imageGenerationCount,
    billedUsage,
    billedEstimatedUsage,
    hasReportedUsage: Boolean(totalUsage),
    titleEligible: titleEligibleContent.trim() !== "",
  };
}
