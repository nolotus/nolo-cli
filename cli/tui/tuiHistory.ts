/**
 * TUI 对话历史：turn 数据结构、样式化渲染与 stream commit 管道。
 *
 * 从 readlineWorkspace.ts 抽出。依赖：
 * - ./tuiAnsi：wrapTranscriptLine / padOrTruncateToWidth / applyTerminalOutputToText
 * - ./theme：themeColorSequence / themeText / getActiveDensity / resolveCliColorEnabled
 * - ../client/assistantOutput：formatAssistantDisplay（assistant turn 的唯一渲染器，
 *   与流式输出共享同一份实现，避免历史重绘与流式样式漂移）
 */
import {
  applyTerminalOutputToText,
  padOrTruncateToWidth,
  stripAnsi,
  truncateAnsi,
  visibleWidth,
  wrapTranscriptLine,
} from "./tuiAnsi";
import {
  getActiveDensity,
  renderSurfaceLine,
  themeColorSequence,
  themeText,
  userSurfaceBackgroundSequence,
} from "./theme";
import { formatAssistantDisplay } from "../client/assistantOutput";
import { resolveCliColorEnabled } from "../client/terminalStyles";

export type TurnRole = "user" | "assistant" | "local";

export type Turn = {
  role: TurnRole;
  content: string;
  /**
   * 本地命令/事件回显专用（role === "local"）：触发它的命令原文，例如
   * "/switch 2"。为空字符串表示无对应命令的系统反馈（如 "Turn stopped"），
   * 渲染时省略 `› ` 前缀，只显示内容行。
   */
  command?: string;
};

export type TurnHistory = {
  turns: Turn[];
  currentRole: TurnRole | null;
  currentContent: string;
  scrollTop: number;
  followBottom: boolean;
  hasMoreAbove?: boolean;
  hasMoreBelow?: boolean;
};

export const MAX_TUI_HISTORY_TURNS = 500;

type TurnLineCacheEntry = {
  width: number;
  color: boolean;
  density: string;
  /**
   * Theme fingerprint. `/theme` and the background auto-follow poller change
   * both the accent foreground and the user-bubble wash; without this the
   * cache would keep replaying rows painted in the previous theme's colors.
   */
  surface: string;
  lines: string[];
};

/** Finalized turns are immutable; cache entries GC when truncation drops them. */
const turnLineCache = new WeakMap<Turn, TurnLineCacheEntry>();

/**
 * Line-count cache: how many terminal rows a finalized turn occupies at a
 * given width. Deliberately keyed by width ONLY — ANSI styling, bubble surface
 * and density never change wrap counts (styles are zero-width and spacious
 * separators live outside the cache). This is what lets renderHistory rebuild
 * its row-offset index without re-running markdown when /theme, density or the
 * background auto-follow poller invalidate the render cache: counts survive,
 * so only the visible window needs repainting instead of all 400 turns.
 */
type TurnLineCountEntry = { width: number; count: number };

const turnLineCountCache = new WeakMap<Turn, TurnLineCountEntry>();

type HistoryFrameBuffer = {
  rows: number;
  columns: number;
  inputLines: number;
  lines: string[];
};

const frameBufferByOutput = new WeakMap<object, HistoryFrameBuffer>();

/**
 * Invalidate the double-buffer diff cache for an output stream.
 * Call this when a full-screen modal, pager, or clear-screen has modified the
 * terminal grid outside of renderHistory, to guarantee the next frame repaints
 * every row.
 */
export function resetHistoryFrameDiffCache(output?: NodeJS.WritableStream): void {
  if (output && typeof output === "object") {
    frameBufferByOutput.delete(output);
  }
}

// Test-only: finalized-turn render-cache misses in renderHistory's window
// loop. Lets tests assert virtualization — a theme/width invalidation must
// repaint at most the visible window, not every turn.
let renderCacheMissCount = 0;
export function getRenderCacheMissCount(): number {
  return renderCacheMissCount;
}

export function createTurnHistory(): TurnHistory {
  return {
    turns: [],
    currentRole: null,
    currentContent: "",
    scrollTop: 0,
    followBottom: true,
  };
}

