// packages/chat/queue/chatQueueRuntime.ts
//
// Thin imperative wrapper around the pure chat queue state machine.
//
// The machine in chatQueueMachine.ts is pure and side-effect-free; it returns
// outgoing events the caller must react to. Most adapters don't want to write
// that dispatch loop by hand every time. This wrapper:
//   - owns one mutable ChatQueueState,
//   - exposes imperative send(event),
//   - fans outgoing events out to registered listeners,
//   - gives adapters a single `on("drain-ready", cb)` subscription point.
//
// It still has zero external dependencies. Web/RN/TUI each instantiate one per
// dialog (or one global with manual dialog routing) and wire their own IO.
//
// Intentionally framework-agnostic: no React hooks, no Redux. Adapters decide
// how to re-render after `queue-changed` / `running-changed` arrive.

import {
  applyChatQueueEvent,
  initialChatQueueState,
  type ChatQueueInEvent,
  type ChatQueueOutEvent,
  type ChatQueueState,
} from "./chatQueueMachine";

export type ChatQueueListener = (event: ChatQueueOutEvent) => void;

export type ChatQueueRuntime = {
  /** Current snapshot. Do not mutate. */
  getState(): ChatQueueState;
  /** Apply an incoming event; outgoing events are dispatched to listeners. */
  send(event: ChatQueueInEvent): ChatQueueState;
  /** Subscribe to outgoing events. Returns an unsubscribe function. */
  subscribe(listener: ChatQueueListener): () => void;
  /** Convenience: subscribe to a single outgoing event type. */
  on<K extends ChatQueueOutEvent["type"]>(
    type: K,
    listener: (event: Extract<ChatQueueOutEvent, { type: K }>) => void
  ): () => void;
  /** Remove all listeners and reset state. */
  dispose(): void;
};

/**
 * Create a chat queue runtime. Optionally seed an initial state (useful for
 * tests or for hydrating from persisted Redux state during the migration).
 */
export function createChatQueueRuntime(
  initialState: ChatQueueState = initialChatQueueState
): ChatQueueRuntime {
  let state: ChatQueueState = initialState;
  const listeners = new Set<ChatQueueListener>();

  const dispatch = (events: ChatQueueOutEvent[]): void => {
    for (const e of events) {
      for (const l of listeners) l(e);
    }
  };

  return {
    getState: () => state,
    send(event) {
      const result = applyChatQueueEvent(state, event);
      state = result.state;
      dispatch(result.outgoing);
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    on(type, listener) {
      const wrapped: ChatQueueListener = (e) => {
        if (e.type === type) {
          // @ts-expect-error: narrowing Extract by discriminant is sound here
          listener(e);
        }
      };
      listeners.add(wrapped);
      return () => {
        listeners.delete(wrapped);
      };
    },
    dispose() {
      listeners.clear();
      state = initialChatQueueState;
    },
  };
}