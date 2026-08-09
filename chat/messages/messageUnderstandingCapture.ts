// Wave17 — UI-turn understanding memory capture (Redux-free helpers).
// Callers pass `messages` so this module does not import messageSlice (cycle).

import type { DialogConfig } from "../../app/types";
import { selectById as selectDbRecordById } from "../../database/dbSlice";
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

/**
 * Same base-url resolution memory recall uses (`fetchMemoryOverlayContext`), so
 * capture and recall cannot end up pointed at different servers.
 */
function resolveMemoryCaptureBaseUrl(state: any): string {
  const currentServer =
    typeof state?.settings?.currentServer === "string"
      ? state.settings.currentServer
      : null;
  const _window = (globalThis as any).window;
  if (!_window) return (currentServer || "").replace(/\/+$/, "");
  if (!currentServer) return _window.location.origin;
  return currentServer.replace(/\/+$/, "");
}

export type CaptureUnderstandingInput = {
  state: any;
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
 *
 * Capture runs on the server (`/api/memory/capture-turn`), not against the
 * client DB. Recall reads the server store, so a local write would be
 * invisible to every later turn — which is exactly what happened while this
 * called `captureUnderstandingMemoryFromDialog(extra.db)` directly. Failures
 * are swallowed: a missed memory must never break the chat turn.
 */
export async function captureUnderstandingFromCompletedUiTurn(
  input: CaptureUnderstandingInput
): Promise<void> {
  if (input.assistantText.trim() === "") return;
  if (input.toolCalls && input.toolCalls.length > 0) return;
  if (!input.agentKey) return;

  const latestUserInput = getLatestUserInputFromMessages(input.messages);
  if (!latestUserInput) return;

  const state = input.state;
  const token =
    typeof state?.auth?.currentToken === "string" ? state.auth.currentToken : null;
  const baseUrl = resolveMemoryCaptureBaseUrl(state);
  // Anonymous / server-less sessions have nowhere to persist to. Recall is
  // equally unavailable there, so skipping keeps both sides consistent.
  if (!token || !baseUrl) return;

  const dialog = input.dialogKey
    ? (selectDbRecordById(state, input.dialogKey) as DialogConfig | undefined)
    : undefined;

  try {
    await fetch(`${baseUrl}/api/memory/capture-turn`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        agentKey: input.agentKey,
        dialogId: input.dialogId,
        userInput: latestUserInput,
        assistantText: input.assistantText,
        spaceId:
          input.spaceId ??
          getDialogSpaceIdFromState(state, input.dialogKey),
      }),
    });
  } catch {
    /* best-effort: never fail a chat turn over memory capture */
  }
}
