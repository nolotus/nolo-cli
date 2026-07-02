import { describe, expect, test } from "bun:test";

import {
  ANSI_ESCAPE_REGEX,
  appendToCurrentTurn,
  applyScrollAction,
  createFixedInput,
  createHistoryOutputStream,
  createRawInputDecoder,
  createTurnHistory,
  displayWidth,
  countPhysicalLines,
  finalizeCurrentTurn,
  padOrTruncateToWidth,
  parseScrollAction,
  renderHistory,
  splitRawInput,
  startTurn,
  stripAnsi,
  takeDisplayWidth,
  wrapTextToLines,
} from "./readlineWorkspace";
describe("displayWidth", () => {
  test("returns 0 for empty string", () => {
    expect(displayWidth("")).toBe(0);
  });

  test("counts ASCII characters as width 1", () => {
    expect(displayWidth("abc")).toBe(3);
  });

  test("counts CJK characters as width 2", () => {
    expect(displayWidth("你")).toBe(2);
    expect(displayWidth("你好")).toBe(4);
  });

  test("counts 》 as width 2", () => {
    expect(displayWidth("》")).toBe(2);
  });

  test("mixes ASCII and CJK correctly", () => {
    expect(displayWidth("you》 ")).toBe(6);
    expect(displayWidth("...》 ")).toBe(6);
  });

  test("ignores control characters but counts printable chars in escape sequences", () => {
    expect(displayWidth("\x01\x02\r")).toBe(0);
    expect(displayWidth("a\x01b")).toBe(2);
  });

  test("counts emoji and common symbols as width 2", () => {
    expect(displayWidth("📁")).toBe(2);
    expect(displayWidth("📋")).toBe(2);
    expect(displayWidth("♠")).toBe(2);
    expect(displayWidth("a📁b")).toBe(4);
  });
});

describe("countPhysicalLines", () => {
  test("single line within columns returns 1", () => {
    expect(countPhysicalLines("you》 abc", 80)).toBe(1);
  });

  test("single line that wraps returns correct physical line count", () => {
    const text = "you》 abcdefghijklmnopqrstuvwxyz0123456789";
    const width = displayWidth(text);
    expect(width).toBe(42);
    expect(countPhysicalLines(text, 20)).toBe(3);
  });

  test("multiple logical lines sum physical lines", () => {
    const text = "you》 abc\n...》 def";
    expect(countPhysicalLines(text, 80)).toBe(2);
  });

  test("multiple logical lines with wrapping", () => {
    const text = "you》 abcdefghijklmnop\n...》 xyz";
    expect(countPhysicalLines(text, 10)).toBe(4);
  });

  test("returns at least 1 for empty text", () => {
    expect(countPhysicalLines("", 80)).toBe(1);
  });

  test("line exactly filling terminal width counts as 1 physical line", () => {
    const text = "you》 a";
    expect(displayWidth(text)).toBe(7);
    expect(countPhysicalLines(text, 7)).toBe(1);
  });

  test("CJK input wraps correctly at narrow terminal width", () => {
    const text = "you》 你好世界测试";
    expect(displayWidth(text)).toBe(18);
    expect(countPhysicalLines(text, 10)).toBe(2);
  });
});

