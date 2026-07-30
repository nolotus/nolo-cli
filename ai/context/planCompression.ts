// 文件路径: packages/ai/context/planCompression.ts

/**
 * 纯决策核心：把「是否压缩 / 压缩多少 / 压缩哪些」从 Redux 副作用中剥离出来。
 *
 * 本模块不调 LLM、不写 DB、不读 store，只根据输入消息与预算算出一个
 * CompressionPlan。副作用（跑摘要模型、落库）由调用方通过 CompressionHost 注入，
 * 以便 TUI / Web / Redux 同构复用同一套决策逻辑。
 */

import type { Message } from "../../chat/messages/types";
import { estimateTokenCount } from "./tokenUtils";
import { serializeMessageContent } from "../../chat/messages/messageContent";
import { ConversationLoad, planContextUsage } from "../context/retention";

// --- 常量 ---

/** 至少压缩 5 条以上才有意义 */
export const MIN_COMPRESS_COUNT = 5;

/** 主动归档时保留最后两条原文，避免刚给用户的结论立刻被折叠进 summary。 */
export const ACTIVE_SUMMARY_TAIL_KEEP_COUNT = 2;

// --- 类型 ---

export type CompressionReason = "task_completed" | "context_budget" | "manual";

export interface CompressionInput {
  allMsgs: Message[];
  summarizedBeforeId?: string;
  summary: string;
  contextWindow: number;
  force?: boolean;
  reason?: CompressionReason;
}

export interface CompressionPlan {
  shouldCompress: boolean;
  compressCount: number;
  msgsToCompress: Message[];
  msgsToKeep: Message[];
  newSummarizedBeforeId?: string;
  /** 本次决策相对于 allMsgs 的起点（summarizedBeforeId 之后第一条的下标）。 */
  startIndex: number;
}

// --- 辅助函数（纯函数，模块内部私有） ---

const getMessageTokenCount = (msg: any): number => {
  if (msg.usage?.completion_tokens) {
    return msg.usage.completion_tokens;
  }
  const content = serializeMessageContent(msg.content) || "";
  return estimateTokenCount(content);
};

const hasOpenEndedToolCall = (msg: Message | undefined): boolean =>
  !!msg &&
  Array.isArray((msg as any).tool_calls) &&
  (msg as any).tool_calls.length > 0;

const isActiveSummaryWorthDoing = (
  pendingTokens: number,
  contextWindow: number
): boolean => {
  const minTokens = Math.min(
    40_000,
    Math.max(10_000, Math.floor(contextWindow * 0.05))
  );
  return pendingTokens >= minTokens;
};

const classifyConversationLoad = (msgs: Message[]): ConversationLoad => {
  const N = 20;
  if (!Array.isArray(msgs) || msgs.length === 0) return "light";

  const tail = msgs.slice(-N);
  const tokenSamples = tail.map(getMessageTokenCount);
  if (tokenSamples.length === 0) return "light";

  const sum = tokenSamples.reduce((acc, v) => acc + v, 0);
  const avg = sum / tokenSamples.length;
  const sorted = [...tokenSamples].sort((a, b) => a - b);
  const p95 = sorted[Math.floor((sorted.length - 1) * 0.95)];

  if (p95 < 200 && avg < 120) {
    return "light";
  }
  if (p95 > 2000 || avg > 1200) {
    return "heavy";
  }
  return "medium";
};

const emptyPlan = (startIndex: number): CompressionPlan => ({
  shouldCompress: false,
  compressCount: 0,
  msgsToCompress: [],
  msgsToKeep: [],
  newSummarizedBeforeId: undefined,
  startIndex,
});

// --- 决策核心 ---

