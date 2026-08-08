/**
 * TUI 对话历史：turn 数据结构、样式化渲染、滚动条贴边、滚动动作应用。
 *
 * 从 readlineWorkspace.ts 抽出。依赖：
 * - ./tuiAnsi：wrapTranscriptLine / padOrTruncateToWidth / applyTerminalOutputToText
 * - ./tuiScrollbar：renderScrollbarRow / parseScrollAction / ScrollAction / WHEEL_SCROLL_LINES
 * - ./theme：themeColorSequence / themeText / getActiveDensity / resolveCliColorEnabled
 * - ../client/assistantOutput：formatAssistantDisplay（assistant turn 的唯一渲染器，
 *   与流式输出共享同一份实现，避免历史重绘与流式样式漂移）
 */
import {
  applyTerminalOutputToText,
  padOrTruncateToWidth,
  stripAnsi,
  wrapTranscriptLine,
} from "./tuiAnsi";
import {
  renderScrollbarRow,
  type ScrollAction,
  WHEEL_SCROLL_LINES,
} from "./tuiScrollbar";
import {
  getActiveDensity,
  themeColorSequence,
  themeText,
} from "./theme";
import { formatAssistantDisplay } from "../client/assistantOutput";
import { resolveCliColorEnabled } from "../client/terminalStyles";

export type TurnRole = "user" | "assistant";

export type Turn = {
  role: TurnRole;
  content: string;
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
  lines: string[];
};

/** Finalized turns are immutable; cache entries GC when truncation drops them. */
const turnLineCache = new WeakMap<Turn, TurnLineCacheEntry>();

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
    if (history.turns.length > MAX_TUI_HISTORY_TURNS) {
      history.turns = history.turns.slice(history.turns.length - MAX_TUI_HISTORY_TURNS);
    }
  }
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

/** Decorate + wrap one turn; separators stay outside so position can vary. */
function renderTurnBlock(
  role: TurnRole,
  content: string,
  contentWidth: number,
  colorEnabled: boolean,
): string[] {
  const lines: string[] = [];
  if (role === "user") {
    const logicalLines = content.split("\n");
    const accentSeq = colorEnabled ? themeColorSequence("accent") : "";
    const chromeSeq = colorEnabled ? themeColorSequence("chrome") : "";

    for (let i = 0; i < logicalLines.length; i++) {
      const line = logicalLines[i];
      let styledLine: string;
      if (colorEnabled) {
        // No `\x1b[39m` after the marker: the body's own accentSeq below
        // overrides the foreground immediately, and wrapTranscriptLine only
        // treats `\x1b[0m` as a style reset — an extra `39` would just pile up
        // in its activeStyles and get re-emitted on every wrapped row.
        const prefix = i === 0 ? `${accentSeq}❯ ` : `${chromeSeq}│ `;
        // Body text is accent + bold so user turns stand out when scrolling
        // back through a long transcript. No explicit closer here:
        // wrapTranscriptLine terminates every styled row with `\x1b[0m`, which
        // both stops the color bleeding into the scrollbar column and re-opens
        // bold + accent on each soft-wrapped continuation row.
        styledLine = `${prefix}\x1b[1m${accentSeq}${line}`;
      } else {
        const prefix = i === 0 ? "❯ " : "  ";
        styledLine = `${prefix}${line}`;
      }
      lines.push(...wrapTranscriptLine(styledLine, contentWidth, "  "));
    }
  } else {
    const styledEntry = styleAssistantTurn(content, colorEnabled);
    for (const logicalLine of styledEntry.split("\n")) {
      lines.push(...wrapTranscriptLine(logicalLine, contentWidth));
    }
  }
  return lines;
}

export function buildCopyViewLines(history: TurnHistory): string[] {
  const turns = [...history.turns];
  if (history.currentRole !== null) {
    turns.push({ role: history.currentRole, content: history.currentContent });
  }
  const lines: string[] = [];
  for (const [index, turn] of turns.entries()) {
    if (index > 0) lines.push("");
    // Normalize line endings: CRLF (\r\n) and lone CR (\r, legacy Mac) both
    // collapse to LF so split("\n") yields clean logical lines. Without this,
    // a stray \r in copied content would either vanish or render as a row
    // rewind, corrupting both the copy-view display and the copied text.
    const normalized = stripAnsi(turn.content).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    lines.push(...normalized.split("\n"));
  }
  return lines;
}

