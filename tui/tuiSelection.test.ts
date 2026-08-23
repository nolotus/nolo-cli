import { describe, expect, test } from "bun:test";
import {
  applySelectionOverlay,
  areSelectionPointsEqual,
  compareSelectionPoints,
  createSelectionState,
  extractSelectedText,
  highlightLineByColumns,
  hitTestHistory,
  type SelectionPoint,
  type TuiSelectionState,
} from "./tuiSelection";
import {
  createTurnHistory,
  startTurn,
  appendToCurrentTurn,
  finalizeCurrentTurn,
  appendLocalTurn,
  buildHistoryLines,
  buildTurnOffsets,
} from "./tuiHistory";

describe("tuiSelection", () => {
  test("createSelectionState initializes default empty state", () => {
    const state = createSelectionState();
    expect(state.dragging).toBe(false);
    expect(state.anchor).toBeNull();
    expect(state.head).toBeNull();
  });

  test("compareSelectionPoints orders points by globalRow then col", () => {
    const p1: SelectionPoint = { globalRow: 0, col: 5 };
    const p2: SelectionPoint = { globalRow: 0, col: 10 };
    const p3: SelectionPoint = { globalRow: 1, col: 0 };

    expect(compareSelectionPoints(p1, p2)).toBeLessThan(0);
    expect(compareSelectionPoints(p2, p1)).toBeGreaterThan(0);
    expect(compareSelectionPoints(p1, p1)).toBe(0);
    expect(compareSelectionPoints(p1, p3)).toBeLessThan(0);
  });

  test("areSelectionPointsEqual compares nulls and points", () => {
    expect(areSelectionPointsEqual(null, null)).toBe(true);
    expect(areSelectionPointsEqual(null, { globalRow: 0, col: 0 })).toBe(false);
    expect(
      areSelectionPointsEqual(
        { globalRow: 0, col: 5 },
        { globalRow: 0, col: 5 },
      ),
    ).toBe(true);
    expect(
      areSelectionPointsEqual(
        { globalRow: 0, col: 5 },
        { globalRow: 0, col: 6 },
      ),
    ).toBe(false);
  });

  test("hitTestHistory maps screen coordinates to globalRow and col", () => {
    const history = createTurnHistory();
    startTurn(history, "user");
    appendToCurrentTurn(history, "Hello world!");
    finalizeCurrentTurn(history);

    const hit = hitTestHistory(history, 2, 5, 80, 10);
    expect(hit).toEqual({ globalRow: 12, col: 5 });
  });

  test("extractSelectedText extracts single line partial text", () => {
    const history = createTurnHistory();
    startTurn(history, "assistant");
    appendToCurrentTurn(history, "Hello wonderful world!");
    finalizeCurrentTurn(history);

    // Row 0: "◈ Hello wonderful world!"
    // 'w' of wonderful is at col 8, after 'l' is at col 17
    const text = extractSelectedText(
      history,
      { globalRow: 0, col: 8 },
      { globalRow: 0, col: 17 },
      80,
    );
    expect(text).toBe("wonderful");
  });

  test("extractSelectedText supports reverse selection (head before anchor)", () => {
    const history = createTurnHistory();
    startTurn(history, "assistant");
    appendToCurrentTurn(history, "Hello wonderful world!");
    finalizeCurrentTurn(history);

    const text = extractSelectedText(
      history,
      { globalRow: 0, col: 17 },
      { globalRow: 0, col: 8 },
      80,
    );
    expect(text).toBe("wonderful");
  });

  test("extractSelectedText extracts cross-turn text and excludes UI decorations", () => {
    const history = createTurnHistory();
    startTurn(history, "user");
    appendToCurrentTurn(history, "First turn");
    finalizeCurrentTurn(history);

    startTurn(history, "assistant");
    appendToCurrentTurn(history, "Second turn");
    finalizeCurrentTurn(history);

    const visibleLines = buildHistoryLines(history, 80);
    // Row 0: "" (separator)
    // Row 1: "┃  First turn"
    // Row 2: "" (separator)
    // Row 3: "◈ Second turn"

    const text = extractSelectedText(
      history,
      { globalRow: 1, col: 9 },  // "turn" in "┃  First turn"
      { globalRow: 3, col: 8 },  // "Second" in "◈ Second turn"
      80,
    );
    expect(text).toContain("turn");
    expect(text).toContain("Second");
    expect(text).not.toContain("┃");
    expect(text).not.toContain("◈");
  });

  test("plain click with identical anchor and head produces empty string (no-op copy)", () => {
    const history = createTurnHistory();
    startTurn(history, "user");
    appendToCurrentTurn(history, "Click here");
    finalizeCurrentTurn(history);

    const point = { globalRow: 1, col: 3 };
    const text = extractSelectedText(history, point, point);
    expect(text).toBe("");
  });

  test("extracts CJK and emoji correctly without truncation glitches", () => {
    const history = createTurnHistory();
    startTurn(history, "assistant");
    appendToCurrentTurn(history, "你好世界 🚀 test");
    finalizeCurrentTurn(history);

    // "◈ 你好世界 🚀 test"
    // ◈ (2 cols), 你 (2 cols), 好 (2 cols), 世 (2 cols), 界 (2 cols), ' ' (1 col), 🚀 (2 cols)
    // Total cols for "你好世界 🚀" = 2 + 11 = 13 cols.
    const text = extractSelectedText(
      history,
      { globalRow: 0, col: 2 },
      { globalRow: 0, col: 13 },
      80,
    );
    expect(text).toBe("你好世界 🚀");
  });

  // --- Precise character selection & overlay tests ---

  test("ASCII 单行部分选择: abcdefghijklmnopqrstuvwxyz 从 f 拖到 j (clipboard + overlay 精确到字符)", () => {
    const history = createTurnHistory();
    startTurn(history, "assistant");
    appendToCurrentTurn(history, "abcdefghijklmnopqrstuvwxyz");
    finalizeCurrentTurn(history);

    const contentWidth = 80;
    // assistant turn line 0: "◈ abcdefghijklmnopqrstuvwxyz"
    // Col 0..1: '◈ ', Col 2: 'a', ..., Col 7: 'f', Col 12: after 'j'
    const hitF = hitTestHistory(history, 0, 7, contentWidth, 0);
    const hitJ = hitTestHistory(history, 0, 12, contentWidth, 0);

    expect(hitF).toEqual({ globalRow: 0, col: 7 });
    expect(hitJ).toEqual({ globalRow: 0, col: 12 });

    const selectedText = extractSelectedText(history, hitF, hitJ, contentWidth);
    expect(selectedText).toBe("fghij");

    const visibleLines = buildHistoryLines(history, contentWidth);
    const selectionState: TuiSelectionState = {
      dragging: true,
      anchor: hitF,
      head: hitJ,
    };
    const overlaid = applySelectionOverlay(visibleLines, history, contentWidth, 0, selectionState);
    expect(overlaid.length).toBe(1);

    expect(overlaid[0]).toContain("\x1b[7mfghij\x1b[27m");
    expect(overlaid[0]).toContain("abcde\x1b[7m");
    expect(overlaid[0]).toContain("\x1b[27mklmnopqrstuvwxyz");
    expect(overlaid[0]).not.toContain("\x1b[7m◈");
  });

  test("ASCII 反向拖拽: 从 j 拖到 f", () => {
    const history = createTurnHistory();
    startTurn(history, "assistant");
    appendToCurrentTurn(history, "abcdefghijklmnopqrstuvwxyz");
    finalizeCurrentTurn(history);

    const contentWidth = 80;
    const hitF = hitTestHistory(history, 0, 7, contentWidth, 0);
    const hitJ = hitTestHistory(history, 0, 12, contentWidth, 0);

    const reverseText = extractSelectedText(history, hitJ, hitF, contentWidth);
    expect(reverseText).toBe("fghij");

    const visibleLines = buildHistoryLines(history, contentWidth);
    const reverseSelection: TuiSelectionState = {
      dragging: true,
      anchor: hitJ,
      head: hitF,
    };
    const overlaid = applySelectionOverlay(visibleLines, history, contentWidth, 0, reverseSelection);
    expect(overlaid[0]).toContain("abcde\x1b[7mfghij\x1b[27mklmnopqrstuvwxyz");
  });

  test("中文部分选择: 你好世界 选择 好世", () => {
    const history = createTurnHistory();
    startTurn(history, "assistant");
    appendToCurrentTurn(history, "你好世界");
    finalizeCurrentTurn(history);

    // "◈ 你好世界" -> ◈ is width 2, 你 is cols 2-3, 好 is cols 4-5, 世 is cols 6-7, 界 is cols 8-9
    const hitHao = hitTestHistory(history, 0, 4, 80, 0); // start of '好'
    const hitJie = hitTestHistory(history, 0, 8, 80, 0); // start of '界' (right edge of '世')

    expect(extractSelectedText(history, hitHao, hitJie, 80)).toBe("好世");

    const visibleLines = buildHistoryLines(history, 80);
    const overlaid = applySelectionOverlay(visibleLines, history, 80, 0, {
      dragging: true,
      anchor: hitHao,
      head: hitJie,
    });
    expect(overlaid[0]).toContain("你\x1b[7m好世\x1b[27m界");
  });

  test("emoji 不被切半 (surrogate pairs / ZWJ emoji)", () => {
    const history = createTurnHistory();
    startTurn(history, "assistant");
    appendToCurrentTurn(history, "A🎉B");
    finalizeCurrentTurn(history);

    // "◈ A🎉B" -> ◈ is width 2, 'A' is col 2, '🎉' is cols 3-4, 'B' is col 5
    const hitEmoji = hitTestHistory(history, 0, 3, 80, 0);
    const hitB = hitTestHistory(history, 0, 5, 80, 0);

    expect(extractSelectedText(history, hitEmoji, hitB, 80)).toBe("🎉");

    const visibleLines = buildHistoryLines(history, 80);
    const overlaid = applySelectionOverlay(visibleLines, history, 80, 0, {
      dragging: true,
      anchor: hitEmoji,
      head: hitB,
    });
    expect(overlaid[0]).toContain("A\x1b[7m🎉\x1b[27mB");
  });

  test("跨多段落完整连续选择 (无跳行/无断层)", () => {
    const history = createTurnHistory();
    startTurn(history, "assistant");
    appendToCurrentTurn(
      history,
      "第一段落文本内容。\n第二段落文本内容。\n第三段落文本内容。\n第四段落文本内容。",
    );
    finalizeCurrentTurn(history);

    const visibleLines = buildHistoryLines(history, 80);
    expect(visibleLines.length).toBe(4);

    // Select from row 0 to row 3
    const hitStart = { globalRow: 0, col: 2 }; // in row 0 at "第一段落"
    const hitEnd = { globalRow: 3, col: 10 };  // in row 3

    const overlaid = applySelectionOverlay(visibleLines, history, 80, 0, {
      dragging: true,
      anchor: hitStart,
      head: hitEnd,
    });

    // ALL rows between row 0 and row 3 MUST be highlighted without any gaps
    expect(overlaid[0]).toContain("\x1b[7m");
    expect(overlaid[1]).toContain("\x1b[7m第二段落文本内容。\x1b[27m"); // Full row 1 highlighted
    expect(overlaid[2]).toContain("\x1b[7m第三段落文本内容。\x1b[27m"); // Full row 2 highlighted
    expect(overlaid[3]).toContain("\x1b[7m");

    const text = extractSelectedText(history, hitStart, hitEnd, 80);
    expect(text).toContain("第一段落");
    expect(text).toContain("第二段落文本内容。");
    expect(text).toContain("第三段落文本内容。");
    expect(text).toContain("第四段落");
  });

  test("highlightLineByColumns handles inner style resets without leaking", () => {
    const line = "◈ before \x1b[1mbold\x1b[0m after";
    // Select from col 9 ("bold") to col 13
    const highlighted = highlightLineByColumns(line, 9, 13);

    expect(highlighted).toContain("\x1b[7mbold\x1b[0m\x1b[7m\x1b[27m");
    expect(highlighted.startsWith("◈ before ")).toBe(true);
    expect(highlighted.endsWith(" after")).toBe(true);
  });
});
