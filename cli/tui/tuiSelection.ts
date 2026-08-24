/**
 * TUI 鼠标文本选择与 Hit-test 映射。
 *
 * 采用标准终端 (xterm.js / tmux / Ghostty) 2D 网格选区模型：
 * 维护全局行/列选区状态 (SelectionPoint { globalRow, col })，在可视行上
 * 叠加字符级反色高亮，并从历史渲染行中按列范围提取纯文本到剪贴板。
 */
import {
  tokenizeAnsiLine,
} from "./tuiAnsi";
import {
  buildHistoryLayoutRows,
  type TurnHistory,
} from "./tuiHistory";

export type SelectionPoint = {
  globalRow: number;
  col: number;
};

export type TuiSelectionState = {
  dragging: boolean;
  anchor: SelectionPoint | null;
  head: SelectionPoint | null;
};

export function createSelectionState(): TuiSelectionState {
  return {
    dragging: false,
    anchor: null,
    head: null,
  };
}

export function compareSelectionPoints(
  a: SelectionPoint,
  b: SelectionPoint,
): number {
  if (a.globalRow !== b.globalRow) {
    return a.globalRow - b.globalRow;
  }
  return a.col - b.col;
}

export function areSelectionPointsEqual(
  a: SelectionPoint | null,
  b: SelectionPoint | null,
): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.globalRow === b.globalRow && a.col === b.col;
}

/**
 * 将一行 ANSI 渲染文本中落在 [selStartCol, selEndCol] 列区间的字符叠加高亮 (\x1b[7m ... \x1b[27m)。
 * 行尾 padding 空格不进入高亮，遇到内部 reset (\x1b[0m) 时自动重新开启高亮，避免高亮中断或泄漏。
 */
export function highlightLineByColumns(
  line: string,
  selStartCol: number,
  selEndCol: number,
  prefixWidth = 0,
): string {
  const tokens = tokenizeAnsiLine(line);
  const range = resolveSelectableColumnRange(
    tokens,
    selStartCol,
    selEndCol,
    prefixWidth,
  );
  if (!range) return line;

  let out = "";
  let currentCol = 0;
  let isHighlightActive = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === "sgr") {
      if (isHighlightActive) {
        if (/^\x1b\[0?m$/.test(token.value)) {
          out += `${token.value}\x1b[7m`;
        } else {
          out += token.value;
        }
      } else {
        out += token.value;
      }
      continue;
    }

    const charStartCol = currentCol;
    const charEndCol = currentCol + token.width;
    const isSelected = charStartCol >= range.start && charStartCol < range.end;

    if (isSelected && !isHighlightActive) {
      out += "\x1b[7m";
      isHighlightActive = true;
    } else if (!isSelected && isHighlightActive) {
      out += "\x1b[27m";
      isHighlightActive = false;
    }

    out += token.value;
    currentCol = charEndCol;
  }

  if (isHighlightActive) {
    out += "\x1b[27m";
  }

  return out;
}

function resolveSelectableColumnRange(
  tokens: ReturnType<typeof tokenizeAnsiLine>,
  requestedStart: number,
  requestedEnd: number,
  prefixWidth: number,
): { start: number; end: number } | null {
  if (requestedStart >= requestedEnd) return null;

  let col = 0;
  let lastNonSpaceCol = 0;
  for (const token of tokens) {
    if (token.kind !== "char") continue;
    if (token.value.trim().length > 0) {
      lastNonSpaceCol = col + token.width;
    }
    col += token.width;
  }

  const start = Math.max(prefixWidth, requestedStart);
  const end = Math.min(requestedEnd, lastNonSpaceCol);
  if (start >= end) return null;

  let snappedStart: number | null = null;
  let snappedEnd: number | null = null;
  col = 0;
  for (const token of tokens) {
    if (token.kind !== "char") continue;
    const tokenStart = col;
    const tokenEnd = col + token.width;
    if (tokenEnd > start && tokenStart < end) {
      snappedStart ??= tokenStart;
      snappedEnd = tokenEnd;
    }
    col = tokenEnd;
  }

  return snappedStart === null || snappedEnd === null
    ? null
    : { start: snappedStart, end: snappedEnd };
}

