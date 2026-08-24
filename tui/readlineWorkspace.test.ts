import { describe, expect, test } from "bun:test";

// Hermetic: never spawn real git for the status chip in workspace tests.
// refreshGitStatus falls back to process.env per key because tests pass env: {}.
process.env.NOLO_CLI_GIT_STATUS ??= "0";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { spawn } from "bun";
import { join } from "node:path";

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
  enterAltScreen,
  finalizeCurrentTurn,
  fitAnsiLine,
  installAltScreenRestoreHandlers,
  padOrTruncateToWidth,
  parseScrollAction,
  renderHistory,
  renderPinnedAgentNotice,
  splitRawInput,
  startTurn,
  startTuiWorkspace,
  stripAnsi,
  takeDisplayWidth,
  truncateAnsi,
  visibleWidth,
  wrapTextToLines,
  wrapTranscriptLine,
} from "./readlineWorkspace";
import { getCliLocale, setCliLocale, t } from "./i18n";
import type { ListedDialog } from "../dialogCommands";
import type { DialogHistoryTurn } from "./dialogPicker";

const TERM_ROWS = 24;
const TERM_COLS = 120;
/** Empty OMP composer: top rule + status + input. */
const EMPTY_COMPOSER_LINES = 3;
/** With slash completions: completion + top + status + input. */
const COMPLETION_COMPOSER_LINES = 4;
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

  test("counts the 🏔 status-line icon as width 2", () => {
    expect(displayWidth("🏔")).toBe(2);
    expect(displayWidth("🏔 minimax-m3")).toBe(13); // 2 + " minimax-m3" (11)
  });

  test("counts CJK quotation marks as width 2 in zh locale", () => {
    const prev = getCliLocale();
    setCliLocale("zh");
    try {
      expect(displayWidth("“”")).toBe(4);
      expect(displayWidth("‘’")).toBe(4);
      // mixed CJK + ASCII: “你好”a => 2+2+2+2+1 = 9
      expect(displayWidth("“你好”a")).toBe(9);
    } finally {
      setCliLocale(prev);
    }
  });

  test("counts CJK quotation marks as width 1 in en locale", () => {
    const prev = getCliLocale();
    setCliLocale("en");
    try {
      expect(displayWidth("“”")).toBe(2);
      expect(displayWidth("‘’")).toBe(2);
    } finally {
      setCliLocale(prev);
    }
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
  test("bottom rule is removed so the last section is not a divider line", () => {
    const tty = mockTty();
    const input = createFixedInput(tty.output, {
      getStatusLine: () => "status",
    });
    input.repaint("");
    const stdout = tty.stdout();
    // Splitting by newline from repaint stdout or checking last section content
    const renderedLines = stdout.split("\n");
    const lastLine = renderedLines[renderedLines.length - 1] ?? "";
    const isFullRule = lastLine.replace(/\x1b\[[0-9;]*m/g, "").replace(/─/g, "").length === 0 && lastLine.includes("─");
    expect(isFullRule).toBe(false);
  });

  test("empty buffer positions cursor on placeholder row (headerRows)", () => {
    const tty = mockTty();
    const input = createFixedInput(tty.output, {
      getStatusLine: () => "status",
    });
    input.repaint("");
    // headerRows is 2 for empty input (top rule + status)
    // composerStart is TERM_ROWS - EMPTY_COMPOSER_LINES + 1 = 24 - 3 + 1 = 22
    // headerRows = 2, cursorRow = composerStart + headerRows = 24
    const composerStart = TERM_ROWS - EMPTY_COMPOSER_LINES + 1;
    const headerRows = 2;
    const expectedCursorRow = composerStart + headerRows;
    const promptWidth = displayWidth(t("promptLabel"));
    const expectedCursorCol = promptWidth + 1;
    expect(tty.stdout()).toContain(`\x1b[${expectedCursorRow};${expectedCursorCol}H`);
  });

  test("activity line increases cursorRow and lines count by 1", () => {
    let activeLine: string | null = null;
    const tty1 = mockTty();
    const input1 = createFixedInput(tty1.output, {
      getStatusLine: () => "status",
      getActivityLine: () => activeLine,
    });
    input1.repaint("hello");
    const lines1 = input1.getInputLines();

    activeLine = "· thinking (2s) · Esc to stop";
    const tty2 = mockTty();
    const input2 = createFixedInput(tty2.output, {
      getStatusLine: () => "status",
      getActivityLine: () => activeLine,
    });
    input2.repaint("hello");
    const lines2 = input2.getInputLines();

    expect(lines2 - lines1).toBe(1);

    // Parse cursor row positions relative to composer top (startRow)
    const getCursorRowAbsolute = (stdout: string) => {
      const match = stdout.match(/\x1b\[(\d+);\d+H(?:[^\x1b]|$)*$/);
      return match ? parseInt(match[1]!, 10) : 0;
    };
    const relativeCursorRow1 = getCursorRowAbsolute(tty1.stdout()) - (TERM_ROWS - lines1 + 1);
    const relativeCursorRow2 = getCursorRowAbsolute(tty2.stdout()) - (TERM_ROWS - lines2 + 1);
    expect(relativeCursorRow2 - relativeCursorRow1).toBe(1);
  });

  test("anchors an OMP-style composer to the terminal bottom", () => {
    const tty = mockTty();
    const input = createFixedInput(tty.output, {
      getStatusLine: () => "nolo > DeepSeek V4 Flash > ~/tmp > context: 1.9% (19.5k/1M)",
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

  test("renders queued preview lines above the input and shifts the cursor down", () => {
    const tty = mockTty();
    const queueLines = ["  ⤷ 1. first queued", "  ⤷ 2. second queued"];
    const input = createFixedInput(tty.output, {
      getStatusLine: () => "nolo > test",
      getQueueLines: () => queueLines,
    });

    input.init();
    input.repaint("draft");

    // Queue lines add rows to the composer so it re-docks with the right height.
    expect(input.getInputLines()).toBe(EMPTY_COMPOSER_LINES + queueLines.length);
    const lines = input.getInputLines();
    const composerStart = TERM_ROWS - lines + 1;
    // top rule + status + 2 queued lines = 4 header rows before the input row.
    // Without counting queueLines in headerRows the cursor would land on a
    // queued preview line instead of the input line.
    const headerRows = 2 + queueLines.length;
    const promptWidth = displayWidth(t("promptLabel"));
    const cursorCol = promptWidth + displayWidth("draft") + 1;
    const cursorRow = composerStart + headerRows;

    const stdout = tty.stdout();
    expect(stdout).toContain("first queued");
    expect(stdout).toContain("second queued");
    expect(stdout).toContain(`\x1b[${cursorRow};${cursorCol}H`);
  });

  test("collapses newlines in a queued preview entry to keep it one physical row", () => {
    const tty = mockTty();
    const input = createFixedInput(tty.output, {
      getStatusLine: () => "nolo > test",
      // A queued multi-line paste: the entry must not inject extra physical
      // rows, or headerRows (which counts entries) undercounts and the cursor
      // drifts up.
      getQueueLines: () => ["one\ntwo"],
    });

    input.init();
    input.repaint("draft");

    const stdout = tty.stdout();
    expect(stdout).toContain("one two");
    expect(stdout).not.toContain("one\ntwo");
    // One entry stays one composer row.
    expect(input.getInputLines()).toBe(EMPTY_COMPOSER_LINES + 1);
  });

  test("omits queued preview lines when getQueueLines returns empty", () => {
    const tty = mockTty();
    const input = createFixedInput(tty.output, {
      getStatusLine: () => "nolo > test",
      getQueueLines: () => [],
    });

    input.init();
    input.repaint("");

    expect(input.getInputLines()).toBe(EMPTY_COMPOSER_LINES);
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
    expect(tty.stdout()).toContain("\x1b[?1006h\x1b[?1002h");

    input.pause();
    expect(tty.stdout()).toContain("\x1b[?1002l\x1b[?1006l");

    input.resumeFromDialog();
    expect(tty.stdout()).toContain("\x1b[?1006h\x1b[?1002h");

    input.disable();
    const disabled = tty.stdout();
    expect(disabled.lastIndexOf("\x1b[?1002l\x1b[?1006l")).toBeGreaterThan(
      disabled.lastIndexOf("\x1b[?1006h\x1b[?1002h")
    );
  });

  test("repaints the composer while paused so it re-docks after a resize", () => {
    const tty = mockTty();
    const input = createFixedInput(tty.output, {
      getStatusLine: () => "nolo > test",
    });

    input.init();
    input.repaint("");
    input.pause();

    // A dialog owns the top rows while paused; the workspace's resize handler
    // still re-docks the composer at the new bottom (the dialog repaints
    // itself on top via its own listener).
    (tty.output as unknown as { rows: number }).rows = 12;
    input.repaint("draft");

    expect(input.isPaused()).toBe(true);
    const composerStart = 12 - EMPTY_COMPOSER_LINES + 1;
    expect(tty.stdout()).toContain(`\x1b[${composerStart};1H`);
    expect(tty.stdout()).toContain("draft");
  });

  test("truncates a long status line instead of wrapping and breaking the composer", () => {
    const tty = mockTty(TERM_ROWS, 40);
    const longStatus =
      "nolo · 🏔 minimax-m3 · local · 📁 ~/very/long/path/to/bun-nolo · ⑂ main *99 · context: 0.4% (4.1k/1M)";
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

  test("repaint with mid-buffer cursorPos positions cursor at cursorPos column, not buffer.length", () => {
    const tty = mockTty();
    const input = createFixedInput(tty.output, {
      getStatusLine: () => "status",
    });
    const buffer = "hello world";
    const cursorPos = 5;
    input.repaint(buffer, cursorPos);

    const promptWidth = displayWidth(t("promptLabel"));
    const cups = [...tty.stdout().matchAll(/\x1b\[(\d+);(\d+)H/g)];
    const last = cups[cups.length - 1]!;
    const col = parseInt(last[2]!, 10);
    // CUP is 1-based: promptWidth + cursorPos + 1, not buffer.length end.
    expect(col).toBe(promptWidth + cursorPos + 1);
    expect(col).not.toBe(promptWidth + buffer.length + 1);
  });

  test("repaint without cursorPos falls back to buffer.length (regression guard for the fallback)", () => {
    const tty = mockTty();
    const input = createFixedInput(tty.output, {
      getStatusLine: () => "status",
    });
    const buffer = "hello world";
    input.repaint(buffer);

    const promptWidth = displayWidth(t("promptLabel"));
    const cups = [...tty.stdout().matchAll(/\x1b\[(\d+);(\d+)H/g)];
    const last = cups[cups.length - 1]!;
    const col = parseInt(last[2]!, 10);
    expect(col).toBe(promptWidth + buffer.length + 1);
  });

  test("repaint with cursorPos=0 positions cursor at start, not buffer.length", () => {
    const tty = mockTty();
    const input = createFixedInput(tty.output, {
      getStatusLine: () => "status",
    });
    const buffer = "hello world";
    input.repaint(buffer, 0);

    const promptWidth = displayWidth(t("promptLabel"));
    const cups = [...tty.stdout().matchAll(/\x1b\[(\d+);(\d+)H/g)];
    const last = cups[cups.length - 1]!;
    const col = parseInt(last[2]!, 10);
    // cursorPos=0 must land at prompt end / input start, not snap to buffer end.
    expect(col).toBe(promptWidth + 1);
    expect(col).not.toBe(promptWidth + buffer.length + 1);
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

  test("strips OSC 8 hyperlink sequences", () => {
    // Open + close hyperlink: ESC ]8;;url ESC \ text ESC ]8;; ESC \
    const link = "\x1b]8;;https://nolo.chat\x1b\\docs (https://nolo.chat)\x1b]8;;\x1b\\";
    expect(stripAnsi(link)).toBe("docs (https://nolo.chat)");
    // visibleWidth also ignores OSC 8
    expect(visibleWidth(link)).toBe("docs (https://nolo.chat)".length);
    // Link embedded in a styled line
    const mixed = `\x1b[1mSee \x1b]8;;https://x\x1b\\x (https://x)\x1b]8;;\x1b\\\x1b[0m`;
    expect(stripAnsi(mixed)).toBe("See x (https://x)");
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
    expect(stdout).toContain("┃"); // user marker (solid gutter)
    expect(stdout).toContain("hello"); // user content
    expect(stdout).toContain("◈ "); // assistant anchor marker
    expect(stdout).toContain("hi there");
    expect(stdout).toContain("\x1b[22;1H");
  });

  test("adds assistant anchor marker ◈ only on the first line and skips [nolo] notices", () => {
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
    history.turns.push({ role: "assistant", content: "line 1\nline 2" });
    history.turns.push({ role: "assistant", content: "[nolo] system status\nline after system" });
    renderHistory(output, history, 2);

    const stdout = chunks.join("");
    // First turn line 1 should have anchor, line 2 should not
    expect(stdout).toContain("◈ line 1");
    expect(stdout).not.toContain("◈ line 2");
    // System notice line should not have anchor
    expect(stdout).not.toContain("◈ [nolo]");
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

    stream.write("\r\x1b[36m⠋\x1b[39m execShell bun test tui/session.test.ts (0s)");
    expect(stripAnsi(history.currentContent)).toBe(
      "⠋ execShell bun test tui/session.test.ts (0s)"
    );
    expect(history.currentContent).not.toContain("working locally");

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

  test("keeps modifier Delete / Backspace CSI sequences intact as single tokens", () => {
    // Forward Delete variants — must arrive as one token so applyTuiInputKey
    // can match them, not split into ESC + leftover.
    expect(splitRawInput("\x1b[3~")).toEqual(["\x1b[3~"]);
    expect(splitRawInput("\x1b[3;5~")).toEqual(["\x1b[3;5~"]);
    expect(splitRawInput("\x1b[3;3~")).toEqual(["\x1b[3;3~"]);
    // Backspace modifier variants
    expect(splitRawInput("\x1b[27;2;8~")).toEqual(["\x1b[27;2;8~"]);
    expect(splitRawInput("\x1b[27;5;8~")).toEqual(["\x1b[27;5;8~"]);
  });

  test("identifies bracketed paste sequences and returns payload as a single token with raw newlines intact", () => {
    // Real terminal markers are CSI 200~ / 201~, NOT the DECSET 2004 enable/disable.
    expect(splitRawInput("\x1b[200~line1\r\nline2\r\nline3\x1b[201~")).toEqual([
      "\x00PASTE\x00line1\r\nline2\r\nline3",
    ]);
  });

  test("splits normal characters outside bracketed paste as individual tokens", () => {
    expect(splitRawInput("a\x1b[200~line1\r\nline2\x1b[201~b")).toEqual([
      "a",
      "\x00PASTE\x00line1\r\nline2",
      "b",
    ]);
  });

  test("does not mistake DECSET 2004 enable/disable for a paste bracket", () => {
    // App writes these to enable the mode; if they were echoed/misread as
    // brackets, collapse would silently never fire on real pastes.
    const tokens = splitRawInput("\x1b[?2004hx\x1b[?2004l");
    expect(tokens).toEqual(["\x1b[?2004h", "x", "\x1b[?2004l"]);
  });

  test("holds an open paste across chunks until 201~ arrives", async () => {
    const tokens: string[] = [];
    const decode = createRawInputDecoder((token) => tokens.push(token), {
      escTimeoutMs: 10,
    });
    decode("\x1b[200~line1\nli");
    // Still open — must not emit a partial PASTE yet.
    expect(tokens).toEqual([]);
    // Slow-SSH style gap: must NOT force-complete just because time passed.
    await Bun.sleep(60);
    expect(tokens).toEqual([]);
    decode("ne2\nline3\x1b[201~");
    expect(tokens).toEqual(["\x00PASTE\x00line1\nline2\nline3"]);
  });

  test("promotes unmarked multi-line bursts to a single PASTE token", async () => {
    const body = Array.from({ length: 10 }, (_, i) => `raw-${i}`).join("\n");
    const tokens: string[] = [];
    const decode = createRawInputDecoder((token) => tokens.push(token), {
      unmarkedPasteDebounceMs: 15,
    });
    decode(body.slice(0, 20));
    decode(body.slice(20));
    await Bun.sleep(40);
    expect(tokens).toEqual([`\x00PASTE\x00${body}`]);
  });

  test("literal CSI 201~ inside bracketed payload closes early; oversized remainder still collapses", async () => {
    // Protocol: first 201~ ends the paste. Remainder is reparsed — if large,
    // unmarked-burst heuristic still yields a PASTE token (not keystroke flood).
    const remainder = Array.from({ length: 10 }, (_, i) => `tail-${i}`).join(
      "\n",
    );
    const tokens: string[] = [];
    const decode = createRawInputDecoder((token) => tokens.push(token), {
      unmarkedPasteDebounceMs: 15,
    });
    decode(`\x1b[200~before\x1b[201~${remainder}`);
    await Bun.sleep(40);
    expect(tokens[0]).toBe("\x00PASTE\x00before");
    expect(tokens[1]).toBe(`\x00PASTE\x00${remainder}`);
    expect(tokens).toHaveLength(2);
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

  test("handles split ANSI SGR mouse tracking sequence across chunks", async () => {
    const tokens: string[] = [];
    const decode = createRawInputDecoder((token) => tokens.push(token), { escTimeoutMs: 20 });
    // Chunk 1 has only \x1b
    decode("\x1b");
    expect(tokens).toEqual([]); // held in buffer

    // Chunk 2 finishes the SGR mouse scroll sequence
    decode("[<65;62;24M");
    expect(tokens).toEqual(["\x1b[<65;62;24M"]);
  });

  test("flushes standalone ESC after escTimeoutMs", async () => {
    const tokens: string[] = [];
    const decode = createRawInputDecoder((token) => tokens.push(token), { escTimeoutMs: 10 });
    decode("\x1b");
    expect(tokens).toEqual([]); // pending timeout

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(tokens).toEqual(["\x1b"]);
  });
});

describe("mouse drag selection integration", () => {
  test("copies the same wrapped row highlighted by SGR press/drag/release events", async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY?: boolean;
      setRawMode?: (mode: boolean) => void;
    };
    const output = new PassThrough() as PassThrough & {
      isTTY?: boolean;
      rows?: number;
      columns?: number;
    };
    input.isTTY = true;
    output.isTTY = true;
    output.rows = TERM_ROWS;
    // contentWidth = columns - scrollbar = 20. The regression used a hidden
    // default width of 80 on release, so row 4 did not exist in the copy grid.
    output.columns = 21;
    input.setRawMode = () => {};

    const outputChunks: string[] = [];
    output.on("data", (chunk) => outputChunks.push(String(chunk)));
    const copied: string[] = [];
    let agentRuns = 0;
    const workspacePromise = startTuiWorkspace({
      scriptDir: "",
      input,
      output,
      env: {},
      clipboardWriter: async (text) => {
        copied.push(text);
      },
      agentRunner: async (options) => {
        agentRuns += 1;
        options.output.write("abcdefghijklmnopqrstuvwxyz");
        return { exitCode: 0, dialogId: "selection-test" };
      },
    });

    input.write("q\r");
    const deadline = Date.now() + 3000;
    while (agentRuns === 0 && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    expect(agentRuns).toBe(1);
    await Bun.sleep(80);

    // History rows at width 20: separator, user, separator,
    // "◈ abcdefghijklmnopqr", "stuvwxyz". SGR coordinates are 1-based.
    input.write("\x1b[<0;1;5M");
    // Deliberately stop the last motion early. The release coordinate is the
    // authoritative endpoint when a terminal coalesces motion reports.
    input.write("\x1b[<32;3;5M");
    input.write("\x1b[<0;6;5m");

    const copyDeadline = Date.now() + 1000;
    while (copied.length === 0 && Date.now() < copyDeadline) {
      await Bun.sleep(10);
    }
    expect(copied).toEqual(["stuvw"]);

    // A plain click starts a zero-width selection and must repaint away the
    // old reverse-video overlay even if no drag follows.
    const outputBeforeClick = outputChunks.length;
    input.write("\x1b[<0;2;5M");
    await Bun.sleep(30);
    const clickPaint = outputChunks.slice(outputBeforeClick).join("");
    expect(clickPaint.length).toBeGreaterThan(0);
    expect(clickPaint).not.toContain("\x1b[7m");

    input.write("/exit\r");
    input.end();
    await Promise.race([workspacePromise, Bun.sleep(3000)]);
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

  test("repaints the welcome banner with the update hint when the check lands on the welcome page", async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY?: boolean;
      setRawMode?: (mode: boolean) => void;
    };
    const output = new PassThrough() as PassThrough & {
      isTTY?: boolean;
      rows?: number;
      columns?: number;
    };
    input.isTTY = true;
    output.isTTY = true;
    output.rows = TERM_ROWS;
    output.columns = TERM_COLS;
    input.setRawMode = () => {};

    const chunks: Uint8Array[] = [];
    output.on("data", (chunk) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });

    const workspacePromise = startTuiWorkspace({
      scriptDir: "",
      input,
      output,
      env: { NOLO_CLI_VERSION: "0.1.0" },
      fetchImpl: (async () =>
        new Response(JSON.stringify({ version: "0.2.0" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
      agentRunner: async () => ({ exitCode: 0, dialogId: "test" }),
    });

    // 轮询等待异步检查结果到达并触发 banner 重绘（网络检查是异步的，
    // 不会在欢迎页首帧内完成）。
    const deadline = Date.now() + 5000;
    let text = "";
    while (Date.now() < deadline) {
      text = Buffer.concat(chunks).toString("utf8");
      if (text.includes("0.2.0")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(text).toContain("0.2.0"); // 新版本提示已渲染出来

    // 重绘帧 = 清行序列（\x1b[N;1H\x1b[2K）+ 逐行定位写入（\x1b[N;1H<行文本>）。
    // 防回归断言：row 1 先被清行，随后 banner 第一行又被定位写到 row 1 ——
    // 修正前的实现把 welcome 整段拼接在清行循环之后，光标停在最后清的那行
    // （row 8），banner 会从屏幕中部开始画。
    // 从提示行反查它所在的 repaint 帧：BSU（帧开头）→ 清行 → 逐行写入 →
    // ESU（帧尾）。不能从文本开头找第一个清行序列——composer 首次绘制等
    // 早期输出里也有 \x1b[1;1H\x1b[2K，会定位错帧。
    const hintIndex = text.indexOf("0.2.0");
    const frameOpen = text.lastIndexOf("\x1b[?2026h", hintIndex);
    expect(frameOpen).toBeGreaterThanOrEqual(0);
    // 防回归断言：row 1 在帧内先被清行，随后 banner 第一行又被定位写到
    // row 1 —— 修正前的实现把 welcome 整段拼接在清行循环之后，光标停在
    // 最后清的那行，banner 会从屏幕中部开始画。
    const row1Clear = text.indexOf("\x1b[1;1H\x1b[2K", frameOpen);
    expect(row1Clear).toBeGreaterThanOrEqual(0);
    expect(row1Clear).toBeLessThan(hintIndex);
    const bannerStart = text.indexOf("\x1b[1;1H", row1Clear + 7);
    expect(bannerStart).toBeGreaterThanOrEqual(0);
    expect(bannerStart).toBeLessThan(hintIndex);
    // ESU 在帧尾（提示行之后）。
    const frameClose = text.indexOf("\x1b[?2026l", hintIndex);
    expect(frameClose).toBeGreaterThan(hintIndex);

    input.write("/exit\r");
    input.end();
    await Promise.race([workspacePromise, new Promise((r) => setTimeout(r, 3000))]);
  });

  test("executes /context locally during busy turn without enqueuing, while normal text remains queued", async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY?: boolean;
      setRawMode?: (mode: boolean) => void;
    };
    const output = new PassThrough() as PassThrough & {
      isTTY?: boolean;
      rows?: number;
      columns?: number;
    };
    input.isTTY = true;
    output.isTTY = true;
    output.rows = TERM_ROWS;
    output.columns = TERM_COLS;
    input.setRawMode = () => {};

    const chunks: Uint8Array[] = [];
    output.on("data", (chunk) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });

    let resolveFirstTurn: (() => void) | null = null;
    const firstTurnPromise = new Promise<void>((resolve) => {
      resolveFirstTurn = resolve;
    });

    let turnCount = 0;
    const turnsProcessed: string[] = [];

    // The agent runner streams its reply to opt.output in multiple chunks,
    // yielding between them so the busy /context submit can interleave. This
    // is what actually exercises the startTurn/currentRole race: the assistant
    // turn is mid-flight (currentRole==="assistant", partial content buffered)
    // when /context is handled.
    const HEAD = "HEAD-part-of-the-reply";
    const TAIL = "TAIL-part-of-the-reply";

    const workspacePromise = startTuiWorkspace({
      scriptDir: "",
      input,
      output,
      env: {},
      agentRunner: async (opt) => {
        turnCount++;
        turnsProcessed.push(opt.message);
        if (turnCount === 1) {
          // Stream the head of the reply, then pause mid-turn so the test can
          // submit /context while the assistant stream is still in flight.
          opt.output.write(HEAD);
          await new Promise((r) => setTimeout(r, 30));
          await firstTurnPromise;
          // After /context has been handled, stream the tail. With the fix the
          // whole reply (HEAD + TAIL) lives in one assistant turn; with the old
          // startTurn path the tail would be dropped.
          opt.output.write(TAIL);
          await new Promise((r) => setTimeout(r, 10));
        }
        return { exitCode: 0, dialogId: "test-dialog" };
      },
    });

    // Send first user input to start turn 1 and enter busy state
    input.write("start turn 1\r");

    // Wait until agentRunner is executing turn 1 (HEAD already streamed)
    while (turnCount < 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    // Let the HEAD chunk + its repaint settle.
    await new Promise((r) => setTimeout(r, 30));

    // Now workspace is busy mid-stream. Submit /context while busy.
    input.write("/context\r");
    await new Promise((r) => setTimeout(r, 50));

    // /context must be executed locally and rendered to the user immediately,
    // via the transient channel (never enqueued as a chat turn).
    const outputTextAfterContext = Buffer.concat(chunks).toString("utf8");
    // Assert the panel rendered, not that it rendered in English: the labels
    // are localized now, so a hardcoded English title only passes when the
    // ambient locale happens to be en.
    expect(outputTextAfterContext).toContain(t("contextTitle"));

    // Submit normal text while busy -> this SHOULD be enqueued for after turn
    input.write("normal queued text\r");
    await new Promise((r) => setTimeout(r, 50));

    // Finish first turn (releases TAIL streaming + finalization)
    resolveFirstTurn!();
    await new Promise((r) => setTimeout(r, 50));

    // Give time for the queued text turn to run
    while (turnCount < 2) {
      await new Promise((r) => setTimeout(r, 10));
    }

    input.write("/exit\r");
    input.end();

    await Promise.race([
      workspacePromise,
      new Promise((r) => setTimeout(r, 3000)),
    ]);

    // /context was NOT enqueued as a chat turn: only the real user messages
    // reached the agent runner. This is the real queue-state verification
    // (the head-of-queue drain produced exactly "normal queued text").
    expect(turnsProcessed).toEqual(["start turn 1", "normal queued text"]);

    // The in-flight assistant reply must be preserved in full in the
    // transcript: both the pre-/context head and the post-/context tail
    // appear in the rendered output. With the old startTurn path the tail
    // would be dropped, failing this assertion.
    const fullOutput = Buffer.concat(chunks).toString("utf8");
    expect(fullOutput).toContain(HEAD);
    expect(fullOutput).toContain(TAIL);
  });

  test("executes /theme locally during busy turn without enqueuing, while normal text remains queued", async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY?: boolean;
      setRawMode?: (mode: boolean) => void;
    };
    const output = new PassThrough() as PassThrough & {
      isTTY?: boolean;
      rows?: number;
      columns?: number;
    };
    input.isTTY = true;
    output.isTTY = true;
    output.rows = TERM_ROWS;
    output.columns = TERM_COLS;
    input.setRawMode = () => {};

    const chunks: Uint8Array[] = [];
    output.on("data", (chunk) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });

    let resolveFirstTurn: (() => void) | null = null;
    const firstTurnPromise = new Promise<void>((resolve) => {
      resolveFirstTurn = resolve;
    });

    let turnCount = 0;
    const turnsProcessed: string[] = [];

    const HEAD = "HEAD-part-of-the-reply";
    const TAIL = "TAIL-part-of-the-reply";

    const workspacePromise = startTuiWorkspace({
      scriptDir: "",
      input,
      output,
      env: {},
      agentRunner: async (opt) => {
        turnCount++;
        turnsProcessed.push(opt.message);
        if (turnCount === 1) {
          opt.output.write(HEAD);
          await new Promise((r) => setTimeout(r, 30));
          await firstTurnPromise;
          opt.output.write(TAIL);
          await new Promise((r) => setTimeout(r, 10));
        }
        return { exitCode: 0, dialogId: "test-dialog" };
      },
    });

    input.write("start turn 1\r");

    while (turnCount < 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 30));

    input.write("/theme light\r");
    await new Promise((r) => setTimeout(r, 50));

    const outputTextAfterTheme = Buffer.concat(chunks).toString("utf8");
    expect(outputTextAfterTheme).toContain(t("themeBrightnessSwitched", "light"));

    input.write("normal queued text\r");
    await new Promise((r) => setTimeout(r, 50));

    resolveFirstTurn!();
    await new Promise((r) => setTimeout(r, 50));

    while (turnCount < 2) {
      await new Promise((r) => setTimeout(r, 10));
    }

    input.write("/exit\r");
    input.end();

    await Promise.race([
      workspacePromise,
      new Promise((r) => setTimeout(r, 3000)),
    ]);

    expect(turnsProcessed).toEqual(["start turn 1", "normal queued text"]);

    const fullOutput = Buffer.concat(chunks).toString("utf8");
    expect(fullOutput).toContain(HEAD);
    expect(fullOutput).toContain(TAIL);
  });

  test("executes /theme refresh locally during busy turn without enqueuing or model picker warning", async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY?: boolean;
      setRawMode?: (mode: boolean) => void;
    };
    const output = new PassThrough() as PassThrough & {
      isTTY?: boolean;
      rows?: number;
      columns?: number;
    };
    input.isTTY = true;
    output.isTTY = true;
    output.rows = TERM_ROWS;
    output.columns = TERM_COLS;
    input.setRawMode = () => {};

    const chunks: Uint8Array[] = [];
    output.on("data", (chunk) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });

    let resolveFirstTurn: (() => void) | null = null;
    const firstTurnPromise = new Promise<void>((resolve) => {
      resolveFirstTurn = resolve;
    });

    let turnCount = 0;
    const turnsProcessed: string[] = [];

    const workspacePromise = startTuiWorkspace({
      scriptDir: "",
      input,
      output,
      env: {},
      agentRunner: async (opt) => {
        turnCount++;
        turnsProcessed.push(opt.message);
        if (turnCount === 1) {
          opt.output.write("HEAD");
          await new Promise((r) => setTimeout(r, 30));
          await firstTurnPromise;
          opt.output.write("TAIL");
          await new Promise((r) => setTimeout(r, 10));
        }
        return { exitCode: 0, dialogId: "test-dialog" };
      },
    });

    input.write("start turn 1\r");

    while (turnCount < 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 30));

    input.write("/theme refresh\r");
    await new Promise((r) => setTimeout(r, 50));

    const outputTextAfterTheme = Buffer.concat(chunks).toString("utf8");
    expect(outputTextAfterTheme).not.toContain("Model picker isn't available");
    expect(outputTextAfterTheme).toMatch(/(refreshed|failed|re-detected|could not detect|已重新检测|无法检测)/i);

    resolveFirstTurn!();
    await new Promise((r) => setTimeout(r, 50));

    input.write("/exit\r");
    input.end();

    await Promise.race([
      workspacePromise,
      new Promise((r) => setTimeout(r, 3000)),
    ]);

    expect(turnsProcessed).toEqual(["start turn 1"]);
  });

  test("busy /switch auto persists and routes the next turn through auto", async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY?: boolean;
      setRawMode?: (mode: boolean) => void;
    };
    const output = new PassThrough() as PassThrough & {
      isTTY?: boolean;
      rows?: number;
      columns?: number;
    };
    input.isTTY = true;
    output.isTTY = true;
    output.rows = TERM_ROWS;
    output.columns = TERM_COLS;
    input.setRawMode = () => {};

    const chunks: Uint8Array[] = [];
    output.on("data", (chunk) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });

    let resolveFirstTurn: (() => void) | null = null;
    const firstTurnPromise = new Promise<void>((resolve) => {
      resolveFirstTurn = resolve;
    });

    let turnCount = 0;
    const turnsProcessed: string[] = [];
    const seenAgentKeys: string[] = [];
    const seenDialogAgentModes: Array<"auto" | "fixed" | undefined> = [];
    const savedSelections: Array<{ agentKey: string; agentName: string }> = [];
    const env: NodeJS.ProcessEnv = {
      NOLO_AGENT: "agent-pub-01APPBUILDER00000001YAII3I",
      NOLO_AGENT_NAME: "app-builder",
    };

    const workspacePromise = startTuiWorkspace({
      scriptDir: "",
      input,
      output,
      env,
      saveAgentSelection: (selection) => {
        savedSelections.push(selection);
        return null;
      },
      agentRunner: async (opt) => {
        turnCount++;
        turnsProcessed.push(opt.message);
        seenAgentKeys.push(opt.agentKey);
        seenDialogAgentModes.push(opt.dialogAgentMode);
        if (turnCount === 1) {
          opt.output.write("HEAD");
          await new Promise((r) => setTimeout(r, 30));
          await firstTurnPromise;
          opt.output.write("TAIL");
          await new Promise((r) => setTimeout(r, 10));
        }
        return { exitCode: 0, dialogId: "busy-switch-dialog" };
      },
    });

    input.write("start turn 1\r");
    while (turnCount < 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 30));

    // Busy: switch back to auto. Must apply locally and persist right now
    // (the next turn uses it) and MUST NOT be enqueued as a chat turn.
    input.write("/switch auto\r");
    await new Promise((r) => setTimeout(r, 50));

    // Busy: bare /switch wants the interactive picker, which can't open
    // mid-stream. It must surface a notice instead of being queued.
    input.write("/switch\r");
    await new Promise((r) => setTimeout(r, 50));

    const outputAfterSwitch = Buffer.concat(chunks).toString("utf8");
    expect(outputAfterSwitch).toContain("Switched to nolo");
    // The token-cost / next-turn notice for a successful busy switch.
    expect(outputAfterSwitch).toContain("may consume more tokens");
    // The picker-unavailable notice for the bare /switch.
    expect(outputAfterSwitch).toContain(
      "isn't available while a reply is running",
    );
    // 切回默认档 = 清除持久化选择，而不是把 nolo 存成一次显式选择。
    // 存了的话下次启动 NOLO_AGENT 就有值，createInitialTuiState 再也走不到
    // DEFAULT_TUI_AGENT_KEY 兜底，默认档等于被这条记录钉死。
    expect(savedSelections).toEqual([{ agentKey: "", agentName: "" }]);
    expect(env.NOLO_AGENT).toBeUndefined();
    expect(env.NOLO_AGENT_NAME).toBeUndefined();

    // Normal text while busy is still queued for after the turn.
    input.write("normal queued text\r");
    await new Promise((r) => setTimeout(r, 50));

    resolveFirstTurn!();
    await new Promise((r) => setTimeout(r, 50));
    while (turnCount < 2) {
      await new Promise((r) => setTimeout(r, 10));
    }

    input.write("/exit\r");
    input.end();

    await Promise.race([
      workspacePromise,
      new Promise((r) => setTimeout(r, 3000)),
    ]);

    // Neither /switch form reached the agent runner: only the real user
    // messages did. A queued `/switch` would have been drained as a chat
    // message and shown up here as "/switch auto".
    expect(turnsProcessed).toEqual(["start turn 1", "normal queued text"]);
    expect(seenAgentKeys).toEqual([
      "agent-pub-01APPBUILDER00000001YAII3I",
      "agent-pub-01NOLOAPPBLD000000019KCKT0",
    ]);
    expect(seenDialogAgentModes).toEqual(["fixed", "auto"]);
  });

  // Regression for "在 TUI 对话时 agent 429 后 /agent 切换不生效"。
  // 根因：autoRouteByDialog 在首轮 auto-route 后按对话缓存 agent，后续轮直接复用
  // 缓存、无视 state.agentKey，导致用户 /agent 切换的 agent 被缓存「切回」原 agent。
  // 修复：显式 /agent 切换时清掉该 dialog 的缓存路由，并标记 explicitAgentSwitch 让
  // runAgentChat 这一轮尊重 state.agentKey。
  test("explicit /agent switch overrides the cached auto-route on the next turn", async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY?: boolean;
      setRawMode?: (mode: boolean) => void;
    };
    const output = new PassThrough() as PassThrough & {
      isTTY?: boolean;
      rows?: number;
      columns?: number;
    };
    input.isTTY = true;
    output.isTTY = true;
    output.rows = TERM_ROWS;
    output.columns = TERM_COLS;
    input.setRawMode = () => {};

    // Capture stdout so /agent "Switched to" echo and the quota hint are visible,
    // but the assertion that matters is which agentKey the runner was called with.
    const chunks: Uint8Array[] = [];
    output.on("data", (chunk) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });

    // The first turn auto-routes to the flash tier key（纯二选一：无图 → flash）。
    // That key gets cached against the dialog. The bug: the second turn reused
    // that cached key even after the user switched agents.
    const switchedAgentKey = "agent-pub-01APPBUILDER00000001YAII3I";

    let turnCount = 0;
    const seenAgentKeys: string[] = [];
    const savedSelections: Array<{ agentKey: string; agentName: string }> = [];

    const workspacePromise = startTuiWorkspace({
      scriptDir: "",
      input,
      output,
      // classifyCliAutoRoute 现为同步纯二选一（无 LLM 调用、无网络请求）；
      // 路由出的 tier key 仍按对话缓存。
      env: {},
      // Capture the persisted selection instead of writing the developer's
      // real ~/.nolo/config.json (this switch used to pin their startup agent).
      saveAgentSelection: (selection) => {
        savedSelections.push(selection);
        return null;
      },
      agentRunner: async (opt) => {
        turnCount++;
        seenAgentKeys.push(opt.agentKey);
        opt.output.write(`turn ${turnCount}`);
        return { exitCode: 0, dialogId: "switch-dialog" };
      },
    });

    // Turn 1: a text message → auto-routes to the flash tier key.
    input.write("implement a distributed transaction coordinator\r");
    while (turnCount < 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 30));

    // Switch agent explicitly by key. /agent <key> resolves via the catalog
    // (agent-pub-... prefix is accepted directly by findAgentCatalogEntry).
    input.write(`/agent ${switchedAgentKey}\r`);
    await new Promise((r) => setTimeout(r, 50));

    // Turn 2: must run on the user-chosen agent, NOT the cached quality tier.
    input.write("follow up in the same dialog\r");
    while (turnCount < 2) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 30));

    input.write("/exit\r");
    input.end();
    await Promise.race([workspacePromise, new Promise((r) => setTimeout(r, 3000))]);

    // The second turn MUST run on the switched agent. Before the fix it ran on
    // the cached first-turn key because autoRouteByDialog overrode the user's
    // /agent switch.
    expect(seenAgentKeys[1]).toBe(switchedAgentKey);
    // And the switch was actually acknowledged to the user.
    expect(Buffer.concat(chunks).toString("utf8")).toContain("Switched to");
    // An explicit switch is persisted, and only through the injected seam.
    expect(savedSelections).toEqual([
      { agentKey: switchedAgentKey, agentName: "应用构建助手" },
    ]);
  });

  test("explicitly chosen agent skips auto-route completely on the first turn", async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY?: boolean;
      setRawMode?: (mode: boolean) => void;
    };
    const output = new PassThrough() as PassThrough & {
      isTTY?: boolean;
      rows?: number;
      columns?: number;
    };
    input.isTTY = true;
    output.isTTY = true;
    output.rows = TERM_ROWS;
    output.columns = TERM_COLS;
    input.setRawMode = () => {};

    const chunks: Uint8Array[] = [];
    output.on("data", (chunk) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });

    const explicitAgentKey = "agent-pub-01APPBUILDER00000001YAII3I";
    let capturedAgentKey: string | undefined;
    let capturedModelOverride: unknown = "not-called";

    const workspacePromise = startTuiWorkspace({
      scriptDir: "",
      input,
      output,
      env: { NOLO_AGENT: explicitAgentKey },
      agentRunner: async (opt) => {
        capturedAgentKey = opt.agentKey;
        capturedModelOverride = (opt as { modelOverride?: unknown }).modelOverride;
        opt.output.write("turn 1");
        return { exitCode: 0, dialogId: "explicit-dialog" };
      },
    });

    // Send a complex prompt that would normally trigger auto-routing
    input.write("implement a distributed transaction coordinator\r");
    while (capturedAgentKey === undefined) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 30));

    input.write("/exit\r");
    input.end();
    await Promise.race([workspacePromise, new Promise((r) => setTimeout(r, 3000))]);

    const fullOutput = Buffer.concat(chunks).toString("utf8");

    // Must execute on the explicitly chosen agent key, NOT an auto-tier key
    expect(capturedAgentKey).toBe(explicitAgentKey);
    // modelOverride must be undefined
    expect(capturedModelOverride).toBeUndefined();
    // Must NOT contain auto-routing hint in output
    expect(fullOutput).not.toContain("auto→");
  });

  // Regression for the "处理得好看点" half of the same bug: a 429 / quota error
  // on a local run should produce a friendly, actionable hint pointing the
  // user at /agent, instead of leaving only the raw error text in the transcript.
  test("surfaces a friendly /agent hint when a local turn fails with a quota error", async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY?: boolean;
      setRawMode?: (mode: boolean) => void;
    };
    const output = new PassThrough() as PassThrough & {
      isTTY?: boolean;
      rows?: number;
      columns?: number;
    };
    input.isTTY = true;
    output.isTTY = true;
    output.rows = TERM_ROWS;
    output.columns = TERM_COLS;
    input.setRawMode = () => {};

    const chunks: Uint8Array[] = [];
    output.on("data", (chunk) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });

    const workspacePromise = startTuiWorkspace({
      scriptDir: "",
      input,
      output,
      // Disable auto-route so the first turn goes straight to state.agentKey
      // (the default platform agent) and doesn't cache a tier route — keeps
      // the test focused on the quota-hint path, not routing.
      env: { NOLO_AUTO_ROUTE: "0" },
      agentRunner: async () => {
        // Simulate a local provider quota error: exitCode 1 + localError whose
        // message mentions 429, which isQuotaExhaustedError matches.
        return {
          exitCode: 1,
          localError: new Error("HTTP 429 Too Many Requests: 额度已用尽"),
        };
      },
    });

    input.write("hi\r");
    await new Promise((r) => setTimeout(r, 60));

    input.write("/exit\r");
    input.end();
    await Promise.race([workspacePromise, new Promise((r) => setTimeout(r, 3000))]);

    const fullOutput = Buffer.concat(chunks).toString("utf8");
    // The friendly hint is emitted (zh is the default locale).
    expect(fullOutput).toContain("429");
    expect(fullOutput).toContain("/agent");
  });

  test("surfaces a balance / dialog-kept hint when a local turn fails with UPSTREAM_402", async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY?: boolean;
      setRawMode?: (mode: boolean) => void;
    };
    const output = new PassThrough() as PassThrough & {
      isTTY?: boolean;
      rows?: number;
      columns?: number;
    };
    input.isTTY = true;
    output.isTTY = true;
    output.rows = TERM_ROWS;
    output.columns = TERM_COLS;
    input.setRawMode = () => {};

    const chunks: Uint8Array[] = [];
    output.on("data", (chunk) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });

    const workspacePromise = startTuiWorkspace({
      scriptDir: "",
      input,
      output,
      env: { NOLO_AUTO_ROUTE: "0" },
      agentRunner: async () => ({
        exitCode: 1,
        dialogId: "dialog-kept-after-402",
        localError: new Error("Insufficient Balance (UPSTREAM_402)"),
      }),
    });

    input.write("review the code\r");
    await new Promise((r) => setTimeout(r, 60));

    input.write("/exit\r");
    input.end();
    await Promise.race([workspacePromise, new Promise((r) => setTimeout(r, 3000))]);

    const fullOutput = Buffer.concat(chunks).toString("utf8");
    expect(fullOutput).toContain("余额不足");
    expect(fullOutput).toContain("继续");
    expect(fullOutput).not.toContain("Fix the local credential/config");
  });

  test("timer does not leak: stopActivity prevents repaint calls after turn finishes", async () => {
    const input = new PassThrough();
    const chunks: Buffer[] = [];
    const output = new PassThrough();
    output.on("data", (chunk: Buffer) => chunks.push(chunk));
    (input as unknown as { isTTY?: boolean; setRawMode?: () => void }).isTTY = true;
    (input as unknown as { isTTY?: boolean; setRawMode?: () => void }).setRawMode = () => {};
    (output as unknown as { isTTY?: boolean; rows?: number; columns?: number }).isTTY = true;
    (output as unknown as { isTTY?: boolean; rows?: number; columns?: number }).rows = 24;
    (output as unknown as { isTTY?: boolean; rows?: number; columns?: number }).columns = 120;

    let runnerReturned = false;
    const workspacePromise = startTuiWorkspace({
      scriptDir: "",
      input,
      output,
      env: {},
      agentRunner: async (opt) => {
        opt.activityReporter?.("thinking...");
        await new Promise((r) => setTimeout(r, 50));
        runnerReturned = true;
        return { exitCode: 0, dialogId: "test-dialog" };
      },
    });

    input.write("hello\r");

    // Wait for the runner to actually return rather than guessing a duration:
    // a fixed sleep here recorded the baseline mid-turn on a loaded machine and
    // made this test flake.
    const deadline = Date.now() + 3000;
    while (!runnerReturned && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(runnerReturned).toBe(true);

    // Now wait for output to go quiet. If the activity timer leaked it repaints
    // every 150ms forever, so this never settles — which is itself the failure
    // this test exists to catch.
    const TICK = 150;
    let stable = 0;
    let previous = -1;
    const quietDeadline = Date.now() + 3000;
    while (stable < 2 && Date.now() < quietDeadline) {
      previous = chunks.length;
      await new Promise((r) => setTimeout(r, TICK + 50));
      stable = chunks.length === previous ? stable + 1 : 0;
    }
    expect(stable).toBeGreaterThanOrEqual(2);

    // Output has been quiet across two full tick windows. Confirm it stays that
    // way for two more, so a slow first tick can't be mistaken for a clean stop.
    const chunkCountAfterTurn = chunks.length;
    await new Promise((r) => setTimeout(r, TICK * 2 + 50));
    expect(chunks.length).toBe(chunkCountAfterTurn);

    input.write("/exit\r");
    input.end();

    await Promise.race([
      workspacePromise,
      new Promise((r) => setTimeout(r, 1000)),
    ]);
  });
});

