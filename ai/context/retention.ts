// 文件路径: packages/ai/context/retention.ts

/**
 * 安全系数：cache-first 策略下尽量保留稳定历史前缀，但仍预留少量空间给
 * system prompt / 工具描述 / 当前输入等固定和动态开销。
 */
export const SAFE_BUFFER_RATIO = 0.95;
const CACHE_FIRST_RETENTION_STRENGTH = 0.95;

/**
 * 对话负载分档：
 * - light  ：短句聊天为主
 * - medium ：中等长度混合
 * - heavy  ：长代码 / 长文档为主
 */
export type ConversationLoad = "light" | "medium" | "heavy";

export interface ContextPlan {
  /**
   * 历史总预算（summary + 原始消息），单位：token
   * 实际不会超过 contextWindow * SAFE_BUFFER_RATIO
   */
  historyBudget: number;
  /**
   * 历史中分配给「原始消息」的预算，单位：token
   * 用于 trimMessagesWithSummary 之类的裁剪逻辑。
   */
  rawMessageBudget: number;
  /**
   * 希望至少保留的「最近尾部消息」的 token 数，用作二次兜底，
   * 确保短句对话能多保几轮，重内容对话能保住最近几条大块内容。
   */
  minTailTokens: number;
}

const clamp = (v: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, v));

/**
 * 统一的上下文使用规划函数：
 * - 输入：模型 window、现有 summary 长度、近期对话负载分档
 * - 输出：历史总预算 + 原始消息预算 + 尾部最少保留 token 数
 *
 * 约束与策略：
 * - 历史最多只能占用 contextWindow * SAFE_BUFFER_RATIO
 * - 默认 cache-first：大上下文模型尽量晚压缩，优先复用 provider prompt/KV cache
 * - recentLoad 决定在该偏好下的微调：
 *   - light ：适当放宽，给更多历史空间
 *   - heavy ：适当收紧，为当前大块内容 / 工具描述预留空间
 */
export const planContextUsage = (params: {
  contextWindow: number;
  summaryTokens: number;
  recentLoad: ConversationLoad;
}): ContextPlan => {
  const { contextWindow, summaryTokens, recentLoad } = params;

  const safeWindowLimit = Math.floor(contextWindow * SAFE_BUFFER_RATIO);

  const iq = CACHE_FIRST_RETENTION_STRENGTH;

  const isLargeWindow = contextWindow >= 512000; // 512k+，如 1M 等大模型
  const isSmallWindow = contextWindow <= 64000; // 64k 以下，本地模型为主

  // 基础历史比例（只考虑默认 cache-first 强度，不考虑对话负载）
  // - small  (≤64k)：本地模型为主，无 provider cache，早压缩
  //   历史占 35% ~ 65% 的 safeWindow
  // - medium (64k~512k)：默认 256k 在这档
  //   历史占 55% ~ 85%
  // - large  (≥512k)：1M 模型，cache-first 极限
  //   历史占 80% ~ 100%，避免过早压缩破坏 prompt/KV cache。
  let baseHistoryRatio: number;
  if (isLargeWindow) {
    baseHistoryRatio = 0.80 + 0.20 * iq; // 0.80 ~ 1.00
  } else if (isSmallWindow) {
    baseHistoryRatio = 0.35 + 0.30 * iq; // 0.35 ~ 0.65
  } else {
    baseHistoryRatio = 0.55 + 0.30 * iq; // 0.55 ~ 0.85
  }

  // 1. 历史比例：在 baseHistoryRatio 基础上，根据对话负载做微调
  let historyRatio = baseHistoryRatio;

  switch (recentLoad) {
    case "light": {
      // 短句对话：可以多给一点历史空间，但仍保留少量余量给其他上下文
      const maxRatio = isLargeWindow ? 1.0 : isSmallWindow ? 0.75 : 0.85;
      historyRatio = clamp(historyRatio * 1.05, 0.3, maxRatio);
      break;
    }
    case "heavy": {
      // 重内容对话：适当收紧历史比例，为当前大块内容 / 工具描述等预留更多窗口
      const maxRatio = isLargeWindow ? 0.98 : isSmallWindow ? 0.70 : 0.80;
      const multiplier = isLargeWindow ? 0.98 : isSmallWindow ? 0.9 : 0.9;
      historyRatio = clamp(historyRatio * multiplier, 0.3, maxRatio);
      break;
    }
    case "medium":
    default: {
      const maxRatio = isLargeWindow ? 1.0 : isSmallWindow ? 0.75 : 0.85;
      historyRatio = clamp(historyRatio, 0.3, maxRatio);
      break;
    }
  }

  const historyBudget = Math.max(
    0,
    Math.floor(safeWindowLimit * historyRatio),
  );

  // 2. 在历史预算里分配给「原始消息」的预算
  //    - summary 已经占用一部分
  //    - 同时保证原始消息至少有一部分空间（heavy 用户更多一点）
  const minRawRatio = isSmallWindow ? 0.5 : isLargeWindow ? 0.2 : 0.3;

  const rawMessageBudget = Math.max(
    Math.floor(historyBudget * minRawRatio),
    historyBudget - summaryTokens,
    0,
  );

  // 3. 希望至少保留的尾部 token 数
  //    - light ：多保几轮短句（不超过 30% window，且上限 8k）
  //    - heavy ：至少给几条大块代码空间（>= 16k，或 25% window）
  //    - medium：取中间值
  let minTailTokens: number;

  if (recentLoad === "light") {
    minTailTokens = Math.min(
      Math.floor(safeWindowLimit * 0.3),
      8000,
    );
  } else if (recentLoad === "heavy") {
    minTailTokens = Math.max(
      Math.floor(safeWindowLimit * 0.25),
      16000,
    );
  } else {
    minTailTokens = Math.floor(safeWindowLimit * 0.2);
  }

  return { historyBudget, rawMessageBudget, minTailTokens };
};
