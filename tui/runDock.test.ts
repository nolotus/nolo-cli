import { describe, expect, test } from "bun:test";

import type { AgentRunSnapshot } from "../client/agentRunSnapshot";
import {
  RUN_DOCK_LINGER_MS,
  RUN_DOCK_STALE_MS,
  RUN_DOCK_TICK_INTERVAL_MS,
  createRunDock,
  formatRunDockLines,
} from "./runDock";

/**
 * 手动时钟 + 捕获的 tick 回调：dock 的全部收尾逻辑（linger / stale）都是时间
 * 驱动的，用真 timer 测必然 flaky。
 */
function setup() {
  let nowMs = 1_000_000;
  let tickCb: (() => void) | null = null;
  let repaints = 0;

  const dock = createRunDock({
    onRepaint: () => {
      repaints += 1;
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
    dock,
    lines: () => dock.getLines(false),
    get repaints() {
      return repaints;
    },
    get timerActive() {
      return tickCb !== null;
    },
    advance(ms: number) {
      nowMs += ms;
    },
    tick() {
      tickCb?.();
    },
    now: () => nowMs,
  };
}

function snapshot(over: Partial<AgentRunSnapshot> & { runId: string }): AgentRunSnapshot {
  return { status: "running", logKey: "", ...over };
}

describe("run dock membership", () => {
  test("holds several runs at once instead of overwriting one slot", () => {
    const h = setup();
    h.dock.update(snapshot({ runId: "run-a", agentName: "Flash" }));
    h.dock.update(snapshot({ runId: "run-b", agentName: "Sonnet" }));

    expect(h.dock.getRuns().map((r) => r.runId)).toEqual(["run-a", "run-b"]);
    const text = h.lines().join("\n");
    expect(text).toContain("Flash");
    expect(text).toContain("Sonnet");
    expect(text).toContain("2 running");
  });

  test("a status poll merges into the run rather than replacing it", () => {
    const h = setup();
    h.dock.update(
      snapshot({ runId: "run-a", agentName: "Flash", startedAt: h.now(), taskPreview: "build X" })
    );
    // 轮询回来的 payload 只带 status/toolCallCount，没有 agentName/startedAt。
    h.dock.update(snapshot({ runId: "run-a", toolCallCount: 9 }));

    const [run] = h.dock.getRuns();
    expect(run?.agentName).toBe("Flash");
    expect(run?.taskPreview).toBe("build X");
    expect(run?.toolCallCount).toBe(9);
  });

  test("a transient error clears when the run reports healthy again", () => {
    const h = setup();
    h.dock.update(snapshot({ runId: "run-a", agentName: "Flash", errorMessage: "ETIMEDOUT" }));
    expect(h.lines().join("\n")).toContain("ETIMEDOUT");

    // 恢复正常后的轮询根本不带 errorMessage 这个 key。
    h.dock.update(snapshot({ runId: "run-a", toolCallCount: 4 }));
    expect(h.dock.getRuns()[0]?.errorMessage).toBeUndefined();
    expect(h.lines().join("\n")).not.toContain("ETIMEDOUT");
  });

  test("a failed run keeps its error even when later polls omit it", () => {
    const h = setup();
    h.dock.update(snapshot({ runId: "run-a", status: "failed", errorMessage: "boom" }));
    h.dock.update(snapshot({ runId: "run-a", status: "failed" }));
    // 终态的错误是结论，不是瞬时噪音。
    expect(h.dock.getRuns()[0]?.errorMessage).toBe("boom");
  });

  test("a not_found report drops that run and leaves its siblings alone", () => {
    const h = setup();
    h.dock.update(snapshot({ runId: "run-a", agentName: "Flash" }));
    h.dock.update(snapshot({ runId: "run-b", agentName: "Sonnet" }));
    h.dock.update(snapshot({ runId: "run-a", status: "not_found" }));

    expect(h.dock.getRuns().map((r) => r.runId)).toEqual(["run-b"]);
  });

  test("a snapshot with no runId is ignored", () => {
    const h = setup();
    h.dock.update(snapshot({ runId: "" }));
    expect(h.dock.getRuns()).toEqual([]);
    expect(h.lines()).toEqual([]);
  });
});

describe("run dock lifecycle", () => {
  test("a finished run lingers, then leaves on its own", () => {
    const h = setup();
    h.dock.update(snapshot({ runId: "run-a", agentName: "Flash", startedAt: h.now() }));
    h.dock.update(snapshot({ runId: "run-a", status: "done", finishedAt: h.now() }));
    // 结束这一帧必须看得见，否则 run 就是「凭空消失」。
    expect(h.lines().join("\n")).toContain("done");

    h.advance(RUN_DOCK_LINGER_MS + 1);
    h.tick();
    expect(h.dock.getRuns()).toEqual([]);
    expect(h.timerActive).toBe(false);
  });

  test("repeated polls on a finished run do not extend the linger", () => {
    const h = setup();
    h.dock.update(snapshot({ runId: "run-a", status: "done", finishedAt: h.now() }));
    h.advance(RUN_DOCK_LINGER_MS - 1000);
    h.dock.update(snapshot({ runId: "run-a", status: "done" }));
    h.advance(1001);
    h.tick();

    expect(h.dock.getRuns()).toEqual([]);
  });

  test("a run nobody updates any more is dropped instead of ticking forever", () => {
    const h = setup();
    h.dock.update(snapshot({ runId: "run-a", agentName: "Flash", startedAt: h.now() }));
    h.advance(RUN_DOCK_STALE_MS + 1);
    h.tick();

    expect(h.dock.getRuns()).toEqual([]);
    expect(h.timerActive).toBe(false);
  });

  test("the timer runs while runs exist and stops once the dock empties", () => {
    const h = setup();
    expect(h.timerActive).toBe(false);
    h.dock.update(snapshot({ runId: "run-a" }));
    expect(h.timerActive).toBe(true);

    // 年龄要自己走，不能等模型来轮询——这正是 dock 存在的理由。
    const before = h.repaints;
    h.advance(RUN_DOCK_TICK_INTERVAL_MS);
    h.tick();
    expect(h.repaints).toBeGreaterThan(before);

    h.dock.remove("run-a");
    expect(h.timerActive).toBe(false);
  });

  test("dispose stops the timer and empties the dock", () => {
    const h = setup();
    h.dock.update(snapshot({ runId: "run-a" }));
    h.dock.dispose();
    expect(h.timerActive).toBe(false);
    expect(h.dock.getRuns()).toEqual([]);
  });

  test("a late update after dispose cannot restart the timer", () => {
    const h = setup();
    h.dock.update(snapshot({ runId: "run-a" }));
    h.dock.dispose();
    // 会话已退出，但上一轮 turn 的 tool-result 迟到了。
    h.dock.update(snapshot({ runId: "run-a", status: "done" }));

    expect(h.dock.getRuns()).toEqual([]);
    expect(h.timerActive).toBe(false);
  });

  test("polling a retired run does not resurrect it", () => {
    const h = setup();
    h.dock.update(snapshot({ runId: "run-a", status: "done", finishedAt: h.now() }));
    h.advance(RUN_DOCK_LINGER_MS + 1);
    h.tick();
    expect(h.dock.getRuns()).toEqual([]);

    // 编排 agent 还在轮询这条已经结束的 run。没有退休名单的话它会以「新 run」
    // 的身份插回来，linger 重新计时，于是每 8 秒闪现一次，永远退不掉。
    h.dock.update(snapshot({ runId: "run-a", status: "done" }));
    expect(h.dock.getRuns()).toEqual([]);
    expect(h.timerActive).toBe(false);
  });

  test("a run dropped for staleness comes back if it starts reporting again", () => {
    const h = setup();
    h.dock.update(snapshot({ runId: "run-a", agentName: "Flash" }));
    h.advance(RUN_DOCK_STALE_MS + 1);
    h.tick();
    expect(h.dock.getRuns()).toEqual([]);

    // 失联 ≠ 结束：它又开始报状态了，就该重新上板。
    h.dock.update(snapshot({ runId: "run-a", agentName: "Flash" }));
    expect(h.dock.getRuns().map((r) => r.runId)).toEqual(["run-a"]);
  });

  test("pruning the last run from getLines stops the timer too", () => {
    const h = setup();
    h.dock.update(snapshot({ runId: "run-a", status: "done", finishedAt: h.now() }));
    h.advance(RUN_DOCK_LINGER_MS + 1);
    // 不走 tick，只是重绘时读了一次面板。
    expect(h.lines()).toEqual([]);
    expect(h.timerActive).toBe(false);
  });
});

describe("run dock rendering", () => {
  test("a single run keeps the two-line panel with its detail row", () => {
    const h = setup();
    h.dock.update(
      snapshot({ runId: "run-a", agentName: "Flash", lastAssistantText: "reading files" })
    );
    const lines = h.lines();
    expect(lines[0]).toContain("Sub-Agent: Flash");
    expect(lines[1]).toContain("reading files");
  });

  test("multi-run rows stay one line each", () => {
    const lines = formatRunDockLines(
      [
        snapshot({
          runId: "run-a",
          agentName: "Flash",
          startedAt: 1_000,
          toolCallCount: 24,
          lastToolNames: ["read", "edit"],
          // 单 run 形态会把它渲染成第二行；多 run 形态不该有第二行。
          lastAssistantText: "a long note that would cost a row",
        }),
        snapshot({ runId: "run-b", agentName: "Sonnet", startedAt: 1_000 }),
      ],
      false,
      64_000
    );

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("2 running");
    expect(lines[1]).toContain("Flash");
    expect(lines[1]).toContain("1m03s");
    expect(lines[1]).toContain("24 tools");
    // 只留最后一个工具名，行宽有限。
    expect(lines[1]).toContain("edit");
    expect(lines.join("\n")).not.toContain("a long note");
  });

  test("live runs keep their rows when finished ones overflow the cap", () => {
    const runs = [
      snapshot({ runId: "run-done", agentName: "Old", status: "done" }),
      snapshot({ runId: "run-a", agentName: "A" }),
      snapshot({ runId: "run-b", agentName: "B" }),
    ];
    const h = setup();
    for (const run of runs) h.dock.update(run);

    const text = h.dock.getLines(false).join("\n");
    expect(text).toContain("2 running · 1 done");
    // 排序把活跃的顶到前面，终态的排在后面。
    expect(text.indexOf("A")).toBeLessThan(text.indexOf("Old"));
  });

  test("rows past the cap collapse into a +N more line", () => {
    const lines = formatRunDockLines(
      ["a", "b", "c", "d", "e"].map((id) => snapshot({ runId: id, agentName: id })),
      false,
      0,
      3
    );
    expect(lines).toHaveLength(5); // header + 3 rows + overflow
    expect(lines[4]).toContain("+2 more");
  });

  test("a failed run names the status and the error", () => {
    const lines = formatRunDockLines(
      [
        snapshot({ runId: "run-a", agentName: "A", status: "failed", errorMessage: "boom" }),
        snapshot({ runId: "run-b", agentName: "B", status: "timeout" }),
      ],
      false,
      0
    );
    expect(lines[1]).toContain("failed");
    expect(lines[1]).toContain("boom");
    // 图标分不出 timeout 和 killed，但这两者的处理方式完全不同。
    expect(lines[2]).toContain("timeout");
  });

  test("colour and plain modes carry the same facts", () => {
    const runs = [
      snapshot({ runId: "run-a", agentName: "Flash", startedAt: 1_000, toolCallCount: 3 }),
      snapshot({
        runId: "run-b",
        agentName: "Sonnet",
        status: "done",
        startedAt: 1_000,
        finishedAt: 5_000,
      }),
    ];
    const plain = formatRunDockLines(runs, false, 9000).join("\n");
    const coloured = formatRunDockLines(runs, true, 9000)
      .join("\n")
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;]*m/g, "");
    expect(coloured).toBe(plain);
  });

  test("the in-flight action wins over the last tool, and times itself", () => {
    const lines = formatRunDockLines(
      [
        snapshot({
          runId: "run-a",
          agentName: "Flash",
          lastToolNames: ["read"],
          inFlight: { kind: "tool", name: "Edit", startedAt: 60_000 },
        }),
        snapshot({
          runId: "run-b",
          agentName: "Sonnet",
          inFlight: { kind: "llm", name: "gemini-3.6-flash", startedAt: 51_000 },
        }),
      ],
      false,
      63_000
    );

    // 计时从动作自己的起点算：卡在一个工具上 3 秒，和换了三次工具，是两回事。
    expect(lines[1]).toContain("Edit 3s");
    expect(lines[1]).not.toContain("read");
    // llm 阶段不报模型名，报它在干嘛。
    expect(lines[2]).toContain("thinking 12s");
  });

  test("a finished run shows no in-flight action", () => {
    const lines = formatRunDockLines(
      [
        snapshot({ runId: "run-a", agentName: "A", status: "done" }),
        snapshot({ runId: "run-b", agentName: "B" }),
      ].map((run) =>
        run.runId === "run-a"
          ? { ...run, inFlight: { kind: "tool" as const, name: "Edit", startedAt: 0 } }
          : run
      ),
      false,
      63_000
    );
    expect(lines.join("\n")).not.toContain("Edit");
  });

  test("a model poll does not wipe the action the registry poller just read", () => {
    const h = setup();
    h.dock.update(
      snapshot({
        runId: "run-a",
        agentName: "Flash",
        inFlight: { kind: "tool", name: "Edit", startedAt: h.now() },
      })
    );
    // controlAgentRun 的返回值里根本没有 inFlight 这个概念。
    h.dock.update(snapshot({ runId: "run-a", toolCallCount: 7 }));
    expect(h.dock.getRuns()[0]?.inFlight?.name).toBe("Edit");

    // 而轮询器明确报「它空着」时就该清掉。
    h.dock.update(snapshot({ runId: "run-a", inFlight: null }));
    expect(h.dock.getRuns()[0]?.inFlight).toBeNull();
  });

  test("an empty dock renders nothing", () => {
    const h = setup();
    expect(h.lines()).toEqual([]);
  });
});