// Regression for "/resume 恢复历史对话后 markdown 样式降级"。
// 根因：/resume 把数据库里的原始 markdown 直接 push 进 history，绕过和新回复
// （流式）同一套完整渲染器（assistantOutput.ts），重绘时只有 theme.ts 的
// highlightMarkdown 生效，它处理不了表格/列表/链接。修复：push 前对 assistant
// turn 过一遍 formatAssistantDisplay。
describe("/resume renders restored assistant turns through the full renderer", () => {
  type FakeInput = PassThrough & {
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => void;
  };
  type FakeOutput = PassThrough & {
    isTTY?: boolean;
    rows?: number;
    columns?: number;
  };

  const makeDialog = (): ListedDialog => ({
    id: "01JZZZZZZZZZZZZZZZZZZZZZZZ",
    dbKey: "dialog-user-01JZZZZZZZZZZZZZZZZZZZZZZZ",
    title: "test dialog",
    status: null,
    updatedAt: null,
    createdAt: null,
    spaceId: null,
    triggerType: null,
    primaryAgentKey: null,
    cybots: [],
  });

  const makeStreams = () => {
    const input = new PassThrough() as FakeInput;
    const output = new PassThrough() as FakeOutput;
    input.isTTY = true;
    output.isTTY = true;
    output.rows = TERM_ROWS;
    output.columns = TERM_COLS;
    input.setRawMode = () => {};
    const chunks: Uint8Array[] = [];
    output.on("data", (chunk) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    return { input, output, chunks };
  };

  // /history 触发 pick-dialog；用 mock picker 直接返回 selected，跳过真实
  // 列表交互。注入 dialogHistoryLoader 返回固定原始 markdown，断言恢复后
  // history 被渲染过的内容出现在输出里。
  const runResume = async (
    turns: DialogHistoryTurn[],
    env: Record<string, string | undefined> = {},
  ) => {
    const { input, output, chunks } = makeStreams();
    const workspacePromise = startTuiWorkspace({
      scriptDir: "",
      input,
      output,
      env,
      agentRunner: async () => ({ exitCode: 0, dialogId: "test-dialog" }),
      dialogPickerRunner: async () => ({
        kind: "selected" as const,
        dialog: makeDialog(),
      }),
      dialogHistoryLoader: async () => turns,
    });

    // /history 和 /resume 都映射为 pick-dialog；发 /history 即可走恢复路径。
    input.write("/history\r");
    // 等 picker + loader + emitCommandOutput("Resumed dialog:") + 重绘落地。
    await new Promise((r) => setTimeout(r, 120));

    input.write("/exit\r");
    input.end();
    await Promise.race([
      workspacePromise,
      new Promise((r) => setTimeout(r, 3000)),
    ]);

    return Buffer.concat(chunks).toString("utf8");
  };

  test("table is converted to bullets (no raw separator)", async () => {
    const tableMarkdown =
      "| 水果 | 颜色 |\n| --- | --- |\n| 苹果 | 红 |";
    const out = await runResume([
      { role: "assistant", content: tableMarkdown },
    ]);
    expect(out).toContain("•");
    expect(out).not.toContain("| --- |");
    // 表格行被转成 bullet：苹果 — 红。
    expect(out).toContain("苹果");
    expect(out).toContain("红");
  });

  test("unordered list marker is normalized to •", async () => {
    const out = await runResume([
      { role: "assistant", content: "- 第一项" },
    ]);
    expect(out).toContain("•");
    expect(out).toContain("第一项");
    // 行首的原始 "- " 不应再出现（已被规范化为 •）。
    expect(out).not.toContain("- 第一项");
  });

  test("user turns are not rendered as assistant markdown", async () => {
    // user turn 含表格语法也不应被渲染——它靠 ❯ 标记区分，buildHistoryLines
    // 里 user 分支不走 markdown 渲染，应原样保留。
    const out = await runResume([
      { role: "user", content: "| a | b |" },
    ]);
    expect(out).toContain("| a | b |");
    // 不应被转成 bullet。
    expect(out).not.toContain("• a");
  });
});

describe("composer draft stays visible during a busy turn (shadow-buffer regression)", () => {
  // Regression for a bug where a block-local `let buffer` inside the
  // interactive-input block shadowed the outer draft binding that the
  // streaming / activity repaint callbacks close over. While a turn ran, every
  // streaming token repainted the composer from the outer binding (stuck at
  // ""), so the docked composer snapped back to the placeholder and hid what
  // the user was typing — even though the submit path read the inner binding
  // and therefore "worked".
  //
  // The assertion inspects the LAST composer repaint frame (repaintAt writes
  // `\x1b[<row>;1H` then `\x1b[J` then the composer text) WHILE the turn is
  // still busy. Holding the turn open is essential: if we let the turn end,
  // exitOutputMode() repaints from the inner buffer and would mask the bug by
  // drawing the draft after the fact.
  test("a streaming repaint mid-turn shows the typed draft, not the placeholder", async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY?: boolean;
      setRawMode?: (mode: boolean) => void;
    };
    const output = new PassThrough() as PassThrough & {
      isTTY?: boolean;
      rows?: number;
      columns?: number;
    };
    input.isTTY = true;
    output.isTTY = true;
    output.rows = TERM_ROWS;
    output.columns = TERM_COLS;
    input.setRawMode = () => {};

    const chunks: Uint8Array[] = [];
    output.on("data", (chunk) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });

    const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

    let turnCount = 0;
    let resolveTail: (() => void) | null = null;
    let resolveHold: (() => void) | null = null;
    const tailGate = new Promise<void>((r) => {
      resolveTail = r;
    });
    const holdGate = new Promise<void>((r) => {
      resolveHold = r;
    });

    const DRAFT = "draftXYZ";

    const workspacePromise = startTuiWorkspace({
      scriptDir: "",
      input,
      output,
      env: {},
      agentRunner: async (opt) => {
        turnCount++;
        if (turnCount === 1) {
          // Head token: outer-scope repaint while the draft is still empty.
          opt.output.write("HEAD-token");
          await tick(20);
          // Pause mid-turn so the test can type into the composer while busy.
          await tailGate;
          // The test has typed DRAFT by now. This token flows through the
          // history-stream callback -> fixedInput.repaint(outerBuffer). With the
          // shadow bug the outer buffer is "" and the composer redraws as the
          // placeholder; with the fix it carries DRAFT.
          opt.output.write("TAIL-token");
          await tick(20);
          // Keep the turn busy so exitOutputMode() cannot run yet.
          await holdGate;
        }
        return { exitCode: 0, dialogId: "test-dialog" };
      },
    });

    // Start turn 1 -> enters busy.
    input.write("start turn 1\r");
    while (turnCount < 1) await tick(10);
    await tick(30); // HEAD streamed + repainted; composer currently placeholder

    // Type a draft while busy (NO carriage return -> not submitted).
    input.write(DRAFT);
    await tick(40); // onKey appended DRAFT to the draft buffer + repainted

    // Trigger an outer-scope repaint now that the draft exists.
    resolveTail!();
    await tick(40); // TAIL streamed -> its repaint is the last \x1b[J frame

    // The history-stream callback runs renderHistoryToOutput() and then
    // fixedInput.repaint(), and nothing writes after that while the turn is
    // held, so splitting on the clear sequence and taking the last segment
    // (ANSI stripped) yields the authoritative, most-recent composer chrome.
    const all = Buffer.concat(chunks).toString("utf8");
    const frames = all.split("\x1b[J");
    const lastFrame = stripAnsi(frames[frames.length - 1] ?? "");

    // The typed draft must survive the streaming repaint...
    expect(lastFrame).toContain(DRAFT);
    // ...and the placeholder must NOT have overwritten it.
    expect(lastFrame).not.toContain(t("placeholder").slice(0, 12));

    // Tear down: release the busy turn, then exit.
    resolveHold!();
    await tick(30);
    input.write("/exit\r");
    input.end();
    await Promise.race([workspacePromise, tick(3000)]);
  });
});

