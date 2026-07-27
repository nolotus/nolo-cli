// packages/cli/tui/chatQueueTuiBinding.ts
//
// TUI binding for the cross-platform chat queue core.
//
// The TUI does not run Redux. It owns a single `ChatQueueRuntime` instance and
// wires it into the readline workspace:
//   - When the user presses Enter while a turn is running, the workspace asks
//     `resolveChatSendDecision`. A `queue-text` decision is enqueued here
//     instead of being dropped (the old behavior was `if (busy) return;`).
//   - When an agent turn ends, the workspace calls `notifyTurnEnd`. If the
//     core emits `drain-ready`, this binding invokes the provided `runTurn`
//     callback with the dequeued text — reusing the same turn execution path
//     the readline composer uses for direct sends.
//
// Esc while busy = abort (the workspace already handles that). Esc Esc is not
// special-cased here; the workspace can call `clear()` directly if desired.

import {
  createChatQueueRuntime,
  type ChatQueueRuntime,
} from "../../chat/queue/chatQueueRuntime";
import {
  resolveChatSendDecision,
  type ChatSendDecision,
} from "../../chat/queue/resolveChatSendDecision";
import { projectChatQueueStatus, type ChatQueueStatus } from "../../chat/queue/chatQueueStatus";

export type RunDrainedTurn = (text: string) => Promise<{ ok: boolean; aborted: boolean }>;

export type ChatQueueTuiBinding = {
  /** Resolve what the composer should do with the current draft right now. */
  resolveSubmit(input: {
    text: string;
    isRunning: boolean;
  }): ChatSendDecision;
  /** Enqueue a queued text. Returns the updated status for status-line render. */
  enqueue(text: string): ChatQueueStatus;
  /** Notify that an agent turn started. */
  notifyTurnStart(): void;
  /**
   * Notify that an agent turn ended. If the queue is non-empty and the turn
   * ended cleanly, this drains the head by calling `runTurn`, then notifies
   * the core of the next turn-start/end. The head is dequeued as soon as the
   * drain starts (before `runTurn` resolves), so a drained message is treated
   * as consumed even if the turn fails. Resolves once the drain cascade
   * settles (queue empty, paused, or a turn fails).
   */
  notifyTurnEnd(outcome: { ok: boolean; aborted: boolean }): Promise<void>;
  /**
   * Manual drain trigger for the idle case: when the composer is empty and
   * the queue has residual items (e.g. a previous turn failed and kept the
   * queue), this dequeues and returns the head so the caller can run it as a
   * fresh turn. Returns null when idle-and-empty or when a turn is still
   * running (use `preemptForDrain` for the busy case).
   */
  drainHeadForManualTurn(): string | null;
  /**
   * Preempt the running turn so the queue head can drain immediately. The
   * caller aborts the in-flight turn right after this returns true; the next
   * `notifyTurnEnd({ aborted: true })` is then treated as a clean turn-end so
   * the drain cascade runs the head instead of clearing the queue (the normal
   * abort behavior). Returns false when not running or the queue is empty.
   */
  preemptForDrain(): boolean;
  /** Clear the queue (e.g. on /new). */
  clear(): void;
  /** Current UI status snapshot. */
  getStatus(): ChatQueueStatus;
  /** Number of queued items (convenience for the status line). */
  queueLength(): number;
  /** Tear down listeners. */
  dispose(): void;
};

/**
 * Create the TUI chat queue binding.
 *
 * `runTurn` is the callback that actually executes a drained user message as
 * an agent turn. It must resolve with `{ok, aborted}` so the binding can feed
 * the outcome back into the core and decide whether to keep draining.
 */