export function startTurn(history: TurnHistory, role: TurnRole) {
  if (history.currentRole !== null) {
    history.turns.push({
      role: history.currentRole,
      content: history.currentContent,
    });
  }
  history.currentRole = role;
  history.currentContent = "";
  resetStreamingTurnCache();
}

export function appendToCurrentTurn(history: TurnHistory, chunk: string) {
  history.currentContent += chunk;
}

export function finalizeCurrentTurn(history: TurnHistory) {
  if (history.currentRole !== null) {
    history.turns.push({
      role: history.currentRole,
      content: history.currentContent,
    });
    history.currentRole = null;
    history.currentContent = "";
    resetStreamingTurnCache();
    if (history.turns.length > MAX_TUI_HISTORY_TURNS) {
      history.turns = history.turns.slice(history.turns.length - MAX_TUI_HISTORY_TURNS);
    }
  }
}

/**
 * 追加一条本地命令/事件回显 turn。用于 slash 命令回显（/switch、/context
 * 等）以及异步系统反馈（Turn stopped、Quota exhausted 等）——这些都不
 * 是真实对话，用 `local` 角色与 user/assistant 视觉区分。
 *
 * 先收尾任何进行中的 streaming turn，再追加 finalized 的 local turn。
 * `command` 为空字符串时表示无对应命令的系统反馈，渲染时省略 `› ` 前缀。
 */
export function appendLocalTurn(
  history: TurnHistory,
  command: string,
  output: string,
) {
  finalizeCurrentTurn(history);
  history.turns.push({
    role: "local",
    command,
    content: output,
  });
  if (history.turns.length > MAX_TUI_HISTORY_TURNS) {
    history.turns = history.turns.slice(history.turns.length - MAX_TUI_HISTORY_TURNS);
  }
  resetStreamingTurnCache();
}

export function applyOutputChunkToCurrentTurn(
  history: TurnHistory,
  chunk: string
): boolean {
  const next = applyTerminalOutputToText(history.currentContent, chunk);
  if (next === history.currentContent) return false;
  history.currentContent = next;
  return true;
}

function styleAssistantTurn(content: string, colorEnabled: boolean): string {
  const highlighted = colorEnabled
    ? formatAssistantDisplay(content)
    : stripAnsi(formatAssistantDisplay(content));
  const rawLines = highlighted.split("\n");
  const styledLines = rawLines.map((line, idx) => {
    if (idx === 0 && !line.startsWith("[nolo]")) {
      const anchorPrefix = colorEnabled
        ? `${themeColorSequence("chrome")}◈\x1b[39m `
        : "◈ ";
      return `${anchorPrefix}${line}`;
    }
    return line.startsWith("[nolo]") && colorEnabled
      ? themeText(line, "chrome", true)
      : line;
  });
  return styledLines.join("\n");
}

/**
 * Paint one already-wrapped user row as a full-width bubble row.
 *
 * The row is padded to exactly `contentWidth` *inside* the background so the
 * bubble's right edge is straight instead of ragged, then closed with a reset
 * so the tint never bleeds into the scrollbar column or the next row.
 *
 * Padding uses visibleWidth (ANSI-aware, CJK/emoji-aware), never `length`.
 * Any interior reset emitted by wrapTranscriptLine re-opens the background,
 * otherwise the tail of a styled row would drop back to the terminal base.
 */
function fillUserBubbleRow(row: string, surfaceSeq: string, contentWidth: number): string {
  const visible = visibleWidth(row);
  // Guard: if the row already exceeds contentWidth (e.g. a narrow terminal
  // where gutter+indent itself is wider than the viewport), truncate the
  // content so the bubble never spills into the scrollbar column.
  if (visible > contentWidth) {
    const truncated = truncateAnsi(row, contentWidth);
    const padAfter = Math.max(0, contentWidth - visibleWidth(truncated));
    return `${surfaceSeq}${truncated}${" ".repeat(padAfter)}\x1b[0m`;
  }
  return renderSurfaceLine({ text: row, surface: surfaceSeq, padTo: contentWidth });
}

