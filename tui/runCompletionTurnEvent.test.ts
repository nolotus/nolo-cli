import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunCompletionWatcher } from "./runCompletionWatcher";
import { createChatQueueTuiBinding } from "./chatQueueTuiBinding";
import {
  createTurnRequest,
  normalizeRunCompletionShape,
  type AgentRunCompletionShape,
  type ChildRunCompletedTurnEvent,
  type InternalTurnEvent,
  type TurnRequest,
} from "../core/chat/internalTurnEvent";
import {
  writeRunRecord,
  readRunRecord,
  ackRunRecord,
  type RunRecord,
} from "../agentRunControl";
import { createCliControlAgentRunExecutor } from "../client/cliAgentRunToolExecutors";

const T0 = 1_700_000_000_000;

function createRecord(
  over: Partial<RunRecord & AgentRunCompletionShape> & { runId: string }
): RunRecord & Partial<AgentRunCompletionShape> {
  return {
    agentKey: "agent-sub-worker",
    agentName: "SubWorker",
    startedAt: new Date(T0 + 1000).toISOString(),
    status: "running",
    logPath: `/tmp/${over.runId}.log`,
    parentDialogId: "parent-dialog-1",
    ...over,
  } as RunRecord;
}

describe("subAgent terminal event & chat queue loop", () => {
  test("1. 空闲自动下一 turn：idle 时收到 child-run-completed 内部事件由真实调度器直接启动下一 turn", async () => {
    let activeDialogId: string | null = "parent-dialog-1";
    const executedTurns: TurnRequest[] = [];

    // 真实 TUI scheduler binding：传入真实的 runTurn 回调收集请求
    const binding = createChatQueueTuiBinding(async (req) => {
      executedTurns.push(req);
      return { ok: true, aborted: false };
    });

    const watcher = createRunCompletionWatcher({
      getCurrentDialogId: () => activeDialogId,
      onWake: (event) => {
        // 使用真实 enqueueAndMaybeRun：空闲时会自动触发 notifyTurnEnd 并执行 runTurn
        void binding.enqueueAndMaybeRun(event);
      },
      now: () => T0 + 10000,
    });

    watcher.observe([createRecord({ runId: "run-1" })]);
    watcher.observe([
      createRecord({ runId: "run-1", status: "done", endedAt: new Date(T0 + 15000).toISOString() }),
    ]);

    // 验证调度器自动出队并真实调用了 runTurn 一次
    expect(executedTurns).toHaveLength(1);
    expect(executedTurns[0]?.event.kind).toBe("child-run-completed");
    expect((executedTurns[0]?.event as ChildRunCompletedTurnEvent).runs[0]?.runId).toBe("run-1");
  });

  test("2. busy 后 turn-end drain：busy 期间完成的 run 结构化入队，turn-end 自动 drain", async () => {
    let activeDialogId: string | null = "parent-dialog-1";
    const executedTurns: TurnRequest[] = [];

    const binding = createChatQueueTuiBinding(async (req) => {
      executedTurns.push(req);
      return { ok: true, aborted: false };
    });

    const watcher = createRunCompletionWatcher({
      getCurrentDialogId: () => activeDialogId,
      onWake: (event) => {
        void binding.enqueueAndMaybeRun(event);
      },
      now: () => T0 + 10000,
    });

    // 假设当前 turn 正在 running
    binding.notifyTurnStart();

    // 运行期间观察到 run-2 完成
    watcher.observe([createRecord({ runId: "run-2" })]);
    watcher.observe([
      createRecord({ runId: "run-2", status: "done", endedAt: new Date(T0 + 15000).toISOString() }),
    ]);

    // 由于处于 busy 状态，enqueueAndMaybeRun 只排队，尚未执行 runTurn
    expect(binding.queueLength()).toBe(1);
    expect(executedTurns).toHaveLength(0);

    // 当前 turn 结束，触发 notifyTurnEnd
    await binding.notifyTurnEnd({ ok: true, aborted: false });

    // notifyTurnEnd 自动 drain
    expect(executedTurns).toHaveLength(1);
    expect(executedTurns[0]?.event.kind).toBe("child-run-completed");
    expect((executedTurns[0]?.event as ChildRunCompletedTurnEvent).runs[0]?.runId).toBe("run-2");
    expect(binding.queueLength()).toBe(0);
  });

  test("3. 批量合并：同一 tick 内完成的多条 run 合并成单条 child-run-completed 事件", () => {
    let activeDialogId: string | null = "parent-dialog-1";
    const events: InternalTurnEvent[] = [];

    const watcher = createRunCompletionWatcher({
      getCurrentDialogId: () => activeDialogId,
      onWake: (ev) => {
        const req = createTurnRequest(ev);
        events.push(req.event);
      },
      now: () => T0 + 10000,
    });

    watcher.observe([
      createRecord({ runId: "run-a" }),
      createRecord({ runId: "run-b" }),
      createRecord({ runId: "run-c" }),
    ]);

    watcher.observe([
      createRecord({ runId: "run-a", status: "done" }),
      createRecord({ runId: "run-b", status: "failed", exitCode: 1 }),
      createRecord({ runId: "run-c", status: "done" }),
    ]);

    expect(events).toHaveLength(1);
    const event = events[0] as ChildRunCompletedTurnEvent;
    expect(event.kind).toBe("child-run-completed");
    expect(event.runs).toHaveLength(3);
    expect(event.runs.map((r) => r.runId)).toEqual(["run-a", "run-b", "run-c"]);
  });

  test("4. wait:true / ack 去重：wait:true 或已 ack 的 run 终态不再次触发 wake", () => {
    let activeDialogId: string | null = "parent-dialog-1";
    const events: InternalTurnEvent[] = [];

    const watcher = createRunCompletionWatcher({
      getCurrentDialogId: () => activeDialogId,
      onWake: (ev) => events.push(createTurnRequest(ev).event),
      now: () => T0 + 10000,
    });

    // 记录自带 ack: true
    watcher.observe([
      createRecord({ runId: "run-sync-wait", status: "done", ack: true }),
    ]);
    expect(events).toHaveLength(0);

    // markAcknowledged 显式 ack
    watcher.markAcknowledged("run-manual-ack");
    watcher.observe([
      createRecord({ runId: "run-manual-ack", status: "done" }),
    ]);
    expect(events).toHaveLength(0);
    expect(watcher.isAcknowledged("run-manual-ack")).toBe(true);
  });

  test("5. dialog 切换隔离：切走 dialog 不污染新 dialog，切回后可正确 wake", () => {
    let activeDialogId: string | null = "dialog-A";
    const events: { dialog: string; event: InternalTurnEvent }[] = [];

    const watcher = createRunCompletionWatcher({
      getCurrentDialogId: () => activeDialogId,
      onWake: (ev) => {
        if (activeDialogId) {
          events.push({ dialog: activeDialogId, event: createTurnRequest(ev).event });
        }
      },
      now: () => T0 + 10000,
    });

    // 在 dialog-A 派发 run-A
    watcher.observe([createRecord({ runId: "run-A", parentDialogId: "dialog-A" })]);

    // 用户切到 dialog-B，此时 run-A 完成
    activeDialogId = "dialog-B";
    watcher.observe([
      createRecord({ runId: "run-A", parentDialogId: "dialog-A", status: "done" }),
    ]);
    // dialog-B 不受污染
    expect(events).toHaveLength(0);

    // 用户切回 dialog-A，poller 再次 observe run-A 终态
    activeDialogId = "dialog-A";
    watcher.observe([
      createRecord({ runId: "run-A", parentDialogId: "dialog-A", status: "done" }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]?.dialog).toBe("dialog-A");
    expect((events[0]?.event as ChildRunCompletedTurnEvent).runs[0]?.runId).toBe("run-A");
  });

  test("6. 失败/timeout/ephemeral 不崩溃：未持久化 dialog 或结果缺失时优雅 fallback", () => {
    let activeDialogId: string | null = "parent-dialog-1";
    const events: InternalTurnEvent[] = [];

    const watcher = createRunCompletionWatcher({
      getCurrentDialogId: () => activeDialogId,
      onWake: (ev) => events.push(createTurnRequest(ev).event),
      now: () => T0 + 10000,
    });

    // Observe ephemeral run and timed out run
    watcher.observe([
      createRecord({
        runId: "run-ephemeral",
        status: "done",
        startedAt: new Date(T0 + 11000).toISOString(),
        ephemeral: true,
        dialogId: undefined, // no child dialog
        note: "One-off review finished",
      }),
      createRecord({
        runId: "run-timeout",
        status: "timeout",
        startedAt: new Date(T0 + 11000).toISOString(),
        error: "Process execution timed out after 60s",
      }),
    ]);

    expect(events).toHaveLength(1);
    const event = events[0] as ChildRunCompletedTurnEvent;
    expect(event.runs).toHaveLength(2);

    const ephShape = normalizeRunCompletionShape(event.runs[0]!);
    expect(ephShape.ephemeral).toBe(true);
    expect(ephShape.dialogId).toBeUndefined();

    const text = event.text;
    expect(text).toContain("runId: run-ephemeral");
    expect(text).toContain("ephemeral: true");
    expect(text).toContain("runId: run-timeout");
    expect(text).toContain("status: timeout");
  });

  test("7. 普通 status 不 ack、不抑制 wake；wait:true 消费确实 ack 且不重复 wake", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "nolo-run-ack-test-"));
    const env = { NOLO_HOME: tempDir };
    const deps = { env, nowMs: () => T0 + 10000 };

    try {
      const runId = "run-ack-semantics-1";
      const record = createRecord({
        runId,
        parentDialogId: "dialog-parent",
        status: "done",
        startedAt: new Date(T0 + 12000).toISOString(),
        endedAt: new Date(T0 + 15000).toISOString(),
      });
      writeRunRecord(record, deps);

      const control = createCliControlAgentRunExecutor(deps);

      // (1) 普通 status 查询
      const statusRes = await control({ arguments: JSON.stringify({ action: "status", runId }) });
      expect(statusRes.content).toContain('"status":"done"');
      const recAfterStatus = readRunRecord(runId, deps);
      expect(recAfterStatus?.ack).toBeUndefined(); // 普通 status 不能 ack!

      // 验证 watcher 能观察到此未 ack 的 run 并触发 wake
      let wokenEvents: InternalTurnEvent[] = [];
      const watcher = createRunCompletionWatcher({
        getCurrentDialogId: () => "dialog-parent",
        onWake: (ev) => wokenEvents.push(createTurnRequest(ev).event),
        now: () => T0 + 10000,
      });

      watcher.observe([recAfterStatus!]);
      expect(wokenEvents).toHaveLength(1);

      // (2) wait:true 消费路径
      const waitRes = await control({ arguments: JSON.stringify({ action: "wait", runId, timeoutMs: 1000 }) });
      expect(waitRes.content).toContain('"status":"done"');
      const recAfterWait = readRunRecord(runId, deps);
      expect(recAfterWait?.ack).toBe(true); // wait 消费确实写入 ack: true!

      // 验证 watcher 再次 observe 该记录时由于 ack===true 会直接跳过，不重复 wake
      wokenEvents = [];
      watcher.observe([recAfterWait!]);
      expect(wokenEvents).toHaveLength(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("8. 队列暂停/恢复机制下事件不丢失，且恢复后正确定向执行", async () => {
    let activeDialogId: string | null = "parent-dialog-1";
    const executedTurns: TurnRequest[] = [];

    const binding = createChatQueueTuiBinding(async (req) => {
      executedTurns.push(req);
      return { ok: true, aborted: false };
    });

    const watcher = createRunCompletionWatcher({
      getCurrentDialogId: () => activeDialogId,
      onWake: (event) => {
        void binding.enqueueAndMaybeRun(event);
      },
      now: () => T0 + 10000,
    });

    // 手动把状态模拟置为 busy
    binding.notifyTurnStart();

    watcher.observe([createRecord({ runId: "run-paused-1" })]);
    watcher.observe([
      createRecord({ runId: "run-paused-1", status: "done" }),
    ]);

    expect(binding.queueLength()).toBe(1);
    expect(executedTurns).toHaveLength(0);

    // Turn 正常结束并触发 drain
    await binding.notifyTurnEnd({ ok: true, aborted: false });
    expect(executedTurns).toHaveLength(1);
    expect((executedTurns[0]?.event as ChildRunCompletedTurnEvent).runs[0]?.runId).toBe("run-paused-1");
  });
});
