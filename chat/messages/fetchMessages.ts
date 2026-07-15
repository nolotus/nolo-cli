// chat/messages/fetchMessages.ts
import type { Message } from "./types"; // 确保引入你的 Message 类型定义
import { isRecord } from "../../core/isRecord";
import { isTombstoneRecord } from "../../database/tombstones";
import { dialogMessageRange } from "../../database/keys";

// 定义返回类型，包含数据库的 key
export type MessageWithKey = Message & { _key: string };

/**
 * 获取指定对话的消息，支持分页加载。
 * @param db 数据库实例。
 * @param dialogId 对话 ID。
 * @param options 配置选项 (limit?, beforeKey?, throwOnError?)。
 * @returns Promise<MessageWithKey[]> 消息数组 (带 key, 默认最新在前)。
 */
/** limit <= 0 / undefined / null → 不限条数（对话默认拉全量，避免 agent 只看到最近 50 条）。 */
export function isUnboundedMessageLimit(
  limit: number | null | undefined,
): boolean {
  return limit == null || !Number.isFinite(limit) || limit <= 0;
}

export const fetchMessages = async (
  db: any, // TODO: 替换为具体的数据库实例类型
  dialogId: string,
  options: {
    limit?: number;
    beforeKey?: string | null;
    throwOnError?: boolean;
    includeDeleted?: boolean;
  } = {}
): Promise<MessageWithKey[]> => {
  const {
    limit,
    beforeKey = null,
    throwOnError = false,
    includeDeleted = false,
  } = options;

  // --- 输入验证 ---
  if (!dialogId || typeof dialogId !== "string") {
    const errorMsg = "fetchMessages: dialogId 必须是一个非空字符串";
    if (throwOnError) throw new Error(errorMsg);
    console.error(errorMsg);
    return [];
  }
  // 其他验证 (limit, beforeKey) 可以根据需要添加

  // --- 准备查询 ---
  const messages: MessageWithKey[] = [];
  const { start, end } = dialogMessageRange(dialogId);

  const iteratorOptions: any = {
    // TODO: 替换为具体的迭代器选项类型
    gte: start,
    reverse: true, // 总是从新到旧获取
    // 默认不限条数；仅在显式正数 limit 时分页（load older）。
    ...(isUnboundedMessageLimit(limit) ? {} : { limit: Math.floor(limit!) }),
  };

  if (beforeKey) {
    // 加载更早的消息: Key < beforeKey
    iteratorOptions.lt = beforeKey;
  } else {
    // 加载最新的消息: Key <= end
    iteratorOptions.lte = end;
  }

  // --- 执行查询 ---
  try {
    let iterator = db.iterator(iteratorOptions);
    // 处理 react-native-leveldb 可能返回 Promise 的情况
    if (iterator && typeof iterator.then === 'function') {
      iterator = await iterator;
    }


    let count = 0;
    for await (const [key, value] of iterator) {
      count++;
      if (!includeDeleted && isTombstoneRecord(value)) {
        continue;
      }
      // 基本数据校验
      if (isRecord(value) && value.id && value.createdAt) {
        // **关键: 将数据库 key 作为 _key 附加到消息对象上**
        messages.push({ ...(value as Message), _key: key });
      }
    }


    return messages; // 返回的消息数组是 newest first
  } catch (error) {
    console.error(`fetchMessages: 获取对话 ${dialogId} 消息失败:`, error);
    if (throwOnError) throw error;
    return [];
  }
};
