/**
 * TUI 鼠标文本选择与 Hit-test 映射。
 *
 * 维护拖拽选区状态、将终端屏幕行列 (screenRow, screenCol) 映射到历史
 * sourceOffset (SelectionPoint)，以及从 TurnHistory 中提取选中文本并渲染
 * 高亮 Overlay。
 */
import {
  displayWidth,
  stripAnsi,
  wrapTranscriptLine,
} from "./tuiAnsi";
import {
  buildTurnOffsets,
  type TurnHistory,
} from "./tuiHistory";

export type SelectionPoint = {
  turnIndex: number;
  sourceOffset: number;
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
  if (a.turnIndex !== b.turnIndex) {
    return a.turnIndex - b.turnIndex;
  }
  return a.sourceOffset - b.sourceOffset;
}

export function areSelectionPointsEqual(
  a: SelectionPoint | null,
  b: SelectionPoint | null,
): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.turnIndex === b.turnIndex && a.sourceOffset === b.sourceOffset;
}

/**
 * 将屏幕行/列坐标转换为 TurnHistory 内的 SelectionPoint (turnIndex + sourceOffset)。
 */
export function hitTestHistory(
  history: TurnHistory,
  screenRow: number,
  screenCol: number,
  contentWidth: number,
  scrollTop: number,
): SelectionPoint | null {
  if (history.turns.length === 0) return null;

  const { entries } = buildTurnOffsets(history, contentWidth);
  if (entries.length === 0) return null;

  const globalRow = scrollTop + screenRow;

  // Clamp before first turn
  const firstEntry = entries[0]!;
  if (globalRow < firstEntry.startRow) {
    return { turnIndex: 0, sourceOffset: 0 };
  }

  // Clamp after last turn
  const lastIdx = entries.length - 1;
  const lastEntry = entries[lastIdx]!;
  const lastTurn = history.turns[lastIdx]!;
  if (globalRow >= lastEntry.startRow + lastEntry.lineCount) {
    return { turnIndex: lastIdx, sourceOffset: lastTurn.content.length };
  }

  // Find matching turn entry
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const turn = history.turns[i]!;
    const turnStart = entry.startRow;
    const turnEnd = turnStart + entry.lineCount;

    // Check if on separator line above turn
    if (entry.separatorAbove > 0 && globalRow === turnStart - 1) {
      return { turnIndex: i, sourceOffset: 0 };
    }

    if (globalRow >= turnStart && globalRow < turnEnd) {
      const rowInTurn = globalRow - turnStart;
      const sourceOffset = mapRowColToSourceOffset(
        turn.content,
        turn.role,
        contentWidth,
        rowInTurn,
        screenCol,
        turn.command,
      );
      return { turnIndex: i, sourceOffset };
    }
  }

  return null;
}

/**
 * 内部辅助：将单个 Turn 内的 (rowInTurn, col) 映射为 content 中的字符索引。
 */
function mapRowColToSourceOffset(
  content: string,
  role: string,
  contentWidth: number,
  targetRow: number,
  targetCol: number,
  command?: string,
): number {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const logicalLines = normalized.split("\n");

  let currentRow = 0;
  let charAccumulator = 0;

  // Handle local turn command line
  if (role === "local" && command) {
    const cmdWrapped = wrapTranscriptLine(`› ${command}`, contentWidth);
    if (targetRow < cmdWrapped.length) {
      // Clicked on command line; map to start of content
      return 0;
    }
    currentRow += cmdWrapped.length;
  }

  for (let l = 0; l < logicalLines.length; l++) {
    const lineText = logicalLines[l]!;
    const lineLen = lineText.length;

    let wrappedRows: string[];
    let prefixFirst = 0;
    let prefixCont = 0;

    if (role === "user") {
      wrappedRows = wrapTranscriptLine(`┃  ${lineText}`, contentWidth, "┃  ");
      prefixFirst = 3;
      prefixCont = 3;
    } else if (role === "local") {
      wrappedRows = wrapTranscriptLine(`  ${lineText}`, contentWidth, "  ");
      prefixFirst = 2;
      prefixCont = 2;
    } else {
      // assistant
      if (l === 0 && !lineText.startsWith("[nolo]")) {
        wrappedRows = wrapTranscriptLine(`◈ ${lineText}`, contentWidth);
        prefixFirst = 2;
        prefixCont = 0;
      } else {
        wrappedRows = wrapTranscriptLine(lineText, contentWidth);
        prefixFirst = 0;
        prefixCont = 0;
      }
    }

    const rowCount = Math.max(1, wrappedRows.length);

    if (targetRow >= currentRow && targetRow < currentRow + rowCount) {
      const subRow = targetRow - currentRow;
      let offsetInLine = 0;

      // Accumulate lengths of full subrows before target subrow
      for (let s = 0; s < subRow; s++) {
        const rowStr = stripAnsi(wrappedRows[s] ?? "");
        const pLen = s === 0 ? prefixFirst : prefixCont;
        const pureText = rowStr.slice(pLen);
        offsetInLine += pureText.length;
      }

      // Add offset within target subrow based on targetCol
      const targetRowStr = stripAnsi(wrappedRows[subRow] ?? "");
      const pLen = subRow === 0 ? prefixFirst : prefixCont;
      const pureTargetText = targetRowStr.slice(pLen);
      const effectiveCol = Math.max(0, targetCol - pLen);

      let colAccum = 0;
      for (let c = 0; c < pureTargetText.length; c++) {
        const char = pureTargetText[c]!;
        const w = displayWidth(char);
        if (colAccum + w > effectiveCol) {
          break;
        }
        colAccum += w;
        offsetInLine += char.length;
      }

      let finalOffset = Math.min(normalized.length, charAccumulator + Math.min(lineLen, offsetInLine));
      // Guard against splitting surrogate pair (if high surrogate at end, include low surrogate)
      if (
        finalOffset > 0 &&
        finalOffset < normalized.length &&
        normalized.charCodeAt(finalOffset - 1) >= 0xd800 &&
        normalized.charCodeAt(finalOffset - 1) <= 0xdbff
      ) {
        finalOffset += 1;
      }
      return finalOffset;
    }

    currentRow += rowCount;
    charAccumulator += lineLen + 1; // +1 for newline
  }

  return normalized.length;
}

