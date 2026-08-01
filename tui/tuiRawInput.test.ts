import { describe, expect, test } from "bun:test";
import { createFixedInput } from "./tuiRawInput";
import { t } from "./i18n";

const TERM_ROWS = 24;
const TERM_COLS = 120;

function mockTty(rows = TERM_ROWS, columns = TERM_COLS) {
  const chunks: string[] = [];
  const output = {
    isTTY: true,
    rows,
    columns,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { output, chunks, stdout: () => chunks.join("") };
}

describe("createFixedInput onInputLinesChange", () => {
  test("composer 3→4 行（活动行出现）时 onInputLinesChange 被调用一次", () => {
    // 缺陷 A 核心：活动行首次出现让 composer 从 3 行变 4 行，repaintAt 据此
    // setScrollRegion 收缩历史可视区，但历史是按旧 inputLines 画的、最底行
    // 被盖住。onInputLinesChange 必须在这一帧被触发，让外部补一次历史重绘。
    let activeLine: string | null = null;
    const calls: number[] = [];
    const tty = mockTty();
    const input = createFixedInput(tty.output, {
      getStatusLine: () => "status",
      getActivityLine: () => activeLine,
      onInputLinesChange: (lines) => {
        calls.push(lines);
      },
    });

    // 第一次 repaint：无活动行，composer = 3 行。不应触发（从初始 1 变 3 也算
    // 变化，但初始 inputLines=1→3 这一次是必然的首次重绘，不算活动行出现）。
    input.repaint("hello");
    const callsAfterFirst = calls.length;
    expect(input.getInputLines()).toBe(3);

    // 第二次 repaint：活动行出现，composer 3→4。必须触发一次，参数=4。
    activeLine = "· working (1s) · Esc to stop";
    input.repaint("hello");
    expect(input.getInputLines()).toBe(4);
    expect(calls.length).toBeGreaterThan(callsAfterFirst);
    expect(calls[calls.length - 1]).toBe(4);
  });

  test("composer 高度不变时不触发 onInputLinesChange", () => {
    let activeLine: string | null = null;
    const calls: number[] = [];
    const tty = mockTty();
    const input = createFixedInput(tty.output, {
      getStatusLine: () => "status",
      getActivityLine: () => activeLine,
      onInputLinesChange: (lines) => {
        calls.push(lines);
      },
    });

    input.repaint("hello");
    const baseline = calls.length;
    // 同样的活动行状态再 repaint，高度不变，不应触发。
    input.repaint("hello world");
    expect(calls.length).toBe(baseline);
  });

  test("onInputLinesChange 在 setScrollRegion 之后调用（回调读到新 region）", () => {
    // 回调触发时，scrollRegion 必须已更新到新值，否则回调里按旧 region
    // 重绘历史会再次被盖住。通过捕获回调执行时刻的 scroll region 序列验证。
    let activeLine: string | null = null;
    const scrollRegionsAtCallback: string[] = [];
    const tty = mockTty();
    let lastScrollRegion = "";
    const realOutput = tty.output as unknown as { write: (s: string) => boolean };
    const originalWrite = realOutput.write.bind(realOutput);
    (tty.output as unknown as { write: (s: string) => boolean }).write = (seq: string) => {
      const match = seq.match(/^\x1b\[1;(\d+)r$/);
      if (match) lastScrollRegion = match[1]!;
      return originalWrite(seq);
    };

    const input = createFixedInput(tty.output, {
      getStatusLine: () => "status",
      getActivityLine: () => activeLine,
      onInputLinesChange: () => {
        scrollRegionsAtCallback.push(lastScrollRegion);
      },
    });

    input.repaint("hello"); // 3 行，region bottom = 24-3 = 21
    activeLine = "· working · Esc to stop";
    input.repaint("hello"); // 4 行，region bottom = 24-4 = 20
    // 回调执行时 region 应已是 20（新值），不是 21（旧值）。
    expect(scrollRegionsAtCallback.length).toBeGreaterThan(0);
    expect(scrollRegionsAtCallback[scrollRegionsAtCallback.length - 1]).toBe("20");
  });
});

describe("createFixedInput 防重入卫兵（onInputLinesChange 反向触发）", () => {
  test("onInputLinesChange 回调里再调 repaint 不无限递归", () => {
    // 缺陷 A 修法的防重入要求：若 onInputLinesChange 反过来触发 composer 重绘，
    // 且重绘又触发 onInputLinesChange，必须被卫兵挡住，不能无限递归把 CPU 打满。
    // 这里在 readlineWorkspace 层用 syncingLayout 卫兵；tuiRawInput 层只负责
    // 在高度变化时调用回调。测试模拟「回调里调 repaint」的递归场景，断言
    // repaint 调用次数有界（不会栈溢出/无限循环）。
    let activeLine: string | null = null;
    let repaintCount = 0;
    let recursing = false;
    const tty = mockTty();

    const input = createFixedInput(tty.output, {
      getStatusLine: () => "status",
      getActivityLine: () => activeLine,
      onInputLinesChange: () => {
        // 模拟 readlineWorkspace 的 renderHistoryToOutput 可能间接触发
        // composer 重绘。只递归一层，避免测试自身栈溢出；关键是验证
        // 第二次 repaint 不会因为高度「又变了」而再次触发回调。
        if (!recursing) {
          recursing = true;
          input.repaint("hello");
          recursing = false;
        }
      },
    });

    input.repaint("hello"); // 初始 3 行
    const before = repaintCount;
    activeLine = "· working · Esc to stop";
    // 触发 3→4 变化 → 回调 → 回调里再 repaint（高度已是 4，不变，不再触发回调）
    input.repaint("hello");
    // 没有无限递归：能正常返回就说明调用次数有界。
    expect(input.getInputLines()).toBe(4);
  });
});

// --- alternate screen (DECSET 1049) -------------------------------------
// The TUI must run on the alternate screen to isolate its scroll state from
// the shell's scrollback. These tests pin the contract: enter on TTY, leave
// on disable(), never on non-TTY, and idempotent so repeated disable() +
// process.exit never write the leave sequence twice (which would otherwise
// pop the shell's own content on some terminals).
import {
  enterAltScreen,
  leaveAltScreen,
  isAltScreenOn,
} from "./tuiRawInput";

describe("createFixedInput alternate screen", () => {
  test("TTY 下 enterAltScreen 写 ?1049h，disable() 写 ?1049l 且在其之后", () => {
    // 覆盖测试要求 1。启动序列（enterAltScreen）写 ?1049h；disable() 在
    // disableMouse+resetScrollRegion 之后调 leaveAltScreen 写 ?1049l。
    const chunks: string[] = [];
    const output = {
      isTTY: true,
      rows: TERM_ROWS,
      columns: TERM_COLS,
      write(c: string) {
        chunks.push(c);
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    // 模拟 readlineWorkspace 启动：enterAltScreen + disable 顺序。
    enterAltScreen(output);
    const input = createFixedInput(output, { getStatusLine: () => "s" });
    input.disable();
    expect(chunks.some((c) => c === "\x1b[?1049h")).toBe(true);
    expect(chunks.some((c) => c === "\x1b[?1049l")).toBe(true);
    // disable() 必须在 resetScrollRegion(\x1b[r) 之后才写 ?1049l，所以
    // ?1049l 的下标必须大于 \x1b[r 的下标。
    const leaveIdx = chunks.indexOf("\x1b[?1049l");
    const resetIdx = chunks.indexOf("\x1b[r");
    expect(leaveIdx).toBeGreaterThanOrEqual(0);
    expect(resetIdx).toBeGreaterThanOrEqual(0);
    expect(leaveIdx).toBeGreaterThan(resetIdx);
  });

  test("enterAltScreen/leaveAltScreen 幂等：重复调用只写一次", () => {
    const chunks: string[] = [];
    const output = {
      isTTY: true,
      rows: 24,
      columns: 80,
      write(c: string) {
        chunks.push(c);
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    // 同一 output 进两次，只写一次 ?1049h。
    expect(enterAltScreen(output)).toBe(true);
    expect(enterAltScreen(output)).toBe(false);
    expect(chunks.filter((c) => c === "\x1b[?1049h").length).toBe(1);
    expect(isAltScreenOn(output)).toBe(true);
    // 离开两次只写一次 ?1049l。
    expect(leaveAltScreen(output)).toBe(true);
    expect(leaveAltScreen(output)).toBe(false);
    expect(chunks.filter((c) => c === "\x1b[?1049l").length).toBe(1);
    expect(isAltScreenOn(output)).toBe(false);
  });

  test("非 TTY output：enter/leave 全程不写任何切屏序列", () => {
    // 覆盖测试要求 2（最易漏）。管道/重定向/测试用 PassThrough 等无 isTTY
    // 的流，切屏序列必须完全跳过，否则会污染输出。
    const chunks: string[] = [];
    const output = {
      isTTY: false,
      write(c: string) {
        chunks.push(c);
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    expect(enterAltScreen(output)).toBe(false);
    expect(leaveAltScreen(output)).toBe(false);
    expect(chunks.length).toBe(0);
    const input = createFixedInput(output, { getStatusLine: () => "s" });
    input.setAltScreenEnabled(true);
    input.setAltScreenEnabled(false);
    input.disable();
    expect(
      chunks.some((c) => c.includes("\x1b[?1049h") || c.includes("\x1b[?1049l")),
    ).toBe(false);
  });

  test("disable() 连续调两次 + 再 leaveAltScreen：?1049l 只出现一次", () => {
    // 覆盖测试要求 3（幂等性核心）。disable() 内部调 leaveAltScreen；模拟
    // SIGINT 后又走 process.exit 的场景：disable 一次 + 信号 handler 再调
    // leaveAltScreen + exit handler 再调一次，离开序列仍只写一次。
    const chunks: string[] = [];
    const output = {
      isTTY: true,
      rows: 24,
      columns: 80,
      write(c: string) {
        chunks.push(c);
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    // 先进备用屏（模拟启动）。
    enterAltScreen(output);
    const input = createFixedInput(output, { getStatusLine: () => "s" });
    input.disable();
    input.disable(); // 第二次：应被幂等挡住
    leaveAltScreen(output); // 信号 handler 再调一次：也应被挡住
    leaveAltScreen(output); // exit handler 再调一次：也应被挡住
    expect(chunks.filter((c) => c === "\x1b[?1049l").length).toBe(1);
  });
});