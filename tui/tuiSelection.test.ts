import { describe, expect, test } from "bun:test";
import {
  applySelectionOverlay,
  areSelectionPointsEqual,
  compareSelectionPoints,
  createSelectionState,
  extractSelectedText,
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
  type TurnHistory,
} from "./tuiHistory";

describe("tuiSelection", () => {
  test("createSelectionState initializes default empty state", () => {
    const state = createSelectionState();
    expect(state.dragging).toBe(false);
    expect(state.anchor).toBeNull();
    expect(state.head).toBeNull();
  });

  test("compareSelectionPoints orders points by turnIndex then sourceOffset", () => {
    const p1: SelectionPoint = { turnIndex: 0, sourceOffset: 5 };
    const p2: SelectionPoint = { turnIndex: 0, sourceOffset: 10 };
    const p3: SelectionPoint = { turnIndex: 1, sourceOffset: 0 };

    expect(compareSelectionPoints(p1, p2)).toBeLessThan(0);
    expect(compareSelectionPoints(p2, p1)).toBeGreaterThan(0);
    expect(compareSelectionPoints(p1, p1)).toBe(0);
    expect(compareSelectionPoints(p1, p3)).toBeLessThan(0);
  });

  test("areSelectionPointsEqual compares nulls and points", () => {
    expect(areSelectionPointsEqual(null, null)).toBe(true);
    expect(areSelectionPointsEqual(null, { turnIndex: 0, sourceOffset: 0 })).toBe(false);
    expect(
      areSelectionPointsEqual(
        { turnIndex: 0, sourceOffset: 5 },
        { turnIndex: 0, sourceOffset: 5 },
      ),
    ).toBe(true);
    expect(
      areSelectionPointsEqual(
        { turnIndex: 0, sourceOffset: 5 },
        { turnIndex: 0, sourceOffset: 6 },
      ),
    ).toBe(false);
  });

  test("hitTestHistory maps screen coordinates to turn and offset", () => {
    const history = createTurnHistory();
    startTurn(history, "user");
    appendToCurrentTurn(history, "Hello world!");
    finalizeCurrentTurn(history);

    startTurn(history, "assistant");
    appendToCurrentTurn(history, "This is an assistant response.");
    finalizeCurrentTurn(history);

    const hitTop = hitTestHistory(history, 0, 5, 80, 0);
    expect(hitTop).not.toBeNull();
    expect(hitTop?.turnIndex).toBe(0);

    const hitSecondTurn = hitTestHistory(history, 2, 5, 80, 0);
    expect(hitSecondTurn).not.toBeNull();
    expect(hitSecondTurn?.turnIndex).toBe(1);
  });

  test("extractSelectedText extracts single turn text", () => {
    const history = createTurnHistory();
    startTurn(history, "user");
    appendToCurrentTurn(history, "Hello wonderful world!");
    finalizeCurrentTurn(history);

    const text = extractSelectedText(
      history,
      { turnIndex: 0, sourceOffset: 6 },
      { turnIndex: 0, sourceOffset: 15 },
    );
    expect(text).toBe("wonderful");
  });

  test("extractSelectedText supports reverse selection (head before anchor)", () => {
    const history = createTurnHistory();
    startTurn(history, "user");
    appendToCurrentTurn(history, "Hello wonderful world!");
    finalizeCurrentTurn(history);

    const text = extractSelectedText(
      history,
      { turnIndex: 0, sourceOffset: 15 },
      { turnIndex: 0, sourceOffset: 6 },
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

    const text = extractSelectedText(
      history,
      { turnIndex: 0, sourceOffset: 6 },
      { turnIndex: 1, sourceOffset: 6 },
    );
    expect(text).toBe("turn\n\nSecond");
  });

  test("applySelectionOverlay adds reverse video to selected rows only when dragging", () => {
    const history = createTurnHistory();
    startTurn(history, "user");
    appendToCurrentTurn(history, "Row 1\nRow 2");
    finalizeCurrentTurn(history);

    const lines = ["", "Line 1", "Line 2"];
    const inactiveState: TuiSelectionState = {
      dragging: false,
      anchor: { turnIndex: 0, sourceOffset: 0 },
      head: { turnIndex: 0, sourceOffset: 5 },
    };
    const notModified = applySelectionOverlay(lines, history, 80, 0, inactiveState);
    expect(notModified).toEqual(lines);

    const activeState: TuiSelectionState = {
      dragging: true,
      anchor: { turnIndex: 0, sourceOffset: 0 },
      head: { turnIndex: 0, sourceOffset: 5 },
    };
    const modified = applySelectionOverlay(lines, history, 80, 0, activeState);
    expect(modified[1]).toContain("\x1b[7m");
    expect(modified[1]).toContain("\x1b[27m");
  });

  test("plain click with identical anchor and head produces empty string (no-op copy)", () => {
    const history = createTurnHistory();
    startTurn(history, "user");
    appendToCurrentTurn(history, "Click here");
    finalizeCurrentTurn(history);

    const point = { turnIndex: 0, sourceOffset: 3 };
    const text = extractSelectedText(history, point, point);
    expect(text).toBe("");
  });

  test("extracts CJK and emoji correctly without truncation glitches", () => {
    const history = createTurnHistory();
    startTurn(history, "user");
    appendToCurrentTurn(history, "你好世界 🚀 test");
    finalizeCurrentTurn(history);

    const text = extractSelectedText(
      history,
      { turnIndex: 0, sourceOffset: 0 },
      { turnIndex: 0, sourceOffset: 7 }, // "你好世界 🚀"
    );
    expect(text).toBe("你好世界 🚀");
  });

  test("clamps out-of-bounds hit-test rows gracefully", () => {
    const history = createTurnHistory();
    startTurn(history, "user");
    appendToCurrentTurn(history, "Hello");
    finalizeCurrentTurn(history);

    const hitBefore = hitTestHistory(history, -5, 0, 80, 0);
    expect(hitBefore).toEqual({ turnIndex: 0, sourceOffset: 0 });

    const hitAfter = hitTestHistory(history, 100, 0, 80, 0);
    expect(hitAfter).toEqual({ turnIndex: 0, sourceOffset: 5 });
  });

  test("hit-tests local turn with command line correctly", () => {
    const history = createTurnHistory();
    appendLocalTurn(history, "switch 2", "Switched to model");

    const hitCmd = hitTestHistory(history, 0, 5, 80, 0);
    expect(hitCmd).toEqual({ turnIndex: 0, sourceOffset: 0 });

    const hitContent = hitTestHistory(history, 1, 5, 80, 0);
    expect(hitContent?.turnIndex).toBe(0);
    expect(hitContent?.sourceOffset).toBeGreaterThan(0);
  });
});