/** Decorate + wrap one turn; separators stay outside so position can vary. */
export function renderTurnBlock(
  role: TurnRole,
  content: string,
  contentWidth: number,
  colorEnabled: boolean,
  command?: string,
): string[] {
  // Normalize line endings before splitting: CRLF (\r\n) and lone CR (\r,
  // legacy Mac) both collapse to LF. Without this, a stray \r survives the
  // split and is emitted into the terminal frame — displayWidth treats it as
  // zero-width so it isn't stripped, and the terminal rewinds to the start of
  // the row, corrupting the transcript layout on Windows (CRLF) and any
  // platform that feeds CR-terminated content. Mirrors formatTurnLines.
  content = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines: string[] = [];
  if (role === "user") {
    const logicalLines = content.split("\n");
    const accentSeq = colorEnabled ? themeColorSequence("accent") : "";
    // User turns carry a dedicated solid vertical gutter `┃` (U+2503) on every line
    // (first line, explicit multiline, and soft wrapping) so user messages are
    // structurally distinct in history even in NO_COLOR / plain mode.
    const firstPrefix = colorEnabled ? `${accentSeq}\x1b[1m┃  ` : "┃  ";
    const multilinePrefix = colorEnabled ? `${accentSeq}\x1b[1m┃  ` : "┃  ";
    const hangingIndent = colorEnabled ? `${accentSeq}\x1b[1m┃  ` : "┃  ";

    // Truecolor only: an accent-tinted wash makes the user turn read as one
    // solid bubble, which is what the eye actually catches while scrolling.
    // Empty without truecolor — the ┃ gutter alone carries the distinction
    // there, and a half-applied block would look broken.
    const surfaceSeq = colorEnabled ? userSurfaceBackgroundSequence() : "";

    for (let i = 0; i < logicalLines.length; i++) {
      const line = logicalLines[i];
      const prefix = i === 0 ? firstPrefix : multilinePrefix;
      const styledLine = `${prefix}${line}`;
      const rows = wrapTranscriptLine(styledLine, contentWidth, hangingIndent);
      lines.push(
        ...(surfaceSeq ? rows.map((row) => fillUserBubbleRow(row, surfaceSeq, contentWidth)) : rows),
      );
    }
  } else if (role === "local") {
    // 本地命令/事件回显：暗色、无头像，与对话明显区分。
    // 有 command 时首行显示 `› /switch 2`，否则只显示内容（系统反馈）。
    const dimSeq = colorEnabled ? "\x1b[2m" : "";
    const resetSeq = colorEnabled ? "\x1b[0m" : "";
    if (command) {
      lines.push(
        ...wrapTranscriptLine(`${dimSeq}› ${command}${resetSeq}`, contentWidth),
      );
    }
    if (content) {
      for (const line of content.split("\n")) {
        lines.push(
          ...wrapTranscriptLine(`${dimSeq}  ${line}${resetSeq}`, contentWidth),
        );
      }
    }
  } else {
    const styledEntry = styleAssistantTurn(content, colorEnabled);
    for (const logicalLine of styledEntry.split("\n")) {
      lines.push(...wrapTranscriptLine(logicalLine, contentWidth));
    }
  }
  return lines;
}

type StreamingTurnCache = {
  role: TurnRole;
  contentWidth: number;
  colorEnabled: boolean;
  density: string;
  surface: string;
  fullContent: string;
  prefixLength: number;
  prefixLines: string[];
};

let streamingTurnCache: StreamingTurnCache | null = null;

export function resetStreamingTurnCache(): void {
  streamingTurnCache = null;
}

