import { describe, expect, test } from "bun:test";

import type { AgentRunSnapshot } from "../client/agentRunSnapshot";
import type { RunRecord } from "../agentRunControl";
import {
  RUN_RECONCILE_SILENCE_MS,
  createRunRegistryPoller,
  snapshotFromRunRecord,
} from "./runRegistryPoller";

const T0 = 1_700_000_000_000;

function record(over: Partial<RunRecord> & { runId: string }): RunRecord {
  return {
    agentKey: "worker",
    startedAt: new Date(T0).toISOString(),
    status: "running",
    logPath: `/tmp/${over.runId}.log`,
    ...over,
  } as RunRecord;
}

/**
 * 轮询器只认两件事：面板上现在挂着谁，以及磁盘上读到什么。两者都注入，
 * 所以测试不碰真实文件系统也不碰真实 timer。
 */
function setup(opts: { docked?: AgentRunSnapshot[] } = {}) {
  let nowMs = T0;
  let tickCb: (() => void) | null = null;
  const docked = new Map<string, AgentRunSnapshot>();
  for (const run of opts.docked ?? []) docked.set(run.runId, run);
  const records = new Map<string, RunRecord>();
  const updates: AgentRunSnapshot[] = [];
  const reads: string[] = [];
  const reconciles: string[] = [];
  const throwOn = new Set<string>();

  const poller = createRunRegistryPoller({
    getDockedRuns: () => [...docked.values()],
    update: (snapshot) => {
      updates.push(snapshot);
      // 真实接线里 dock 会把快照收下，面板下一轮就按新状态走。
      docked.set(snapshot.runId, { ...docked.get(snapshot.runId), ...snapshot });
    },
    readRecord: (runId) => {
      reads.push(runId);
      if (throwOn.has(runId)) throw new Error("boom");
      return records.get(runId) ?? null;
    },
    reconcile: (runId) => {
      reconciles.push(runId);
      return records.get(runId) ?? null;
    },
    now: () => nowMs,
    setIntervalFn: (cb) => {
      tickCb = cb;
      return {};
    },
    clearIntervalFn: () => {
      tickCb = null;
    },
  });

  return {
    poller,
    updates,
    reads,
    reconciles,
    records,
    throwOn,
    docked,
    dock(run: AgentRunSnapshot) {
      docked.set(run.runId, run);
    },
    advance(ms: number) {
      nowMs += ms;
    },
    tick() {
      tickCb?.();
    },
    get timerActive() {
      return tickCb !== null;
    },
    now: () => nowMs,
  };
}

function docked(over: Partial<AgentRunSnapshot> & { runId: string }): AgentRunSnapshot {
  return { status: "running", logKey: "", ...over };
}

describe("snapshotFromRunRecord", () => {
  test("carries the in-flight action the model's own status call never sees", () => {
    const snapshot = snapshotFromRunRecord(
      record({
        runId: "run-a",
        agentName: "Flash",
        activity: {
          lastEventAt: new Date(T0 + 9_000).toISOString(),
          inFlight: { kind: "tool", name: "Edit", sinceMs: 3_000 },
          counters: { llmCalls: 4, toolCalls: 24, fileEdits: 2 },
          updatedAt: new Date(T0 + 9_000).toISOString(),
        },
      }),
      T0 + 10_000
    );

    expect(snapshot.toolCallCount).toBe(24);
    expect(snapshot.inFlight?.kind).toBe("tool");
    expect(snapshot.inFlight?.name).toBe("Edit");
    // sinceMs 是采样值；换算成绝对起点后面板才能自己把秒数走下去。
    expect(snapshot.inFlight?.startedAt).toBe(T0 + 6_000);
  });

  test("an idle run reports inFlight as an explicit null, not a missing key", () => {
    const snapshot = snapshotFromRunRecord(
      record({
        runId: "run-a",
        activity: {
          lastEventAt: new Date(T0).toISOString(),
          inFlight: null,
          counters: { llmCalls: 1, toolCalls: 2, fileEdits: 0 },
          updatedAt: new Date(T0).toISOString(),
        },
      }),
      T0
    );
    // null = 我刚看过，它空着；undefined = 这个来源不知道。dock 靠这个区分。
    expect(snapshot.inFlight).toBeNull();
    expect("inFlight" in snapshot).toBe(true);
  });

  test("a terminal run reports its end time and drops any in-flight action", () => {
    const snapshot = snapshotFromRunRecord(
      record({
        runId: "run-a",
        status: "orphaned",
        endedAt: new Date(T0 + 60_000).toISOString(),
        note: "orphaned: process gone without writing terminal status",
        activity: {
          lastEventAt: new Date(T0).toISOString(),
          inFlight: { kind: "tool", name: "Edit", sinceMs: 1_000 },
          counters: { llmCalls: 1, toolCalls: 1, fileEdits: 0 },
          updatedAt: new Date(T0).toISOString(),
        },
      }),
      T0 + 90_000
    );

    expect(snapshot.finishedAt).toBe(T0 + 60_000);
    expect(snapshot.inFlight).toBeNull();
    // 终态的 note 就是死因。
    expect(snapshot.errorMessage).toContain("orphaned");
  });

  test("a bogus sinceMs cannot push the action's start before the epoch", () => {
    const snapshot = snapshotFromRunRecord(
      record({
        runId: "run-a",
        activity: {
          lastEventAt: new Date(T0).toISOString(),
          // 坏掉的 sinceMs（或采样期间时钟被回拨）会算出负数起点，面板会把它
          // 当成 1970 年，渲染成「已进行 19900 天」。
          inFlight: { kind: "tool", name: "Edit", sinceMs: T0 * 2 },
          counters: { llmCalls: 0, toolCalls: 0, fileEdits: 0 },
          updatedAt: new Date(T0).toISOString(),
        },
      }),
      T0
    );
    expect(snapshot.inFlight?.startedAt).toBe(T0);
  });

  test("an action cannot start in the future", () => {
    const snapshot = snapshotFromRunRecord(
      record({
        runId: "run-a",
        activity: {
          lastEventAt: new Date(T0 + 60_000).toISOString(),
          inFlight: { kind: "llm", name: "llm", sinceMs: 0 },
          // 记录是别的进程写的，它的钟可能比我们快。
          updatedAt: new Date(T0 + 60_000).toISOString(),
          counters: { llmCalls: 0, toolCalls: 0, fileEdits: 0 },
        },
      }),
      T0
    );
    expect(snapshot.inFlight?.startedAt).toBe(T0);
  });

  test("a running run's note is not mistaken for an error", () => {
    const snapshot = snapshotFromRunRecord(record({ runId: "run-a", note: "just a note" }), T0);
    expect(snapshot.errorMessage).toBeUndefined();
  });
});

