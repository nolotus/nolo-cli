import { describe, expect, test } from "bun:test";

import type { RunRecord } from "../agentRunControl";
import { createRunCompletionWatcher } from "./runCompletionWatcher";
import type { ChildRunCompletedTurnEvent, InternalTurnEvent } from "../core/chat/internalTurnEvent";

const T0 = 1_700_000_000_000;

function record(over: Partial<RunRecord> & { runId: string }): RunRecord {
  return {
    agentKey: "agent-user-worker",
    agentName: "Worker",
    startedAt: new Date(T0 + 1_000).toISOString(),
    status: "running",
    logPath: `/tmp/${over.runId}.log`,
    parentDialogId: "dlg-1",
    ...over,
  } as RunRecord;
}

function setup(opts: { dialogId?: string | null } = {}) {
  let currentDialogId: string | null = opts.dialogId === undefined ? "dlg-1" : opts.dialogId;
  let nowMs = T0;
  const wakes: (InternalTurnEvent | string)[] = [];
  const watcher = createRunCompletionWatcher({
    getCurrentDialogId: () => currentDialogId,
    onWake: (event) => wakes.push(event),
    now: () => nowMs,
  });
  return {
    watcher,
    wakes,
    setDialog(id: string | null) {
      currentDialogId = id;
    },
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

describe("createRunCompletionWatcher", () => {
  test("活跃→终态的转变触发一次唤醒，带结构化 InternalTurnEvent 字段", () => {
    const h = setup();
    h.watcher.observe([record({ runId: "run-a" })]);
    expect(h.wakes).toHaveLength(0);

    h.watcher.observe([
      record({
        runId: "run-a",
        status: "done",
        exitCode: 0,
        endedAt: new Date(T0 + 61_000).toISOString(),
        dialogId: "child-dialog-1",
      }),
    ]);
    expect(h.wakes).toHaveLength(1);
    const event = h.wakes[0] as ChildRunCompletedTurnEvent;
    expect(event.kind).toBe("child-run-completed");
    expect(event.runs).toHaveLength(1);
    expect(event.runs[0]).toMatchObject({
      runId: "run-a",
      status: "done",
      exitCode: 0,
      dialogId: "child-dialog-1",
      parentDialogId: "dlg-1",
    });
    const text = event.text;
    expect(text).toContain("runId: run-a");
    expect(text).toContain("status: done");
    expect(text).toContain("agent: Worker");
    expect(text).toContain("childDialogId: child-dialog-1");
    // 成功完成不报 exitCode：诊断字段只在失败时才值得占上下文。
    expect(text).not.toContain("exitCode");
  });

  test("失败终态仍带 exitCode 与活动计数（诊断信息不被瘦身掉）", () => {
    const h = setup();
    h.watcher.observe([record({ runId: "run-fail" })]);
    h.watcher.observe([
      record({
        runId: "run-fail",
        status: "failed",
        exitCode: 1,
        activity: {
          counters: { toolCalls: 3, llmCalls: 2, fileEdits: 1 },
          lastEventAt: new Date(T0).toISOString(),
          inFlight: null,
          updatedAt: new Date(T0).toISOString(),
        },
      }),
    ]);
    const event = h.wakes[0] as ChildRunCompletedTurnEvent;
    expect(event.text).toContain("exitCode: 1");
    expect(event.text).toContain("3 tool calls");
  });

  test("displayText 是屏幕用的紧凑单行，与送模型的完整摘要分开", () => {
    const h = setup();
    h.watcher.observe([record({ runId: "run-1" }), record({ runId: "run-2" })]);
    h.advance(61_000);
    h.watcher.observe([
      record({ runId: "run-1", status: "done" }),
      record({ runId: "run-2", status: "failed", exitCode: 1 }),
    ]);
    const event = h.wakes[0] as ChildRunCompletedTurnEvent;
    const display = event.displayText ?? "";
    expect(display).toContain("2 条后台 run 已完成");
    expect(display).toContain("✓");
    expect(display).toContain("✗");
    expect(display).toContain("failed");
    // 屏幕那行不许出现整段内部字段，也不能多行。
    expect(display).not.toContain("runId:");
    expect(display).not.toContain("\n");
    expect(display.length).toBeLessThan(event.text.length);
  });

  test("wait:true 已 ack 的 runId 不会触发唤醒", () => {
    const h = setup();
    // ack: true 在 record 上
    h.watcher.observe([
      record({
        runId: "run-wait-true",
        status: "done",
        ack: true,
      }),
    ]);
    expect(h.wakes).toHaveLength(0);

    // markAcknowledged 手动标记
    h.watcher.markAcknowledged("run-manual-ack");
    h.watcher.observe([
      record({
        runId: "run-manual-ack",
        status: "done",
      }),
    ]);
    expect(h.wakes).toHaveLength(0);
    expect(h.watcher.isAcknowledged("run-manual-ack")).toBe(true);
  });

  test("首次见即终态：watcher 创建之前起步的旧记录不唤醒", () => {
    const h = setup();
    h.watcher.observe([
      record({
        runId: "run-old",
        status: "done",
        startedAt: new Date(T0 - 3_600_000).toISOString(),
        endedAt: new Date(T0 - 3_500_000).toISOString(),
      }),
    ]);
    expect(h.wakes).toHaveLength(0);
  });

  test("首次见即终态：创建之后起步的 run 唤醒", () => {
    const h = setup();
    h.advance(500);
    h.watcher.observe([
      record({
        runId: "run-fast",
        status: "done",
        startedAt: new Date(T0 + 500).toISOString(),
        endedAt: new Date(T0 + 900).toISOString(),
      }),
    ]);
    expect(h.wakes).toHaveLength(1);
    const event = h.wakes[0] as ChildRunCompletedTurnEvent;
    expect(event.runs[0]?.runId).toBe("run-fast");
  });

  test("parentDialogId 不属于当前 dialog 的 run 只跳过，不唤醒", () => {
    const h = setup();
    h.watcher.observe([record({ runId: "run-x", parentDialogId: "dlg-other" })]);
    h.watcher.observe([
      record({ runId: "run-x", parentDialogId: "dlg-other", status: "done" }),
    ]);
    expect(h.wakes).toHaveLength(0);

    h.setDialog(null);
    h.watcher.observe([record({ runId: "run-y" })]);
    h.watcher.observe([record({ runId: "run-y", status: "failed" })]);
    expect(h.wakes).toHaveLength(0);
  });

  test("同一个 runId 绝不重复唤醒", () => {
    const h = setup();
    const done = record({ runId: "run-a", status: "done" });
    h.watcher.observe([record({ runId: "run-a" })]);
    h.watcher.observe([done]);
    h.watcher.observe([done]);
    h.watcher.observe([done]);
    expect(h.wakes).toHaveLength(1);
  });

  test("同一次 observe 的多条转变合并成一条唤醒事件", () => {
    const h = setup();
    h.watcher.observe([
      record({ runId: "run-1" }),
      record({ runId: "run-2" }),
      record({ runId: "run-3", parentDialogId: "dlg-other" }),
    ]);
    h.watcher.observe([
      record({ runId: "run-1", status: "done" }),
      record({ runId: "run-2", status: "failed", exitCode: 1 }),
      record({ runId: "run-3", parentDialogId: "dlg-other", status: "done" }),
    ]);
    expect(h.wakes).toHaveLength(1);
    const event = h.wakes[0] as ChildRunCompletedTurnEvent;
    expect(event.runs).toHaveLength(2);
    expect(event.runs.map((r) => r.runId)).toEqual(["run-1", "run-2"]);
    expect(event.text).toContain("2 条");
  });

  test("ephemeral run 提供 fallback 说明，不崩溃", () => {
    const h = setup();
    h.watcher.observe([
      record({
        runId: "run-eph",
        status: "done",
        ephemeral: true,
      }),
    ]);
    expect(h.wakes).toHaveLength(1);
    const event = h.wakes[0] as ChildRunCompletedTurnEvent;
    expect(event.runs[0]?.ephemeral).toBe(true);
    expect(event.text).toContain("ephemeral: true");
  });

  test("切走 dialog 期间 run 完成，切回来仍能唤醒（H1 回归）", () => {
    const h = setup();
    h.watcher.observe([record({ runId: "run-a" })]);
    expect(h.wakes).toHaveLength(0);

    h.setDialog("dlg-2");
    h.advance(61_000);
    h.watcher.observe([
      record({ runId: "run-a", status: "done", endedAt: new Date(T0 + 61_000).toISOString() }),
    ]);
    expect(h.wakes).toHaveLength(0);

    h.setDialog("dlg-1");
    h.watcher.observe([
      record({ runId: "run-a", status: "done", endedAt: new Date(T0 + 61_000).toISOString() }),
    ]);
    expect(h.wakes).toHaveLength(1);
    const event = h.wakes[0] as ChildRunCompletedTurnEvent;
    expect(event.runs[0]?.runId).toBe("run-a");
  });
});