export function buildHistoryLines(history: TurnHistory, contentWidth: number): string[] {
  const colorEnabled = resolveCliColorEnabled();
  // Visual rhythm: every turn is separated by a blank line, user turns carry an
  // accent ❯ marker on the first line and chrome │ markers on explicit multiline
  // continuations (two spaces when no-color), and render their body text in
  // accent + bold so they stay easy to spot when scrolling back.
  //
  // Colors use theme tokens (tui/theme.ts) so the history area stays in the
  // same hue family as the status line.
  const density = getActiveDensity();
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
      cached.density === density
    ) {
      wrapped.push(...cached.lines);
    } else {
      const lines = renderTurnBlock(turn.role, turn.content, contentWidth, colorEnabled);
      turnLineCache.set(turn, {
        width: contentWidth,
        color: colorEnabled,
        density,
        lines,
      });
      wrapped.push(...lines);
    }
  }

  // Streaming turn mutates per chunk — always compute fresh (never cached).
  if (history.currentRole !== null && history.currentContent) {
    const i = history.turns.length;
    if (density === "spacious" && (i > 0 || history.currentRole === "user")) {
      wrapped.push("");
    }
    wrapped.push(
      ...renderTurnBlock(
        history.currentRole,
        history.currentContent,
        contentWidth,
        colorEnabled,
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

  const lines = buildHistoryLines(history, contentWidth);
  const totalLines = lines.length;

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

  const visibleStart = history.scrollTop;
  const visibleEnd = Math.min(totalLines, visibleStart + visibleHeight);
  const visibleLines = lines.slice(visibleStart, visibleEnd);

  // Clear + paint ONLY the main transcript rows. Never use ED (\x1b[J) from
  // the top of the screen — many terminals wipe the docked composer below
  // the scroll region too, which is why the input bar "vanishes" mid-turn.
  // Build a single frame string and write once — multiple write() calls per
  // row cause the terminal to paint partial frames, producing flicker during
  // streaming output.
  let frame = "";
  for (let i = 0; i < visibleHeight; i++) {
    const line = visibleLines[i] ?? "";
    const padded = padOrTruncateToWidth(line, contentWidth);
    const thumb = renderScrollbarRow(i, visibleHeight, totalLines, history.scrollTop);
    frame += `\x1b[${i + 1};1H`;
    frame += "\x1b[2K";
    frame += padded;
    frame += `\x1b[${columns}G`;
    frame += thumb;
  }

  const mainBottom = Math.max(1, rows - inputLines);
  frame += `\x1b[${mainBottom};1H`;
  output.write(frame);
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

export function applyScrollAction(
  history: TurnHistory,
  action: ScrollAction,
  output: NodeJS.WritableStream,
  inputLines: number
): void {
  const tty = output as { rows?: number; columns?: number };
  const rows = tty.rows ?? 24;
  const columns = tty.columns ?? 80;
  const visibleHeight = Math.max(1, rows - inputLines);
  const contentWidth = Math.max(1, columns - 1);
  const totalLines = buildHistoryLines(history, contentWidth).length;
  const maxScrollTop = Math.max(0, totalLines - visibleHeight);

  history.followBottom = false;

  switch (action) {
    case "page-up":
      history.scrollTop = Math.max(0, history.scrollTop - visibleHeight);
      break;
    case "page-down":
      history.scrollTop = Math.min(maxScrollTop, history.scrollTop + visibleHeight);
      break;
    case "half-page-up":
      history.scrollTop = Math.max(0, history.scrollTop - Math.floor(visibleHeight / 2));
      break;
    case "half-page-down":
      history.scrollTop = Math.min(
        maxScrollTop,
        history.scrollTop + Math.floor(visibleHeight / 2)
      );
      break;
    case "wheel-up":
      history.scrollTop = Math.max(0, history.scrollTop - WHEEL_SCROLL_LINES);
      break;
    case "wheel-down":
      history.scrollTop = Math.min(maxScrollTop, history.scrollTop + WHEEL_SCROLL_LINES);
      // Scrolling back to the bottom resumes live-tail, like the End key.
      if (history.scrollTop >= maxScrollTop) history.followBottom = true;
      break;
    case "top":
      history.scrollTop = 0;
      break;
    case "bottom":
      history.scrollTop = maxScrollTop;
      history.followBottom = true;
      break;
  }
}
