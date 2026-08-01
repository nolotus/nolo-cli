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

export function buildHistoryLines(history: TurnHistory, contentWidth: number): string[] {
  const colorEnabled = resolveCliColorEnabled();
  // Visual rhythm: every turn is separated by a blank line, user turns carry a
  // colored ❯ marker, and [nolo] system notices render dim so questions,
  // answers, and plumbing are distinguishable at a glance.
  //
  // Colors use theme tokens (tui/theme.ts) so the history area stays in the
  // same hue family as the status line — accent for the user marker, chrome
  // (muted gray) for system notices.
  const styleTurn = (role: TurnRole, content: string): string => {
    if (role === "user") {
      // Only the ❯ marker carries accent; the text itself stays on the
      // terminal's default foreground. Coloring whole user turns made every
      // question a solid block of accent, which fought the assistant's own
      // markdown highlighting — the marker alone is enough to tell turns apart.
      if (!colorEnabled) return `❯ ${content}`;
      const accent = themeColorSequence("accent");
      const reset = "\x1b[39m";
      return `${accent}❯${reset} ${content}`;
    }
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
  };
  const lines: string[] = [];
  const pushTurn = (role: TurnRole, content: string) => {
    if (getActiveDensity() === "spacious") {
      if (lines.length > 0 || role === "user") lines.push("");
    }
    lines.push(styleTurn(role, content));
  };
  for (const turn of history.turns) {
    pushTurn(turn.role, turn.content);
  }
  if (history.currentRole !== null && history.currentContent) {
    pushTurn(history.currentRole, history.currentContent);
  }
  const wrapped: string[] = [];
  for (const entry of lines) {
    for (const logicalLine of entry.split("\n")) {
      wrapped.push(...wrapTranscriptLine(logicalLine, contentWidth));
    }
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