function renderPrefixTurnBlock(
  role: TurnRole,
  content: string,
  contentWidth: number,
  colorEnabled: boolean,
): string[] {
  content = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (role === "user") {
    return renderTurnBlock(role, content, contentWidth, colorEnabled);
  }
  const highlighted = colorEnabled
    ? formatAssistantDisplay(content, { trimEdges: false })
    : stripAnsi(formatAssistantDisplay(content, { trimEdges: false }));
  const rawLines = highlighted.split("\n");
  const styledLines = rawLines.map((line, idx) => {
    if (idx === 0 && !line.startsWith("[nolo]")) {
      const anchorPrefix = colorEnabled
        ? `${themeColorSequence("chrome")}◈\x1b[39m `
        : "◈ ";
      return `${anchorPrefix}${line}`;
    }
    return line.startsWith("[nolo]") && colorEnabled
      ? themeText(line, "chrome", true)
      : line;
  });
  const lines: string[] = [];
  for (const logicalLine of styledLines) {
    lines.push(...wrapTranscriptLine(logicalLine, contentWidth));
  }
  return lines;
}

function renderTailTurnBlock(
  role: TurnRole,
  content: string,
  contentWidth: number,
  colorEnabled: boolean,
): string[] {
  content = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines: string[] = [];
  if (role === "user") {
    const surfaceSeq = colorEnabled ? userSurfaceBackgroundSequence() : "";
    const accentSeq = colorEnabled ? themeColorSequence("accent") : "";
    const multilinePrefix = colorEnabled ? `${accentSeq}\x1b[1m┃  ` : "┃  ";
    const hangingIndent = colorEnabled ? `${accentSeq}\x1b[1m┃  ` : "┃  ";
    for (const rawLine of content.split("\n")) {
      const styledLine = `${multilinePrefix}${rawLine}`;
      const rows = wrapTranscriptLine(styledLine, contentWidth, hangingIndent);
      lines.push(
        ...(surfaceSeq ? rows.map((row) => fillUserBubbleRow(row, surfaceSeq, contentWidth)) : rows),
      );
    }
  } else {
    const highlighted = colorEnabled
      ? formatAssistantDisplay(content)
      : stripAnsi(formatAssistantDisplay(content));
    const rawLines = highlighted.split("\n");
    const styledLines = rawLines.map((line) => {
      return line.startsWith("[nolo]") && colorEnabled
        ? themeText(line, "chrome", true)
        : line;
    });
    for (const logicalLine of styledLines) {
      lines.push(...wrapTranscriptLine(logicalLine, contentWidth));
    }
  }
  return lines;
}

