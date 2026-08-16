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
  realContextUsagePercent?: number;
  /**
   * 防死亡螺旋守卫的基线 token 数。
   *
   * 当前调用方传的是 `estimateTokenCount(currentSummary)`——当前 summary 的
   * token 估算。因为 totalUsed = summaryTokens + pendingTokens，而基线也是
   * summaryTokens，守卫不等式 `totalUsed < baseline + minNew` 精确等价于
   * `pendingTokens < minNew`，即「上次压缩点之后新增消息不足 minNew tokens
   * 则不压缩」。这是守卫的实际语义，与字面含义（上次压缩的 totalUsed）不同
   * 但方向安全：基线低估（忽略保留尾部）→ 守卫更宽松 → 不会误拦必要压缩。
   *
   * force=true 或 realContextUsagePercent >= 78% 的紧急路径绕过此守卫。
   * 注意：78% 紧急出口依赖调用方传入真实遥测；若调用方不传 realContextUsagePercent，
   * 紧急出口只剩 force（cold-resume 需 60 分钟空闲，活跃对话不命中）。
   */
  lastCompactedTokenCount?: number;
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

// --- 辅助函数（纯函数） ---

/** getMessageTokenCount 接受的最小消息形状。 */
export interface TokenCountableMessage {
  content?: unknown;
  tool_calls?: Array<{
    function?: { name?: string; arguments?: unknown };
  }>;
}

/**
 * 估算一条消息在 context 窗口里占用的 token 数（输入侧）。
 *
 * 注意：不能用 `usage.completion_tokens`——那是模型生成回复消耗的输出侧
 * token，不等于这条消息在 context 里占多少。用 completion_tokens 会导致
 * assistant 消息的 context 占用被严重低估（例如回复 200 token 但 content
 * 实际 5000 token），进而让压缩决策错过该压缩的时机。
 *
 * 正确做法：从 content + tool_calls 结构估算输入侧占用。
 *
 * 导出供 compactionShared 的 metrics 复用，确保埋点和决策用同一套口径。
 */