/**
 * 提取选区范围内的纯文本。
 */
export function extractSelectedText(
  history: TurnHistory,
  anchor: SelectionPoint | null,
  head: SelectionPoint | null,
): string {
  if (!anchor || !head) return "";
  const cmp = compareSelectionPoints(anchor, head);
  if (cmp === 0) return "";

  const start = cmp < 0 ? anchor : head;
  const end = cmp < 0 ? head : anchor;

  if (start.turnIndex === end.turnIndex) {
    const turn = history.turns[start.turnIndex];
    if (!turn) return "";
    const raw = turn.content.slice(start.sourceOffset, end.sourceOffset);
    return stripAnsi(raw);
  }

  const pieces: string[] = [];
  const startTurn = history.turns[start.turnIndex];
  if (startTurn) {
    pieces.push(startTurn.content.slice(start.sourceOffset));
  }

  for (let i = start.turnIndex + 1; i < end.turnIndex; i++) {
    const midTurn = history.turns[i];
    if (midTurn) {
      pieces.push(midTurn.content);
    }
  }

  const endTurn = history.turns[end.turnIndex];
  if (endTurn) {
    pieces.push(endTurn.content.slice(0, end.sourceOffset));
  }

  return stripAnsi(pieces.join("\n\n"));
}

/**
 * 将反色高亮 (Reverse Video \x1b[7m ... \x1b[27m) 叠加到可见行。
 */
export function applySelectionOverlay(
  visibleLines: string[],
  history: TurnHistory,
  contentWidth: number,
  scrollTop: number,
  selection: TuiSelectionState,
): string[] {
  if (!selection.dragging || !selection.anchor || !selection.head) {
    return visibleLines;
  }
  const cmp = compareSelectionPoints(selection.anchor, selection.head);
  if (cmp === 0) return visibleLines;

  const start = cmp < 0 ? selection.anchor : selection.head;
  const end = cmp < 0 ? selection.head : selection.anchor;

  const { entries } = buildTurnOffsets(history, contentWidth);
  const result = [...visibleLines];

  for (let screenRow = 0; screenRow < visibleLines.length; screenRow++) {
    const globalRow = scrollTop + screenRow;

    // Check if globalRow is between start and end selection points
    let isSelectedRow = false;
    for (let i = start.turnIndex; i <= end.turnIndex; i++) {
      const entry = entries[i];
      if (!entry) continue;

      const turnStart = entry.startRow;
      const turnEnd = turnStart + entry.lineCount;

      if (i === start.turnIndex && i === end.turnIndex) {
        if (globalRow >= turnStart && globalRow < turnEnd) {
          isSelectedRow = true;
        }
      } else if (i === start.turnIndex) {
        if (globalRow >= turnStart) {
          isSelectedRow = true;
        }
      } else if (i === end.turnIndex) {
        if (globalRow < turnEnd) {
          isSelectedRow = true;
        }
      } else {
        if (globalRow >= turnStart && globalRow < turnEnd) {
          isSelectedRow = true;
        }
      }
    }

    if (isSelectedRow) {
      const line = result[screenRow] ?? "";
      if (line.length > 0) {
        result[screenRow] = `\x1b[7m${line}\x1b[27m`;
      }
    }
  }

  return result;
}
