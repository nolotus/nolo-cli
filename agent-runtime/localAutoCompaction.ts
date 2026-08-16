/**
 * localLoop 自动上下文压缩。
 *
 * 复用 web 端 `planCompression` 纯决策，在 CLI/桌面本地路径上：
 * 1) 判定是否需要压缩；2) 用当前 provider 生成事实性摘要；3) 摘要落盘；
 * 4) 把发给 provider 的历史投影为「摘要 + 保留尾部」。
 *
 * 硬约束：摘要只在压缩点生成一次并持久化。压缩点之间前缀必须稳定，
 * 否则会打掉 provider 前缀缓存（实测比不压缩更贵）。
 */

import { planCompression } from "../ai/context/planCompression";
import { estimateTokenCount } from "../ai/context/tokenUtils";
import { getModelContextWindow } from "../ai/llm/getModelContextWindow";
import { canonicalizeToolName } from "./toolNameAliases";
import {
  COMPACTION_SUMMARY_SYSTEM_PROMPT,
  formatMessagesForSummaryWithTruncation,
  formatFileOperationsFromMessages,
  buildCompactionUserContent,
  buildCompactionMetricsFromPlan,
  formatCompactionMetricsLog,
  type CompactionMetrics,
} from "../ai/context/compactionShared";
import type {
  AgentRuntimeHostAdapter,
  AgentRuntimeProvider,
} from "./hostAdapter";
import { buildDialogSummaryLayer } from "./turnContext";
import type { AgentRuntimeChatMessage } from "./types";

/** planCompression 实际读取的字段（见 packages/ai/context/planCompression.ts）。 */
export type PlanCompressionBridgeMessage = {
  id: string;
  role: AgentRuntimeChatMessage["role"];
  content: AgentRuntimeChatMessage["content"];
  tool_calls?: AgentRuntimeChatMessage["tool_calls"];
};

/**
 * 保留向下兼容的 re-export：外部可能仍 import LOCAL_AUTO_COMPACTION_SYSTEM_PROMPT
 * 或 FileOperation，统一指向共享模块的同名常量。
 */
export { COMPACTION_SUMMARY_SYSTEM_PROMPT as LOCAL_AUTO_COMPACTION_SYSTEM_PROMPT } from "../ai/context/compactionShared";

/**
 * AgentRuntimeChatMessage → planCompression 输入桥接。
 * 只映射判定所需字段：id / role / content / tool_calls。
 * id 用稳定的位置索引（历史只追加不重排），以便 summarizedBeforeId 跨轮对齐。
 * P-1 后不再映射 usage.completion_tokens（getMessageTokenCount 从 content 估算）。
 */
export function toPlanCompressionMessages(
  history: AgentRuntimeChatMessage[],
): PlanCompressionBridgeMessage[] {
  return history.map((message, index) => ({
    id: `local-${index}`,
    role: message.role,
    content: message.content,
    ...(Array.isArray(message.tool_calls)
      ? { tool_calls: message.tool_calls }
      : {}),
  }));
}

export function buildLocalSummaryHistoryMessage(
  summary: string,
): AgentRuntimeChatMessage {
  const layer = buildDialogSummaryLayer({ summary });
  return {
    role: "user",
    content:
      layer?.content ??
      `--- 历史对话摘要 ---\n${summary.trim()}`,
  };
}

export function projectHistoryWithSummary(args: {
  history: AgentRuntimeChatMessage[];
  summary: string;
  summarizedBeforeId?: string;
}): AgentRuntimeChatMessage[] {
  const bridged = toPlanCompressionMessages(args.history);
  let startIndex = 0;
  if (args.summarizedBeforeId) {
    const found = bridged.findIndex((m) => m.id === args.summarizedBeforeId);
    if (found !== -1) startIndex = found + 1;
  }
  return [
    buildLocalSummaryHistoryMessage(args.summary),
    ...args.history.slice(startIndex),
  ];
}

/**
 * 认为 provider 前缀缓存已过期的静默时长。
 *
 * 取值偏保守：误判为「已过期」会生成新摘要、改变前缀，把本来还热的缓存毁掉。
 * 常见 provider 的前缀缓存 TTL 在分钟到小时量级，取 60 分钟留足余量。
 */
export const COLD_RESUME_IDLE_MS = 60 * 60 * 1000;

/** 距最后一条带时间戳的历史消息是否已超过 COLD_RESUME_IDLE_MS。 */
export function isColdResume(
  history: AgentRuntimeChatMessage[],
  nowMs: number,
): boolean {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const at = history[i]?.createdAt;
    if (typeof at === "number" && Number.isFinite(at)) {
      return nowMs - at > COLD_RESUME_IDLE_MS;
    }
  }
  // 历史不带时间戳（旧记录或不支持的 host）→ 不触发，保持既有行为。
  return false;
}

export type LocalAutoCompactionResult = {
  history: AgentRuntimeChatMessage[];
  /** True when history was projected through a (new or existing) summary. */
  compressed: boolean;
  /** True only when this call generated and persisted a new summary. */
  summaryGenerated: boolean;
  /**
   * 摘要生成那次 LLM 调用的用量。必须透出并由调用方并入本轮 turnUsage——
   * 否则这次消耗只出现在 provider 账单上，我们自己的 token 记账完全看不到，
   * 形成计费盲区（本轮改动的主题恰恰是成本可观测）。
   */
  usage?: Record<string, unknown>;
  /** P1-8: 压缩 metrics（仅在 summaryGenerated=true 时有值） */
  metrics?: CompactionMetrics;
};