export const getMessageTokenCount = (msg: TokenCountableMessage): number => {
  const content = serializeMessageContent(msg.content) || "";
  let tokens = estimateTokenCount(content);
  // tool_calls 的函数名 + arguments JSON 也占 context token
  if (Array.isArray(msg.tool_calls)) {
    for (const call of msg.tool_calls) {
      const fn = call?.function;
      if (fn?.name) tokens += estimateTokenCount(fn.name);
      const args = fn?.arguments;
      if (args) {
        tokens += estimateTokenCount(
          typeof args === "string" ? args : JSON.stringify(args),
        );
      }
    }
  }
  return tokens;
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

/**
 * Accept either a ratio (0..1) or a percentage (0..100), but reject invalid
 * values so bad provider telemetry falls back to the legacy estimate path.
 */
const normalizeContextUsageRatio = (value: number | undefined): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const ratio = value > 1 ? value / 100 : value;
  return ratio >= 0 && ratio <= 1 ? ratio : undefined;
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

/**
 * 找到上次压缩边界后的待处理消息。
 */
function findPendingMessages(
  allMsgs: Message[],
  summarizedBeforeId?: string,
): { pendingMsgs: Message[]; startIndex: number } {
  let startIndex = 0;
  if (summarizedBeforeId) {
    const found = allMsgs.findIndex((m) => m.id === summarizedBeforeId);
    if (found !== -1) startIndex = found + 1;
  }
  return { pendingMsgs: allMsgs.slice(startIndex), startIndex };
}

/**
 * 判断是否应该触发压缩（预算/遥测/主动归档）。
 */
function shouldTriggerCompaction(args: {
  pendingTokens: number;
  summaryTokens: number;
  contextWindow: number;
  historyBudget: number;
  force: boolean;
  reason?: CompressionReason;
  realContextUsagePercent?: number;
  lastCompactedTokenCount?: number;
  lastMsg?: Message;
}): { trigger: boolean; triggeredByRealUsage: boolean; shouldRunActiveSummary: boolean } {
  const {
    pendingTokens, summaryTokens, contextWindow, historyBudget,
    force, reason, realContextUsagePercent, lastCompactedTokenCount, lastMsg,
  } = args;

  const totalUsed = summaryTokens + pendingTokens;
  const usageRatio = normalizeContextUsageRatio(realContextUsagePercent);

  let shouldTriggerByUsage = false;
  if (usageRatio !== undefined) {
    if (usageRatio >= 0.78) {
      shouldTriggerByUsage = true;
    } else if (usageRatio >= 0.65 && isActiveSummaryWorthDoing(pendingTokens, contextWindow)) {
      shouldTriggerByUsage = true;
    }
  }
  if (totalUsed >= historyBudget) {
    shouldTriggerByUsage = true;
  }

  // 防死亡螺旋守卫
  if (
    typeof lastCompactedTokenCount === "number" &&
    Number.isFinite(lastCompactedTokenCount) &&
    lastCompactedTokenCount >= 0 &&
    !force &&
    !(usageRatio !== undefined && usageRatio >= 0.78)
  ) {
    const minNewTokensToCompress = Math.min(40_000, Math.max(5_000, Math.floor(contextWindow * 0.03)));
    if (totalUsed < lastCompactedTokenCount + minNewTokensToCompress) {
      return { trigger: false, triggeredByRealUsage: false, shouldRunActiveSummary: false };
    }
  }

  const shouldRunActiveSummary =
    force && reason === "manual" && !hasOpenEndedToolCall(lastMsg) && isActiveSummaryWorthDoing(pendingTokens, contextWindow);

  const triggeredByRealUsage = usageRatio !== undefined && shouldTriggerByUsage;
  return { trigger: shouldTriggerByUsage || shouldRunActiveSummary, triggeredByRealUsage, shouldRunActiveSummary };
}

/**
 * 从后往前保留消息直到填满 rawMessageBudget，返回应压缩的条数。
 */
function calculateCompressCount(
  pendingMsgs: Message[],
  rawMessageBudget: number,
  opts: { keepTailCount: boolean; totalUsed: number; historyBudget: number },
): number {
  const { keepTailCount, totalUsed, historyBudget } = opts;

  if (keepTailCount && totalUsed < historyBudget) {
    return Math.max(0, pendingMsgs.length - ACTIVE_SUMMARY_TAIL_KEEP_COUNT);
  }

  let tokensToKeep = 0;
  let keepCount = 0;
  for (let i = pendingMsgs.length - 1; i >= 0; i--) {
    const t = getMessageTokenCount(pendingMsgs[i]);
    if (tokensToKeep + t > rawMessageBudget) break;
    tokensToKeep += t;
    keepCount++;
  }
  return pendingMsgs.length - keepCount;
}

/**
 * 保护 tool chain 边界：不切断 assistant(tool_calls) → tool(result) 配对。
 */
function guardToolChainBoundary(pendingMsgs: Message[], compressCount: number): number {
  let count = compressCount;
  // 不让保留的第一条是 tool（它的 assistant 被压缩了就是孤儿）
  while (count > 0 && count < pendingMsgs.length && pendingMsgs[count].role === "tool") {
    count--;
  }
  // 最后一条被压缩的不能是带 tool_calls 的 assistant（output 还没来）
  if (count > 0) {
    const lastCompressed = pendingMsgs[count - 1];
    if (hasOpenEndedToolCall(lastCompressed)) {
      count--;
    }
  }
  return count;
}

export function planCompression(input: CompressionInput): CompressionPlan {
  const {
    allMsgs, summarizedBeforeId, summary, contextWindow,
    force = false, reason, realContextUsagePercent,
  } = input;

  // 1. 找待处理消息
  const { pendingMsgs, startIndex } = findPendingMessages(allMsgs, summarizedBeforeId);
  if (pendingMsgs.length === 0) return emptyPlan(startIndex);

  // 2. 算 token 开销 + 预算
  const summaryTokens = estimateTokenCount(summary || "");
  const pendingTokens = pendingMsgs.reduce((sum, msg) => sum + getMessageTokenCount(msg), 0);
  const totalUsed = summaryTokens + pendingTokens;
  const adjustedSummaryTokens = Math.max(summaryTokens, 1000);
  const recentLoad = classifyConversationLoad(pendingMsgs);
  const { historyBudget, rawMessageBudget } = planContextUsage({
    contextWindow, summaryTokens: adjustedSummaryTokens, recentLoad,
  });

  // 3. 判断是否触发
  const { trigger, triggeredByRealUsage, shouldRunActiveSummary } = shouldTriggerCompaction({
    pendingTokens, summaryTokens, contextWindow, historyBudget,
    force, reason, realContextUsagePercent,
    lastCompactedTokenCount: input.lastCompactedTokenCount,
    lastMsg: pendingMsgs[pendingMsgs.length - 1],
  });
  if (!trigger) return emptyPlan(startIndex);

  // 4. 算压缩条数 + 保护 tool chain
  let compressCount = calculateCompressCount(pendingMsgs, rawMessageBudget, {
    keepTailCount: shouldRunActiveSummary || triggeredByRealUsage,
    totalUsed, historyBudget,
  });
  compressCount = guardToolChainBoundary(pendingMsgs, compressCount);

  // 5. 太少不值得压缩
  if (compressCount < MIN_COMPRESS_COUNT) return emptyPlan(startIndex);

  const msgsToCompress = pendingMsgs.slice(0, compressCount);
  const msgsToKeep = pendingMsgs.slice(compressCount);
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
