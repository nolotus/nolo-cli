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
} from "../core/chat/chatQueueRuntime";
import {
  resolveChatSendDecision,
  type ChatSendDecision,
} from "../core/chat/resolveChatSendDecision";
import { projectChatQueueStatus, type ChatQueueStatus } from "../core/chat/chatQueueStatus";
import type { InternalTurnEvent, TurnRequest } from "../core/chat/internalTurnEvent";

export type RunDrainedTurn = (
  request: TurnRequest
) => Promise<{ ok: boolean; aborted: boolean }>;

export type ChatQueueTuiBinding = {
  /** Resolve what the composer should do with the current draft right now. */
  resolveSubmit(input: {
    text: string;
    isRunning: boolean;
  }): ChatSendDecision;
  /** Enqueue a queued text or structured event. Returns the updated status for status-line render. */
  enqueue(input: TurnRequest | InternalTurnEvent | string): ChatQueueStatus;
  /**
   * Enqueue a text or structured event and, if the workspace is currently idle,
   * trigger the drain loop synchronously/immediately so `runTurn` executes the head.
   * Returns true if a turn drain was initiated, or false if enqueued while busy/paused.
   */
  enqueueAndMaybeRun(
    input: TurnRequest | InternalTurnEvent | string
  ): Promise<boolean>;
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
  drainHeadForManualTurn(): TurnRequest | null;
  /**
   * Preempt the running turn so the queue head can drain immediately. The
   * caller aborts the in-flight turn right after this returns true; the next
   * `notifyTurnEnd({ aborted: true })` is then treated as a clean turn-end so
   * the drain cascade runs the head instead of clearing the queue (the normal
   * abort behavior). Returns false when not running or the queue is empty.
   */
  preemptForDrain(): boolean;
  /**
   * Preempt the running turn so Esc preserves the queued follow-up without
   * draining it immediately (the "stop current reply, keep queue" action).
   * The caller aborts the in-flight turn right after this returns true; the next
   * `notifyTurnEnd({ aborted: true })` is treated as a failed non-aborted
   * turn-end so the queue is preserved (not cleared) but the drain cascade
   * does not run. Returns false when not running.
   */
  preemptForStop(): boolean;
  /**
   * Snapshot the entire queue as a single merged text (items joined by "\n"),
   * then clear the queue. Used by the Ctrl+S "flush all" shortcut: the queued
   * follow-ups are collapsed into one message and sent immediately instead of
   * waiting for the in-flight turn to finish and drain them one by one.
   * Returns null when the queue is empty.
   */
  snapshotAndClearQueue(): string | null;
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
  // Armed by `preemptForDrain()` / `preemptForStop()`: when the caller
  // aborts the in-flight turn right after arming, the subsequent
  // `notifyTurnEnd({ aborted: true })` is reinterpreted so the queue is
  // preserved instead of cleared (the normal abort behavior). Two modes:
  //   - "drain": reinterpret as a clean turn-end so the cascade runs the head.
  //   - "stop":  reinterpret as a failed (non-aborted) turn-end so the queue
  //              is kept but the cascade does NOT drain (user just wants to
  //              stop the current reply, not continue to the next queued item).
  type PreemptMode = "drain" | "stop";
  let preemptArmed: PreemptMode | null = null;

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

  const enqueue = (input: TurnRequest | InternalTurnEvent | string) => {
    runtime.send({ type: "enqueue", text: input as any });
    return projectChatQueueStatus({ state: runtime.getState() });
  };

  const enqueueAndMaybeRun = async (
    input: TurnRequest | InternalTurnEvent | string
  ): Promise<boolean> => {
    enqueue(input);
    const status = runtime.getState();
    if (!status.running && !status.drainPaused) {
      await notifyTurnEnd({ ok: true, aborted: false });
      return true;
    }
    return false;
  };

  const notifyTurnStart = () => {
    runtime.send({ type: "turn-start" });
  };

  const notifyTurnEnd = async (outcome: { ok: boolean; aborted: boolean }) => {
    // If a preempt was armed, reinterpret the aborted turn-end so the queue
    // is preserved instead of cleared. "drain" mode reinterprets as a clean
    // turn-end (cascade runs the head); "stop" mode reinterprets as a failed
    // non-aborted turn-end (queue kept, cascade does not drain — the core
    // treats ok:false/non-aborted as "keep queue, stop draining").
    // Consumed by both the outer (direct-turn) turn-end and the drain
    // cascade below: Ctrl+S can arm preempt while a cascade turn is
    // mid-flight, and that abort must be reinterpreted too, otherwise the
    // bare `turn-end { aborted }` inside the cascade would clear the queue
    // and drop the just-merged message.
    // Returns the reinterpreted outcome plus the mode that was consumed (so
    // the caller can apply the stop-mode drain-error reset).
    const consumePreempt = (
      raw: { ok: boolean; aborted: boolean },
    ): { outcome: { ok: boolean; aborted: boolean }; mode: PreemptMode | null } => {
      const mode = preemptArmed;
      preemptArmed = null;
      if (mode === null || !raw.aborted) return { outcome: raw, mode: null };
      return {
        outcome:
          mode === "drain"
            ? { ok: true, aborted: false }
            : { ok: false, aborted: false },
        mode,
      };
    };
    const { outcome: effectiveOutcome, mode: consumedMode } = consumePreempt(outcome);
    runtime.send({ type: "turn-end", ...effectiveOutcome });
    // "stop" mode reinterprets abort as ok:false so the queue is kept and the
    // cascade does not drain — but ok:false also sets lastDrainError, which
    // would surface a spurious "previous turn failed" error for a deliberate
    // Esc. Clear it: an empty drain-error message is falsy, so the status
    // projection treats it as "no error".
    if (consumedMode === "stop") {
      runtime.send({ type: "drain-error", message: "" });
    }

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
        const req = status.queue[0]!;
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
          turnOutcome = await runTurn(req);
        } catch {
          turnOutcome = { ok: false, aborted: false };
        }
        // A Ctrl+S flush can arm preempt while this cascade turn is
        // mid-flight; consume it so the abort is reinterpreted (drain/stop)
        const consumed = consumePreempt(turnOutcome);
        const effectiveTurnOutcome = consumed.outcome;
        runtime.send({ type: "turn-end", ...effectiveTurnOutcome });
        if (consumed.mode === "stop") {
          runtime.send({ type: "drain-error", message: "" });
        }
        lastOk = effectiveTurnOutcome.ok && !effectiveTurnOutcome.aborted;
      } else {
        break;
      }
    }
  };

  const drainHeadForManualTurn = (): TurnRequest | null => {
    const status = runtime.getState();
    if (status.running || status.queue.length === 0) return null;
    const head = status.queue[0]!;
    runtime.send({ type: "turn-start" });
    runtime.send({ type: "dequeue" });
    return head;
  };

  const preemptForDrain = (): boolean => {
    const status = runtime.getState();
    if (!status.running || status.queue.length === 0) return false;
    preemptArmed = "drain";
    return true;
  };

  const preemptForStop = (): boolean => {
    const status = runtime.getState();
    if (!status.running) return false;
    preemptArmed = "stop";
    return true;
  };

  const snapshotAndClearQueue = (): string | null => {
    const status = runtime.getState();
    if (status.queue.length === 0) return null;
    const merged = status.queue.map((req) => req.text).join("\n");
    runtime.send({ type: "clear" });
    return merged;
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
    enqueueAndMaybeRun,
    notifyTurnStart,
    notifyTurnEnd,
    drainHeadForManualTurn,
    preemptForDrain,
    preemptForStop,
    snapshotAndClearQueue,
    clear,
    getStatus,
    queueLength,
    dispose,
  };
}