export function planCompression(input: CompressionInput): CompressionPlan {
  const {
    allMsgs,
    summarizedBeforeId,
    summary,
    contextWindow,
    force = false,
    reason,
  } = input;

  // 1. 找到最后一次压缩的位置
  let startIndex = 0;
  if (summarizedBeforeId) {
    const found = allMsgs.findIndex((m) => m.id === summarizedBeforeId);
    if (found !== -1) {
      startIndex = found + 1;
    }
  }

  // 待处理的消息（尚未被压缩进 summary）
  const pendingMsgs = allMsgs.slice(startIndex);
  if (pendingMsgs.length === 0) {
    return emptyPlan(startIndex);
  }

  // 2. 计算当前总开销 = 已有 Summary + 待处理消息
  const summaryTokens = estimateTokenCount(summary || "");
  const pendingTokens = pendingMsgs.reduce(
    (sum, msg) => sum + getMessageTokenCount(msg),
    0
  );
  const totalUsed = summaryTokens + pendingTokens;

  // 3. 基于模型窗口 / slider / 近期负载，规划历史预算
  const adjustedSummaryTokens = Math.max(summaryTokens, 1000);
  const recentLoad = classifyConversationLoad(pendingMsgs);
  const { historyBudget, rawMessageBudget } = planContextUsage({
    contextWindow,
    summaryTokens: adjustedSummaryTokens,
    recentLoad,
  });

  const shouldRunActiveSummary =
    force &&
    reason === "manual" &&
    !hasOpenEndedToolCall(pendingMsgs[pendingMsgs.length - 1]) &&
    isActiveSummaryWorthDoing(pendingTokens, contextWindow);

  // 历史 + 待处理总开销未达到预算，且没有明确的主动归档信号，不触发压缩
  if (totalUsed < historyBudget && !shouldRunActiveSummary) {
    return emptyPlan(startIndex);
  }

  // 4. 需要压缩：决定把哪些消息压进去
  // 目标：压缩后，summary + 保留的原始消息 ≈ historyBudget，
  // 且尽量保留最近的若干条消息。
  let tokensToKeep = 0;
  let keepCount = 0;

  // 从后往前数，保留最近的消息直到填满 rawMessageBudget
  for (let i = pendingMsgs.length - 1; i >= 0; i--) {
    const t = getMessageTokenCount(pendingMsgs[i]);
    if (tokensToKeep + t > rawMessageBudget) break;
    tokensToKeep += t;
    keepCount++;
  }

  // 主动归档时保留最后两条原文，避免刚给用户的结论立刻被折叠进 summary。
  let compressCount =
    shouldRunActiveSummary && totalUsed < historyBudget
      ? Math.max(0, pendingMsgs.length - ACTIVE_SUMMARY_TAIL_KEEP_COUNT)
      : pendingMsgs.length - keepCount;

  // Guard: Prevent breaking tool chains or compressing open-ended tool calls
  // OpenAI requires: Assistant(tool_calls) -> Tool(output) must be contiguous.
  // 1. Ensure we do not cut immediately before a 'tool' message.
  // If pendingMsgs[compressCount] (the first kept message) is 'tool',
  // it means we are summarizing its parent 'assistant'. This is illegal.
  while (
    compressCount > 0 &&
    compressCount < pendingMsgs.length &&
    pendingMsgs[compressCount].role === "tool"
  ) {
    compressCount--;
  }

  // 2. Ensure the last compressed message is not an assistant with tool_calls that needs a future tool output
  // (This is implicitly covered by #1 if tool output exists, but if tool output hasn't arrived yet,
  // we must check the last message itself).
  if (compressCount > 0) {
    const lastCompressed = pendingMsgs[compressCount - 1];
    const hasToolCalls =
      Array.isArray((lastCompressed as any).tool_calls) &&
      (lastCompressed as any).tool_calls.length > 0;
    if (hasToolCalls) {
      // If we are chopping off the end of the conversation, and it ends with a tool call,
      // we must preserve it until tool output arrives.
      // Actually, just to be safe, never compress an active tool call.
      compressCount--;
    }
  }

  // 5. 可压缩的消息太少，不值得压缩
  if (compressCount < MIN_COMPRESS_COUNT) {
    return emptyPlan(startIndex);
  }

  const msgsToCompress = pendingMsgs.slice(0, compressCount);
  const msgsToKeep = pendingMsgs.slice(compressCount);

  // 最后一条被压缩的消息
  const newSummarizedBeforeId = msgsToCompress[msgsToCompress.length - 1].id;

  return {
    shouldCompress: true,
    compressCount,
    msgsToCompress,
    msgsToKeep,
    newSummarizedBeforeId,
    startIndex,
  };
}
