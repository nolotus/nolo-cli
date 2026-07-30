// packages/chat/queue/chatQueueMachine.ts
//
// Pure chat queue state machine — the cross-platform core for
// "queue user input while a turn is running, then auto-drain when it ends".
//
// Design goals:
//   1. Zero dependencies. No React, no Redux. Web/RN/TUI all share this.
//   2. The machine owns *when* to drain (shouldDrainAfterTurnEnd), but never
//      performs the drain itself. Performing a drain means actually sending a
//      message (network, billing, agent runtime) — that is the adapter's job.
//      The machine emits a `drain-ready` outgoing event instead.
//   3. Dialog-scoped. Each dialog owns one machine instance. This mirrors the
//      existing Redux `pendingUserInputQueue` per-dialogKey bucketing and
//      keeps the TUI (which has no Redux) on the exact same semantics.
//
// Lifecycle (single dialog):
//   idle ──enqueue──► idle+queue
//   idle+queue ──turn-start──► running+queue
//   running+queue ──turn-end(ok,!aborted,!paused)──► emits drain-ready, dequeue
//        └─ adapter sends the dequeued text, which triggers turn-start again
//   running+queue ──turn-end(aborted)──► clear queue (user stopped = abandon)
//   running+queue ──pause-drain──► running+queue+paused (tool confirm pending)
//   paused ──resume-drain──► running+queue (adapter may then drain)

export type ChatQueueState = {
  /** True while an agent turn is actively streaming/running. */
  running: boolean;
  /** Pending user inputs queued while `running` is true. FIFO. */
  queue: string[];
  /** True when drain is intentionally suspended (e.g. awaiting tool confirm). */
  drainPaused: boolean;
  /** Last drain-attempt error surfaced by the adapter (balance, network, etc). */
  lastDrainError: string | null;
};

export type ChatQueueInEvent =
  | { type: "turn-start" }
  | { type: "turn-end"; ok: boolean; aborted: boolean }
  | { type: "enqueue"; text: string }
  | { type: "dequeue" }
  | { type: "clear" }
  | { type: "pause-drain" }
  | { type: "resume-drain" }
  | { type: "drain-error"; message: string };

/**
 * Outgoing events the machine asks the adapter to handle.
 * `drain-ready` is the key one: the adapter should send `text` as the next
 * user message. After dispatching it, the adapter must also send `dequeue`
 * (and the resulting send will produce `turn-start` from the runtime).
 */
export type ChatQueueOutEvent =
  | { type: "drain-ready"; text: string }
  | { type: "queue-changed"; length: number }
  | { type: "running-changed"; running: boolean }
  | { type: "drain-paused-changed"; paused: boolean };

export const initialChatQueueState: ChatQueueState = {
  running: false,
  queue: [],
  drainPaused: false,
  lastDrainError: null,
};

/**
 * Reduce one incoming event to the next state. Pure.
 *
 * It does NOT emit outgoing events; use `applyChatQueueEvent` (which wraps this
 * and returns outgoing side-effects) when you need them, or call this directly
 * in tests that only care about state shape.
 */
export function reduceChatQueue(
  state: ChatQueueState,
  event: ChatQueueInEvent
): ChatQueueState {
  switch (event.type) {
    case "turn-start":
      if (state.running) return state;
      return { ...state, running: true, lastDrainError: null };

    case "turn-end": {
      if (!state.running) return state;
      // User-initiated abort abandons the queued follow-ups for this dialog.
      if (event.aborted) {
        return {
          ...state,
          running: false,
          queue: [],
          lastDrainError: null,
        };
      }
      // A failed turn that wasn't aborted keeps the queue but stops the run;
      // the adapter decides whether to retry/surface. We do not auto-drain on
      // failure because the previous turn may have left things inconsistent.
      return {
        ...state,
        running: false,
        ...(event.ok ? {} : { lastDrainError: "previous turn failed" }),
      };
    }

    case "enqueue": {
      const text = event.text;
      if (!text) return state;
      return { ...state, queue: [...state.queue, text], lastDrainError: null };
    }

    case "dequeue": {
      if (state.queue.length === 0) return state;
      return { ...state, queue: state.queue.slice(1) };
    }

    case "clear":
      if (state.queue.length === 0 && !state.lastDrainError) return state;
      return { ...state, queue: [], lastDrainError: null };

    case "pause-drain":
      if (state.drainPaused) return state;
      return { ...state, drainPaused: true };

    case "resume-drain":
      if (!state.drainPaused) return state;
      return { ...state, drainPaused: false };

    case "drain-error":
      return { ...state, lastDrainError: event.message };

    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      return state;
    }
  }
}

/**
 * Decide whether the adapter should drain the queue right now, i.e. emit
 * `drain-ready` with the head text. Pure; no side effects.
 *
 * Conditions:
 *   - not currently running (previous turn ended)
 *   - queue is non-empty
 *   - drain is not paused (no pending tool confirm)
 *   - the previous turn ended successfully (ok and not aborted)
 *
 * `prevEndedOk` is supplied by the caller because the machine's `running` flag
 * has already been flipped to false by the time we ask; the caller carries the
 * turn-end outcome forward from the event that triggered the check.
 */
export function shouldDrainAfterTurnEnd(
  state: ChatQueueState,
  prevEndedOk: boolean
): boolean {
  return (
    !state.running &&
    !state.drainPaused &&
    state.queue.length > 0 &&
    prevEndedOk
  );
}

type ApplyResult = {
  state: ChatQueueState;
  outgoing: ChatQueueOutEvent[];
};

/**
 * Apply an incoming event, returning the next state plus any outgoing events
 * the adapter must react to. This is what a runtime/adapter should call.
 *
 * `turn-end` is the only event that can produce a `drain-ready` (when the
 * queue is non-empty and the turn ended cleanly). Adapters receiving
 * `drain-ready` should: send the text, then dispatch `dequeue`, and rely on
 * the runtime to eventually emit another `turn-start`/`turn-end` pair.
 */
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

  // Drain trigger: only on a clean, non-aborted, successful turn-end that left
  // a non-empty queue and no pause. We carry `ok` from the event itself.
  if (event.type === "turn-end" && !event.aborted && event.ok) {
    if (shouldDrainAfterTurnEnd(next, true)) {
      outgoing.push({ type: "drain-ready", text: next.queue[0]! });
    }
  }

  return { state: next, outgoing };
}