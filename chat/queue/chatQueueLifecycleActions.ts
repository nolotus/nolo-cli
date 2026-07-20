// packages/chat/queue/chatQueueLifecycleActions.ts
//
// Thunk action creators that bridge the agent-turn lifecycle into the chat
// queue core. `streamAgentChatTurn` dispatches these from its finally block;
// the thunk reads the `ChatQueueReduxAdapter` from the thunk `extra` argument
// (set up in the store's thunk middleware) and forwards the event to the
// per-dialog runtime.
//
// When no adapter is registered in `extra` (tests, non-Redux clients), these
// thunks are inert no-ops — they neither touch Redux state nor throw. That
// keeps the streaming thunk decoupled from whether the queue adapter is wired
// up, and keeps the core machine Redux-free.

import type { ChatQueueReduxAdapter } from "./chatQueueReduxAdapter";

export const CHAT_QUEUE_TURN_END = "chatQueue/turnEnd" as const;
export const CHAT_QUEUE_TURN_START = "chatQueue/turnStart" as const;

type ThunkExtra = {
  chatQueueAdapter?: ChatQueueReduxAdapter;
  [key: string]: unknown;
};

/**
 * Thunk: notify the chat queue core that an agent turn ended for a dialog.
 * Dispatch this from the streaming lifecycle's finally block. If no adapter is
 * registered in the thunk extra, this is a no-op.
 */
export function runChatQueueTurnEnd(payload: {
  dialogKey: string;
  ok: boolean;
  aborted: boolean;
}) {
  return (_dispatch: any, _getState: () => any, extra: ThunkExtra) => {
    const adapter = extra?.chatQueueAdapter;
    if (!adapter) return;
    void adapter.notifyTurnEnd(payload.dialogKey, {
      ok: payload.ok,
      aborted: payload.aborted,
    });
  };
}

/**
 * Thunk: notify the chat queue core that an agent turn started for a dialog.
 */
export function runChatQueueTurnStart(payload: { dialogKey: string }) {
  return (_dispatch: any, _getState: () => any, extra: ThunkExtra) => {
    const adapter = extra?.chatQueueAdapter;
    if (!adapter) return;
    adapter.notifyTurnStart(payload.dialogKey);
  };
}