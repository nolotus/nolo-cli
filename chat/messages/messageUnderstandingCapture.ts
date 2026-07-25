// Wave17 — UI-turn understanding memory capture (Redux-free helpers).
// Callers pass `messages` so this module does not import messageSlice (cycle).

import type { DialogConfig } from "../../app/types";
import { selectById as selectDbRecordById } from "../../database/dbSlice";
import { selectIdentityUserId } from "identity/selectors";
import { serializeMessageContent } from "./messageContent";
import type { Message } from "./types";

export function getLatestUserInputFromMessages(
  messages: Message[]
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "user") continue;
    const serialized = serializeMessageContent(message.content, "[图片]")?.trim();
    if (serialized) return serialized;
  }
  return null;
}

export function getDialogSpaceIdFromState(
  state: any,
  dialogKey?: string
): string | undefined {
  if (!dialogKey) return undefined;
  const dialog = selectDbRecordById(state, dialogKey) as DialogConfig | undefined;
  return typeof dialog?.spaceId === "string" ? dialog.spaceId : undefined;
}

export type CaptureUnderstandingInput = {
  state: any;
  db?: any;
  agentKey?: string | null;
  dialogId: string;
  dialogKey?: string;
  spaceId?: string;
  assistantText: string;
  toolCalls?: unknown[] | null;
  messages: Message[];
};

/**
 * After a completed UI turn (no tool_calls), capture understanding memory.
 * No-ops when assistant text empty, tools present, or agent/user input missing.
 */
export async function captureUnderstandingFromCompletedUiTurn(
  input: CaptureUnderstandingInput
): Promise<void> {
  if (input.assistantText.trim() === "") return;
  if (input.toolCalls && input.toolCalls.length > 0) return;
  if (!input.agentKey) return;

  const latestUserInput = getLatestUserInputFromMessages(input.messages);
  if (!latestUserInput) return;

  const { captureUnderstandingMemoryFromDialog } = await import(
    "../../ai/memory/understanding"
  );
  await captureUnderstandingMemoryFromDialog({
    db: input.db,
    userId: selectIdentityUserId(input.state),
    spaceId:
      input.spaceId ??
      getDialogSpaceIdFromState(input.state, input.dialogKey),
    agentKey: input.agentKey,
    dialogId: input.dialogId,
    userInput: latestUserInput,
    trace: [
      {
        role: "assistant",
        content: input.assistantText,
      } as any,
    ],
  });
}
