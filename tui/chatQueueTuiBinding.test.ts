// packages/cli/tui/chatQueueTuiBinding.test.ts
//
// TUI binding tests: pure, no readline/terminal. Verifies that:
//   - submit while running → queue-text (not dropped),
//   - turn-end drains the queue by calling runTurn,
//   - abort stops the drain cascade,
//   - a failed turn stops draining and keeps remaining items,
//   - /new while running still arms a fresh dialog (resolver priority),
//   - clear() empties the queue.

import { describe, expect, it, mock } from "bun:test";

import { createChatQueueTuiBinding } from "./chatQueueTuiBinding";

describe("createChatQueueTuiBinding", () => {
  it("resolves a pure-text submit while running as queue-text", () => {
    const binding = createChatQueueTuiBinding(async () => ({ ok: true, aborted: false }));
    const decision = binding.resolveSubmit({ text: "follow-up", isRunning: true });
    expect(decision.kind).toBe("queue-text");
    expect("text" in decision && decision.text).toBe("follow-up");
    binding.dispose();
  });

  it("resolves a submit while idle as send", () => {
    const binding = createChatQueueTuiBinding(async () => ({ ok: true, aborted: false }));
    const decision = binding.resolveSubmit({ text: "hello", isRunning: false });
    expect(decision.kind).toBe("send");
    binding.dispose();
  });

  it("/new while running arms a fresh dialog (resolver priority over queue)", () => {
    const binding = createChatQueueTuiBinding(async () => ({ ok: true, aborted: false }));
    const decision = binding.resolveSubmit({ text: "/new", isRunning: true });
    expect(decision.kind).toBe("arm-fresh-dialog");
    binding.dispose();
  });

  it("/compact while running is compact-blocked", () => {
    const binding = createChatQueueTuiBinding(async () => ({ ok: true, aborted: false }));
    const decision = binding.resolveSubmit({ text: "/compact", isRunning: true });
    expect(decision.kind).toBe("compact-blocked");
    binding.dispose();
  });

  it("enqueue grows the queue and updates the status", () => {
    const binding = createChatQueueTuiBinding(async () => ({ ok: true, aborted: false }));
    const status = binding.enqueue("queued message");
    expect(status.queueLength).toBe(1);
    expect(status.queuePreview).toEqual(["queued message"]);
    expect(binding.queueLength()).toBe(1);
    binding.dispose();
  });

  it("drains the queue after a clean turn-end by calling runTurn", async () => {
    const runTurn = mock(async (_text: string) => ({ ok: true, aborted: false } as const));
    const binding = createChatQueueTuiBinding(runTurn);

    binding.enqueue("first");
    binding.enqueue("second");
    binding.notifyTurnStart();
    await binding.notifyTurnEnd({ ok: true, aborted: false });

    // Both queued items should have been drained via runTurn, in order.
    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(runTurn.mock.calls[0]?.[0]).toBe("first");
    expect(runTurn.mock.calls[1]?.[0]).toBe("second");
    expect(binding.queueLength()).toBe(0);
    binding.dispose();
  });

  it("does not drain when the queue is empty", async () => {
    const runTurn = mock(async (_text: string) => ({ ok: true, aborted: false } as const));
    const binding = createChatQueueTuiBinding(runTurn);
    binding.notifyTurnStart();
    await binding.notifyTurnEnd({ ok: true, aborted: false });
    expect(runTurn).not.toHaveBeenCalled();
    binding.dispose();
  });

  it("aborted turn-end stops the drain cascade and clears the queue", async () => {
    const runTurn = mock(async (_text: string) => ({ ok: true, aborted: false } as const));
    const binding = createChatQueueTuiBinding(runTurn);
    binding.enqueue("will-be-abandoned");
    binding.notifyTurnStart();
    await binding.notifyTurnEnd({ ok: false, aborted: true });
    expect(runTurn).not.toHaveBeenCalled();
    expect(binding.queueLength()).toBe(0);
    binding.dispose();
  });

  it("a failed turn-end does not trigger any drain and keeps the queue", async () => {
    const runTurn = mock(async (_text: string) => ({ ok: false, aborted: false } as const));
    const binding = createChatQueueTuiBinding(runTurn);
    binding.enqueue("first");
    binding.enqueue("second");
    binding.notifyTurnStart();
    await binding.notifyTurnEnd({ ok: false, aborted: false });
    // The turn-end outcome itself was a failure, so the drain cascade never
    // starts. Both items remain untouched.
    expect(runTurn).not.toHaveBeenCalled();
    expect(binding.queueLength()).toBe(2);
    binding.dispose();
  });

  it("drain stops mid-cascade when a later turn fails", async () => {
    let call = 0;
    const runTurn = mock(async (_text: string) => {
      call += 1;
      return call === 2
        ? ({ ok: false, aborted: false } as const)
        : ({ ok: true, aborted: false } as const);
    });
    const binding = createChatQueueTuiBinding(runTurn);
    binding.enqueue("a");
    binding.enqueue("b");
    binding.enqueue("c");
    binding.notifyTurnStart();
    await binding.notifyTurnEnd({ ok: true, aborted: false });
    // a succeeded (dequeued), b failed (still dequeued — drain consumes the
    // head before runTurn resolves), c never attempted. Only c remains.
    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(runTurn.mock.calls[0]?.[0]).toBe("a");
    expect(runTurn.mock.calls[1]?.[0]).toBe("b");
    expect(binding.queueLength()).toBe(1);
    binding.dispose();
  });

  it("dequeues the head as soon as the drain starts, before runTurn resolves", async () => {
    // Block runTurn so we can observe the queue state while the turn is still
    // in flight: the head must already be gone the moment the drain begins.
    let resolveTurn: (v: { ok: boolean; aborted: boolean }) => void = () => {};
    const turnPromise = new Promise<{ ok: boolean; aborted: boolean }>((resolve) => {
      resolveTurn = resolve;
    });
    const runTurn = mock(async (_text: string) => turnPromise);
    const binding = createChatQueueTuiBinding(runTurn);
    binding.enqueue("only");
    binding.notifyTurnStart();
    // Kick off the drain but do not await it yet — runTurn is still pending.
    const settled = binding.notifyTurnEnd({ ok: true, aborted: false });
    // Yield once so the drain loop reaches the `await runTurn(text)` point.
    await Promise.resolve();
    // The message has been consumed: neither the queue length nor the status
    // snapshot still list it, even though runTurn has not resolved.
    expect(binding.queueLength()).toBe(0);
    const status = binding.getStatus();
    expect(status.queueLength).toBe(0);
    expect(status.queuePreview).toEqual([]);
    // Let the in-flight turn finish so the binding settles cleanly.
    resolveTurn({ ok: true, aborted: false });
    await settled;
    binding.dispose();
  });

  it("a failed drained turn does not leave its message in the queue (no resend)", async () => {
    // The drained turn fails (ok:false). With the old "dequeue only on
    // success" logic the message would remain and be resent on the next clean
    // turn-end; the fix dequeues at drain start so it stays gone.
    const runTurn = mock(async (_text: string) => ({ ok: false, aborted: false } as const));
    const binding = createChatQueueTuiBinding(runTurn);
    binding.enqueue("doomed");
    binding.notifyTurnStart();
    await binding.notifyTurnEnd({ ok: true, aborted: false });
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(runTurn.mock.calls[0]?.[0]).toBe("doomed");
    // The failed drained message is NOT left in the queue.
    expect(binding.queueLength()).toBe(0);
    expect(binding.getStatus().queuePreview).toEqual([]);
    // A subsequent clean turn-end must not resend it: runTurn is not called
    // again and the queue stays empty.
    binding.notifyTurnStart();
    await binding.notifyTurnEnd({ ok: true, aborted: false });
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(binding.queueLength()).toBe(0);
    binding.dispose();
  });

  it("clear() empties the queue", () => {
    const binding = createChatQueueTuiBinding(async () => ({ ok: true, aborted: false }));
    binding.enqueue("x");
    binding.enqueue("y");
    binding.clear();
    expect(binding.queueLength()).toBe(0);
    binding.dispose();
  });

  it("getStatus reflects running state for the status line", () => {
    const binding = createChatQueueTuiBinding(async () => ({ ok: true, aborted: false }));
    expect(binding.getStatus().isRunning).toBe(false);
    binding.enqueue("x");
    binding.notifyTurnStart();
    const status = binding.getStatus();
    expect(status.isRunning).toBe(true);
    expect(status.queueLength).toBe(1);
    expect(status.composerPlaceholderKey).toBe("queuing");
    binding.dispose();
  });

  it("runTurn throwing is treated as a failed turn and does not leave the head in the queue", async () => {
    const runTurn = mock(async () => {
      throw new Error("network");
    });
    const binding = createChatQueueTuiBinding(runTurn);
    binding.enqueue("x");
    binding.notifyTurnStart();
    await binding.notifyTurnEnd({ ok: true, aborted: false });
    expect(runTurn).toHaveBeenCalledTimes(1);
    // The head was dequeued before runTurn resolved, so a thrown turn does not
    // leave "x" behind to be resent on the next clean turn-end.
    expect(binding.queueLength()).toBe(0);
    binding.dispose();
  });
});