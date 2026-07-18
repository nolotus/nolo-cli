import { serializeMessageContent } from "./messageContent";
import {
  buildActivityTimeline,
  type ToolActivityStatus,
} from "./web/toolDisplayName";

type ActivityMessage = Parameters<typeof buildActivityTimeline>[0][number];

type AssistantActivityCompletionInput = {
  messages: ActivityMessage[];
  finalContent: unknown;
};

type AssistantActivityCompletionMetadata = {
  activity: {
    phase: {
      id: string;
      title: string;
      index?: number;
      total?: number;
      status: Extract<ToolActivityStatus, "success">;
    };
  };
};

const FINAL_DELIVERY_PHASE_PATTERNS = [
  /汇报/,
  /回复/,
  /总结/,
  /结果/,
  /交付/,
  /可视化/,
  /图表/,
  /report/i,
  /deliver/i,
  /result/i,
  /summary/i,
  /visual/i,
  /chart/i,
];

const FAILED_FINAL_CONTENT_PATTERNS = [
  /抱歉/,
  /无法/,
  /不能/,
  /失败/,
  /出错/,
  /未完成/,
  /cannot/i,
  /can't/i,
  /failed/i,
  /error/i,
  /unable/i,
];

function isLikelyFinalDeliveryPhase(title: string): boolean {
  return FINAL_DELIVERY_PHASE_PATTERNS.some((pattern) => pattern.test(title));
}

function isLikelyFailedFinalContent(text: string): boolean {
  return FAILED_FINAL_CONTENT_PATTERNS.some((pattern) => pattern.test(text));
}

export function inferAssistantActivityCompletionMetadata({
  messages,
  finalContent,
}: AssistantActivityCompletionInput): AssistantActivityCompletionMetadata | undefined {
  const finalText = serializeMessageContent(finalContent, "[图片]")?.trim();
  if (!finalText || isLikelyFailedFinalContent(finalText)) return undefined;

  const timeline = buildActivityTimeline(messages);
  if (timeline.totalPhases <= 1 || timeline.completedPhases >= timeline.totalPhases) {
    return undefined;
  }

  const finalPhase = timeline.phases[timeline.phases.length - 1];
  if (!finalPhase || finalPhase.status !== "pending") return undefined;

  const priorPhases = timeline.phases.slice(0, -1);
  if (priorPhases.length === 0 || priorPhases.some((phase) => phase.status !== "success")) {
    return undefined;
  }

  if (!isLikelyFinalDeliveryPhase(finalPhase.title)) return undefined;

  return {
    activity: {
      phase: {
        id: finalPhase.id,
        title: finalPhase.title,
        ...(finalPhase.index !== undefined ? { index: finalPhase.index } : {}),
        ...(finalPhase.total !== undefined ? { total: finalPhase.total } : {}),
        status: "success",
      },
    },
  };
}
