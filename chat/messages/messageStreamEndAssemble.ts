// Wave11 — pure core for assembling the final assistant Message at stream end.
//
// Extracted from the `messageStreamEnd` thunk in messageSlice. This function
// only builds the `Message` object that gets persisted; it does NOT touch
// `normalizeAssistantContentBuffer`, write, `updateTokens`, `updateDialogTitle`,
// summary, refs, or understanding capture — those remain in the thunk (they
// have side effects / await).
//
// Key invariants kept identical to the inline thunk logic:
//   - `isStreaming: false` (terminal state)
//   - `userId` is resolved via `resolveMessageOwner` and written LAST so
//     `...otherPersistedMessageMetadata` / metadata cannot overwrite it
//   - `tool_calls` is only attached when non-empty
//   - `metadata` only attached when finalMetadata is defined

import type { CompletionFinishReason, Message } from "./types";
import { resolveMessageOwner } from "./resolveMessageOwner";

export interface AssembleFinalAssistantMessageInput {
  messageId: string;
  msgKey: string;
  finalVisibleContent: Message["content"];
  thinkContent: string;
  agentConfig: { dbKey: string; name?: string };
  finalUsageData:
    | { completion_tokens: number }
    | undefined;
  toolCalls?:
    | Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>
    | undefined;
  /**
   * Provider 报告的收尾原因（OpenAI chat.completions 语义）。
   * assembleFinalAssistantMessage 只把需要用户知道的值写进 Message：
   * "length"（撞输出上限被截断）、"content_filter"、以及工具轮的 "tool_calls"。
   * "stop" 是正常结束，丢弃，避免污染记录。
   */
  finishReason?: CompletionFinishReason;
  otherPersistedMessageMetadata: Partial<Message>;
  finalMetadata: Record<string, unknown> | undefined;
  agentName: string | undefined;
  userId: string;
}

/**
 * Assemble the final, persistable assistant `Message` after stream end.
 *
 * `userId` is passed in (already resolved via `resolveMessageOwner`) and
 * stamped last so persisted metadata / inferred metadata cannot clobber the
 * authoritative owner.
 */
export function assembleFinalAssistantMessage(
  input: AssembleFinalAssistantMessageInput,
): Message {
  const {
    messageId,
    msgKey,
    finalVisibleContent,
    thinkContent,
    agentConfig,
    finalUsageData,
    toolCalls,
    finishReason,
    otherPersistedMessageMetadata,
    finalMetadata,
    agentName,
    userId,
  } = input;

  const message: Message = {
    id: messageId,
    dbKey: msgKey,
    content: finalVisibleContent,
    thinkContent,
    role: "assistant",
    agentKey: agentConfig.dbKey,
    cybotKey: agentConfig.dbKey,
    usage: finalUsageData,
    isStreaming: false,
    ...otherPersistedMessageMetadata,
    ...(finalMetadata ? { metadata: finalMetadata } : {}),
    ...(agentName ? { agentName } : {}),
    ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    // finishReason: 只存需要用户知道的值。
    // "stop" 是正常结束，丢弃；null/undefined 也丢弃，避免写 undefined 进记录。
    // 保留 "length" / "content_filter" / "tool_calls"，让界面能据此提示截断。
    ...(finishReason && finishReason !== "stop" ? { finishReason } : {}),
    // Authoritative owner last so metadata cannot overwrite it.
    userId,
  };

  // Defensive: never let a persisted metadata field resurrect streaming state
  // on the terminal message.
  message.isStreaming = false;
  // Owner authority is absolute — reassert after the spread in case a caller
  // mistakenly included userId inside otherPersistedMessageMetadata.
  message.userId = userId;

  return message;
}

export { resolveMessageOwner };