// 缺陷 B：Esc 即时反馈 + 第二次 Esc 强制停止。
// 这些测试用 startTuiWorkspace + agentRunner 驱动，模拟真实 TUI 的 Esc 按键
// 流和迟到的 runAgentChat 返回，验证 busyLock 解除和迟到返回值被丢弃。
describe("Esc 即时反馈与强制停止", () => {
  type FakeInput = PassThrough & {
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => void;
  };
  type FakeOutput = PassThrough & {
    isTTY?: boolean;
    rows?: number;
    columns?: number;
  };

  const makeStreams = () => {
    const input = new PassThrough() as FakeInput;
    const output = new PassThrough() as FakeOutput;
    input.isTTY = true;
    output.isTTY = true;
    output.rows = TERM_ROWS;
    output.columns = TERM_COLS;
    input.setRawMode = () => {};
    const chunks: Uint8Array[] = [];
    output.on("data", (chunk) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    return { input, output, chunks, stdout: () => Buffer.concat(chunks).toString("utf8") };
  };

  test("第二次 Esc 后 busyLock 解除、composer 可再次输入", async () => {
    const { input, output, stdout } = makeStreams();
    const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

    let turnCount = 0;
    let resolveHold: (() => void) | null = null;
    const holdGate = new Promise<void>((r) => { resolveHold = r; });

    const workspacePromise = startTuiWorkspace({
      scriptDir: "",
      input,
      output,
      env: {},
      agentRunner: async (opt) => {
        turnCount++;
        opt.output.write("working");
        await tick(20);
        // 把 turn 挂住，模拟还在跑。测试期间发两次 Esc 强制停止。
        await holdGate;
        return { exitCode: 0, dialogId: "test-dialog" };
      },
    });

    // 启动 turn 1
    input.write("start\r");
    while (turnCount < 1) await tick(10);
    await tick(40);

    // 第一次 Esc：协作停止 + 即时反馈（markStopping）
    input.write("\x1b");
    await tick(40);
    // 第二次 Esc：强制停止，busyLock 解除
    input.write("\x1b");
    await tick(60);

    const out = stripAnsi(stdout());
    // 强制停止提示出现
    expect(out).toContain(t("forceStopped"));

    // busyLock 解除后，用户可以输入（不提交，只验证 composer 接受输入不卡死）。
    // 发一个普通字符，不应被 busyLock 拦截。无法直接读 busy 变量，但能验证
    // composer 重绘发生了（forceStopped 提示后有 composer frame）。
    input.write("x");
    await tick(40);
    // 能输入说明 busy 已解除——如果 busy 仍锁着，Enter 会走 queue 而非 submit。
    // 这里验证发 Enter 能启动新 turn（turnCount 变 2），证明 busyLock 解除。
    input.write("\r");
    let waited = 0;
    while (turnCount < 2 && waited < 2000) {
      await tick(20);
      waited += 20;
    }
    expect(turnCount).toBe(2);

    // 清理：释放第二个 turn 的 hold，然后退出。
    resolveHold!();
    await tick(30);
    input.write("/exit\r");
    input.end();
    await Promise.race([workspacePromise, tick(3000)]);
  });

  test("强制停止后迟到的 runAgentChat 返回值被丢弃：不重复打印 turnStopped", async () => {
    // 这是本任务最容易出错的地方：强制停止后 activeTurnAbort 已被清空、
    // busyLock 已解除，但 runAgentChat 的 await 仍会在稍后返回。返回值走
    // runOneAgentTurn 的收尾段时，必须被 forcedStop epoch 分支丢弃：
    // 不读已 null 的 activeTurnAbort（NPE）、不打印 turnStopped（重复）、
    // 不重绘（污染用户可能已开始的新输入）。
    const { input, output, stdout } = makeStreams();
    const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

    let turnCount = 0;
    let resolveHold: (() => void) | null = null;
    const holdGate = new Promise<void>((r) => { resolveHold = r; });

    const workspacePromise = startTuiWorkspace({
      scriptDir: "",
      input,
      output,
      env: {},
      agentRunner: async (opt) => {
        turnCount++;
        opt.output.write("working");
        await tick(20);
        // 挂住 turn，让测试先强制停止，再释放让迟到返回值流入。
        await holdGate;
        return { exitCode: 0, dialogId: "late-dialog" };
      },
    });

    input.write("start\r");
    while (turnCount < 1) await tick(10);
    await tick(40);

    // 两次 Esc 强制停止
    input.write("\x1b");
    await tick(40);
    input.write("\x1b");
    await tick(60);

    // 注意：emitCommandOutput 把 forceStopped 写进 history，之后每次
    // renderHistory 重绘都会重新输出该行，所以输出流里 forceStopped 文本
    // 会出现多次（每帧一次）。用「释放 hold 前后的增量」判定迟到返回值是否
    // 又打印了新的提示，而非绝对出现次数。
    const outBefore = stripAnsi(stdout());
    const forceStoppedBefore = countOccurrences(outBefore, t("forceStopped"));
    const turnStoppedBefore = countOccurrences(outBefore, t("turnStopped"));
    // 强制停止已发生：forceStopped 至少出现一次。
    expect(forceStoppedBefore).toBeGreaterThanOrEqual(1);
    // 强制停止时不打印 turnStopped。
    expect(turnStoppedBefore).toBe(0);

    // 现在释放 hold，让迟到的 runAgentChat 返回。返回值走 forcedStop 分支，
    // 必须被丢弃——不重复打印 turnStopped、不新增 forceStopped。
    resolveHold!();
    await tick(80);

    const outAfter = stripAnsi(stdout());
    const forceStoppedAfter = countOccurrences(outAfter, t("forceStopped"));
    const turnStoppedAfter = countOccurrences(outAfter, t("turnStopped"));

    // 迟到返回值不应增加任何停止提示的打印次数（可能因重绘次数变化而
    // 有少量波动，但 turnStopped 必须仍为 0——它根本没被 emitCommandOutput
    // 调用过，所以无论重绘多少次都不该出现）。
    expect(turnStoppedAfter).toBe(0);
    // forceStopped 增量应为 0：迟到返回值不应再 emitCommandOutput(forceStopped)。
    // 允许重绘导致的帧数波动，但新增 emit 调用会让文本作为新行追加，次数跳增。
    // 这里用「不显著增加」判定：迟到返回值的 forcedStop 分支只做 state 折叠，
    // 不调 emitCommandOutput，所以 forceStopped 的出现应只来自重绘（帧数不变
    // 则次数不变）。
    expect(forceStoppedAfter).toBe(forceStoppedBefore);

    // 清理
    input.write("/exit\r");
    input.end();
    await Promise.race([workspacePromise, tick(3000)]);
  });

  test("第一次 Esc 显示停止中文案（即时反馈），不打印 turnStopped", async () => {
    const { input, output, stdout } = makeStreams();
    const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

    let turnCount = 0;
    let resolveHold: (() => void) | null = null;
    const holdGate = new Promise<void>((r) => { resolveHold = r; });

    const workspacePromise = startTuiWorkspace({
      scriptDir: "",
      input,
      output,
      env: {},
      agentRunner: async (opt) => {
        turnCount++;
        opt.output.write("working");
        await tick(20);
        await holdGate;
        return { exitCode: 0, dialogId: "test-dialog" };
      },
    });

    input.write("start\r");
    while (turnCount < 1) await tick(10);
    await tick(40);

    // 第一次 Esc：markStopping 即时反馈
    input.write("\x1b");
    await tick(60);

    const out = stripAnsi(stdout());
    // 停止中文案出现在活动行
    expect(out).toContain(t("turnStopping"));
    // turnStopped 要等链路 unwind，此刻还没打印
    expect(out).not.toContain(t("turnStopped"));

    // 清理：直接释放（不再发第二次 Esc，走正常 abort 收尾）
    resolveHold!();
    await tick(60);
    input.write("/exit\r");
    input.end();
    await Promise.race([workspacePromise, tick(3000)]);
  });

  test("abort 时带 pendingToolName：打印带工具名的提示，不打印 turnStopped", async () => {
    const { input, output, stdout } = makeStreams();
    const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

    let turnCount = 0;
    let resolveHold: (() => void) | null = null;
    const holdGate = new Promise<void>((r) => { resolveHold = r; });

    const workspacePromise = startTuiWorkspace({
      scriptDir: "",
      input,
      output,
      env: {},
      agentRunner: async (opt) => {
        turnCount++;
        opt.output.write("working");
        await tick(20);
        await holdGate;
        return {
          exitCode: 0,
          dialogId: "test-dialog",
          pendingToolName: "editFile",
        };
      },
    });

    input.write("start\r");
    while (turnCount < 1) await tick(10);
    await tick(40);

    // 第一次 Esc：协作中止，释放 hold 让 runAgentChat 带 pendingToolName 返回。
    input.write("\x1b");
    await tick(60);
    resolveHold!();
    await tick(80);

    const out = stripAnsi(stdout());
    // 带工具名的协作中止提示出现；原 turnStopped 不再打印。
    expect(out).toContain(t("turnStoppedToolPending", "editFile"));
    expect(out).not.toContain(t("turnStopped"));

    // 清理
    input.write("/exit\r");
    input.end();
    await Promise.race([workspacePromise, tick(3000)]);
  });

  test("abort 时无 pendingToolName：仍打印原 turnStopped", async () => {
    const { input, output, stdout } = makeStreams();
    const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

    let turnCount = 0;
    let resolveHold: (() => void) | null = null;
    const holdGate = new Promise<void>((r) => { resolveHold = r; });

    const workspacePromise = startTuiWorkspace({
      scriptDir: "",
      input,
      output,
      env: {},
      agentRunner: async (opt) => {
        turnCount++;
        opt.output.write("working");
        await tick(20);
        await holdGate;
        return { exitCode: 0, dialogId: "test-dialog" };
      },
    });

    input.write("start\r");
    while (turnCount < 1) await tick(10);
    await tick(40);

    // 第一次 Esc：协作中止，释放 hold，返回不带 pendingToolName。
    input.write("\x1b");
    await tick(60);
    resolveHold!();
    await tick(80);

    const out = stripAnsi(stdout());
    // 原 turnStopped 照旧打印；带工具名的提示不出现。
    expect(out).toContain(t("turnStopped"));
    expect(out).not.toContain(t("turnStoppedToolPending", "editFile"));

    // 清理
    input.write("/exit\r");
    input.end();
    await Promise.race([workspacePromise, tick(3000)]);
  });
});

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

// --- alternate screen (DECSET 1049) integration ---------------------------
// These drive startTuiWorkspace end-to-end to verify the alternate-screen
// isolation layer is wired into the real startup sequence and the
// /altscreen runtime toggle, plus the process-handler registration guard.
function makeTtyIo() {
  const input = new PassThrough() as PassThrough & {
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => void;
  };
  const output = new PassThrough() as PassThrough & {
    isTTY?: boolean;
    rows?: number;
    columns?: number;
  };
  input.isTTY = true;
  output.isTTY = true;
  output.rows = TERM_ROWS;
  output.columns = TERM_COLS;
  input.setRawMode = () => {};
  const chunks: Uint8Array[] = [];
  output.on("data", (chunk) => {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  });
  return { input, output, chunks, stdout: () => Buffer.concat(chunks).toString("utf8") };
}

describe("alternate screen isolation (startTuiWorkspace)", () => {
  test("TTY 启动写 ?1049h 且启动序列不再含 \\x1b[3J", async () => {
    // 覆盖测试要求 1（启动）+ 4（3J 被删）。启动序列里必须有 ?1049h，
    // 绝不能有 \x1b[3J（它会清主屏 scrollback，切到备用屏后是无意义且有害的）。
    const { input, output, stdout } = makeTtyIo();
    const workspacePromise = startTuiWorkspace({
      scriptDir: "",
      input,
      output,
      env: {},
      agentRunner: async () => ({ exitCode: 0, dialogId: "d" }),
    });
    // 等启动 banner + 清屏序列落地。
    await new Promise((r) => setTimeout(r, 60));
    const out = stdout();
    expect(out).toContain("\x1b[?1049h");
    expect(out).not.toContain("\x1b[3J");
    input.write("/exit\r");
    input.end();
    await Promise.race([workspacePromise, new Promise((r) => setTimeout(r, 3000))]);
  });

  test("/altscreen off 写 ?1049l 且触发历史重绘；on 反之", async () => {
    // 覆盖测试要求 5。off → 写 ?1049l 并重绘历史（否则切过去是空屏），
    // on → 写 ?1049h。同时验证反馈文案出现。
    const { input, output, stdout } = makeTtyIo();
    let resolveFirst: (() => void) | null = null;
    const firstTurn = new Promise<void>((r) => { resolveFirst = r; });
    let turnCount = 0;
    const workspacePromise = startTuiWorkspace({
      scriptDir: "",
      input,
      output,
      env: {},
      agentRunner: async (opt) => {
        turnCount++;
        opt.output.write(`reply ${turnCount}`);
        resolveFirst!();
        return { exitCode: 0, dialogId: "d" };
      },
    });
    // 发一条消息产生一个 assistant turn，让历史里有点东西可重绘。
    input.write("hello\r");
    while (turnCount < 1) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 40));

    // off：必须写 ?1049l 并出现 altscreenOff 文案。
    input.write("/altscreen off\r");
    await new Promise((r) => setTimeout(r, 60));
    let out = stdout();
    expect(out).toContain("\x1b[?1049l");
    expect(out).toContain(t("altscreenOff"));

    // on：必须写 ?1049h 并出现 altscreenOn 文案，且重绘（composer 状态行
    // 🏔 在 altscreenOn 文案之后再次出现，证明 repaint 被调用，而非空屏）。
    input.write("/altscreen on\r");
    await new Promise((r) => setTimeout(r, 60));
    out = stdout();
    expect(out).toContain("\x1b[?1049h");
    expect(out).toContain(t("altscreenOn"));
    // 重绘落地：切回 on 后历史内容仍在输出里（证明 renderHistoryToOutput 被调）。
    expect(out).toContain("reply 1");
    // composer 重绘证据：?1049h 之后必须出现一次 🏔 状态行（action handler 的
    // renderHistoryToOutput+repaint 在切屏后才补绘，证明切过去不是空屏）。
    const onSeqIdx = out.lastIndexOf("\x1b[?1049h");
    expect(onSeqIdx).toBeGreaterThanOrEqual(0);
    const statusAfterOn = out.indexOf("🏔", onSeqIdx);
    expect(statusAfterOn, "composer 应在切到备用屏后重绘").toBeGreaterThan(onSeqIdx);

    input.write("/exit\r");
    input.end();
    await Promise.race([workspacePromise, new Promise((r) => setTimeout(r, 3000))]);
  });

  test("Ctrl+L (\\x0c) triggers full redraw of history and composer", async () => {
    const { input, output, stdout } = makeTtyIo();
    let turnCount = 0;
    const workspacePromise = startTuiWorkspace({
      scriptDir: "",
      input,
      output,
      env: {},
      agentRunner: async (opt) => {
        turnCount += 1;
        opt.output.write(`reply ${turnCount}`);
        return {
          exitCode: 0,
          dialogId: "d",
        };
      },
    });

    await new Promise((r) => setTimeout(r, 40));
    input.write("hello\r");
    while (turnCount < 1) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 40));

    const baselineOut = stdout();
    expect(baselineOut).toContain("reply 1");

    // Send Ctrl+L (\x0c)
    input.write("\x0c");
    await new Promise((r) => setTimeout(r, 50));
    const outAfterRedraw = stdout();

    // Must have repainted the full screen from row 1 and forced composer redraw
    expect(outAfterRedraw).toContain("\x1b[1;1H");
    expect(outAfterRedraw).toContain("reply 1");
    expect(outAfterRedraw).toContain("\x1b[J");
    expect(outAfterRedraw).toContain("🏔");

    input.write("/exit\r");
    input.end();
    await Promise.race([workspacePromise, new Promise((r) => setTimeout(r, 3000))]);
  });

  test("信号 handler 注册防重复：多次 TTY 启动后 listener 数不增长", async () => {
    // 覆盖测试要求 7。readlineWorkspace 可能在测试/重入里多次调用入口；
    // process 监听器必须只注册一次，否则 Node 报 MaxListenersExceededWarning。
    const before = process.listenerCount("exit") +
      process.listenerCount("SIGINT") +
      process.listenerCount("SIGTERM") +
      process.listenerCount("SIGHUP");
    // 跑两次启动-退出周期。
    for (let i = 0; i < 2; i++) {
      const { input, output } = makeTtyIo();
      const wp = startTuiWorkspace({
        scriptDir: "",
        input,
        output,
        env: {},
        agentRunner: async () => ({ exitCode: 0, dialogId: "d" }),
      });
      await new Promise((r) => setTimeout(r, 40));
      input.write("/exit\r");
      input.end();
      await Promise.race([wp, new Promise((r) => setTimeout(r, 3000))]);
    }
    const after = process.listenerCount("exit") +
      process.listenerCount("SIGINT") +
      process.listenerCount("SIGTERM") +
      process.listenerCount("SIGHUP");
    // 第二次启动不应新增任何 listener（install 是幂等的）。
    expect(after).toBe(before);
  });
});

