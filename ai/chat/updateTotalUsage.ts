// 文件路径: ai/chat/updateTotalUsage.ts

import { CompletionUsage } from "../../chat/messages/types";

/**
 * ✨ 新增辅助函数 ✨
 * 根据新的数据块更新累积的 token 使用量。
 * @param currentUsage - 当前的累积 usage 对象，可能为 null。
 * @param newUsageChunk - 从流中收到的新 usage 数据块。
 * @returns 更新后的 usage 对象。
 */
export function updateTotalUsage(
  currentUsage: CompletionUsage | null,
  newUsageChunk: Partial<CompletionUsage>
): CompletionUsage | null {
  if (!newUsageChunk) {
    return currentUsage;
  }

  // 如果是第一次接收，直接克隆新数据块
  if (!currentUsage) {
    return {
      completion_tokens: 0,
      prompt_tokens: 0,
      total_tokens: 0,
      ...newUsageChunk,
    } as CompletionUsage;
  }

  // 否则，在现有基础上进行累加或更新
  const updatedUsage: CompletionUsage = { ...currentUsage };

  // === token 相关 ===
  // 这里假设 usage 是累积的还是单次的？
  // 如果是 OpenAI 流式 output，usage 通常只在最后一次 chunk 发送完整的统计值 (除了 Azure 等可能变体)。
  // 如果是这种情况，我们直接覆盖即可。
  // 但如果服务端分片发送增量（比较少见但有可能），则需要累加。
  // 原代码逻辑是：
  // updatedUsage.completion_tokens = newUsageChunk.completion_tokens ?? updatedUsage.completion_tokens;
  // 这意味着如果有新值就覆盖，没新值保持原样。这适合 "最后一次发送完整值" 的场景。

  // 保持原逻辑：覆盖
  if (newUsageChunk.completion_tokens !== undefined) updatedUsage.completion_tokens = newUsageChunk.completion_tokens;
  if (newUsageChunk.prompt_tokens !== undefined) updatedUsage.prompt_tokens = newUsageChunk.prompt_tokens;
  if (newUsageChunk.total_tokens !== undefined) updatedUsage.total_tokens = newUsageChunk.total_tokens;


  if (newUsageChunk.prompt_tokens_details) {
    updatedUsage.prompt_tokens_details = {
      ...(updatedUsage.prompt_tokens_details || {}),
      ...newUsageChunk.prompt_tokens_details,
    };
  }
  if (newUsageChunk.completion_tokens_details) {
    updatedUsage.completion_tokens_details = {
      ...(updatedUsage.completion_tokens_details || {}),
      ...newUsageChunk.completion_tokens_details,
    };
  }

  // === OpenRouter usage.cost 相关 ===
  if (typeof newUsageChunk.cost === "number") {
    // 对于 OpenRouter，通常只有最后一条 chunk 带 cost，这里直接覆盖即可
    updatedUsage.cost = newUsageChunk.cost;
  }

  if (newUsageChunk.cost_details) {
    updatedUsage.cost_details = {
      ...(updatedUsage.cost_details || {}),
      ...newUsageChunk.cost_details,
    };
  }

  if (
    typeof newUsageChunk.billing_provider === "string" &&
    newUsageChunk.billing_provider.trim()
  ) {
    updatedUsage.billing_provider = newUsageChunk.billing_provider.trim();
  }

  if (
    typeof newUsageChunk.billing_model === "string" &&
    newUsageChunk.billing_model.trim()
  ) {
    updatedUsage.billing_model = newUsageChunk.billing_model.trim();
  }

  return updatedUsage;
}