function getStreamingTurnLines(
  role: TurnRole,
  content: string,
  contentWidth: number,
  colorEnabled: boolean,
  density: string,
  surface: string,
): string[] {
  if (
    streamingTurnCache &&
    (streamingTurnCache.role !== role ||
      streamingTurnCache.contentWidth !== contentWidth ||
      streamingTurnCache.colorEnabled !== colorEnabled ||
      streamingTurnCache.density !== density ||
      streamingTurnCache.surface !== surface ||
      !content.startsWith(streamingTurnCache.fullContent.slice(0, streamingTurnCache.prefixLength)))
  ) {
    streamingTurnCache = null;
  }

  if (!streamingTurnCache) {
    streamingTurnCache = {
      role,
      contentWidth,
      colorEnabled,
      density,
      surface,
      fullContent: content,
      prefixLength: 0,
      prefixLines: [],
    };
  }

  if (content.length > streamingTurnCache.fullContent.length) {
    let searchPos = streamingTurnCache.prefixLength;
    let candidateCut = -1;

    while (true) {
      const idx = content.indexOf("\n\n", searchPos);
      if (idx === -1) break;
      const cut = idx + 1;
      searchPos = idx + 2;

      const prefixSub = content.slice(0, cut);
      const fenceCount = (prefixSub.match(/^```/gm) || []).length;
      if (fenceCount % 2 === 0) {
        candidateCut = cut;
        break;
      }
    }

    if (candidateCut > streamingTurnCache.prefixLength) {
      const candidatePrefix = content.slice(0, candidateCut);
      const candidateTail = content.slice(candidateCut);

      const candPrefixLines = renderPrefixTurnBlock(role, candidatePrefix, contentWidth, colorEnabled);
      const candTailLines = renderTailTurnBlock(role, candidateTail, contentWidth, colorEnabled);
      const candCombined = [...candPrefixLines, ...candTailLines];
      const fullCheckLines = renderTurnBlock(role, content, contentWidth, colorEnabled);

      if (JSON.stringify(candCombined) === JSON.stringify(fullCheckLines)) {
        streamingTurnCache.prefixLength = candidateCut;
        streamingTurnCache.prefixLines = candPrefixLines;
        streamingTurnCache.fullContent = content;
      } else {
        streamingTurnCache.fullContent = content;
      }
    } else {
      streamingTurnCache.fullContent = content;
    }
  }

  if (streamingTurnCache.prefixLength === 0) {
    return renderTurnBlock(role, content, contentWidth, colorEnabled);
  }

  const tailContent = content.slice(streamingTurnCache.prefixLength);
  const tailLines = renderTailTurnBlock(role, tailContent, contentWidth, colorEnabled);
  return [...streamingTurnCache.prefixLines, ...tailLines];
}

/**
 * Exact cheap row count for one turn at a width, without materializing styled
 * rows. A turn's row count is a pure function of (visible text, width): ANSI
 * styling is zero-width, so the wrapped count equals the count of the same
 * text with the anchor prefixes applied. We reuse the real assistantOutput
 * pipeline for the line structure (no markdown state machine reimplementation)
 * but throw the styling away, so a cold render / resize costs O(rows) instead
 * of a full re-render of every turn.
 *
 * Must mirror renderTurnBlock exactly:
 * - CRLF / CR collapse to LF before splitting
 * - user turns: first-line `┃  ` and continuation `┃  ` prefixes both occupy
 *   3 cells and hangingIndent `┃  ` is applied to every row, so a single form
 *   yields identical wrap counts
 * - assistant turns: `◈ ` anchor on the first line unless it starts with
 *   [nolo]; chrome theming of [nolo] lines is zero-width
 */
const assistantPlainLinesCache = new Map<string, string[]>();

function getAssistantPlainLines(content: string): string[] {
  let plainLines = assistantPlainLinesCache.get(content);
  if (plainLines !== undefined) {
    return plainLines;
  }

  // Fast path: plain text without markdown structural or inline syntax
  // formatAssistantDisplay only trims and leaves pure text unmodified.
  if (!/[\r\x00#|\-*_~`>+\[\]()•☐☑]|\b\d+\./.test(content)) {
    plainLines = content.trim().split("\n");
  } else {
    plainLines = stripAnsi(formatAssistantDisplay(content)).split("\n");
  }

  if (assistantPlainLinesCache.size > 2000) {
    const firstKey = assistantPlainLinesCache.keys().next().value;
    if (firstKey !== undefined) assistantPlainLinesCache.delete(firstKey);
  }
  assistantPlainLinesCache.set(content, plainLines);
  return plainLines;
}

export function countTurnLines(
  role: TurnRole,
  content: string,
  contentWidth: number,
  command?: string,
): number {
  content = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let count = 0;
  if (role === "user") {
    for (const line of content.split("\n")) {
      count += wrapTranscriptLine(`┃  ${line}`, contentWidth, "┃  ").length;
    }
  } else if (role === "local") {
    // 与 renderTurnBlock 的 local 分支保持一致的行数估算。
    if (command) {
      count += wrapTranscriptLine(`› ${command}`, contentWidth).length;
    }
    if (content) {
      for (const line of content.split("\n")) {
        count += wrapTranscriptLine(`  ${line}`, contentWidth).length;
      }
    }
  } else {
    const plainLines = getAssistantPlainLines(content);
    for (let i = 0; i < plainLines.length; i++) {
      const line = plainLines[i]!;
      const wrapped =
        i === 0 && !line.startsWith("[nolo]")
          ? wrapTranscriptLine(`◈ ${line}`, contentWidth)
          : wrapTranscriptLine(line, contentWidth);
      count += wrapped.length;
    }
  }
  return count;
}

export type TurnOffsetEntry = {
  /** Row of this turn's first line (after any separator above it). */
  startRow: number;
  /** Rows this turn's content occupies (separator excluded). */
  lineCount: number;
  /** 1 when density=spacious inserts a blank row above this turn. */
  separatorAbove: number;
};

export type TurnOffsets = {
  entries: TurnOffsetEntry[];
  totalLines: number;
};

/**
 * Row-offset index: turn → start row. O(n) but reads only the line-count
 * cache — no markdown re-rendering; on a miss the count comes from the cheap
 * countTurnLines pass and is recorded for later frames. Spacious separators
 * depend on position, so they are indexed here rather than cached.
 */
export function buildTurnOffsets(
  history: TurnHistory,
  contentWidth: number
): TurnOffsets {
  const density = getActiveDensity();
  const entries: TurnOffsetEntry[] = [];
  let offset = 0;
  for (let i = 0; i < history.turns.length; i++) {
    const turn = history.turns[i]!;
    const separatorAbove =
      density === "spacious" && (i > 0 || turn.role === "user") ? 1 : 0;
    offset += separatorAbove;
    const cached = turnLineCountCache.get(turn);
    let lineCount: number;
    if (cached && cached.width === contentWidth) {
      lineCount = cached.count;
    } else {
      lineCount = countTurnLines(turn.role, turn.content, contentWidth, turn.command);
      turnLineCountCache.set(turn, { width: contentWidth, count: lineCount });
    }
    entries.push({ startRow: offset, lineCount, separatorAbove });
    offset += lineCount;
  }
  return { entries, totalLines: offset };
}

/** Row index of the blank separator above the current streaming turn, if any. */
function currentTurnSeparator(history: TurnHistory, density: string): number {
  return density === "spacious" &&
    (history.turns.length > 0 || history.currentRole === "user")
    ? 1
    : 0;
}

export function buildHistoryLines(history: TurnHistory, contentWidth: number): string[] {
  const colorEnabled = resolveCliColorEnabled();
  // Visual rhythm: every turn is separated by a blank line. User turns carry a
  // unique ┃ gutter on every line with an accent ❯ marker on the first line (and
  // two spaces on continuation rows), rendering body text in accent + bold so
  // they are structurally and visually unique when scrolling back.
  //
  // Colors use theme tokens (tui/theme.ts) so the history area stays in the
  // same hue family as the status line.
  const density = getActiveDensity();
  // Cheap theme fingerprint: the wash is derived from accent + terminal base,
  // so it changes exactly when a cached user bubble would need repainting.
  const surface = colorEnabled ? userSurfaceBackgroundSequence() : "";
  const wrapped: string[] = [];

  for (let i = 0; i < history.turns.length; i++) {
    const turn = history.turns[i]!;
    // Spacious separators depend on position — keep them outside the cache.
    if (density === "spacious" && (i > 0 || turn.role === "user")) {
      wrapped.push("");
    }
    const cached = turnLineCache.get(turn);
    if (
      cached &&
      cached.width === contentWidth &&
      cached.color === colorEnabled &&
      cached.density === density &&
      cached.surface === surface
    ) {
      wrapped.push(...cached.lines);
    } else {
      const lines = renderTurnBlock(turn.role, turn.content, contentWidth, colorEnabled, turn.command);
      turnLineCache.set(turn, {
        width: contentWidth,
        color: colorEnabled,
        density,
        surface,
        lines,
      });
      wrapped.push(...lines);
    }
  }

  // Streaming turn mutates per chunk — incremental prefix cache.
  if (history.currentRole !== null && history.currentContent) {
    const i = history.turns.length;
    if (density === "spacious" && (i > 0 || history.currentRole === "user")) {
      wrapped.push("");
    }
    wrapped.push(
      ...getStreamingTurnLines(
        history.currentRole,
        history.currentContent,
        contentWidth,
        colorEnabled,
        density,
        surface,
      ),
    );
  }

  return wrapped;
}

export function renderHistory(
  output: NodeJS.WritableStream,
  history: TurnHistory,
  inputLines: number
) {
  const tty = output as { isTTY?: boolean; rows?: number; columns?: number };
  if (!tty.isTTY) return;
  const rows = tty.rows ?? 24;
  const columns = tty.columns ?? 80;
  const visibleHeight = Math.max(1, rows - inputLines);
  const contentWidth = Math.max(1, columns - 1);

  const colorEnabled = resolveCliColorEnabled();
  const density = getActiveDensity();
  const surface = colorEnabled ? userSurfaceBackgroundSequence() : "";

  // Row-offset index: O(turns), reads only cached line counts. A cold render
  // or resize pays the cheap count pass here instead of re-rendering every
  // turn just to slice the visible window.
  const { entries, totalLines: finalizedLines } = buildTurnOffsets(
    history,
    contentWidth,
  );

  // Streaming turn mutates per chunk — incremental prefix cache.
  // Rendered once per frame; the rows are reused for painting when visible.
  let totalLines = finalizedLines;
  let currentStart = -1;
  let currentLines: string[] = [];
  if (history.currentRole !== null && history.currentContent) {
    currentLines = getStreamingTurnLines(
      history.currentRole,
      history.currentContent,
      contentWidth,
      colorEnabled,
      density,
      surface,
    );
    currentStart = finalizedLines + currentTurnSeparator(history, density);
    totalLines = currentStart + currentLines.length;
  }

  if (history.followBottom) {
    history.scrollTop = Math.max(0, totalLines - visibleHeight);
  } else {
    history.scrollTop = Math.max(
      0,
      Math.min(history.scrollTop, Math.max(0, totalLines - visibleHeight))
    );
  }

  history.hasMoreAbove = history.scrollTop > 0;
  history.hasMoreBelow = history.scrollTop + visibleHeight < totalLines;

  const winStart = history.scrollTop;
  const winEnd = Math.min(totalLines, winStart + visibleHeight);
  const visibleLines: string[] = new Array(visibleHeight).fill("");

  // Paint ONLY the turns overlapping the visible window. Off-screen turns are
  // never re-rendered — cache invalidation (theme/density/width) repaints at
  // most one screenful instead of the whole transcript.
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.separatorAbove > 0) {
      const sepRow = entry.startRow - 1;
      if (sepRow >= winStart && sepRow < winEnd) {
        visibleLines[sepRow - winStart] = "";
      }
    }
    const turnStart = entry.startRow;
    const turnEnd = turnStart + entry.lineCount;
    if (turnEnd <= winStart || turnStart >= winEnd) continue;

    const turn = history.turns[i]!;
    const cached = turnLineCache.get(turn);
    let lines: string[];
    if (
      cached &&
      cached.width === contentWidth &&
      cached.color === colorEnabled &&
      cached.density === density &&
      cached.surface === surface
    ) {
      lines = cached.lines;
    } else {
      renderCacheMissCount += 1;
      lines = renderTurnBlock(turn.role, turn.content, contentWidth, colorEnabled, turn.command);
      turnLineCache.set(turn, {
        width: contentWidth,
        color: colorEnabled,
        density,
        surface,
        lines,
      });
    }
    const interStart = Math.max(turnStart, winStart);
    const interEnd = Math.min(turnEnd, winEnd);
    for (let r = interStart; r < interEnd; r++) {
      visibleLines[r - winStart] = lines[r - turnStart] ?? "";
    }
  }
  if (currentStart >= 0) {
    const separatorAbove = currentTurnSeparator(history, density);
    if (separatorAbove > 0) {
      const sepRow = currentStart - 1;
      if (sepRow >= winStart && sepRow < winEnd) {
        visibleLines[sepRow - winStart] = "";
      }
    }
    const currentEnd = currentStart + currentLines.length;
    if (currentEnd > winStart && currentStart < winEnd) {
      const interStart = Math.max(currentStart, winStart);
      const interEnd = Math.min(currentEnd, winEnd);
      for (let r = interStart; r < interEnd; r++) {
        visibleLines[r - winStart] = currentLines[r - currentStart] ?? "";
      }
    }
  }

  // Double-buffering / Line diffing:
  // Compare each composed row against the previous frame for this output stream.
  // When streaming or updating a small part of the viewport, unchanged rows are
  // skipped entirely, reducing terminal escape payload by up to ~95% and eliminating
  // terminal emulation lag.
  const prevBuffer =
    typeof output === "object" && output !== null
      ? frameBufferByOutput.get(output)
      : undefined;
  const isGeometryCompatible =
    prevBuffer !== undefined &&
    prevBuffer.rows === rows &&
    prevBuffer.columns === columns &&
    prevBuffer.inputLines === inputLines &&
    prevBuffer.lines.length === visibleHeight;

  const prevLines = isGeometryCompatible ? prevBuffer.lines : undefined;
  const nextLines: string[] = new Array(visibleHeight);

  // Clear + paint ONLY modified transcript rows. Never use ED (\x1b[J) from
  // the top of the screen — many terminals wipe the docked composer below
  // the scroll region too, which is why the input bar "vanishes" mid-turn.
  // Build a single diffed frame string and write once.
  let frame = "";
  for (let i = 0; i < visibleHeight; i++) {
    const line = visibleLines[i] ?? "";
    const padded = padOrTruncateToWidth(line, columns);
    const rowContent = padded;
    nextLines[i] = rowContent;

    if (!prevLines || prevLines[i] !== rowContent) {
      frame += `\x1b[${i + 1};1H\x1b[2K${rowContent}`;
    }
  }

  if (typeof output === "object" && output !== null) {
    frameBufferByOutput.set(output, {
      rows,
      columns,
      inputLines,
      lines: nextLines,
    });
  }

  if (frame.length > 0) {
    const mainBottom = Math.max(1, rows - inputLines);
    frame += `\x1b[${mainBottom};1H`;
    output.write(frame);
  }
}

