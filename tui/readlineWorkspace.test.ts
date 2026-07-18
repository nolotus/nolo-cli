import { describe, expect, test } from "bun:test";

import {
  ANSI_ESCAPE_REGEX,
  appendToCurrentTurn,
  applyScrollAction,
  applyTerminalOutputToText,
  createFixedInput,
  createHistoryOutputStream,
  createRawInputDecoder,
  createTurnHistory,
  displayWidth,
  countPhysicalLines,
  finalizeCurrentTurn,
  fitAnsiLine,
  padOrTruncateToWidth,
  parseScrollAction,
  renderHistory,
  splitRawInput,
  startTurn,
  stripAnsi,
  takeDisplayWidth,
  truncateAnsi,
  visibleWidth,
  wrapTextToLines,
  wrapTranscriptLine,
} from "./readlineWorkspace";
import { t } from "./i18n";

const TERM_ROWS = 24;
const TERM_COLS = 120;
/** Empty OMP composer: top rule + status + input + bottom rule. */
const EMPTY_COMPOSER_LINES = 4;
/** With slash completions: completion + top + status + input + bottom. */
const COMPLETION_COMPOSER_LINES = 5;
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

  test("counts the ❯ prompt ornament as width 1", () => {
    expect(displayWidth("❯")).toBe(1);
    expect(displayWidth("❯ ")).toBe(2);
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

describe("createFixedInput", () => {
  test("anchors an OMP-style composer to the terminal bottom", () => {
    const tty = mockTty();
    const input = createFixedInput(tty.output, {
      getStatusLine: () => "nolo > DeepSeek V4 Flash > ~/tmp > ◫ 1.9%/1M",
    });

    input.init();
    input.repaint("");
    expect(input.getInputLines()).toBe(EMPTY_COMPOSER_LINES);
    // enterOutputMode keeps the dock; submitted text is owned by history.
    input.enterOutputMode("hello");

    const lines = input.getInputLines();
    const scrollEnd = TERM_ROWS - lines;
    const composerStart = scrollEnd + 1;
    const stdout = tty.stdout();
    expect(stdout).toContain(`\x1b[1;${scrollEnd}r`);
    expect(stdout).toContain(`\x1b[${composerStart};1H`);
    expect(stdout).not.toContain("\x1b 7");
    expect(stdout).not.toContain("\x1b 8");
    expect(stdout).toContain("\x1b7");
    expect(stdout).toContain("DeepSeek V4 Flash");
    expect(stdout).toContain(t("placeholder").slice(0, 12));
    expect(stdout).toContain("─");
    expect(stdout).not.toContain("╭");
    expect(stdout).not.toContain("╰");
  });

  test("positions the cursor on the input line when completions are shown", () => {
    const tty = mockTty();
    const input = createFixedInput(tty.output, {
      getStatusLine: () => "nolo > minimax-m3 > ~/tmp",
    });

    input.init();
    input.repaint("/a");

    expect(input.getInputLines()).toBe(COMPLETION_COMPOSER_LINES);
    const lines = input.getInputLines();
    const scrollEnd = TERM_ROWS - lines;
    const composerStart = scrollEnd + 1;
    // completion + top rule + status = 3 header rows before the input row
    const headerRows = 3;
    const promptWidth = displayWidth(t("promptLabel"));
    const cursorCol0 = promptWidth + displayWidth("/a");
    const cursorRow1 = composerStart + headerRows;
    const cursorCol1 = cursorCol0 + 1;

    const stdout = tty.stdout();
    expect(stdout).toContain(`\x1b[1;${scrollEnd}r`);
    expect(stdout).toContain(`\x1b[${composerStart};1H`);
    expect(stdout).toContain("/agent");
    expect(stdout).toContain("/a");
    expect(stdout).toContain(`\x1b[${cursorRow1};${cursorCol1}H`);
  });

  test("keeps the docked composer when entering output mode", () => {
    const tty = mockTty();
    const input = createFixedInput(tty.output, {
      getStatusLine: () => "nolo > test",
    });

    input.init();
    input.repaint("old buffer");
    input.enterOutputMode("submitted");

    const stdout = tty.stdout();
    expect(stdout).toContain("old buffer");
    expect(stdout).toContain("nolo > test");
    expect(stdout).toContain("─");
    expect(input.getInputLines()).toBe(EMPTY_COMPOSER_LINES);
  });

  test("enables wheel reporting on init and disables it on pause/disable", () => {
    const tty = mockTty();
    const input = createFixedInput(tty.output, {
      getStatusLine: () => "nolo > test",
    });

    input.init();
    expect(tty.stdout()).toContain("\x1b[?1006h\x1b[?1000h");

    input.pause();
    expect(tty.stdout()).toContain("\x1b[?1000l\x1b[?1006l");

    input.resumeFromDialog();
    expect(tty.stdout()).toContain("\x1b[?1006h\x1b[?1000h");

    input.disable();
    const disabled = tty.stdout();
    expect(disabled.lastIndexOf("\x1b[?1000l\x1b[?1006l")).toBeGreaterThan(
      disabled.lastIndexOf("\x1b[?1006h\x1b[?1000h")
    );
  });

  test("truncates a long status line instead of wrapping and breaking the composer", () => {
    const tty = mockTty(TERM_ROWS, 40);
    const longStatus =
      "nolo > ⬢ minimax-m3 · local > 📁 ~/very/long/path/to/bun-nolo > ⑂ main *99 > ◫ 0.4%/1M";
    const input = createFixedInput(tty.output, {
      getStatusLine: () => longStatus,
    });
    input.repaint("");

    expect(tty.stdout()).toContain("…");
    expect(input.getInputLines()).toBe(EMPTY_COMPOSER_LINES);
  });

  test("does not crash on a 1-column terminal", () => {
    const tty = mockTty(TERM_ROWS, 1);
    const input = createFixedInput(tty.output, {
      getStatusLine: () => "nolo > agent > path",
    });
    expect(() => {
      input.init();
      input.repaint("hi");
      input.enterOutputMode("hi");
    }).not.toThrow();
    expect(input.getInputLines()).toBeGreaterThan(0);
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

  test("removes cursor visibility and erase-line sequences used by Spinner", () => {
    expect(stripAnsi("\x1b[?25lready\x1b[?25h")).toBe("ready");
    expect(stripAnsi("\r\x1b[K")).toBe("\r");
    expect(stripAnsi("\x1b[?25l")).toBe("");
    expect("\x1b[?25l".replace(ANSI_ESCAPE_REGEX, "")).toBe("");
  });

  test("strips private-mode and intermediate-byte CSI sequences", () => {
    // bracketed paste enable + secondary DA (intermediate `>`)
    expect(stripAnsi("a\x1b[?2004hb\x1b[>0cc")).toBe("abc");
    // mouse tracking private mode; final byte is `h`, trailing `y` is plain text
    expect(stripAnsi("x\x1b[?1000;1006;1015hy")).toBe("xy");
  });
});

describe("truncateAnsi / fitAnsiLine / visibleWidth", () => {
  test("visibleWidth ignores ANSI color codes", () => {
    expect(visibleWidth("\x1b[31mhi\x1b[0m")).toBe(2);
    expect(visibleWidth("你好")).toBe(4);
  });

  test("truncateAnsi preserves CSI and appends reset when cut", () => {
    const colored = "\x1b[36mabcdef\x1b[39m";
    const cut = truncateAnsi(colored, 3);
    expect(visibleWidth(cut)).toBe(3);
    expect(cut.startsWith("\x1b[36m")).toBe(true);
    expect(cut.endsWith("\x1b[0m")).toBe(true);
    expect(stripAnsi(cut)).toBe("abc");
  });

  test("truncateAnsi keeps a CSI that sits past the cut boundary intact as prefix only", () => {
    // Color open, then three letters — cut at 2 keeps open CSI + ab + reset
    const cut = truncateAnsi("\x1b[32mxyz\x1b[0m", 2);
    expect(stripAnsi(cut)).toBe("xy");
    expect(cut.includes("\x1b[32m")).toBe(true);
  });

  test("fitAnsiLine appends single-width ellipsis by default", () => {
    expect(fitAnsiLine("abcdefghij", 5)).toBe("abcd…");
    expect(visibleWidth(fitAnsiLine("abcdefghij", 5))).toBe(5);
  });

  test("fitAnsiLine with double-width ellipsis does not overflow width", () => {
    // U+22EF midline horizontal ellipsis is typically width 1 or 2 depending on
    // font; force a known double-width marker (CJK fullwidth ellipsis U+2026 is 1,
    // use "……" or a CJK char). Use "…" width check + a wide fallback "口".
    const wide = "口"; // CJK, displayWidth 2
    expect(displayWidth(wide)).toBe(2);
    const fitted = fitAnsiLine("abcdefghij", 1, wide);
    expect(visibleWidth(fitted)).toBeLessThanOrEqual(1);
    const fitted2 = fitAnsiLine("abcdefghij", 2, wide);
    expect(visibleWidth(fitted2)).toBeLessThanOrEqual(2);
  });
});

describe("applyTerminalOutputToText", () => {
  test("appends plain text", () => {
    expect(applyTerminalOutputToText("hello", " world")).toBe("hello world");
  });

  test("\\r rewinds to the start of the current line", () => {
    expect(applyTerminalOutputToText("old status", "\rnew status")).toBe("new status");
    expect(
      applyTerminalOutputToText("kept\nold status", "\rnew status")
    ).toBe("kept\nnew status");
  });

  test("spinner frames collapse to a single status line then clear", () => {
    let text = "";
    text = applyTerminalOutputToText(text, "\x1b[?25l\x1b[36m⠋\x1b[39m agent -> working locally (0s)");
    text = applyTerminalOutputToText(
      text,
      "\r\x1b[36m⠙\x1b[39m agent -> working locally (0s)"
    );
    text = applyTerminalOutputToText(
      text,
      "\r\x1b[36m⠹\x1b[39m agent -> working locally (1s)"
    );
    expect(text).toBe("\x1b[36m⠹\x1b[39m agent -> working locally (1s)");
    expect(stripAnsi(text)).toBe("⠹ agent -> working locally (1s)");
    text = applyTerminalOutputToText(text, "\r\x1b[K\x1b[?25h");
    expect(text).toBe("");
  });

  test("keeps SGR color codes but strips cursor and erase sequences", () => {
    const text = applyTerminalOutputToText(
      "",
      "\x1b[?25l\x1b[2mdim tool line\x1b[0m\x1b[3;1H\x1b[2Kplain"
    );
    expect(text).toBe("\x1b[2mdim tool line\x1b[0mplain");
  });

  test("real assistant text still appends after a cleared spinner line", () => {
    let text = applyTerminalOutputToText("", "⠋ agent -> working locally (0s)");
    text = applyTerminalOutputToText(text, "\r\x1b[K");
    text = applyTerminalOutputToText(text, "\nagent > hello");
    expect(text).toBe("\nagent > hello");
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
    // Per-row clear (EL) only — full-screen ED would wipe the docked composer.
    expect(stdout).toContain("\x1b[1;1H");
    expect(stdout).toContain("\x1b[2K");
    expect(stdout).not.toContain("\x1b[J");
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

    // SGR color codes survive into the transcript (the renderer is ANSI-aware).
    expect(history.currentContent).toBe("\x1b[32mhello\x1b[0m world");
    expect(stripAnsi(history.currentContent)).toBe("hello world");
    expect(updateCount).toBe(2);
  });

  test("collapses spinner \\r frames instead of appending a wall of status lines", () => {
    const history = createTurnHistory();
    startTurn(history, "assistant");
    let updateCount = 0;
    const stream = createHistoryOutputStream(history, () => {
      updateCount += 1;
    });

    stream.write("\x1b[?25l\x1b[36m⠋\x1b[39m minimax-m3 -> working locally (0s)");
    stream.write("\r\x1b[36m⠙\x1b[39m minimax-m3 -> working locally (0s)");
    stream.write("\r\x1b[36m⠹\x1b[39m minimax-m3 -> working locally (1s)");
    stream.write("\r\x1b[36m⠸\x1b[39m minimax-m3 -> working locally (2s)");
    expect(stripAnsi(history.currentContent)).toBe("⠸ minimax-m3 -> working locally (2s)");
    expect(history.currentContent.match(/working locally/g)?.length).toBe(1);

    stream.write("\r\x1b[K\x1b[?25h");
    expect(history.currentContent).toBe("");

    stream.write("\nminimax-m3 > 你好");
    expect(history.currentContent).toBe("\nminimax-m3 > 你好");
    expect(updateCount).toBeGreaterThanOrEqual(5);
  });

  test("no-ops update when a chunk has only stripped control sequences", () => {
    const history = createTurnHistory();
    startTurn(history, "assistant");
    history.currentContent = "stable";
    let updateCount = 0;
    const stream = createHistoryOutputStream(history, () => {
      updateCount += 1;
    });

    stream.write("\x1b[?25l\x1b[?25h");
    expect(history.currentContent).toBe("stable");
    expect(updateCount).toBe(0);
  });

  test("final transcript after spinner stop has no bare \\r and one status collapse", () => {
    // Mirrors a Spinner writing into the history stream (isTTY virtual).
    const history = createTurnHistory();
    startTurn(history, "assistant");
    const stream = createHistoryOutputStream(history, () => {});

    stream.write("\x1b[?25l\x1b[36m⠋\x1b[39m agent -> working locally (0s)");
    for (let i = 0; i < 12; i += 1) {
      stream.write(`\r\x1b[36m⠙\x1b[39m agent -> working locally (${i % 3}s)`);
    }
    stream.write("\r\x1b[K\x1b[?25h");
    stream.write("\nagent > final answer");

    expect(history.currentContent.includes("\r")).toBe(false);
    expect(history.currentContent.match(/working locally/g)).toBeNull();
    expect(history.currentContent).toBe("\nagent > final answer");
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

  test("padOrTruncateToWidth measures ANSI text by visible width", () => {
    const styled = "\x1b[2mhi\x1b[0m";
    expect(padOrTruncateToWidth(styled, 4)).toBe(`${styled}  `);
    const long = "\x1b[31mhello world\x1b[0m";
    const cut = padOrTruncateToWidth(long, 5);
    expect(stripAnsi(cut)).toBe("hello");
    expect(cut.endsWith("\x1b[0m")).toBe(true);
  });

  test("wrapTranscriptLine breaks latin text at word boundaries", () => {
    expect(wrapTranscriptLine("hello brave world", 11)).toEqual([
      "hello brave",
      "world",
    ]);
    expect(wrapTranscriptLine("aaa bbbb", 6)).toEqual(["aaa ", "bbbb"]);
  });

  test("wrapTranscriptLine hard-breaks words longer than the row", () => {
    expect(wrapTranscriptLine("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  test("wrapTranscriptLine wraps CJK anywhere by display width", () => {
    expect(wrapTranscriptLine("你好世界", 4)).toEqual(["你好", "世界"]);
  });

  test("wrapTranscriptLine keeps style on continuation rows without bleeding", () => {
    const wrapped = wrapTranscriptLine("\x1b[2mhello brave world\x1b[0m", 11);
    expect(wrapped).toHaveLength(2);
    expect(wrapped[0].startsWith("\x1b[2m")).toBe(true);
    expect(wrapped[0].endsWith("\x1b[0m")).toBe(true);
    expect(wrapped[1].startsWith("\x1b[2m")).toBe(true);
    expect(wrapped[1].endsWith("\x1b[0m")).toBe(true);
    expect(wrapped.map((line) => stripAnsi(line))).toEqual([
      "hello brave",
      "world",
    ]);
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

  test("parseScrollAction recognizes SGR mouse wheel events", () => {
    expect(parseScrollAction("\x1b[<64;10;5M")).toBe("wheel-up");
    expect(parseScrollAction("\x1b[<65;10;5M")).toBe("wheel-down");
    // modifier bits (shift=4, meta=8, ctrl=16) keep the wheel mapping
    expect(parseScrollAction("\x1b[<68;10;5M")).toBe("wheel-up");
    expect(parseScrollAction("\x1b[<81;10;5M")).toBe("wheel-down");
    // horizontal wheel and plain clicks are not scroll actions
    expect(parseScrollAction("\x1b[<66;10;5M")).toBeNull();
    expect(parseScrollAction("\x1b[<67;10;5M")).toBeNull();
    expect(parseScrollAction("\x1b[<0;10;5M")).toBeNull();
    expect(parseScrollAction("\x1b[<0;10;5m")).toBeNull();
  });

  test("applyScrollAction scrolls by wheel lines and refollows at bottom", () => {
    const { output } = makeOutput(10, 40);
    const history = createTurnHistory();
    for (let i = 0; i < 30; i++) {
      history.turns.push({ role: "assistant", content: `line ${i}` });
    }
    history.scrollTop = 10;
    history.followBottom = false;

    applyScrollAction(history, "wheel-up", output, 2);
    expect(history.scrollTop).toBe(7);
    expect(history.followBottom).toBe(false);

    applyScrollAction(history, "wheel-down", output, 2);
    expect(history.scrollTop).toBe(10);
    expect(history.followBottom).toBe(false);

    // Reaching the bottom via the wheel resumes live-tail. 30 assistant
    // turns render as 59 lines (blank separators), viewport 8 → max 51.
    history.scrollTop = 50;
    applyScrollAction(history, "wheel-down", output, 2);
    expect(history.scrollTop).toBe(51);
    expect(history.followBottom).toBe(true);
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
    // 59 transcript lines (30 turns + blank separators) - 8 visible = 51.
    expect(history.scrollTop).toBe(51);
  });

  test("splitRawInput keeps CSI scroll sequences intact", () => {
    expect(splitRawInput("\x1b[5~")).toEqual(["\x1b[5~"]);
    expect(splitRawInput("\x1b[6;2~")).toEqual(["\x1b[6;2~"]);
    expect(splitRawInput("\x1b[H")).toEqual(["\x1b[H"]);
    expect(splitRawInput("\x1b[F")).toEqual(["\x1b[F"]);
  });

  test("splitRawInput keeps SGR mouse wheel sequences intact", () => {
    expect(splitRawInput("\x1b[<64;35;10M")).toEqual(["\x1b[<64;35;10M"]);
    expect(splitRawInput("\x1b[<65;1;1M")).toEqual(["\x1b[<65;1;1M"]);
  });
});
