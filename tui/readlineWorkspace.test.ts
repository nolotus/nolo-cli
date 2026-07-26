import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

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
    (tty.output as { rows: number }).rows = 12;
    input.repaint("draft");

    expect(input.isPaused()).toBe(true);
    const composerStart = 12 - EMPTY_COMPOSER_LINES + 1;
    expect(tty.stdout()).toContain(`\x1b[${composerStart};1H`);
    expect(tty.stdout()).toContain("draft");
  });

  test("truncates a long status line instead of wrapping and breaking the composer", () => {
    const tty = mockTty(TERM_ROWS, 40);
    const longStatus =
      "nolo · 🏔 minimax-m3 · local · 📁 ~/very/long/path/to/bun-nolo · ⑂ main *99 · ◫ 0.4%/1M";
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
    expect(stdout).toContain("❯"); // user marker (theme-colored)
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
    expect(splitRawInput("\x1b[?2004hline1\r\nline2\r\nline3\x1b[?2004l")).toEqual([
      "\x00PASTE\x00line1\r\nline2\r\nline3",
    ]);
  });

  test("splits normal characters outside bracketed paste as individual tokens", () => {
    expect(splitRawInput("a\x1b[?2004hline1\r\nline2\x1b[?2004lb")).toEqual([
      "a",
      "\x00PASTE\x00line1\r\nline2",
      "b",
    ]);
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

    // The first turn (no authToken) auto-routes to the fallback tier for a
    // complex message → the GLM-5.2 (quality) tier agent key. That key gets
    // cached against the dialog. The bug: the second turn reused that cached
    // key even after the user switched agents.
    const switchedAgentKey = "agent-pub-01APPBUILDER00000001YAII3I";

    let turnCount = 0;
    const seenAgentKeys: string[] = [];

    const workspacePromise = startTuiWorkspace({
      scriptDir: "",
      input,
      output,
      // No authToken → classifyCliAutoRoute returns the fallback tier without
      // any network call; the routed tier key is still cached per dialog.
      env: {},
      agentRunner: async (opt) => {
        turnCount++;
        seenAgentKeys.push(opt.agentKey);
        opt.output.write(`turn ${turnCount}`);
        return { exitCode: 0, dialogId: "switch-dialog" };
      },
    });

    // Turn 1: a complex-ish message → fallback tier = "quality" (GLM-5.2).
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
    // the cached first-turn (quality) key because autoRouteByDialog overrode
    // the user's /agent switch.
    expect(seenAgentKeys[1]).toBe(switchedAgentKey);
    // And the switch was actually acknowledged to the user.
    expect(Buffer.concat(chunks).toString("utf8")).toContain("Switched to");
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
