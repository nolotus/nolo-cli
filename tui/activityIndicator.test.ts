import { describe, expect, test } from "bun:test";

import {
  ACTIVITY_FALLBACK_DELAY_MS,
  ACTIVITY_FRAMES,
  createActivityIndicator,
  formatAgentRunPanelLines,
} from "./activityIndicator";

/**
 * 确定性驱动：注入手动时钟 + 捕获 setInterval 回调，测试里手动 advance + tick，
 * 不依赖真实 timer，避免 flaky。真实环境 Date.now() 恒 > 0，这里时钟从 1000 起
 * 以避开 lastActivityAt > 0 的防御性守卫边界。
 */
function setup(opts: { turnActive?: boolean } = {}) {
  let nowMs = 1000;
  let tickCb: (() => void) | null = null;
  let timerActive = false;
  let repaints = 0;
  let turnActive = opts.turnActive ?? true;

  const indicator = createActivityIndicator({
    isTurnActive: () => turnActive,
    fallbackLabel: () => "glm-5.2 -> working",
    stoppingLabel: () => "Stopping… press Esc again to force",
    onRepaint: () => {
      repaints += 1;
    },
    now: () => nowMs,
    setIntervalFn: (cb) => {
      tickCb = cb;
      timerActive = true;
      return {};
    },
    clearIntervalFn: () => {
      tickCb = null;
      timerActive = false;
    },
  });

  return {
    indicator,
    /** 触发一次 150ms 帧（推进 frame + 跑看门狗 + 重绘）。 */
    tick: () => {
      tickCb?.();
    },
    advance: (ms: number) => {
      nowMs += ms;
    },
    setTurnActive: (v: boolean) => {
      turnActive = v;
    },
    repaints: () => repaints,
    timerActive: () => timerActive,
  };
}

describe("activityIndicator", () => {
  test("explicit label shows immediately with the first frame", () => {
    const s = setup();
    s.indicator.report("frontend -> working locally");
    expect(s.indicator.getView()).toEqual({
      frame: ACTIVITY_FRAMES[0],
      label: "frontend -> working locally",
      elapsedSec: 0,
    });
  });

  test("explicit label takes priority over the fallback and reports elapsed", () => {
    const s = setup();
    s.indicator.report("Run bun test");
    // 即使越过 fallback 阈值，explicit 标签仍在，优先显示。
    s.advance(ACTIVITY_FALLBACK_DELAY_MS + 5000);
    s.tick();
    const view = s.indicator.getView();
    expect(view?.label).toBe("Run bun test");
    expect(view?.elapsedSec).toBe(6);
  });

  test("fallback appears after a silent gap while the turn is active", () => {
    const s = setup();
    s.indicator.report("frontend -> working locally");
    // 文本开始流动 → 显式标签清空。
    s.indicator.report(null);
    expect(s.indicator.getView()).toBeNull();

    // 阈值前一帧：仍为空。
    s.advance(ACTIVITY_FALLBACK_DELAY_MS - 1);
    s.tick();
    expect(s.indicator.getView()).toBeNull();

    // 越过阈值：补上 working fallback。
    s.advance(2);
    s.tick();
    const view = s.indicator.getView();
    expect(view?.label).toBe("glm-5.2 -> working");
    expect(view?.elapsedSec).toBe(0);
  });

  test("new output clears the fallback immediately", () => {
    const s = setup();
    s.indicator.report(null);
    s.advance(ACTIVITY_FALLBACK_DELAY_MS + 100);
    s.tick();
    expect(s.indicator.getView()?.label).toBe("glm-5.2 -> working");

    // 一个新的流式 chunk 到达 → fallback 立刻消失。
    s.indicator.report(null);
    expect(s.indicator.getView()).toBeNull();
  });

  test("a tool label replaces the fallback and resets elapsed", () => {
    const s = setup();
    s.indicator.report(null);
    s.advance(ACTIVITY_FALLBACK_DELAY_MS + 100);
    s.tick();
    expect(s.indicator.getView()?.label).toBe("glm-5.2 -> working");

    s.indicator.report("Read foo.ts");
    const view = s.indicator.getView();
    expect(view?.label).toBe("Read foo.ts");
    expect(view?.elapsedSec).toBe(0);
  });

  test("no fallback when the turn is not active", () => {
    const s = setup({ turnActive: false });
    s.indicator.report(null);
    s.advance(ACTIVITY_FALLBACK_DELAY_MS + 5000);
    s.tick();
    expect(s.indicator.getView()).toBeNull();
  });

  test("fallback stops appearing once the turn ends mid-gap", () => {
    const s = setup();
    s.indicator.report(null);
    s.advance(ACTIVITY_FALLBACK_DELAY_MS + 100);
    // turn 在看门狗触发前结束。
    s.setTurnActive(false);
    s.tick();
    expect(s.indicator.getView()).toBeNull();
  });

  test("frame advances on each tick", () => {
    const s = setup();
    s.indicator.report("x");
    expect(s.indicator.getView()?.frame).toBe(ACTIVITY_FRAMES[0]);
    s.tick();
    expect(s.indicator.getView()?.frame).toBe(ACTIVITY_FRAMES[1]);
    s.tick();
    expect(s.indicator.getView()?.frame).toBe(ACTIVITY_FRAMES[2]);
  });

  test("stop clears state and the timer", () => {
    const s = setup();
    s.indicator.report("x");
    expect(s.timerActive()).toBe(true);
    s.indicator.stop();
    expect(s.indicator.getView()).toBeNull();
    expect(s.timerActive()).toBe(false);
  });

  test("report keeps a single timer running across label/null churn", () => {
    let setIntervalCalls = 0;
    let nowMs = 1000;
    const ind = createActivityIndicator({
      isTurnActive: () => true,
      fallbackLabel: () => "x -> working",
      stoppingLabel: () => "Stopping…",
      onRepaint: () => {},
      now: () => nowMs,
      setIntervalFn: (cb) => {
        setIntervalCalls += 1;
        void cb;
        return {};
      },
      clearIntervalFn: () => {},
    });
    // 多次 report（模拟流式 chunk + 工具标签切换）不应重复起 timer。
    ind.report("a");
    ind.report(null);
    ind.report("b");
    ind.report(null);
    expect(setIntervalCalls).toBe(1);
  });
});

