// packages/chat/queue/chatQueueMachine.ts
//
// Pure chat queue state machine — the cross-platform core for
// "queue user input while a turn is running, then auto-drain when it ends".

import { createTurnRequest, type TurnRequest } from "./internalTurnEvent";

export type ChatQueueState = {
  /** True while an agent turn is actively streaming/running. */
  running: boolean;
  /** Pending user inputs/turn requests queued while `running` is true. FIFO. */
  queue: TurnRequest[];
  /** True when drain is intentionally suspended (e.g. awaiting tool confirm). */
  drainPaused: boolean;
  /** Last drain-attempt error surfaced by the adapter (balance, network, etc). */
  lastDrainError: string | null;
};

export type ChatQueueInEvent =
  | { type: "turn-start" }
  | { type: "turn-end"; ok: boolean; aborted: boolean }
  | { type: "enqueue"; text: TurnRequest | string }
  | { type: "dequeue" }
  | { type: "clear" }
  | { type: "pause-drain" }
  | { type: "resume-drain" }
  | { type: "drain-error"; message: string };

export type ChatQueueOutEvent =
  | { type: "drain-ready"; text: string; request: TurnRequest }
  | { type: "queue-changed"; length: number }
  | { type: "running-changed"; running: boolean }
  | { type: "drain-paused-changed"; paused: boolean };

export const initialChatQueueState: ChatQueueState = {
  running: false,
  queue: [],
  drainPaused: false,
  lastDrainError: null,
};

export function reduceChatQueue(
  state: ChatQueueState,
  event: ChatQueueInEvent
): ChatQueueState {
  switch (event.type) {
    case "turn-start":
      if (state.running && state.lastDrainError === null) return state;
      return {
        ...state,
        running: true,
        lastDrainError: null,
      };

    case "turn-end":
      return {
        ...state,
        running: false,
        queue: event.aborted ? [] : state.queue,
        lastDrainError: !event.ok && !event.aborted ? "previous turn failed" : state.lastDrainError,
      };

    case "enqueue": {
      const req = createTurnRequest(event.text);
      if (!req.text.trim() && req.event.kind === "user") {
        return state;
      }
      return {
        ...state,
        queue: [...state.queue, req],
      };
    }

    case "dequeue":
      if (state.queue.length === 0) return state;
      return {
        ...state,
        queue: state.queue.slice(1),
      };

    case "clear":
      if (state.queue.length === 0 && state.lastDrainError === null) return state;
      return {
        ...state,
        queue: [],
        lastDrainError: null,
      };

    case "pause-drain":
      if (state.drainPaused) return state;
      return {
        ...state,
        drainPaused: true,
      };

    case "resume-drain":
      if (!state.drainPaused) return state;
      return {
        ...state,
        drainPaused: false,
      };

    case "drain-error":
      return {
        ...state,
        lastDrainError: event.message || null,
      };

    default:
      return state;
  }
}

export function shouldDrainAfterTurnEnd(
  state: ChatQueueState,
  cleanTurnEnd: boolean
): boolean {
  return (
    cleanTurnEnd &&
    !state.running &&
    !state.drainPaused &&
    state.queue.length > 0
  );
}

export type ApplyResult = {
  state: ChatQueueState;
  outgoing: ChatQueueOutEvent[];
};

export function applyChatQueueEvent(
  state: ChatQueueState,
  event: ChatQueueInEvent
): ApplyResult {
  const prevQueueLen = state.queue.length;
  const prevRunning = state.running;
  const prevPaused = state.drainPaused;

  const next = reduceChatQueue(state, event);
  const outgoing: ChatQueueOutEvent[] = [];

  if (next.queue.length !== prevQueueLen) {
    outgoing.push({ type: "queue-changed", length: next.queue.length });
  }
  if (next.running !== prevRunning) {
    outgoing.push({ type: "running-changed", running: next.running });
  }
  if (next.drainPaused !== prevPaused) {
    outgoing.push({ type: "drain-paused-changed", paused: next.drainPaused });
  }

  if (event.type === "turn-end" && !event.aborted && event.ok) {
    if (shouldDrainAfterTurnEnd(next, true)) {
      const head = next.queue[0]!;
      outgoing.push({ type: "drain-ready", text: head.text, request: head });
    }
  }

  return { state: next, outgoing };
}