describe("createFixedInput", () => {
  test("anchors the prompt to the terminal bottom with a scroll region", () => {
    const chunks: string[] = [];
    const output = {
      isTTY: true,
      rows: 24,
      columns: 120,
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WritableStream;

    const input = createFixedInput(output, {
      getStatusLine: () => "nolo > DeepSeek V4 Flash > ~/tmp > ◫ 1.9%/1M",
    });

    input.init();
    input.repaint("");
    input.enterOutputMode("hello");

    const stdout = chunks.join("");
    expect(stdout).toContain("\x1b[1;22r");
    expect(stdout).toContain("\x1b[23;1H");
    expect(stdout).not.toContain("\x1b 7");
    expect(stdout).not.toContain("\x1b 8");
    expect(stdout).toContain("\x1b7");
    expect(stdout).toContain("DeepSeek V4 Flash");
    expect(stdout).toContain("hello");
  });

  test("positions the cursor on the input line when completions are shown", () => {
    const chunks: string[] = [];
    const output = {
      isTTY: true,
      rows: 24,
      columns: 120,
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WritableStream;

    const input = createFixedInput(output, {
      getStatusLine: () => "nolo > minimax-m3 > ~/tmp",
    });

    input.init();
    input.repaint("/a");

    const stdout = chunks.join("");
    expect(stdout).toContain("\x1b[1;21r");
    expect(stdout).toContain("\x1b[22;1H");
    expect(stdout).toContain("/agent");
    expect(stdout).toContain("/a");
    expect(stdout).toContain("\x1b[24;6G");
  });

  test("clears the input area when entering output mode", () => {
    const chunks: string[] = [];
    const output = {
      isTTY: true,
      rows: 24,
      columns: 120,
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WritableStream;

    const input = createFixedInput(output, {
      getStatusLine: () => "nolo > test",
    });

    input.init();
    input.repaint("old buffer");
    input.enterOutputMode("submitted");

    const stdout = chunks.join("");
    expect(stdout).toContain("old buffer");
    expect(stdout).toContain("\x1b[J");
    expect(stdout).toContain("submitted");
    expect(stdout).toMatch(/\x1b\[23;1H\x1b\[J\x1b\[22;1Hsubmitted\n$/);
  });
});

describe("stripAnsi", () => {
  test("removes simple color escape sequences", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
  });

  test("leaves plain text unchanged", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });

  test("removes multi-code escape sequences", () => {
    expect(stripAnsi("\x1b[1;31;40mbold\x1b[0m")).toBe("bold");
  });
});

describe("turn history", () => {
  test("createTurnHistory starts empty", () => {
    const history = createTurnHistory();
    expect(history.turns).toEqual([]);
    expect(history.currentRole).toBeNull();
    expect(history.currentContent).toBe("");
  });

  test("startTurn finalizes the previous turn", () => {
    const history = createTurnHistory();
    startTurn(history, "user");
    appendToCurrentTurn(history, "hello");
    startTurn(history, "assistant");
    expect(history.turns).toEqual([{ role: "user", content: "hello" }]);
    expect(history.currentRole).toBe("assistant");
    expect(history.currentContent).toBe("");
  });

  test("finalizeCurrentTurn pushes current content", () => {
    const history = createTurnHistory();
    startTurn(history, "assistant");
    appendToCurrentTurn(history, "world");
    finalizeCurrentTurn(history);
    expect(history.turns).toEqual([{ role: "assistant", content: "world" }]);
    expect(history.currentRole).toBeNull();
  });

  test("finalizeCurrentTurn is a no-op when no current turn", () => {
    const history = createTurnHistory();
    finalizeCurrentTurn(history);
    expect(history.turns).toEqual([]);
  });
});

describe("renderHistory", () => {
  test("renders user and assistant turns in the main area", () => {
    const chunks: string[] = [];
    const output = {
      isTTY: true,
      rows: 24,
      columns: 120,
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WritableStream;

    const history = createTurnHistory();
    history.turns.push({ role: "user", content: "hello" });
    history.turns.push({ role: "assistant", content: "hi there" });
    renderHistory(output, history, 2);

    const stdout = chunks.join("");
    expect(stdout).toContain("\x1b[1;1H");
    expect(stdout).toContain("\x1b[J");
    expect(stdout).toContain("❯ hello");
    expect(stdout).toContain("hi there");
    expect(stdout).toContain("\x1b[22;1H");
  });

  test("renders the current streaming turn", () => {
    const chunks: string[] = [];
    const output = {
      isTTY: true,
      rows: 10,
      columns: 80,
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WritableStream;

    const history = createTurnHistory();
    history.currentRole = "assistant";
    history.currentContent = "streaming...";
    renderHistory(output, history, 1);

    const stdout = chunks.join("");
    expect(stdout).toContain("streaming...");
    expect(stdout).toContain("\x1b[9;1H");
  });

  test("is a no-op for non-tty output", () => {
    const chunks: string[] = [];
    const output = {
      isTTY: false,
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WritableStream;

    const history = createTurnHistory();
    history.turns.push({ role: "user", content: "hello" });
    renderHistory(output, history, 2);

    expect(chunks).toEqual([]);
  });
});

describe("createHistoryOutputStream", () => {
  test("captures plain text into the current turn and triggers updates", () => {
    const history = createTurnHistory();
    startTurn(history, "assistant");
    let updateCount = 0;
    const stream = createHistoryOutputStream(history, () => {
      updateCount += 1;
    });

    stream.write("\x1b[32mhello\x1b[0m");
    stream.write(Buffer.from(" world"));

    expect(history.currentContent).toBe("hello world");
    expect(updateCount).toBe(2);
  });
});
describe("splitRawInput", () => {
  test("splits CJK characters into individual code points", () => {
    expect(splitRawInput("步骤")).toEqual(["步", "骤"]);
  });

  test("keeps multi-byte ANSI escape sequences intact", () => {
    expect(splitRawInput("\x1b[13;2~")).toEqual(["\x1b[13;2~"]);
    expect(splitRawInput("\x1b[27;2;13~")).toEqual(["\x1b[27;2;13~"]);
    expect(splitRawInput("\x1b\r")).toEqual(["\x1b\r"]);
  });
});

describe("createRawInputDecoder", () => {
  test("decodes Chinese split across Buffer chunks without mojibake", () => {
    const full = "请阅读 https://agent.qq.com/doc/cli-setup.md 文档，按照步骤为我安装并配置 Agent Mail CLI。";
    const fullBytes = Buffer.from(full, "utf8");
    const beforeStep = "请阅读 https://agent.qq.com/doc/cli-setup.md 文档，按照";
    const beforeStepBytes = Buffer.byteLength(beforeStep, "utf8");

    // Split right after the first byte of the "步" character (E6 AD A5).
    const chunk1 = fullBytes.subarray(0, beforeStepBytes + 1);
    const chunk2 = fullBytes.subarray(beforeStepBytes + 1);

    const tokens: string[] = [];
    const decode = createRawInputDecoder((token) => tokens.push(token));
    decode(chunk1);
    decode(chunk2);

    expect(tokens.join("")).toBe(full);
  });

  test("handles string chunks without double-encoding", () => {
    const tokens: string[] = [];
    const decode = createRawInputDecoder((token) => tokens.push(token));
    decode("hello");
    decode(" 世界");

    expect(tokens.join("")).toBe("hello 世界");
  });
});

describe("scroll-aware history", () => {
  function makeOutput(rows = 10, columns = 40) {
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
    return { output, chunks };
  }

  test("createTurnHistory starts at bottom with follow mode", () => {
    const history = createTurnHistory();
    expect(history.scrollTop).toBe(0);
    expect(history.followBottom).toBe(true);
  });

  test("wrapTextToLines wraps long lines by display width", () => {
    expect(wrapTextToLines("hello world", 5)).toEqual([
      "hello",
      " worl",
      "d",
    ]);
  });

  test("wrapTextToLines keeps empty lines", () => {
    expect(wrapTextToLines("a\n\nb", 10)).toEqual(["a", "", "b"]);
  });

  test("takeDisplayWidth never returns empty when a single char exceeds width", () => {
    const { prefix, rest } = takeDisplayWidth("你好", 1);
    expect(prefix).toBe("你");
    expect(rest).toBe("好");
  });

  test("padOrTruncateToWidth pads short text and truncates long text", () => {
    expect(padOrTruncateToWidth("hi", 5)).toBe("hi   ");
    expect(padOrTruncateToWidth("hello world", 5)).toBe("hello");
    expect(padOrTruncateToWidth("你好世界", 3)).toBe("你");
  });

  test("renderHistory shows scrollbar when history exceeds viewport", () => {
    const { output, chunks } = makeOutput(10, 40);
    const history = createTurnHistory();
    for (let i = 0; i < 20; i++) {
      history.turns.push({ role: "assistant", content: `line ${i}` });
    }
    renderHistory(output, history, 2);
    const stdout = chunks.join("");
    expect(stdout).toContain("█");
    expect(stdout).toContain("│");
  });

  test("renderHistory scrolls to follow bottom by default", () => {
    const { output, chunks } = makeOutput(10, 40);
    const history = createTurnHistory();
    for (let i = 0; i < 30; i++) {
      history.turns.push({ role: "assistant", content: `line ${i}` });
    }
    renderHistory(output, history, 2);
    const stdout = chunks.join("");
    expect(stdout).toContain("line 29");
    expect(stdout).not.toContain("line 0");
    expect(history.scrollTop).toBeGreaterThan(0);
  });

  test("renderHistory respects scrollTop when not following bottom", () => {
    const { output, chunks } = makeOutput(10, 40);
    const history = createTurnHistory();
    history.followBottom = false;
    for (let i = 0; i < 30; i++) {
      history.turns.push({ role: "assistant", content: `line ${i}` });
    }
    history.scrollTop = 2;
    renderHistory(output, history, 2);
    const stdout = chunks.join("");
    expect(stdout).toContain("line 2");
    expect(stdout).not.toContain("line 29");
  });

  test("parseScrollAction recognizes scroll keys", () => {
    expect(parseScrollAction("\x1b[5~")).toBe("page-up");
    expect(parseScrollAction("\x1b[6~")).toBe("page-down");
    expect(parseScrollAction("\x1b[5;2~")).toBe("half-page-up");
    expect(parseScrollAction("\x1b[6;5~")).toBe("half-page-down");
    expect(parseScrollAction("\x1b[H")).toBe("top");
    expect(parseScrollAction("\x1b[F")).toBe("bottom");
    expect(parseScrollAction("\x1b[1~")).toBe("top");
    expect(parseScrollAction("\x1b[4~")).toBe("bottom");
    expect(parseScrollAction("a")).toBeNull();
  });

  test("applyScrollAction moves scrollTop and disables follow bottom", () => {
    const { output } = makeOutput(10, 40);
    const history = createTurnHistory();
    history.followBottom = true;
    for (let i = 0; i < 30; i++) {
      history.turns.push({ role: "assistant", content: `line ${i}` });
    }
    applyScrollAction(history, "page-up", output, 2);
    expect(history.followBottom).toBe(false);
    expect(history.scrollTop).toBe(0);

    applyScrollAction(history, "page-down", output, 2);
    expect(history.scrollTop).toBe(8);

    applyScrollAction(history, "bottom", output, 2);
    expect(history.followBottom).toBe(true);
    expect(history.scrollTop).toBe(22);
  });

  test("splitRawInput keeps CSI scroll sequences intact", () => {
    expect(splitRawInput("\x1b[5~")).toEqual(["\x1b[5~"]);
    expect(splitRawInput("\x1b[6;2~")).toEqual(["\x1b[6;2~"]);
    expect(splitRawInput("\x1b[H")).toEqual(["\x1b[H"]);
    expect(splitRawInput("\x1b[F")).toEqual(["\x1b[F"]);
  });
});
