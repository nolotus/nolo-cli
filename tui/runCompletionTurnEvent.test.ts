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
  claimRunRecord,
  releaseRunRecordAck,
  resolveRunRecordPath,
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

  test("9. claim-on-start：wait 轮询期间 poller 并发看到终态也不唤醒（wait 了还收到通知的回归）", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "nolo-run-claim-test-"));
    const env = { NOLO_HOME: tempDir };
    const runId = "run-claim-race";
    const wokenEvents: InternalTurnEvent[] = [];
    const watcher = createRunCompletionWatcher({
      getCurrentDialogId: () => "dialog-parent",
      onWake: (ev) => wokenEvents.push(createTurnRequest(ev).event),
      now: () => T0 + 10000,
    });

    try {
      // run 起步时仍在跑，watcher 先看到活跃状态（真实 poller 的第一 tick）。
      writeRunRecord(
        createRecord({
          runId,
          parentDialogId: "dialog-parent",
          status: "running",
          startedAt: new Date(T0 + 12000).toISOString(),
        }),
        { env },
      );
      watcher.observe([readRunRecord(runId, { env })!]);
      expect(wokenEvents).toHaveLength(0);

      // wait 进入轮询；第一次 sleep 时模拟两件并发的事：子进程写终态，
      // 然后 poller 抢在 wait 的下一次读取之前 observe 到这条终态记录。
      // 旧实现（终态后才 ack）在这里会发出唤醒——正是「wait 了还收到通知」。
      const control = createCliControlAgentRunExecutor({
        env,
        nowMs: () => T0 + 10000,
        sleep: async () => {
          const rec = readRunRecord(runId, { env })!;
          if (rec.status === "running") {
            writeRunRecord(
              {
                ...rec,
                status: "done",
                exitCode: 0,
                endedAt: new Date(T0 + 15000).toISOString(),
              },
              { env },
            );
          }
          watcher.observe([readRunRecord(runId, { env })!]);
        },
      });

      const waitRes = await control({
        arguments: JSON.stringify({ action: "wait", runId, timeoutMs: 60_000 }),
      });
      expect(waitRes.content).toContain('"status":"done"');
      // 结果由 wait 这一条通道返回，唤醒通道必须全程沉默。
      expect(wokenEvents).toHaveLength(0);

      // wait 之后 poller 继续 observe 同一条记录，也不得补发。
      watcher.observe([readRunRecord(runId, { env })!]);
      expect(wokenEvents).toHaveLength(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("10. wait 超时释放 claim：放弃同步等待后，真终态仍能唤醒（结果不静默）", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "nolo-run-claim-release-"));
    const env = { NOLO_HOME: tempDir };
    const runId = "run-claim-release";
    const wokenEvents: InternalTurnEvent[] = [];
    const watcher = createRunCompletionWatcher({
      getCurrentDialogId: () => "dialog-parent",
      onWake: (ev) => wokenEvents.push(createTurnRequest(ev).event),
      now: () => T0 + 10000,
    });

    try {
      writeRunRecord(
        createRecord({
          runId,
          parentDialogId: "dialog-parent",
          status: "running",
          startedAt: new Date(T0 + 12000).toISOString(),
        }),
        { env },
      );
      watcher.observe([readRunRecord(runId, { env })!]);

      // wait 超时：run 全程 running，nowMs 每次读都推进到超过 deadline。
      let nowMs = T0 + 10000;
      const control = createCliControlAgentRunExecutor({
        env,
        nowMs: () => nowMs,
        sleep: async () => {
          nowMs += 5000;
          // claim 期间 poller 照常 observe（仍是 running，不该唤醒）。
          watcher.observe([readRunRecord(runId, { env })!]);
        },
      });
      const timeoutRes = await control({
        arguments: JSON.stringify({ action: "wait", runId, timeoutMs: 1000 }),
      });
      expect(timeoutRes.content).toContain('"status":"timeout"');
      // 放弃同步等待 → claim 必须释放，否则这条 run 的结果永远没人来收。
      expect(readRunRecord(runId, { env })?.ack).toBeUndefined();
      expect(wokenEvents).toHaveLength(0);

      // 稍后 run 真的完成：唤醒通道重新接管。
      writeRunRecord(
        {
          ...readRunRecord(runId, { env })!,
          status: "done",
          exitCode: 0,
          endedAt: new Date(T0 + 40000).toISOString(),
        },
        { env },
      );
      watcher.observe([readRunRecord(runId, { env })!]);
      expect(wokenEvents).toHaveLength(1);
      expect((wokenEvents[0] as ChildRunCompletedTurnEvent).runs[0]?.runId).toBe(runId);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("12. ghost 释放：被孤儿化的旧 wait 迟到 finally 不会删掉新 wait 的租约", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "nolo-run-claim-ghost-"));
    const env = { NOLO_HOME: tempDir };
    const runId = "run-claim-ghost";
    try {
      writeRunRecord(
        createRecord({ runId, parentDialogId: "dialog-parent", status: "running" }),
        { env },
      );

      // 旧 wait 取得租约后被强停（token 记在手里，finally 迟迟未跑）。
      const ghostToken = claimRunRecord(runId, { env })!;
      expect(ghostToken).toBeTruthy();
      // 旧 wait 放弃，租约回到未持有。
      releaseRunRecordAck(runId, ghostToken, { env });
      expect(readRunRecord(runId, { env })?.ack).toBeUndefined();

      // 新 wait 取得新租约。
      const freshToken = claimRunRecord(runId, { env })!;
      expect(freshToken).not.toBe(ghostToken);

      // 迟到的 ghost 释放到达：token 不匹配，必须放手，否则新 wait 的 claim
      // 被删掉，「wait 了还收到通知」在窄窗口复现。
      releaseRunRecordAck(runId, ghostToken, { env });
      const rec = readRunRecord(runId, { env });
      expect(rec?.ack).toBe(true);
      expect(rec?.ackLease?.token).toBe(freshToken);

      // 唤醒通道此刻仍应让路（租约有效）。
      const wokenEvents: InternalTurnEvent[] = [];
      const watcher = createRunCompletionWatcher({
        getCurrentDialogId: () => "dialog-parent",
        onWake: (ev) => wokenEvents.push(createTurnRequest(ev).event),
        now: () => T0 + 10000,
      });
      watcher.observe([rec!]);
      writeRunRecord({ ...rec!, status: "done", exitCode: 0 }, { env });
      watcher.observe([readRunRecord(runId, { env })!]);
      expect(wokenEvents).toHaveLength(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("13. crash 粘滞自愈：持有者进程被硬杀，过期租约不再永久静默这条 run", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "nolo-run-claim-expiry-"));
    const env = { NOLO_HOME: tempDir };
    const runId = "run-claim-expired";
    try {
      writeRunRecord(
        createRecord({ runId, parentDialogId: "dialog-parent", status: "running" }),
        { env },
      );
      // wait 取得短租约后进程被杀：finally 永远不会跑。
      const token = claimRunRecord(runId, {
        env,
        ttlMs: 1000,
        now: () => new Date(T0),
      });
      expect(token).toBeTruthy();

      const rec = readRunRecord(runId, { env })!;
      expect(rec.ack).toBe(true);

      // 租约仍在有效期内：唤醒通道让路。
      const early: InternalTurnEvent[] = [];
      const earlyWatcher = createRunCompletionWatcher({
        getCurrentDialogId: () => "dialog-parent",
        onWake: (ev) => early.push(createTurnRequest(ev).event),
        now: () => T0 + 500,
      });
      earlyWatcher.observe([rec]);
      writeRunRecord({ ...rec, status: "done", exitCode: 0 }, { env });
      earlyWatcher.observe([readRunRecord(runId, { env })!]);
      expect(early).toHaveLength(0);

      // 租约过期后：没有任何人来清理，但读者一律视为未被 claim，
      // 这条 run 的完成重新可被唤醒通道收走。
      const late: InternalTurnEvent[] = [];
      const lateWatcher = createRunCompletionWatcher({
        getCurrentDialogId: () => "dialog-parent",
        onWake: (ev) => late.push(createTurnRequest(ev).event),
        now: () => T0 + 60_000,
      });
      const doneRec = readRunRecord(runId, { env })!;
      lateWatcher.observe([{ ...doneRec, status: "running" }]);
      lateWatcher.observe([doneRec]);
      expect(late).toHaveLength(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("14. abort 收手：wait 收到 abortSignal 立刻退出并释放租约", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "nolo-run-claim-signal-"));
    const env = { NOLO_HOME: tempDir };
    const runId = "run-claim-signal";
    try {
      writeRunRecord(
        createRecord({ runId, parentDialogId: "dialog-parent", status: "running" }),
        { env },
      );
      const controller = new AbortController();
      const control = createCliControlAgentRunExecutor({
        env,
        nowMs: () => T0 + 10000,
        // 第一次休眠时 turn 被强停（真实路径：用户 Esc / 强制收尾）。
        sleep: async () => controller.abort(),
      });

      await expect(
        control(
          { arguments: JSON.stringify({ action: "wait", runId, timeoutMs: 60_000 }) },
          { abortSignal: controller.signal },
        ),
      ).rejects.toThrow(/中止/);

      // 租约释放，run 之后完成仍能被唤醒通道收走。
      expect(readRunRecord(runId, { env })?.ack).toBeUndefined();
      const woken: InternalTurnEvent[] = [];
      const watcher = createRunCompletionWatcher({
        getCurrentDialogId: () => "dialog-parent",
        onWake: (ev) => woken.push(createTurnRequest(ev).event),
        now: () => T0 + 10000,
      });
      watcher.observe([readRunRecord(runId, { env })!]);
      writeRunRecord(
        { ...readRunRecord(runId, { env })!, status: "done", exitCode: 0 },
        { env },
      );
      watcher.observe([readRunRecord(runId, { env })!]);
      expect(woken).toHaveLength(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("15. W1 回归：子进程已终态但 wait 在 commit 前 abort 并释放租约，watcher 仍能唤醒（不提前永久静默）", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "nolo-run-w1-race-"));
    const env = { NOLO_HOME: tempDir };
    const runId = "run-w1-race";
    const wokenEvents: InternalTurnEvent[] = [];
    const watcher = createRunCompletionWatcher({
      getCurrentDialogId: () => "dialog-parent",
      onWake: (ev) => wokenEvents.push(createTurnRequest(ev).event),
      now: () => T0 + 10000,
    });

    try {
      writeRunRecord(
        createRecord({
          runId,
          parentDialogId: "dialog-parent",
          status: "running",
          startedAt: new Date(T0 + 1000).toISOString(),
        }),
        { env },
      );
      watcher.observe([readRunRecord(runId, { env })!]);

      // wait 拿到租约。
      const token = claimRunRecord(runId, { env, now: () => new Date(T0 + 2000) })!;
      expect(token).toBeTruthy();

      // 子进程落终态（done）；此时 wait 还没来得及 commit。
      writeRunRecord(
        {
          ...readRunRecord(runId, { env })!,
          status: "done",
          exitCode: 0,
          endedAt: new Date(T0 + 3000).toISOString(),
        },
        { env },
      );

      // Poller 在此交错时刻 tick：看到「终态 + 有效租约」。
      // W1 的 bug 在这里：旧代码因为看到终态就把 runId 推进 notifiedRunIds。
      const claimedDoneRec = readRunRecord(runId, { env })!;
      watcher.observe([claimedDoneRec]);
      // 唤醒通道当前确实让路（租约仍在）。
      expect(wokenEvents).toHaveLength(0);

      // 关键交错：wait 因 abort/超时/异常而退出，释放了租约，结果未被交付。
      releaseRunRecordAck(runId, token, { env });
      expect(readRunRecord(runId, { env })?.ack).toBeUndefined();

      // 下一次 poller tick：租约已不在，这次完成必须能重新触发唤醒。
      // 旧代码因提前 notifiedRunIds.add 会在这里永久静默。
      watcher.observe([readRunRecord(runId, { env })!]);
      expect(wokenEvents).toHaveLength(1);
      expect((wokenEvents[0] as ChildRunCompletedTurnEvent).runs[0]?.runId).toBe(runId);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // 真实强停路径见测试 14（abortSignal）。这条覆盖的是另一类退出：轮询中
  // 任意异常（IO 错误等）抛出时 finally 仍须释放租约。
  test("11. wait 轮询中途抛异常不泄漏租约：结果仍能被唤醒通道收走", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "nolo-run-claim-abort-"));
    const env = { NOLO_HOME: tempDir };
    const runId = "run-claim-abort";
    const wokenEvents: InternalTurnEvent[] = [];
    const watcher = createRunCompletionWatcher({
      getCurrentDialogId: () => "dialog-parent",
      onWake: (ev) => wokenEvents.push(createTurnRequest(ev).event),
      now: () => T0 + 10000,
    });

    try {
      writeRunRecord(
        createRecord({
          runId,
          parentDialogId: "dialog-parent",
          status: "running",
          startedAt: new Date(T0 + 12000).toISOString(),
        }),
        { env },
      );
      watcher.observe([readRunRecord(runId, { env })!]);

      // wait 在轮询途中被打断（turn 强停 / abort 会以抛错形式离开循环）。
      const control = createCliControlAgentRunExecutor({
        env,
        nowMs: () => T0 + 10000,
        sleep: async () => {
          throw new Error("turn aborted");
        },
      });
      await expect(
        control({ arguments: JSON.stringify({ action: "wait", runId, timeoutMs: 60_000 }) }),
      ).rejects.toThrow("turn aborted");

      // 异常路径同样必须释放 claim，否则这条 run 完成后永久静默、跨重启粘滞。
      expect(readRunRecord(runId, { env })?.ack).toBeUndefined();

      writeRunRecord(
        {
          ...readRunRecord(runId, { env })!,
          status: "done",
          exitCode: 0,
          endedAt: new Date(T0 + 40000).toISOString(),
        },
        { env },
      );
      watcher.observe([readRunRecord(runId, { env })!]);
      expect(wokenEvents).toHaveLength(1);
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

  test("16. strict claim 原子性：锁竞争时只有一个 wait 拿到 token，另一个 null 退出", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "nolo-run-claim-strict-"));
    const env = { NOLO_HOME: tempDir };
    const runId = "run-claim-strict";
    try {
      writeRunRecord(
        createRecord({ runId, parentDialogId: "dialog-parent", status: "running" }),
        { env },
      );

      // 模拟两个并发 wait 拿同一个 lock 文件：第一个拿到 wx 锁，第二个
      // 在 strict 模式下必须返回 null（而非裸执行读-检查-写后也返回 token）。
      const fs = require("node:fs");
      const lockPath = `${resolveRunRecordPath(runId, env)}.lock`;
      // 预占 lock 文件，模拟另一个 wait 正持有锁。
      fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });

      // strict 模式：锁被占 → claimRunRecord 返回 null，不裸执行。
      const token = claimRunRecord(runId, { env });
      expect(token).toBeNull();

      // 记录未被修改（claim 未写入）。
      const rec = readRunRecord(runId, { env });
      expect(rec?.ack).toBeUndefined();
      expect(rec?.ackLease).toBeUndefined();

      // 释放预占的锁后 claim 可以正常获取。
      fs.unlinkSync(lockPath);
      const token2 = claimRunRecord(runId, { env });
      expect(token2).toBeTruthy();
      expect(readRunRecord(runId, { env })?.ackLease?.token).toBe(token2);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