describe("run registry poller", () => {
  test("feeds the dock without anyone calling the model", () => {
    const h = setup({ docked: [docked({ runId: "run-a" })] });
    h.records.set(
      "run-a",
      record({
        runId: "run-a",
        agentName: "Flash",
        activity: {
          lastEventAt: new Date(T0).toISOString(),
          inFlight: { kind: "tool", name: "Edit", sinceMs: 0 },
          counters: { llmCalls: 1, toolCalls: 5, fileEdits: 0 },
          updatedAt: new Date(T0).toISOString(),
        },
      })
    );

    h.poller.poll();
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]).toMatchObject({ runId: "run-a", toolCallCount: 5 });
  });

  test("unchanged records do not trigger a repaint every second", () => {
    const h = setup({ docked: [docked({ runId: "run-a" })] });
    h.records.set("run-a", record({ runId: "run-a", agentName: "Flash" }));

    h.poller.poll();
    expect(h.updates).toHaveLength(1);
    // 年龄由 dock 自己的 tick 走，不该靠轮询器每秒推一次快照。
    h.advance(1000);
    h.poller.poll();
    h.advance(1000);
    h.poller.poll();
    expect(h.updates).toHaveLength(1);
  });

  test("a new tool call does push an update", () => {
    const h = setup({ docked: [docked({ runId: "run-a" })] });
    h.records.set("run-a", record({ runId: "run-a" }));
    h.poller.poll();

    h.advance(1000);
    h.records.set(
      "run-a",
      record({
        runId: "run-a",
        activity: {
          lastEventAt: new Date(h.now()).toISOString(),
          inFlight: { kind: "tool", name: "Read", sinceMs: 0 },
          counters: { llmCalls: 1, toolCalls: 1, fileEdits: 0 },
          updatedAt: new Date(h.now()).toISOString(),
        },
      })
    );
    h.poller.poll();

    expect(h.updates).toHaveLength(2);
    expect(h.updates[1]?.inFlight?.name).toBe("Read");
  });

  test("runs that are not in the local registry are left to the model's path", () => {
    const h = setup({ docked: [docked({ runId: "server-run" })] });
    // 服务端跑的 run 本地没有记录文件——不代表它没了，不该动面板。
    h.poller.poll();
    expect(h.updates).toEqual([]);
  });

  test("terminal runs are not re-read", () => {
    const h = setup({
      docked: [docked({ runId: "run-a", status: "done" }), docked({ runId: "run-b" })],
    });
    h.records.set("run-a", record({ runId: "run-a", status: "done" }));
    h.records.set("run-b", record({ runId: "run-b" }));

    h.poller.poll();
    h.advance(1000);
    h.poller.poll();
    expect(h.reads).toEqual(["run-b", "run-b"]);
    expect(h.reconciles).toEqual([]);
  });

  test("a healthy run never pays for the orphan check", () => {
    const h = setup({ docked: [docked({ runId: "run-a" })] });
    const fresh = () =>
      record({
        runId: "run-a",
        activity: {
          lastEventAt: new Date(h.now()).toISOString(),
          inFlight: null,
          counters: { llmCalls: 1, toolCalls: 1, fileEdits: 0 },
          updatedAt: new Date(h.now()).toISOString(),
        },
      });
    h.records.set("run-a", fresh());

    // 活着的 run 每 2 秒写一次 activity，所以永远不该 fork ps —— 那一步是
    // 同步的，跑在 TUI 主循环上就是一次卡顿。
    for (let i = 0; i < 30; i++) {
      h.poller.poll();
      h.advance(1000);
      h.records.set("run-a", fresh());
    }
    expect(h.reconciles).toEqual([]);
    expect(h.reads.length).toBe(30);
  });

  test("a run that goes silent gets its pid checked", () => {
    const h = setup({ docked: [docked({ runId: "run-a" })] });
    h.records.set(
      "run-a",
      record({
        runId: "run-a",
        activity: {
          lastEventAt: new Date(h.now()).toISOString(),
          inFlight: { kind: "tool", name: "Edit", sinceMs: 0 },
          counters: { llmCalls: 1, toolCalls: 0, fileEdits: 0 },
          updatedAt: new Date(h.now()).toISOString(),
        },
      })
    );

    h.poller.poll();
    expect(h.reconciles).toEqual([]);

    // 记录不动了：可能是进程被 OOM 掉、崩了、没写终态就没了。这才是该问
    // 「pid 还在吗」的时刻。
    h.advance(RUN_RECONCILE_SILENCE_MS + 1);
    h.poller.poll();
    expect(h.reconciles).toEqual(["run-a"]);

    // 问过一次就别每秒重问。
    h.advance(1000);
    h.poller.poll();
    expect(h.reconciles).toEqual(["run-a"]);
  });

  test("a record with no activity yet falls back to the run start time", () => {
    const h = setup({ docked: [docked({ runId: "run-a" })] });
    // 记录里还没有 activity 段（run 刚起、或是个老记录）：拿 startedAt 当
    // 新鲜度，否则一条陈年记录会被当成「刚刚有动静」而永远不被对账。
    h.records.set("run-a", record({ runId: "run-a" }));
    h.advance(RUN_RECONCILE_SILENCE_MS + 1);
    h.poller.poll();
    expect(h.reconciles).toEqual(["run-a"]);
  });

  test("a throwing reader skips that run instead of taking down the TUI", () => {
    const h = setup({ docked: [docked({ runId: "run-a" }), docked({ runId: "run-b" })] });
    h.records.set("run-b", record({ runId: "run-b" }));
    h.throwOn.add("run-a");

    expect(() => h.poller.poll()).not.toThrow();
    // 一条 run 读挂了不该连累另一条。
    expect(h.updates.map((u) => u.runId)).toEqual(["run-b"]);
  });

  test("the timer stops once no docked run is still active", () => {
    const h = setup({ docked: [docked({ runId: "run-a" })] });
    h.records.set("run-a", record({ runId: "run-a" }));
    h.poller.ensureRunning();
    expect(h.timerActive).toBe(true);

    h.tick();
    expect(h.timerActive).toBe(true);

    // run 跑完了：面板还挂着它（linger 中），但已经没什么可读的了。
    h.docked.set("run-a", docked({ runId: "run-a", status: "done" }));
    h.tick();
    expect(h.timerActive).toBe(false);
  });

  test("ensureRunning is idempotent", () => {
    const h = setup({ docked: [docked({ runId: "run-a" })] });
    h.poller.ensureRunning();
    h.poller.ensureRunning();
    h.poller.stop();
    // 第二次 ensureRunning 若真开了第二个表，stop 只会清掉其中一个。
    expect(h.timerActive).toBe(false);
  });

  test("a late update after dispose cannot restart the timer", () => {
    const h = setup({ docked: [docked({ runId: "run-a" })] });
    h.poller.ensureRunning();
    h.poller.dispose();
    expect(h.timerActive).toBe(false);

    // 会话已退出，但上一轮 turn 的 tool-result 迟到了，接线处会调 ensureRunning。
    // stop() 是可逆的（没活跃 run 时自停），dispose() 不是。
    h.poller.ensureRunning();
    expect(h.timerActive).toBe(false);
  });

  test("a restarted poller re-emits state for a run it already reported", () => {
    const h = setup({ docked: [docked({ runId: "run-a" })] });
    h.records.set("run-a", record({ runId: "run-a" }));
    h.poller.poll();
    expect(h.updates).toHaveLength(1);

    // stop 会忘掉去重指纹，否则重启后面板会一直空着等一个「变化」。
    h.poller.stop();
    h.poller.poll();
    expect(h.updates).toHaveLength(2);
  });
});