describe("activityIndicator getView turn-end guard", () => {
  test("getView suppresses explicit label and fallback once the turn ends", () => {
    // 收尾窗口守卫：turn 结束（isTurnActive=false）后，即便 stop() 还没清状态，
    // getView 也必须返回 null，避免活动行冻结残留（abort 路径跳过 finish 的 report(null)）。
    const s = setup();
    s.indicator.report("Run bun test");
    expect(s.indicator.getView()?.label).toBe("Run bun test");
    s.setTurnActive(false);
    expect(s.indicator.getView()).toBeNull();

    // fallback 同理。
    const s2 = setup();
    s2.indicator.report(null);
    s2.advance(ACTIVITY_FALLBACK_DELAY_MS + 100);
    s2.tick();
    expect(s2.indicator.getView()?.label).toBe("glm-5.2 -> working");
    s2.setTurnActive(false);
    expect(s2.indicator.getView()).toBeNull();
  });
});

describe("activityIndicator markStopping", () => {
  test("markStopping 后 getView().label 变成停止中文案", () => {
    // 缺陷 B 即时反馈：Esc 同帧把活动行标签换成停止中文案，不等链路 unwind。
    const s = setup();
    s.indicator.report("Run bun test");
    expect(s.indicator.getView()?.label).toBe("Run bun test");

    s.indicator.markStopping();
    const view = s.indicator.getView();
    expect(view?.label).toBe("Stopping… press Esc again to force");
    expect(s.indicator.isStopping()).toBe(true);
  });

  test("markStopping 后 tick 不再推进 frame（冻结）", () => {
    const s = setup();
    s.indicator.report("x");
    const frameBefore = s.indicator.getView()?.frame;
    s.indicator.markStopping();
    s.tick();
    s.tick();
    s.tick();
    // frame 冻结在 markStopping 时的值，不随 tick 变化。
    expect(s.indicator.getView()?.frame).toBe(frameBefore);
  });

  test("markStopping 覆盖 fallback label", () => {
    const s = setup();
    s.indicator.report(null);
    s.advance(ACTIVITY_FALLBACK_DELAY_MS + 100);
    s.tick();
    expect(s.indicator.getView()?.label).toBe("glm-5.2 -> working");

    s.indicator.markStopping();
    expect(s.indicator.getView()?.label).toBe("Stopping… press Esc again to force");
  });

  test("stop 清掉停止中标志，下一轮 getView 不再显示停止中", () => {
    // 缺陷 B：stop() 必须清 stopping 标志，否则下一轮 turn 一开始就显示"停止中"。
    const s = setup();
    s.indicator.report("x");
    s.indicator.markStopping();
    expect(s.indicator.isStopping()).toBe(true);

    s.indicator.stop();
    expect(s.indicator.isStopping()).toBe(false);

    // 模拟下一轮 turn：turn 仍 active，report 一个新标签。
    s.indicator.report("new turn label");
    const view = s.indicator.getView();
    expect(view?.label).toBe("new turn label");
    expect(view?.label).not.toBe("Stopping… press Esc again to force");
  });

  test("markStopping 立即触发一次 onRepaint", () => {
    let repaints = 0;
    let nowMs = 1000;
    const ind = createActivityIndicator({
      isTurnActive: () => true,
      fallbackLabel: () => "x -> working",
      stoppingLabel: () => "Stopping…",
      onRepaint: () => {
        repaints += 1;
      },
      now: () => nowMs,
      setIntervalFn: () => ({}),
      clearIntervalFn: () => {},
    });
    ind.report("x");
    const before = repaints;
    ind.markStopping();
    expect(repaints).toBe(before + 1);
  });
});

