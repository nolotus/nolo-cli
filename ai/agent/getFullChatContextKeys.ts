
// packages/ai/agent/getFullChatContextKeys.ts
import { RootState } from "../../app/store";
import { selectAllMsgs } from "../../chat/messages/messageSlice";
import { extractReferenceKeysFromMessage } from "../../chat/dialog/actions/extractReferenceKeys";
import type { Message } from "../../chat/messages/types";
import type { DialogConfig } from "../../app/types";
import { extractCustomId } from "../../core/prefix";

/** 简单的数组差集工具：返回 arrA 中不在 arrB 里的元素 */
const difference = <T>(arrA: T[], arrB: T[]): T[] => {
  if (!arrA.length) return [];
  if (!arrB.length) return [...arrA];

  const exclude = new Set(arrB);
  return arrA.filter((item) => !exclude.has(item));
};

/**
 * Collect all possible reference keys for this chat turn:
 * - botInstructionKeys: keys from agentConfig.references of type "instruction"
 * - botKnowledgeKeys: keys from agentConfig.references (non-instruction)
 * - currentInputKeys: keys referenced directly by the user's current input (array parts with pageKey)
 * - historyKeys: keys from all previous messages' content parts
 */
export const getFullChatContextKeys = async (
  state: RootState,
  dispatch: any,
  agentConfig: any,
  userInput: string | any[],
  dialogConfig?: DialogConfig
): Promise<Record<string, Set<string>>> => {
  const msgs = selectAllMsgs(
    state,
    dialogConfig?.dbKey
      ? extractCustomId(dialogConfig.dbKey)
      : dialogConfig?.id
  );

  const botInstructionKeys = new Set<string>();
  const botKnowledgeKeys = new Set<string>();

  if (Array.isArray(agentConfig.references)) {
    for (const ref of agentConfig.references as Array<{
      dbKey: string;
      type: string;
    }>) {
      if (!ref?.dbKey) continue;
      if (ref.type === "instruction") {
        botInstructionKeys.add(ref.dbKey);
      } else {
        botKnowledgeKeys.add(ref.dbKey);
      }
    }
  }

  const currentInputKeys = new Set<string>();
  if (Array.isArray(userInput)) {
    for (const part of userInput) {
      if (part?.pageKey) currentInputKeys.add(part.pageKey);
      if (part?.dialogKey) currentInputKeys.add(part.dialogKey);
    }
  }

  const historyKeys = new Set<string>();

  // 1. 从 DialogConfig.referenceKeys 读取（这是主要的、持久化的引用来源）
  // 即使消息被压缩，这里的 keys 也会保留
  const savedKeys = dialogConfig?.referenceKeys;
  if (Array.isArray(savedKeys)) {
    savedKeys.forEach((k: string) => historyKeys.add(k));
  }

  // 2. 仅扫描尚未被压缩的近期消息
  const scanContentParts = (msg: Message) => {
    if (!msg) return;
    for (const key of extractReferenceKeysFromMessage(msg)) {
      historyKeys.add(key);
    }
  };

  if (msgs && msgs.length > 0) {
    const summarizedBeforeId = dialogConfig?.summarizedBeforeId;

    if (!summarizedBeforeId) {
      // 无压缩记录，扫描全部消息
      for (const msg of msgs) scanContentParts(msg);
    } else {
      let foundMarker = false;
      let startScan = false;

      for (const msg of msgs) {
        if (!startScan) {
          if (msg.id === summarizedBeforeId) {
            foundMarker = true;
            startScan = true;
            // summarizedBeforeId 那条消息本身已被压缩，keys 在 referenceKeys 里，跳过
          }
          continue;
        }
        scanContentParts(msg);
      }

      // marker 找不到说明 Redux 中的消息都是新的，应该全扫
      if (!foundMarker) {
        console.warn(`[getFullChatContextKeys] marker ${summarizedBeforeId} not found, scanning all`);
        for (const msg of msgs) scanContentParts(msg);
      }
    }
  }

  return {
    botInstructionKeys,
    currentInputKeys,
    historyKeys,
    botKnowledgeKeys,
  };
};

/**
 * Deduplicate keys across priority levels.
 * Priority order (high -> low):
 * 1) botInstructionKeys
 * 2) currentInputKeys
 * 3) historyKeys
 * 4) botKnowledgeKeys
 *
 * Return field names match context block identifiers expected downstream.
 */
export const deduplicateContextKeys = (
  keys: Record<string, Set<string>>
): Record<string, string[]> => {
  const {
    botInstructionKeys,
    currentInputKeys,
    historyKeys,
    botKnowledgeKeys,
  } = keys;

  const finalBotInstructionKeys = Array.from(botInstructionKeys);

  const finalCurrentInputKeys = difference(
    Array.from(currentInputKeys),
    finalBotInstructionKeys
  );

  const finalHistoryKeys = difference(Array.from(historyKeys), [
    ...finalBotInstructionKeys,
    ...finalCurrentInputKeys,
  ]);

  const finalBotKnowledgeKeys = difference(Array.from(botKnowledgeKeys), [
    ...finalBotInstructionKeys,
    ...finalCurrentInputKeys,
    ...finalHistoryKeys,
  ]);

  return {
    botInstructionsContext: finalBotInstructionKeys,
    currentInputContext: finalCurrentInputKeys,
    historyContext: finalHistoryKeys,
    botKnowledgeContext: finalBotKnowledgeKeys,
  };
};
