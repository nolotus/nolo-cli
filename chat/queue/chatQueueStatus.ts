// packages/chat/queue/chatQueueStatus.ts
//
// Shared, framework-agnostic projection of chat queue state into the shape UIs
// consume. Web, RN, and TUI each render this differently but read the exact
// same fields, so "正在回复，输入将排队" looks identical across clients.
//
// This module deliberately takes a plain `ChatQueueState` (from the core
// machine) plus a couple of runtime-derived flags, and returns a UI status
// object. It does NOT import React or Redux.

import type { ChatQueueState } from "./chatQueueMachine";

export type ChatQueueStatus = {
  /** An agent turn is currently streaming/running. */
  isRunning: boolean;
  /** Number of queued user inputs waiting to be sent. */
  queueLength: number;
  /** Up to `maxPreview` queued texts, each truncated to `previewCharLimit`. */
  queuePreview: string[];
  /**
   * Whether the composer should accept input that will be queued rather than
   * sent immediately. True while running and not blocked by a pending
   * confirmation (drainPaused).
   */
  canQueueNow: boolean;
  /** Drain is paused (e.g. tool confirm pending); queued items won't auto-send. */
  drainPaused: boolean;
  /** Last drain error message, if any (balance, network, etc). */
  lastDrainError: string | null;
  /** Human-facing placeholder text for the composer, already i18n-neutral. */
  composerPlaceholderKey:
    | "default"
    | "queuing"
    | "drain-paused"
    | "error";
};

export type ProjectChatQueueStatusInput = {
  state: ChatQueueState;
  /** Max number of preview entries. Defaults to 3. */
  maxPreview?: number;
  /** Max chars per preview entry. Defaults to 40. */
  previewCharLimit?: number;
};

/**
 * Project the core queue state into a UI-facing status object.
 *
 * `composerPlaceholderKey` is a semantic key, not a localized string; each
 * client maps it to its own i18n bundle. This keeps the core free of any
 * specific language while still giving all clients the same placeholder
 * semantics.
 */
export function projectChatQueueStatus({
  state,
  maxPreview = 3,
  previewCharLimit = 40,
}: ProjectChatQueueStatusInput): ChatQueueStatus {
  const preview: string[] = [];
  for (let i = 0; i < Math.min(maxPreview, state.queue.length); i++) {
    const text = state.queue[i] ?? "";
    preview.push(text.length > previewCharLimit ? text.slice(0, previewCharLimit) + "…" : text);
  }

  let composerPlaceholderKey: ChatQueueStatus["composerPlaceholderKey"] = "default";
  if (state.lastDrainError) {
    composerPlaceholderKey = "error";
  } else if (state.drainPaused) {
    composerPlaceholderKey = "drain-paused";
  } else if (state.running) {
    composerPlaceholderKey = "queuing";
  }

  return {
    isRunning: state.running,
    queueLength: state.queue.length,
    queuePreview: preview,
    canQueueNow: state.running && !state.drainPaused,
    drainPaused: state.drainPaused,
    lastDrainError: state.lastDrainError,
    composerPlaceholderKey,
  };
}