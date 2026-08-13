// packages/chat/queue/chatQueueReduxAdapter.ts
//
// Redux adapter for the cross-platform chat queue core.
//
// During the Redux→core migration this is the bridge that keeps Web/RN (which
// still run Redux) on the same semantics as TUI (which uses the core directly):
//
//   - Each dialog gets its own `ChatQueueRuntime` instance, keyed by dialogKey.
//   - The adapter listens to the runtime's `drain-ready` event and dispatches
//     the existing continuation send path (`handleSendMessage`) so we do not
//     duplicate network/billing/agent-runtime logic.
//   - The adapter provides helpers to notify the runtime of `turn-start` and
//     `turn-end` from the slice side (`messageStreamEnd` / streaming lifecycle).
//
// The core never imports Redux; only this file does. When Web/RN eventually
// drop Redux, this file is deleted and they drive the runtime directly.
//
// `loopStopReason === "pending"` (a tool confirmation awaiting the user) maps
// to the runtime's `pause-drain`/`resume-drain` so we don't auto-send over a
// pending confirmation.

import type { Dispatch, Store } from "@reduxjs/toolkit";

import { handleSendMessage } from "../dialog/dialogSlice";
import {
  clearPendingUserInputQueue,
  dequeueUserInput,
  enqueueUserInput,
  getLoopStopReason,
  getPendingUserInputQueue,
} from "../dialog/dialogRuntimeStore";
import { createChatQueueRuntime, type ChatQueueRuntime } from "../../core/chat/chatQueueRuntime";
import { createTurnRequest } from "../../core/chat/internalTurnEvent";
import type { ChatQueueState } from "../../core/chat/chatQueueMachine";

export type ChatQueueReduxAdapterOptions = {
  /**
   * Optional override for the actual send used when draining. Defaults to
   * dispatching `handleSendMessage` with the drained text. Exposed for tests
   * and for cases where the caller already has a prepared continuation thunk.
   */
  sendDrainedText?: (args: {
    dialogKey: string;
    text: string;
    dispatch: Dispatch;
  }) => Promise<void> | void;
};

/**
 * Per-store adapter. Construct once (e.g. in the store module or a React
 * context provider) and call `notifyTurnStart` / `notifyTurnEnd` from the
 * streaming lifecycle. It lazily creates a runtime per dialogKey.
 */
export class ChatQueueReduxAdapter {
  private runtimes = new Map<string, ChatQueueRuntime>();
  private readonly store: Store<any, any>;
  private readonly opts: ChatQueueReduxAdapterOptions;
  /** Pending drain promises per dialog, so notifyTurnEnd can be awaited. */
  private pendingDrains = new Map<string, Promise<unknown>>();

  constructor(store: Store<any, any>, opts: ChatQueueReduxAdapterOptions = {}) {
    this.store = store;
    this.opts = opts;
  }

