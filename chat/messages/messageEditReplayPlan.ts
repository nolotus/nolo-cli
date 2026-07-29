// Wave19 — pure decision core for editUserMessageAndReplay.
//
// Extracted verbatim from the `editUserMessageAndReplay` thunk in messageSlice
// (~lines 1188–1207) so the validation + content/trailing computation is
// testable without Redux/db I/O. Behaviour and error strings are byte-level
// unchanged.
//
// The thunk keeps the dialogKey/dialogConfig/dialogId resolution (those depend
// on Redux state + selectDbRecordById), then calls this core with the already
// resolved `messages` array and uses the returned plan to drive dispatches.

import type { Message } from "./types";
import { buildEditedMessageContent } from "./messageEditContent";

export type EditReplayPlanError =
  | "target_not_found"
  | "not_user_message"
  | "streaming_in_progress";

export type EditReplayPlan =
  | {
      ok: true;
      targetMessage: Message;
      nextContent: Message["content"];
      trailingMessages: Message[];
    }
  | {
      ok: false;
      error: EditReplayPlanError;
      message: string;
    };

/**
 * Decide what `editUserMessageAndReplay` should mutate, without touching Redux.
 *
 * Rules (mirrors the thunk, error strings kept byte-identical):
 *  - targetIndex = findIndex by messageId; <0 → target_not_found
 *  - !target || role !== "user" → not_user_message / "只能编辑用户消息。"
 *  - messages.some(isStreaming) → streaming_in_progress /
 *    "请等待当前回复完成后再编辑历史消息。"
 *  - nextContent = buildEditedMessageContent(originalContent ?? target.content, nextText)
 *  - trailingMessages = messages.slice(targetIndex + 1)
 */
export function planEditUserMessageAndReplay(input: {
  messages: Message[];
  messageId: string;
  originalContent?: Message["content"];
  nextText: string;
}): EditReplayPlan {
  const { messages, messageId, originalContent, nextText } = input;

  const targetIndex = messages.findIndex((message) => message.id === messageId);
  if (targetIndex < 0) {
    return {
      ok: false,
      error: "target_not_found",
      message: "editUserMessageAndReplay: target message not found.",
    };
  }

  const targetMessage = messages[targetIndex];
  if (!targetMessage || targetMessage.role !== "user") {
    return {
      ok: false,
      error: "not_user_message",
      message: "只能编辑用户消息。",
    };
  }

  if (messages.some((message) => message.isStreaming)) {
    return {
      ok: false,
      error: "streaming_in_progress",
      message: "请等待当前回复完成后再编辑历史消息。",
    };
  }

  const nextContent = buildEditedMessageContent(
    originalContent ?? targetMessage.content,
    nextText
  );
  const trailingMessages = messages.slice(targetIndex + 1);

  return {
    ok: true,
    targetMessage,
    nextContent,
    trailingMessages,
  };
}