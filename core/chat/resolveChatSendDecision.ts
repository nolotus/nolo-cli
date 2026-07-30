// packages/chat/queue/resolveChatSendDecision.ts
//
// Cross-platform send/queue decision resolver for the chat composer.
//
// This is the single source of truth for "what should the composer do when the
// user presses send right now?" across Web, RN, and TUI. It is a pure function
// with zero dependencies — no React, no Redux — so every client can share the
// exact same semantics.
//
// Originally extracted from packages/chat/web/messageInputSendResolver.ts;
// behavior is intentionally identical so existing tests keep passing.

export type ChatSendDecision =
  | { kind: "arm-fresh-dialog" }
  | { kind: "compact-blocked" }
  | { kind: "compact-dialog" }
  | { kind: "noop" }
  | { kind: "multi-image-blocked" }
  | { kind: "queue-text"; text: string }
  | { kind: "queue-blocked" }
  | { kind: "send"; text: string };

export type ResolveChatSendDecisionInput = {
  text: string;
  imagePreviewCount: number;
  pendingFileCount: number;
  isSendBlocked: boolean;
  canMultiImg: boolean;
  isLoopRunning: boolean;
  isSendPending: boolean;
  isFreshDialogSlashCommand: (input: string) => boolean;
  isCompactDialogSlashCommand: (input: string) => boolean;
};

export function resolveChatSendDecision(
  input: ResolveChatSendDecisionInput
): ChatSendDecision {
  const trimmed = input.text.trim();

  if (input.isFreshDialogSlashCommand(trimmed)) {
    return { kind: "arm-fresh-dialog" };
  }

  if (input.isCompactDialogSlashCommand(trimmed)) {
    if (input.isLoopRunning || input.isSendPending) {
      return { kind: "compact-blocked" };
    }
    return { kind: "compact-dialog" };
  }

  if (
    (!trimmed && !input.imagePreviewCount && !input.pendingFileCount) ||
    input.isSendBlocked
  ) {
    return { kind: "noop" };
  }

  if (!input.canMultiImg && input.imagePreviewCount > 1) {
    return { kind: "multi-image-blocked" };
  }

  if (input.isLoopRunning) {
    if (trimmed && !input.imagePreviewCount && !input.pendingFileCount) {
      return { kind: "queue-text", text: trimmed };
    }
    return { kind: "queue-blocked" };
  }

  return { kind: "send", text: trimmed };
}