  /**
   * Get (or lazily create) the runtime for a dialog. The runtime is seeded from
   * dialogRuntimeStore `pendingUserInputQueue` so we don't lose queued items
   * written before the adapter existed.
   */
  getRuntime(dialogKey: string): ChatQueueRuntime {
    let rt = this.runtimes.get(dialogKey);
    if (rt) return rt;

    const legacyQueue = getPendingUserInputQueue(dialogKey);
    const seed: ChatQueueState = {
      running: false,
      queue: Array.isArray(legacyQueue)
        ? legacyQueue.map((t) => createTurnRequest(t))
        : [],
      drainPaused: getLoopStopReason(dialogKey) === "pending",
      lastDrainError: null,
    };
    rt = createChatQueueRuntime(seed);
    this.runtimes.set(dialogKey, rt);

    // Wire drain-ready → dispatch the continuation send.
    //
    // Order: send first, dequeue only on success. If the send throws (balance,
    // network, aborted-by-user), the head stays in the queue so a later retry
    // or re-drain can re-attempt it. The core is told about the failure via
    // `drain-error`; the runtime shadow is only shifted once we commit.
    //
    // The drain is async but the runtime emits drain-ready synchronously inside
    // `send({type:"turn-end"})`. We stash the resulting promise so callers
    // (notifyTurnEnd) can await it; otherwise the dequeue/commit would race
    // with the next assertion in tests and, in real apps, with the next turn.
    rt.on("drain-ready", ({ text }) => {
      const dispatch = this.store.dispatch;
      const runtime = rt!;

      const promise = (async () => {
        try {
          if (this.opts.sendDrainedText) {
            await this.opts.sendDrainedText({ dialogKey, text, dispatch });
          } else {
            await dispatch(
              handleSendMessage({
                dialogKey,
                userInput: text,
              }) as any
            );
          }
          // Commit: remove the head from both core and the runtime-store shadow.
          runtime.send({ type: "dequeue" });
          dequeueUserInput({ dialogKey });
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : typeof error === "string"
                ? error
                : "drain send failed";
          runtime.send({ type: "drain-error", message });
          // Head remains in the queue for retry. Do NOT dequeue.
        } finally {
          this.pendingDrains.delete(dialogKey);
        }
      })();

      this.pendingDrains.set(dialogKey, promise);
    });

    return rt;
  }

  /** Drop a dialog's runtime (e.g. when the dialog is closed/deleted). */
  disposeRuntime(dialogKey: string): void {
    const rt = this.runtimes.get(dialogKey);
    if (rt) {
      rt.dispose();
      this.runtimes.delete(dialogKey);
    }
  }

  /** Call when an agent turn starts streaming for this dialog. */
  notifyTurnStart(dialogKey: string): void {
    this.getRuntime(dialogKey).send({ type: "turn-start" });
  }

  /**
   * Call when an agent turn ends for this dialog.
   * `ok` false without `aborted` keeps the queue (failure stop); `aborted`
   * clears the queue (user abandoned follow-ups) both in the core and in the
   * dialogRuntimeStore shadow.
   *
   * Returns a promise that resolves once any drain triggered by this turn-end
   * has committed (sent + dequeued) or failed. Callers that need to assert on
   * the post-drain state should await it.
   */
  notifyTurnEnd(
    dialogKey: string,
    outcome: { ok: boolean; aborted: boolean }
  ): Promise<void> {
    const rt = this.getRuntime(dialogKey);
    rt.send({ type: "turn-end", ...outcome });

    if (outcome.aborted) {
      // Mirror the core's "clear queue on abort" into the runtime-store shadow.
      clearPendingUserInputQueue({ dialogKey });
    }

    const pending = this.pendingDrains.get(dialogKey);
    return pending ? pending.then(() => undefined) : Promise.resolve();
  }

  /**
   * Enqueue a user input through the adapter. This writes to both the core
   * runtime and the dialogRuntimeStore queue so existing UI hooks keep working
   * during the migration.
   *
   * Order matters: we touch the runtime first (creating it if needed, seeded
   * from the *current* store shadow) and then mirror into the store. Doing it
   * the other way around would let the seed read back the value we just wrote
   * and double-count it.
   */
  enqueue(dialogKey: string, text: string): void {
    this.getRuntime(dialogKey).send({ type: "enqueue", text });
    enqueueUserInput({ text, dialogKey });
  }

  /** Current queue snapshot (from the core runtime). */
  getQueue(dialogKey: string): string[] {
    return this.getRuntime(dialogKey).getState().queue.map((req) => req.text);
  }

  /** Reflect `loopStopReason === "pending"` into the runtime's pause flag. */
  syncDrainPause(dialogKey: string): void {
    const paused = getLoopStopReason(dialogKey) === "pending";
    const rt = this.getRuntime(dialogKey);
    if (paused) rt.send({ type: "pause-drain" });
    else rt.send({ type: "resume-drain" });
  }
}