export async function maybeAutoCompactLocalHistory(args: {
  adapter: AgentRuntimeHostAdapter;
  dialogId?: string;
  /** 可注入的当前时间，供 cold-resume 判定使用；测试用来保持确定性。 */
  now?: () => number;
  history: AgentRuntimeChatMessage[];
  model?: string;
  /** Lazy provider resolver — only invoked when a new summary must be generated. */
  resolveProvider: () => Promise<AgentRuntimeProvider>;
  /** Test override; production uses getModelContextWindow(model). */
  contextWindow?: number;
}): Promise<LocalAutoCompactionResult> {
  const { adapter, dialogId, history } = args;
  const unchanged = (): LocalAutoCompactionResult => ({
    history,
    compressed: false,
    summaryGenerated: false,
  });

  if (
    !dialogId ||
    history.length === 0 ||
    typeof adapter.loadDialogSummary !== "function" ||
    typeof adapter.saveDialogSummary !== "function"
  ) {
    return unchanged();
  }

  let stored: { summary: string; summarizedBeforeId?: string } | null = null;
  try {
    stored = await adapter.loadDialogSummary(dialogId);
  } catch (error) {
    console.warn("[localLoop] loadDialogSummary failed:", error);
    return unchanged();
  }

  const existingSummary =
    typeof stored?.summary === "string" ? stored.summary : "";
  const summarizedBeforeId =
    typeof stored?.summarizedBeforeId === "string"
      ? stored.summarizedBeforeId
      : undefined;

  const contextWindow =
    typeof args.contextWindow === "number" &&
    Number.isFinite(args.contextWindow) &&
    args.contextWindow > 0
      ? args.contextWindow
      : getModelContextWindow(args.model ?? "");

  const allMsgs = toPlanCompressionMessages(history);
  // Cold-resume 判定：距上次活动很久再继续的对话，provider 前缀缓存必然已过期，
  // 这一轮无论如何都要全量重发整个上下文。那正是压缩最划算的时刻——反正要付
  // 全量未命中的钱，不如让重发的那份小一点，且后续每一轮都跟着受益。
  //
  // 阈值方向必须保守：若缓存其实还热却误触发，新摘要会改变前缀、把热缓存毁掉。
  // 所以取一个明显高于常见 provider TTL 的值，宁可漏判也不误判。
  const coldResume = isColdResume(history, args.now?.() ?? Date.now());

  const plan = planCompression({
    allMsgs: allMsgs as any,
    summarizedBeforeId,
    summary: existingSummary,
    contextWindow,
    // 防死亡螺旋：用 summary 长度作为上次压缩后的基线。如果新内容没让
    // totalUsed 比 summary 本身增长超过 minNewTokens，不重复触发。
    lastCompactedTokenCount: existingSummary
      ? estimateTokenCount(existingSummary)
      : undefined,
    ...(coldResume ? { force: true, reason: "context_budget" as const } : {}),
  });

  const projectExisting = (): LocalAutoCompactionResult => {
    if (!existingSummary.trim()) return unchanged();
    return {
      history: projectHistoryWithSummary({
        history,
        summary: existingSummary,
        summarizedBeforeId,
      }),
      compressed: true,
      summaryGenerated: false,
    };
  };

  if (!plan.shouldCompress) {
    return projectExisting();
  }

  try {
    const provider = await args.resolveProvider();
    const msgsToCompress =
      plan.msgsToCompress as PlanCompressionBridgeMessage[];
    // 用共享模块的截断版格式化，避免大工具结果撑爆摘要请求（P0-2）。
    const messagesText = formatMessagesForSummaryWithTruncation(msgsToCompress);
    const fileOpsText = formatFileOperationsFromMessages(
      msgsToCompress,
      canonicalizeToolName,
    );
    const promptContent = buildCompactionUserContent({
      previousSummary: existingSummary,
      messagesText,
      fileOpsText,
    });
    const result = await provider.complete([
      { role: "system", content: COMPACTION_SUMMARY_SYSTEM_PROMPT },
      { role: "user", content: promptContent },
    ]);
    const newSummary =
      typeof result.content === "string" ? result.content.trim() : "";
    if (!newSummary) {
      console.warn(
        "[localLoop] auto-compaction produced empty summary; keeping prior projection",
      );
      return projectExisting();
    }

    await adapter.saveDialogSummary({
      dialogId,
      summary: newSummary,
      summarizedBeforeId: plan.newSummarizedBeforeId,
    });

    // P1-8 压缩埋点：记录 metrics 并日志
    const metrics = buildCompactionMetricsFromPlan({
      reason: coldResume ? "cold_resume" : "context_budget",
      previousSummary: existingSummary,
      plan,
      newSummary,
      summaryUsage: result.usage as Record<string, unknown> | undefined,
    });
    console.log(formatCompactionMetricsLog(metrics));

    return {
      history: projectHistoryWithSummary({
        history,
        summary: newSummary,
        summarizedBeforeId: plan.newSummarizedBeforeId,
      }),
      compressed: true,
      summaryGenerated: true,
      ...(result.usage ? { usage: result.usage as Record<string, unknown> } : {}),
      metrics,
    };
  } catch (error) {
    // 观测/优化功能：摘要失败绝不能让本轮对话失败。
    console.warn("[localLoop] auto-compaction failed:", error);
    return projectExisting();
  }
}
