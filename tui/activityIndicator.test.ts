import { describe, expect, test } from "bun:test";

import {
  ACTIVITY_FALLBACK_DELAY_MS,
  ACTIVITY_FRAMES,
  createActivityIndicator,
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
