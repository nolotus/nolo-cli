// 文件路径: packages/ai/context/retention.ts

/**
 * 将 contextRetention slider (1–100) 映射为实际保留比例 R ∈ (0, 1)。
 *
 * 分三档线性映射：
 * - 低保留：  1–30  → 15% ~ 30%
 * - 中保留： 31–70 → 30% ~ 60%
 * - 高保留： 71–100 → 60% ~ 85%
 */
export const mapRetentionSliderToRatio = (slider: number): number => {
  const s = Math.min(100, Math.max(1, slider));

  if (s <= 30) {
    // Low retention: 15% ~ 30%
    return 0.15 + (0.30 - 0.15) * (s / 30);
  }

  if (s <= 70) {
    // Medium retention: 30% ~ 60%
    return 0.30 + (0.60 - 0.30) * ((s - 30) / 40);
  }

  // High retention: 60% ~ 85%
  return 0.60 + (0.85 - 0.60) * ((s - 70) / 30);
};

/**
 * 安全系数：只允许历史对话最多占用 contextWindow 的 SAFE_BUFFER_RATIO 部分，
 * 预留剩余空间给 system prompt / 工具描述等固定开销。
 */
export const SAFE_BUFFER_RATIO = 0.9;

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
 * - 输入：模型 window、用户 slider、现有 summary 长度、近期对话负载分档
 * - 输出：历史总预算 + 原始消息预算 + 尾部最少保留 token 数
 *
 * 约束与策略：
 * - 历史最多只能占用 contextWindow * SAFE_BUFFER_RATIO
 * - slider 决定「整体偏好多记还是少记」
 * - recentLoad 决定在该偏好下的微调：
 *   - light ：适当放宽，给更多历史空间
 *   - heavy ：适当收紧，为当前大块内容 / 工具描述预留空间
 */
export const planContextUsage = (params: {
  contextWindow: number;
  retentionSlider: number;
  summaryTokens: number;
  recentLoad: ConversationLoad;
}): ContextPlan => {
  const { contextWindow, retentionSlider, summaryTokens, recentLoad } = params;

  const safeWindowLimit = Math.floor(contextWindow * SAFE_BUFFER_RATIO);

  const s = Math.min(100, Math.max(1, retentionSlider));
  const iq = s / 100; // 0~1，表示用户偏好的“记忆强度”

  const isBigWindow = contextWindow >= 128000; // 例如 128k / 1M 等大模型
  const isSmallWindow = contextWindow <= 32000; // 例如 8k / 16k 等小模型

  // 基础历史比例（只考虑 slider，不考虑对话负载）
  // - 小窗口：历史占 35% ~ 70% 的 safeWindow
  // - 中窗口：历史占 40% ~ 75%
  // - 大窗口：历史占 65% ~ 90%（尽量吃满大模型上下文）
  let baseHistoryRatio: number;
  if (isBigWindow) {
    baseHistoryRatio = 0.65 + 0.25 * iq; // 0.65 ~ 0.90
  } else if (isSmallWindow) {
    baseHistoryRatio = 0.35 + 0.35 * iq; // 0.35 ~ 0.70
  } else {
    baseHistoryRatio = 0.40 + 0.35 * iq; // 0.40 ~ 0.75
  }

  // 1. 历史比例：在 baseHistoryRatio 基础上，根据对话负载做微调
  let historyRatio = baseHistoryRatio;

  switch (recentLoad) {
    case "light": {
      // 短句对话：可以多给一点历史空间，但仍保留少量余量给其他上下文
      const maxRatio = isBigWindow ? 0.95 : 0.85;
      historyRatio = clamp(historyRatio * 1.05, 0.3, maxRatio);
      break;
    }
    case "heavy": {
      // 重内容对话：适当收紧历史比例，为当前大块内容 / 工具描述等预留更多窗口
      const maxRatio = isBigWindow ? 0.90 : 0.80;
      historyRatio = clamp(historyRatio * 0.9, 0.3, maxRatio);
      break;
    }
    case "medium":
    default: {
      const maxRatio = isBigWindow ? 0.90 : 0.85;
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
  const minRawRatio = recentLoad === "heavy" ? 0.4 : 0.2;

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