export function createChatQueueTuiBinding(runTurn: RunDrainedTurn): ChatQueueTuiBinding {
  const runtime: ChatQueueRuntime = createChatQueueRuntime();
  // Armed by `preemptForDrain()`: when the caller aborts the in-flight turn
  // right after arming, the subsequent `notifyTurnEnd({ aborted: true })` is
  // reinterpreted as a clean turn-end so the drain cascade runs the queued
  // head instead of the normal abort behavior (which clears the queue).
  let preemptArmed = false;

  const resolveSubmit = ({ text, isRunning }: { text: string; isRunning: boolean }) => {
    return resolveChatSendDecision({
      text,
      imagePreviewCount: 0,
      pendingFileCount: 0,
      isSendBlocked: false,
      canMultiImg: true,
      isLoopRunning: isRunning,
      isSendPending: false,
      isFreshDialogSlashCommand: (s: string) => s === "/new",
      isCompactDialogSlashCommand: (s: string) => s === "/compact",
    });
  };

  const enqueue = (text: string) => {
    runtime.send({ type: "enqueue", text });
    return projectChatQueueStatus({ state: runtime.getState() });
  };

  const notifyTurnStart = () => {
    runtime.send({ type: "turn-start" });
  };

  const notifyTurnEnd = async (outcome: { ok: boolean; aborted: boolean }) => {
    // If a preempt was armed, reinterpret the aborted turn-end as a clean
    // one so the drain cascade runs the queued head. The preempt was
    // user-initiated (empty Enter while busy + queue non-empty), not a stop,
    // so the queue must be preserved, not cleared.
    const effectiveOutcome =
      preemptArmed && outcome.aborted
        ? { ok: true, aborted: false }
        : outcome;
    preemptArmed = false;
    runtime.send({ type: "turn-end", ...effectiveOutcome });

    // Drain cascade: keep draining while the core says we should. Each drain
    // runs a full agent turn; we feed its outcome back in. The core's own
    // `drain-ready` event fires synchronously inside the turn-end send above,
    // but we drive the cascade explicitly here so we can await each turn.
    let lastOk = effectiveOutcome.ok && !effectiveOutcome.aborted;
    // Guard against runaway: the core clears the queue on abort, and a failed
    // turn stops the cascade (shouldDrainAfterTurnEnd returns false), so this
    // loop is bounded by the queue length and turn outcomes.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const status = runtime.getState();
      if (!status.running && !status.drainPaused && status.queue.length > 0 && lastOk) {
        const text = status.queue[0]!;
        runtime.send({ type: "turn-start" });
        // Dequeue as soon as a message is consumed by the drain, before the
        // turn runs. The queue machine contract treats "drain started" as
        // "consumed": once a message has been fed to the agent turn it must
        // leave the queue immediately, regardless of whether the turn later
        // succeeds or fails. Dequeueing only on success left failed turns in
        // the queue, so the next clean turn-end would resend them.
        runtime.send({ type: "dequeue" });
        let turnOutcome: { ok: boolean; aborted: boolean };
        try {
          turnOutcome = await runTurn(text);
        } catch {
          turnOutcome = { ok: false, aborted: false };
        }
        runtime.send({ type: "turn-end", ...turnOutcome });
        lastOk = turnOutcome.ok && !turnOutcome.aborted;
        // If the turn was aborted, the core already cleared the queue; stop.
        if (turnOutcome.aborted) break;
        if (!lastOk) break;
      } else {
        break;
      }
    }
  };

  const drainHeadForManualTurn = (): string | null => {
    const status = runtime.getState();
    // Only when idle: a running turn owns the queue drain path; interfering
    // here would race the in-flight turn. The empty-Enter-while-busy path
    // uses preemptForDrain instead.
    if (status.running || status.queue.length === 0) return null;
    const text = status.queue[0]!;
    runtime.send({ type: "turn-start" });
    runtime.send({ type: "dequeue" });
    return text;
  };

  const preemptForDrain = (): boolean => {
    const status = runtime.getState();
    if (!status.running || status.queue.length === 0) return false;
    preemptArmed = true;
    return true;
  };

  const clear = () => {
    runtime.send({ type: "clear" });
  };

  const getStatus = () => projectChatQueueStatus({ state: runtime.getState() });

  const queueLength = () => runtime.getState().queue.length;

  const dispose = () => {
    runtime.dispose();
  };

  return {
    resolveSubmit,
    enqueue,
    notifyTurnStart,
    notifyTurnEnd,
    drainHeadForManualTurn,
    preemptForDrain,
    clear,
    getStatus,
    queueLength,
    dispose,
  };
}