// --- alternate screen signal / crash exit semantics ----------------------
// These run real signals through a subprocess (Bun.spawn) so the test runner
// itself is never killed. Each probe installs the real handlers, then the
// parent sends a real signal / waits for a crash and asserts the exit code
// and stderr output. The probe lives at packages/cli/tui/__altScreenSigProbe.ts.

const PROBE_PATH = join(import.meta.dir, "__altScreenSigProbe.ts");

/** Spawn the probe and expose a `ready` promise that resolves once the
 *  child prints "ready\n" (handlers installed). Callers should `await ready`
 *  before sending signals instead of relying on a fixed delay. */
function spawnProbe(mode: string): {
  child: ReturnType<typeof spawn>;
  ready: Promise<void>;
  exited: Promise<{ code: number | null; stderr: string }>;
} {
  const child = spawn({
    cmd: ["bun", "run", PROBE_PATH, mode],
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  let resolveReady!: () => void;
  const ready = new Promise<void>((r) => { resolveReady = r; });
  const exited = (async () => {
    const stderr = Bun.readableStreamToText(child.stderr);
    // Drain stdout until "ready" appears (handlers installed) or proc exits.
    const stdoutReader = child.stdout.getReader();
    let buf = "";
    while (true) {
      const { value, done } = await stdoutReader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      if (buf.includes("ready\n")) { resolveReady(); break; }
    }
    const res = await child.exited;
    const stderrText = await stderr;
    return { code: res, stderr: stderrText };
  })();
  return { child, ready, exited };
}

describe("altScreen signal/crash exit semantics (subprocess)", () => {
  test("SIGTERM 无既有 listener → 恢复后以 143 退出（不挂住）", async () => {
    const { child, ready, exited } = spawnProbe("install");
    await ready;
    process.kill(child.pid!, "SIGTERM");
    const { code } = await Promise.race([
      exited,
      new Promise<{ code: number | null }>((_, rej) =>
        setTimeout(() => rej(new Error("timeout")), 4000)
      ),
    ]);
    expect(code).toBe(143);
  });

  test("SIGINT 无既有 listener → 恢复后以 130 退出", async () => {
    const { child, ready, exited } = spawnProbe("install");
    await ready;
    process.kill(child.pid!, "SIGINT");
    const { code } = await Promise.race([
      exited,
      new Promise<{ code: number | null }>((_, rej) =>
        setTimeout(() => rej(new Error("timeout")), 4000)
      ),
    ]);
    expect(code).toBe(130);
  });

  test("SIGHUP 无既有 listener → 恢复后以 129 退出", async () => {
    const { child, ready, exited } = spawnProbe("install");
    await ready;
    process.kill(child.pid!, "SIGHUP");
    const { code } = await Promise.race([
      exited,
      new Promise<{ code: number | null }>((_, rej) =>
        setTimeout(() => rej(new Error("timeout")), 4000)
      ),
    ]);
    expect(code).toBe(129);
  });

  test("有既有 SIGINT listener → 该 listener 恰好执行一次（不是两次）", async () => {
    const { child, ready, exited } = spawnProbe("install+listener");
    await ready;
    process.kill(child.pid!, "SIGINT");
    const { code, stderr } = await Promise.race([
      exited,
      new Promise<{ code: number | null; stderr: string }>((_, rej) =>
        setTimeout(() => rej(new Error("timeout")), 4000)
      ),
    ]);
    // The pre-existing listener exits with its run-count as the code.
    // Exactly-once => exit code 1. If our handler had auto-exited on empty
    // cached (the snapshot-miss bug) the code would be 130 and the listener
    // never runs. If double-fired, the listener exits on call #1 so a second
    // call is impossible — but the stderr marker "listener-runs=1" appears
    // exactly once, confirming no double-fire.
    expect(code).toBe(1);
    const runs = stderr.match(/listener-runs=(\d+)/g) ?? [];
    expect(runs.length, `stderr: ${JSON.stringify(stderr)}`).toBe(1);
    expect(runs[0]).toBe("listener-runs=1");
  });

  test("uncaughtException → 打印错误信息并以非 0 退出", async () => {
    const { child, ready, exited } = spawnProbe("throw");
    const { code, stderr } = await Promise.race([
      exited,
      new Promise<{ code: number | null; stderr: string }>((_, rej) =>
        setTimeout(() => rej(new Error("timeout")), 4000)
      ),
    ]);
    expect(code).not.toBe(0);
    expect(code).not.toBe(null);
    expect(stderr).toContain("uncaughtException:");
    expect(stderr).toContain("probe-boom");
  });
});

describe("restoreAltScreen error guard", () => {
  test("output 已销毁时不抛（写失败静默跳过）", () => {
    // restoreAltScreen is not exported; it is registered on the "exit" event
    // by installAltScreenRestoreHandlers. We point altScreenRestoreOutput at a
    // destroyed TTY-named stream, flip the altScreenOn flag via enterAltScreen,
    // then emit "exit" — restoreAltScreen will try to write the leave sequence
    // to a destroyed stream, which throws synchronously in Node. The try/catch
    // guard must swallow it so the test does not throw.
    const stream = new PassThrough();
    (stream as { isTTY?: boolean }).isTTY = true;
    enterAltScreen(stream); // sets altScreenOn=true, writes ?1049h
    stream.destroy();
    installAltScreenRestoreHandlers(stream); // sets altScreenRestoreOutput=stream
    expect(() => process.emit("exit", 0)).not.toThrow();
  });
});

describe("readlineWorkspace paste store clearance contract", () => {
  test("clearCollapsedPasteStore is invoked on pick-dialog selection success", async () => {
    const code = readFileSync(
      join(import.meta.dir, "readlineWorkspace.ts"),
      "utf8",
    );
    const pickDialogBlock = code.slice(
      code.indexOf('result.action?.type === "pick-dialog"'),
      code.indexOf('result.action?.type === "list-agents"'),
    );
    expect(pickDialogBlock).toContain("clearCollapsedPasteStore(pasteStore)");
  });
});

describe("terminal window title sync", () => {
  test("emits OSC window title sequences when output is TTY and NOLO_TUI_TITLE is not 0/false", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    (output as any).isTTY = true;
    (output as any).rows = TERM_ROWS;
    (output as any).columns = TERM_COLS;

    const chunks: string[] = [];
    output.on("data", (chunk) => {
      chunks.push(chunk.toString());
    });

    const workspacePromise = startTuiWorkspace({
      scriptDir: "",
      input,
      output,
      env: {},
    });

    input.write("/exit\r");
    await workspacePromise;

    const fullOutput = chunks.join("");
    expect(fullOutput).toContain("\x1b]0;new\x07\x1b]2;new\x07");
  });

  test("does not emit OSC window title sequences when NOLO_TUI_TITLE is set to 0 or false", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    (output as any).isTTY = true;
    (output as any).rows = TERM_ROWS;
    (output as any).columns = TERM_COLS;

    const chunks: string[] = [];
    output.on("data", (chunk) => {
      chunks.push(chunk.toString());
    });

    const workspacePromise = startTuiWorkspace({
      scriptDir: "",
      input,
      output,
      env: { NOLO_TUI_TITLE: "0" },
    });

    input.write("/exit\r");
    await workspacePromise;

    const fullOutput = chunks.join("");
    expect(fullOutput).not.toContain("\x1b]0;");
    expect(fullOutput).not.toContain("\x1b]2;");
  });

  test("LLM 总结标题后台 patch 完成后立即刷新窗口标题（不等下一轮）", async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY?: boolean;
      setRawMode?: (mode: boolean) => void;
    };
    const output = new PassThrough() as PassThrough & {
      isTTY?: boolean;
      rows?: number;
      columns?: number;
    };
    input.isTTY = true;
    input.setRawMode = () => {};
    output.isTTY = true;
    output.rows = TERM_ROWS;
    output.columns = TERM_COLS;

    const chunks: string[] = [];
    output.on("data", (chunk) => {
      chunks.push(chunk.toString());
    });

    // 模拟 saveTurn 的 fire-and-forget：turn 返回时只有 fallback title，
    // LLM 总结标题稍后才 resolve（后台 patch 完成）。
    let releasePatch: ((title: string | null) => void) | null = null;
    const titlePatchPromise = new Promise<string | null>((resolve) => {
      releasePatch = resolve;
    });

    const workspacePromise = startTuiWorkspace({
      scriptDir: "",
      input,
      output,
      env: {},
      agentRunner: async () => ({
        exitCode: 0,
        dialogId: "d-title-patch",
        title: "fallback title",
        titlePatchPromise,
      }),
    });

    // 第一轮 turn：窗口标题先显示 fallback（saveTurn 返回值）。
    input.write("hello\r");
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (chunks.join("").includes("\x1b]0;fallback title\x07")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(chunks.join("")).toContain("\x1b]0;fallback title\x07");

    // 释放后台 patch：窗口标题应立即变成 LLM 总结标题，无需再发一轮。
    releasePatch!("LLM 总结标题");
    const deadline2 = Date.now() + 5000;
    while (Date.now() < deadline2) {
      if (chunks.join("").includes("\x1b]0;LLM 总结标题\x07")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(chunks.join("")).toContain("\x1b]0;LLM 总结标题\x07");

    input.write("/exit\r");
    await workspacePromise;
  });

  test("patch 悬挂期间 /new 切走：释放后旧 dialog 标题不写入窗口标题（串台保护）", async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY?: boolean;
      setRawMode?: (mode: boolean) => void;
    };
    const output = new PassThrough() as PassThrough & {
      isTTY?: boolean;
      rows?: number;
      columns?: number;
    };
    input.isTTY = true;
    input.setRawMode = () => {};
    output.isTTY = true;
    output.rows = TERM_ROWS;
    output.columns = TERM_COLS;

    const chunks: string[] = [];
    output.on("data", (chunk) => {
      chunks.push(chunk.toString());
    });

    // 旧 dialog 的 title patch 悬挂：turn 已返回 fallback，LLM 标题迟迟未 resolve。
    let releasePatch: ((title: string | null) => void) | null = null;
    const titlePatchPromise = new Promise<string | null>((resolve) => {
      releasePatch = resolve;
    });

    const workspacePromise = startTuiWorkspace({
      scriptDir: "",
      input,
      output,
      env: {},
      agentRunner: async () => ({
        exitCode: 0,
        dialogId: "d-old",
        title: "old fallback",
        titlePatchPromise,
      }),
    });

    // 第一轮 turn 完成：窗口标题 = 旧 dialog 的 fallback。
    input.write("hello\r");
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (chunks.join("").includes("\x1b]0;old fallback\x07")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(chunks.join("")).toContain("\x1b]0;old fallback\x07");

    // patch 仍悬挂时用户 /new 切走：窗口标题切到新 dialog（t("newDialog")）。
    input.write("/new\r");
    const deadline2 = Date.now() + 5000;
    while (Date.now() < deadline2) {
      if (chunks.join("").includes("\x1b]0;新对话\x07")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(chunks.join("")).toContain("\x1b]0;新对话\x07");

    // 释放旧 dialog 的 patch：dialogId 校验应挡住，窗口标题不得变回旧标题。
    releasePatch!("old dialog LLM title");
    await new Promise((r) => setTimeout(r, 300));
    const afterRelease = chunks.join("");
    expect(afterRelease).not.toContain("old dialog LLM title");

    input.write("/exit\r");
    await workspacePromise;
  });
});

/** Point NOLO_HOME at a fresh temp dir for the duration of the callback. */
async function withNoloHomeDir(): Promise<{ dir: string; tmp: string; restore: () => void }> {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "nolo-run-wake-test-"));
  const prev = process.env.NOLO_HOME;
  process.env.NOLO_HOME = dir;
  const restore = () => {
    if (prev === undefined) delete process.env.NOLO_HOME;
    else process.env.NOLO_HOME = prev;
  };
  return { dir, tmp: dir, restore };
}

