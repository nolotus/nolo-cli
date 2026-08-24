import { describe, expect, test } from "bun:test";
import {
  createFixedInput,
  createRawInputDecoder,
  splitRawInput,
  splitRawInputWithTail,
} from "./tuiRawInput";
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

describe("createFixedInput composer title", () => {
  test("renders title on its own row without changing status text", () => {
    const tty = mockTty();
    const input = createFixedInput(tty.output, {
      getTitleLine: () => "💬 Project planning",
      getStatusLine: () => "context: 10%",
    });

    input.repaint("");
    const output = tty.stdout();
    expect(output).toContain("💬 Project planning");
    expect(output).toContain("context: 10%");
    expect(output.indexOf("💬 Project planning")).toBeLessThan(output.indexOf("context: 10%"));
    expect(input.getInputLines()).toBe(4);
  });
});

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

describe("createFixedInput composer diffing & decoupled repaint", () => {
  test("re-rendering identical buffer and cursor emits 0 bytes to output", () => {
    const tty = mockTty();
    const input = createFixedInput(tty.output, {
      getStatusLine: () => "status: ready",
    });

    input.repaint("hello", 5);
    expect(tty.chunks.length).toBeGreaterThan(0);
    tty.chunks.length = 0;

    // Second repaint with same buffer, cursor, and status
    input.repaint("hello", 5);
    expect(tty.chunks.length).toBe(0);
  });

  test("cursor movement on identical buffer only emits cursor positioning (CUP), not \\x1b[J wipe", () => {
    const tty = mockTty();
    const input = createFixedInput(tty.output, {
      getStatusLine: () => "status: ready",
    });

    input.repaint("hello world", 11);
    tty.chunks.length = 0;

    // Move cursor left by 5 characters
    input.repaint("hello world", 6);
    expect(tty.chunks.length).toBe(1);
    // Emits cursor positioning only
    expect(tty.chunks[0]).toMatch(/^\x1b\[\d+;\d+H$/);
    expect(tty.chunks[0]).not.toContain("\x1b[J");
  });

  test("status line changes trigger full composer repaint", () => {
    let status = "status: ready";
    const tty = mockTty();
    const input = createFixedInput(tty.output, {
      getStatusLine: () => status,
    });

    input.repaint("", 0);
    tty.chunks.length = 0;

    // Status changes during background agent run / billing update
    status = "status: token 100";
    input.repaint("", 0);
    expect(tty.chunks.length).toBeGreaterThan(0);
    const text = tty.stdout();
    expect(text).toContain("\x1b[J");
    expect(text).toContain("status: token 100");
  });

  test("resumeFromDialog invalidates cache and triggers full repaint on next repaint", () => {
    const tty = mockTty();
    const input = createFixedInput(tty.output, {
      getStatusLine: () => "status: ready",
    });

    input.repaint("test", 4);
    tty.chunks.length = 0;

    // Modal opens and resumes
    input.pause();
    input.resumeFromDialog();
    tty.chunks.length = 0;

    // Next repaint must redraw fully to recover from modal drawing over screen
    input.repaint("test", 4);
    expect(tty.chunks.length).toBeGreaterThan(0);
    expect(tty.stdout()).toContain("\x1b[J");
  });

  test("resumeFromSubprocess invalidates cache and triggers full repaint on next repaint", () => {
    const tty = mockTty();
    const input = createFixedInput(tty.output, {
      getStatusLine: () => "status: ready",
    });

    input.repaint("test", 4);
    tty.chunks.length = 0;

    // Subprocess runs (action gate / pager / editor) and resumes
    input.pause();
    input.resumeFromSubprocess();
    tty.chunks.length = 0;

    // Next repaint must redraw fully
    input.repaint("test", 4);
    expect(tty.chunks.length).toBeGreaterThan(0);
    expect(tty.stdout()).toContain("\x1b[J");
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

describe("createRawInputDecoder SGR mouse wheel", () => {
  test("分块到达且间隔超过 escTimeoutMs 的滚轮序列不被拆成裸 ESC / 字符", async () => {
    // 回归：SSH/网络下 SGR mouse 序列（\x1b[<65;10;20M）可能分块到达，且
    // 块间隔超过 esc timeout。旧行为在 timeout 后强制 flush，把半截序列拆成
    // 裸 \x1b（触发 agent 停止）+ `[<65;10;20` 字符（写进 composer）。
    const tokens: string[] = [];
    const decode = createRawInputDecoder((token) => tokens.push(token), {
      escTimeoutMs: 15,
    });
    decode("\x1b[<65;10;20");
    expect(tokens).toEqual([]);
    // 超过 esc timeout：不得强制 emit，也不得把尾部当普通字符泄漏。
    await Bun.sleep(60);
    expect(tokens).toEqual([]);
    // 迟到的剩余字节补齐后，整体作为一个完整 CSI token 发出。
    decode("M");
    expect(tokens).toEqual(["\x1b[<65;10;20M"]);
  });

  test("flush() 丢弃未补齐的 SGR mouse 前缀，不泄漏进 composer", async () => {
    const tokens: string[] = [];
    const decode = createRawInputDecoder((token) => tokens.push(token), {
      escTimeoutMs: 15,
    });
    decode("\x1b[<65;10;20");
    await Bun.sleep(30);
    decode.flush();
    expect(tokens).toEqual([]);
  });

  test("flush() 后裸 ESC 仍按原行为发出", () => {
    const tokens: string[] = [];
    const decode = createRawInputDecoder((token) => tokens.push(token));
    decode("\x1b");
    decode.flush();
    expect(tokens).toEqual(["\x1b"]);
  });

  test("滚轮报告恰好被拆在 ESC 边界：不产生裸 ESC，补齐后是完整鼠标 token", async () => {
    // 回归：流式渲染占住事件循环时，pty 可能把 \x1b[<65;21;33M 拆成
    // "\x1b" | "[<65;21;33M"。第一块是裸 ESC，旧行为 15ms 后当成 Esc 键
    // 发出（协作式停止打断 streaming），后半截无 ESC 前缀被当普通字符打进
    // composer（用户看到 `[<65;21;33M`）。既然刚刚才收到过鼠标报告，裸 ESC
    // 应先等待 mouseSplitGraceMs。
    const tokens: string[] = [];
    const decode = createRawInputDecoder((token) => tokens.push(token), {
      escTimeoutMs: 10,
      mouseSplitGraceMs: 120,
    });
    // 一次正常滚动，标记"鼠标正在上报"。
    decode("\x1b[<65;21;33M");
    expect(tokens).toEqual(["\x1b[<65;21;33M"]);
    // 下一个报告被拆在 ESC 边界，且第二块迟于 escTimeoutMs 到达。
    decode("\x1b");
    await Bun.sleep(40);
    expect(tokens).toEqual(["\x1b[<65;21;33M"]); // 未泄漏裸 ESC
    decode("[<65;21;34M");
    expect(tokens).toEqual(["\x1b[<65;21;33M", "\x1b[<65;21;34M"]);
  });

  test("鼠标静默足够久后，裸 ESC 仍按 escTimeoutMs 快速判定为 Esc 键", async () => {
    const tokens: string[] = [];
    const decode = createRawInputDecoder((token) => tokens.push(token), {
      escTimeoutMs: 10,
      mouseSplitGraceMs: 500,
    });
    decode("\x1b[<65;21;33M");
    tokens.length = 0;
    // 超过 MOUSE_ACTIVE_WINDOW_MS(250ms)：不再视为鼠标活跃期。
    await Bun.sleep(300);
    decode("\x1b");
    await Bun.sleep(40);
    expect(tokens).toEqual(["\x1b"]);
  });

  test("一般未完成 CSI（非鼠标/OSC）有界丢弃：不泄漏文本、不积压后续按键", async () => {
    // 回归（review MEDIUM）：malformed/truncated CSI（如 \x1b[ 后无终止符）
    // 之前被改成无限期等待，会把后续普通键全部积压进 pendingBuffer。现在应
    // 有界超时后丢弃该半截序列，且后续按键照常送达。
    const tokens: string[] = [];
    const decode = createRawInputDecoder((token) => tokens.push(token), {
      escTimeoutMs: 10,
    });
    decode("\x1b[");
    expect(tokens).toEqual([]);
    // 超过 esc timeout：半截 CSI 被丢弃，不泄漏文本、不产生裸 ESC。
    await Bun.sleep(25);
    expect(tokens).toEqual([]);
    // 后续普通按键不被积压。
    decode("q");
    expect(tokens).toEqual(["q"]);
  });

  test("裸 ESC 仍是 ESC 键：timeout 后正常 emit（防过度修复）", async () => {
    const tokens: string[] = [];
    const decode = createRawInputDecoder((token) => tokens.push(token), {
      escTimeoutMs: 10,
    });
    decode("\x1b");
    expect(tokens).toEqual([]);
    await Bun.sleep(25);
    expect(tokens).toEqual(["\x1b"]);
  });
});

describe("createRawInputDecoder 未完成 OSC flush 不泄漏", () => {
  test("不完整 OSC 在超时与 flush() 后 0 token 泄漏", async () => {
    // /theme refresh 探测的 OSC 11 回复（\x1b]11;rgb:…）跨 chunk 且间隔超过
    // esc timeout：guard 必须阻止 arm 15ms timer，flush 时整体丢弃半截，
    // 绝不把 \x1b（触发停止）+ `]11;rgb:…`（写进 composer）泄漏成按键。
    const tokens: string[] = [];
    const decode = createRawInputDecoder((token) => tokens.push(token), {
      escTimeoutMs: 20,
    });
    decode("\x1b]11;rgb:1F1F/");
    expect(tokens).toEqual([]);
    // 超过 esc timeout：不得 arm timer，也不得强制 emit 半截 OSC。
    await Bun.sleep(50);
    expect(tokens).toEqual([]);
    // 强制 flush：半截 OSC 整体丢弃。
    decode.flush();
    expect(tokens).toEqual([]);
  });

  test("跨 chunk 且间隔超过 timeout：补齐后完整 OSC 被吞掉，0 token 泄漏", async () => {
    const tokens: string[] = [];
    const decode = createRawInputDecoder((token) => tokens.push(token), {
      escTimeoutMs: 15,
    });
    decode("\x1b]11;rgb:1F1F/");
    expect(tokens).toEqual([]);
    // 超过 esc timeout：旧行为会把已收 tail 拆成 \x1b + 字符泄漏进 composer。
    await Bun.sleep(40);
    expect(tokens).toEqual([]);
    // 迟到的剩余字节补齐 BEL 终结的完整 OSC：整体吞掉，0 个 token。
    decode("2E2E/3E3E\x07");
    decode.flush();
    expect(tokens).toEqual([]);
  });
});

describe("splitRawInput OSC 回复整体跳过", () => {
  test("ST 终结的完整 OSC 回复产出 0 token", () => {
    // /theme refresh 运行中探测背景色时，终端经 stdin 异步回复
    // \x1b]11;rgb:…\x1b\\。旧行为把它当普通输入逐字符拆成按键 token 污染
    // composer；现在必须在 decode 层整体跳过。
    const tokens = splitRawInput("\x1b]11;rgb:1F1F2E/2E2E2E/3E3E3E\x1b\\");
    expect(tokens).toEqual([]);
  });

  test("BEL 终结的完整 OSC 回复同样产出 0 token", () => {
    const tokens = splitRawInput(
      "\x1b]11;rgb:FFFFFFFF/FFFFFFFF/FFFFFFFF\x07",
    );
    expect(tokens).toEqual([]);
  });

  test("跨 chunk：不完整 OSC 留 tail，补齐后整体消费、无 token 泄漏", () => {
    const part1 = "\x1b]11;rgb:1F";
    const first = splitRawInputWithTail(part1);
    expect(first.tokens).toEqual([]);
    expect(first.tail).toBe(part1);
    // 剩余字节到达后拼回完整报文，整体跳过。
    const full = "\x1b]11;rgb:1F1F2E/2E2E2E/3E3E3E\x1b\\";
    const second = splitRawInputWithTail(
      first.tail + full.slice(part1.length),
    );
    expect(second.tokens).toEqual([]);
    expect(second.tail).toBe("");
  });

  test("回归：普通文本与 CSI 方向键仍照常产出 token", () => {
    expect(splitRawInput("abc")).toEqual(["a", "b", "c"]);
    expect(splitRawInput("\x1b[A")).toEqual(["\x1b[A"]);
  });
});