export function createHistoryOutputStream(
  history: TurnHistory,
  onUpdate: () => void
): NodeJS.WritableStream {
  return {
    // Virtual TTY: Spinner uses \\r in-place updates. We honor that via
    // applyTerminalOutputToText so frames collapse to one status line instead
    // of spamming the transcript. Do not fall through to process.stdout here.
    isTTY: true,
    write(chunk: string | Buffer): boolean {
      const text = typeof chunk === "string" ? chunk : chunk.toString();
      if (applyOutputChunkToCurrentTurn(history, text)) {
        onUpdate();
      }
      return true;
    },
  } as unknown as NodeJS.WritableStream;
}

export function createNativeOutputStream(
  history: TurnHistory,
  terminalOutput: NodeJS.WritableStream,
): NodeJS.WritableStream {
  return {
    isTTY: true,
    write(chunk: string | Buffer): boolean {
      const text = typeof chunk === "string" ? chunk : chunk.toString();
      applyOutputChunkToCurrentTurn(history, text);
      terminalOutput.write(text);
      return true;
    },
  } as unknown as NodeJS.WritableStream;
}

/**
 * Format one finalized turn into styled ANSI physical lines.
 */
export function formatTurnLines(
  turn: Turn,
  contentWidth: number,
  colorEnabled: boolean = resolveCliColorEnabled(),
): string[] {
  return renderTurnBlock(
    turn.role,
    turn.content,
    contentWidth,
    colorEnabled,
    turn.command,
  );
}

/**
 * Commit a finalized turn directly to the terminal's output stream, pushing it into
 * the native scrollback buffer.
 */
export function commitTurnToTerminal(
  output: NodeJS.WritableStream,
  turn: Turn,
  options?: {
    contentWidth?: number;
    colorEnabled?: boolean;
    addBlankSeparator?: boolean;
  },
): void {
  const tty = output as { columns?: number };
  const contentWidth =
    options?.contentWidth ?? Math.max(1, (tty.columns ?? 80) - 1);
  const colorEnabled = options?.colorEnabled ?? resolveCliColorEnabled();
  const lines = formatTurnLines(turn, contentWidth, colorEnabled);
  if (lines.length === 0) return;
  const prefix = options?.addBlankSeparator ? "\n" : "";
  output.write(`${prefix}${lines.join("\n")}\n`);
}