/**
 * 将屏幕行/列坐标转换为全局绝对坐标 SelectionPoint (globalRow + col)。
 */
export function hitTestHistory(
  history: TurnHistory,
  screenRow: number,
  screenCol: number,
  _contentWidth: number,
  scrollTop: number,
): SelectionPoint | null {
  const globalRow = Math.max(0, scrollTop + screenRow);
  const col = Math.max(0, screenCol);
  return { globalRow, col };
}

/**
 * 从一行纯文本中提取落在 [startCol, endCol] 列范围内的字符，自动去除 UI 前缀。
 */
export function extractTextSliceByColumns(
  line: string,
  startCol: number,
  endCol: number,
  prefixWidth = 0,
): string {
  const tokens = tokenizeAnsiLine(line);
  const range = resolveSelectableColumnRange(
    tokens,
    startCol,
    endCol,
    prefixWidth,
  );
  if (!range) return "";

  let col = 0;
  let text = "";
  for (const token of tokens) {
    if (token.kind !== "char") continue;
    if (col >= range.start && col < range.end) {
      text += token.value;
    }
    col += token.width;
  }
  return text;
}

/**
 * 提取选区范围内的纯文本。
 */
export function extractSelectedText(
  history: TurnHistory,
  anchor: SelectionPoint | null,
  head: SelectionPoint | null,
  contentWidth: number,
): string {
  if (!anchor || !head) return "";
  const cmp = compareSelectionPoints(anchor, head);
  if (cmp === 0) return "";

  const start = cmp < 0 ? anchor : head;
  const end = cmp < 0 ? head : anchor;

  const rows = buildHistoryLayoutRows(history, contentWidth);
  const pieces: string[] = [];

  for (let r = start.globalRow; r <= end.globalRow; r++) {
    const row = rows[r];
    if (!row) continue;

    let lineStartCol = 0;
    let lineEndCol = Infinity;

    if (r === start.globalRow) {
      lineStartCol = start.col;
    }
    if (r === end.globalRow) {
      lineEndCol = end.col;
    }

    pieces.push(
      extractTextSliceByColumns(
        row.rendered,
        lineStartCol,
        lineEndCol,
        row.prefixWidth,
      ),
    );
    if (r < end.globalRow) {
      pieces.push(row.softWrapped ? (row.softWrapJoiner ?? "") : "\n");
    }
  }

  return pieces.join("");
}

/**
 * 将字符级反色高亮 (Reverse Video \x1b[7m ... \x1b[27m) 叠加到可见行。
 */
export function applySelectionOverlay(
  visibleLines: string[],
  history: TurnHistory,
  contentWidth: number,
  scrollTop: number,
  selection: TuiSelectionState,
): string[] {
  if (!selection.anchor || !selection.head) {
    return visibleLines;
  }
  const cmp = compareSelectionPoints(selection.anchor, selection.head);
  if (cmp === 0) return visibleLines;

  const start = cmp < 0 ? selection.anchor : selection.head;
  const end = cmp < 0 ? selection.head : selection.anchor;
  const layoutRows = buildHistoryLayoutRows(history, contentWidth);

  const result = [...visibleLines];

  for (let screenRow = 0; screenRow < visibleLines.length; screenRow++) {
    const globalRow = scrollTop + screenRow;
    if (globalRow < start.globalRow || globalRow > end.globalRow) {
      continue;
    }

    const currentLine = result[screenRow] ?? "";
    if (currentLine.length === 0) continue;
    const layoutRow = layoutRows[globalRow];

    let selStartCol = 0;
    let selEndCol = Infinity;

    if (globalRow === start.globalRow) {
      selStartCol = start.col;
    }
    if (globalRow === end.globalRow) {
      selEndCol = end.col;
    }

    result[screenRow] = highlightLineByColumns(
      currentLine,
      selStartCol,
      selEndCol,
      layoutRow?.prefixWidth ?? 0,
    );
  }

  return result;
}