// 终态唤醒（runCompletionWatcher → runRegistryPoller → workspace）的端到端
// 接线测试。整条链用真家伙驱动：真 poller（1s 真实 interval）、真
// ~/.nolo/runs/*.json（写入临时 NOLO_HOME）、真 dock 订阅——只有 agentRunner
// 是假的。所以每个用例都要等得起「下一轮 tick」（最长 ~1s）。
describe("run completion wake (TUI 终态唤醒)", () => {
  /** 等 cond 为真，最长 timeoutMs。 */
  async function waitFor(cond: () => boolean, timeoutMs = 6000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  function makeIo() {
    const input = new PassThrough() as PassThrough & {
      isTTY?: boolean;
      setRawMode?: (mode: boolean) => void;
    };
    const output = new PassThrough() as PassThrough & {
      isTTY?: boolean;
      rows?: number;
      columns?: number;
    };
    input.isTTY = true;
    output.isTTY = true;
    output.rows = TERM_ROWS;
    output.columns = TERM_COLS;
    input.setRawMode = () => {};
    const chunks: Uint8Array[] = [];
    output.on("data", (chunk) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    return { input, output, chunks };
  }

  function makeRecordWriter(dir: string, runId: string, parentDialogId: string) {
    return async (status: string) => {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const runsDir = join(dir, "runs");
      mkdirSync(runsDir, { recursive: true });
      writeFileSync(
        join(runsDir, `${runId}.json`),
        JSON.stringify({
          runId,
          agentKey: "agent-user-worker",
          agentName: "Worker",
          startedAt: new Date().toISOString(),
          status,
          logPath: join(runsDir, `${runId}.log`),
          parentDialogId,
          ...(status !== "running"
            ? { endedAt: new Date().toISOString(), exitCode: 0 }
            : {}),
        })
      );
    };
  }

  test("run 干完时对话正在进行：唤醒消息入队，当前 turn 结束后自动继续", async () => {
    const { dir, restore } = await withNoloHomeDir();
    try {
      const writeRecord = await makeRecordWriter(dir, "run-wake-1", "dlg-wake");
      const { input, output } = makeIo();
      let turnCount = 0;
      const turnsProcessed: string[] = [];
      let releaseSecondTurn: (() => void) | null = null;
      const secondTurnGate = new Promise<void>((resolve) => {
        releaseSecondTurn = resolve;
      });

      const workspacePromise = startTuiWorkspace({
        scriptDir: "",
        input,
        output,
        env: {},
        agentRunner: async (opt: any) => {
          turnCount++;
          turnsProcessed.push(opt.message);
          if (turnCount === 2) {
            // 这一轮扮演「派发」：落一条 running 记录 + 把 run 挂上面板
            // （onAgentRunStatus 是 dock 的模型侧入口，也是 poller 的起表信号），
            // 然后挂住不放，模拟 turn 进行中。
            await writeRecord("running");
            opt.onAgentRunStatus?.({
              runId: "run-wake-1",
              status: "running",
              agentName: "Worker",
              logKey: "",
            });
            await secondTurnGate;
          }
          return { exitCode: 0, dialogId: "dlg-wake" };
        },
      } as any);

      // turn 1：建立 dialogId = dlg-wake。
      input.write("hello\r");
      await waitFor(() => turnCount === 1);
      // 等 turn 1 的收尾（busy 释放）完成再发下一轮。
      await new Promise((r) => setTimeout(r, 200));

      // turn 2：派发并挂住 → busy。
      input.write("dispatch\r");
      await waitFor(() => turnCount === 2);
      // 等至少一轮 poller tick，让 watcher 先观测到 running（转变检测的前提）。
      await new Promise((r) => setTimeout(r, 1300));

      // run 在 turn 2 进行中干完了。
      await writeRecord("done");
      // 等一轮 tick：watcher 应当检测到 done 并触发唤醒——但 busy，所以只能入队，
      // 绝不能就地开第三个 turn。
      await new Promise((r) => setTimeout(r, 1500));
      expect(turnCount).toBe(2);

      // 当前 turn 结束 → notifyTurnEnd 的 drain 把唤醒消息作为新 turn 跑。
      releaseSecondTurn!();
      await waitFor(() => turnCount === 3);
      expect(turnsProcessed[2]).toContain("run-wake-1");
      expect(turnsProcessed[2]).toContain("终态");
      expect(turnsProcessed[2]).toContain("done");

      input.write("/exit\r");
      input.end();
      await Promise.race([
        workspacePromise,
        new Promise((r) => setTimeout(r, 3000)),
      ]);
    } finally {
      restore();
    }
  }, 20000);

  test("run 干完时对话空闲：唤醒消息直接作为新 turn 跑", async () => {
    const { dir, restore } = await withNoloHomeDir();
    try {
      const writeRecord = await makeRecordWriter(dir, "run-wake-2", "dlg-wake-2");
      const { input, output } = makeIo();
      let turnCount = 0;
      const turnsProcessed: string[] = [];

      const workspacePromise = startTuiWorkspace({
        scriptDir: "",
        input,
        output,
        env: {},
        agentRunner: async (opt: any) => {
          turnCount++;
          turnsProcessed.push(opt.message);
          if (turnCount === 2) {
            await writeRecord("running");
            opt.onAgentRunStatus?.({
              runId: "run-wake-2",
              status: "running",
              agentName: "Worker",
              logKey: "",
            });
          }
          return { exitCode: 0, dialogId: "dlg-wake-2" };
        },
      } as any);

      input.write("hello\r");
      await waitFor(() => turnCount === 1);
      await new Promise((r) => setTimeout(r, 200));
      input.write("dispatch\r");
      await waitFor(() => turnCount === 2);
      // turn 2 收尾 + 一轮 tick 观测 running。
      await new Promise((r) => setTimeout(r, 1300));

      // 空闲时 run 干完 → 下一个 tick 直接唤醒一个新 turn（不需要任何人按 Enter）。
      await writeRecord("done");
      await waitFor(() => turnCount === 3);
      expect(turnsProcessed[2]).toContain("run-wake-2");
      expect(turnsProcessed[2]).toContain("终态");

      input.write("/exit\r");
      input.end();
      await Promise.race([
        workspacePromise,
        new Promise((r) => setTimeout(r, 3000)),
      ]);
    } finally {
      restore();
    }
  }, 20000);
});

describe("pinned agent notice", () => {
  const appBuilder = {
    agentKey: "agent-pub-01APPBUILDER00000001YAII3I",
    agentName: "应用构建助手",
  } as Parameters<typeof renderPinnedAgentNotice>[0];

  test("names the file a restored non-default agent came from", () => {
    const notice = renderPinnedAgentNotice(appBuilder, {
      NOLO_AGENT_SOURCE: "profile",
    });
    expect(stripAnsi(notice)).toContain("应用构建助手");
    expect(stripAnsi(notice)).toContain("config.json");
    expect(stripAnsi(notice)).toContain("/switch nolo");
    // One line, so the banner's line accounting stays exact.
    expect(notice.endsWith("\n")).toBe(true);
    expect(notice.trimEnd().split("\n")).toHaveLength(1);
  });

  test("tells a missing audit log apart from one that simply aged out", () => {
    const { mkdtempSync, rmSync, writeFileSync } =
      require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    // The audit path is injected rather than resolved from the ambient home:
    // this test writes fixture logs, and `bun test` shares one process across
    // files — resolving the path here is how a fixture ends up in the
    // developer's real ~/.nolo/agent-selection.log.
    const dir = mkdtempSync(join(tmpdir(), "nolo-notice-audit-"));
    const auditPath = join(dir, "agent-selection.log");
    const notice = () =>
      stripAnsi(
        renderPinnedAgentNotice(
          appBuilder,
          { NOLO_AGENT_SOURCE: "profile" },
          auditPath,
        ),
      );
    const writeAudit = (agentKey: string, agentName: string) =>
      writeFileSync(
        auditPath,
        `${JSON.stringify({ next: { agentKey, agentName } })}\n`,
        "utf8",
      );
    try {
      // No log at all → the write predates the audit trail (an older build).
      expect(notice()).toContain(t("agentPinnedUnaudited"));

      // A log whose newest entry is some other agent → the entry aged out or a
      // parallel session wrote it. Blaming an "older build" here would send the
      // reader hunting for a stale binary that isn't there.
      writeAudit("agent-pub-other", "other");
      expect(notice()).toContain(t("agentPinnedAuditRotated"));
      expect(notice()).not.toContain(t("agentPinnedUnaudited"));

      // The matching entry explains itself; no suffix needed.
      writeAudit(appBuilder.agentKey, appBuilder.agentName);
      expect(notice()).not.toContain(t("agentPinnedAuditRotated"));
      expect(notice()).not.toContain(t("agentPinnedUnaudited"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stays silent on the default agent and on an explicit shell agent", () => {
    expect(
      renderPinnedAgentNotice(
        {
          agentKey: "agent-pub-01NOLOAPPBLD000000019KCKT0",
          agentName: "nolo",
        } as Parameters<typeof renderPinnedAgentNotice>[0],
        { NOLO_AGENT_SOURCE: "profile" },
      ),
    ).toBe("");
    expect(renderPinnedAgentNotice(appBuilder, { NOLO_AGENT_SOURCE: "env" })).toBe("");
    expect(renderPinnedAgentNotice(appBuilder, {})).toBe("");
  });

  test("localRuntimeAdapterFactory wires confirmDestructiveAction to created adapters", async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY?: boolean;
      setRawMode?: (mode: boolean) => void;
    };
    const output = new PassThrough() as PassThrough & {
      isTTY?: boolean;
      rows?: number;
      columns?: number;
    };
    output.rows = TERM_ROWS;
    output.columns = TERM_COLS;
    input.setRawMode = () => {};

    const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let factoryReceived: any = null;

    const workspacePromise = startTuiWorkspace({
      scriptDir: "",
      input,
      output,
      env: {},
      agentRunner: async (opt) => {
        if (opt.localRuntimeAdapterFactory) {
          factoryReceived = opt.localRuntimeAdapterFactory(opt.env, { cwd: opt.localRuntimeCwd });
        }
        return { exitCode: 0, dialogId: "test-dialog" };
      },
    });

    input.write("hello\r");
    await tick(100);

    expect(factoryReceived).not.toBeNull();
    expect(typeof factoryReceived.executeTool).toBe("function");

    input.write("/exit\r");
    input.end();
    await Promise.race([workspacePromise, tick(2000)]);
  });
});