describe("formatAgentRunPanelLines", () => {
  const base = { runId: "run-abcdef123456", agentName: "Worker", logKey: "" };

  test("a finished run renders as finished, not as still-working", () => {
    // Regression: the panel used to test for "completed"/"finished"/"success",
    // none of which the run store emits. A run that reached `done` therefore
    // kept the in-progress hourglass — the dock claimed a finished run was
    // still working, for the rest of the turn.
    const [header] = formatAgentRunPanelLines({ ...base, status: "done" }, false);
    expect(header).toContain("✓ done");
    expect(header).not.toContain("⌛");
  });

  test("terminal failure states are distinguished from running", () => {
    for (const status of ["failed", "timeout", "killed", "cancelled"]) {
      const [header] = formatAgentRunPanelLines({ ...base, status }, false);
      expect(header).not.toContain("⌛");
    }
    const [running] = formatAgentRunPanelLines({ ...base, status: "running" }, false);
    expect(running).toContain("⏳ running");
  });

  test("header carries progress and a short runId", () => {
    const [header] = formatAgentRunPanelLines(
      { ...base, status: "running", toolCallCount: 12, lastToolNames: ["readFile", "grep"] },
      false
    );
    expect(header).toContain("(ef123456)");
    expect(header).toContain("12 tools · readFile, grep");
  });

  test("the run's own words win over its log tail", () => {
    const lines = formatAgentRunPanelLines(
      {
        ...base,
        status: "running",
        lastAssistantText: "已定位到 adapter 的缓存点",
        logLines: ["DATA_CLONE_ERR: 25,"],
      },
      false
    );
    expect(lines[1]).toContain("已定位到 adapter 的缓存点");
    expect(lines[1]).not.toContain("DATA_CLONE_ERR");
  });

  test("a healthy run with nothing to say shows no detail line at all", () => {
    // The panel obeys the same rule as the cards: raw stdout is evidence on a
    // failed run and noise on a healthy one. Falling back unconditionally put
    // the withheld fragments straight back onto the dock.
    const lines = formatAgentRunPanelLines(
      { ...base, status: "running", logLines: ["step 1", "DATA_CLONE_ERR: 25,"] },
      false
    );
    expect(lines).toHaveLength(1);
    expect(lines.join("\n")).not.toContain("DATA_CLONE_ERR");
  });

  test("falls back to the log tail once the run has failed", () => {
    for (const status of ["failed", "timeout"]) {
      const lines = formatAgentRunPanelLines(
        { ...base, status, logLines: ["step 1", "step 2"] },
        false
      );
      expect(lines[1]).toContain("step 2");
    }
  });
});

describe("agent run panel age", () => {
  const base = { runId: "run-abcdef123456", agentName: "Worker", logKey: "" };

  test("a running run's age counts up from its start", () => {
    const [header] = formatAgentRunPanelLines(
      { ...base, status: "running", startedAt: 1_000_000 },
      false,
      1_000_000 + 134_000
    );
    expect(header).toContain("· 2m14s");
  });

  test("a finished run's age freezes at its end", () => {
    const [header] = formatAgentRunPanelLines(
      { ...base, status: "done", startedAt: 1_000_000, finishedAt: 1_060_000 },
      false,
      9_000_000
    );
    expect(header).toContain("· 1m00s");
  });

  test("no start time means no age, not a wrong one", () => {
    const [header] = formatAgentRunPanelLines({ ...base, status: "running" }, false, 9_000_000);
    expect(header).toContain("⏳ running");
    expect(header).not.toMatch(/\d+[smh]/);
  });
});

describe("agent run panel colour parity", () => {
  const base = { runId: "run-abcdef123456", agentName: "Worker", logKey: "" };

  // The real TUI runs with colour on. Asserting only the plain branch let the
  // live duration ship invisible in the mode users actually see.
  test("the coloured branch carries every field the plain branch does", () => {
    const snapshot = {
      ...base,
      status: "running",
      startedAt: 1_000_000,
      toolCallCount: 12,
      lastToolNames: ["readFile"],
    };
    const plain = formatAgentRunPanelLines(snapshot, false, 1_134_000).join("\n");
    const coloured = formatAgentRunPanelLines(snapshot, true, 1_134_000)
      .join("\n")
      .replace(/\x1b\[[0-9;]*m/g, "");

    for (const token of ["Worker", "ef123456", "running", "2m14s", "12 tools", "readFile"]) {
      expect(plain).toContain(token);
      expect(coloured).toContain(token);
    }
  });
});
