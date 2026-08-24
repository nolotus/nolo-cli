/**
 * TUI 固定输入区（docked composer）与 raw input 解码。
 *
 * 从 readlineWorkspace.ts 抽出。createFixedInput 负责底部输入栏的渲染、
 * 滚动区域、鼠标上报；splitRawInput/createRawInputDecoder 负责把终端 raw
 * mode 字节流切成语义 token（按键、粘贴块、CSI 序列）。
 *
 * 依赖：
 * - ./tuiAnsi：displayWidth / fitAnsiLine / wrapTextToLines
 * - ../client/terminalStyles：dimCliText / resolveCliColorEnabled
 * - ./theme：themeColorSequence
 * - ./i18n：t
 * - ./sessionInput：completeSlashCommand
 * - ./session：PASTE_TOKEN_PREFIX
 */
import {
  COLLAPSED_PASTE_PLACEHOLDER_RE,
  shouldCollapsePaste,
} from "../core/collapsedPaste";
import { displayWidth, fitAnsiLine, wrapTextToLines } from "./tuiAnsi";
import { consumeSgrMouseSequence } from "./tuiMouse";
import { dimCliText, resolveCliColorEnabled } from "../client/terminalStyles";
import { themeColorSequence, themeText } from "./theme";
import { t } from "./i18n";
import { completeSlashCommand } from "./sessionInput";
import { PASTE_TOKEN_PREFIX } from "./session";
import { resetHistoryFrameDiffCache } from "./tuiHistory";

function normalizePasteNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Alternate-screen (DECSET 1049) bookkeeping, keyed per output stream.
 *
 * The TUI renders on the *main* screen by default, which shares scrollback
 * with the shell: a wheel scroll moves the terminal's own scrollback while
 * the TUI keeps its own `scrollTop`, and the next 150ms repaint lands in a
 * shifted viewport. Entering the alternate screen gives the TUI a private
 * buffer so the two scroll states can no longer desync.
 *
 * Idempotency matters because every exit path (disable(), SIGINT, SIGTERM,
 * SIGHUP, process exit, uncaughtException, unhandledRejection) writes the
 * leave sequence, and several can fire for one shutdown (e.g. SIGINT then
 * exit). The map records whether each output is currently *on* the
 * alternate screen so the enter/leave sequences are each written at most
 * once per output. Non-TTY outputs (pipes, redirects, tests) are skipped
 * entirely — entering/leaving an alternate screen there is a no-op.
 */
const altScreenOn = new WeakMap<NodeJS.WritableStream, boolean>();
const altScreenInvalidators = new WeakMap<object, Set<() => void>>();

function notifyAltScreenInvalidators(output: object) {
  const set = altScreenInvalidators.get(output);
  if (set) {
    for (const fn of set) {
      fn();
    }
  }
}

function outputIsTty(output: NodeJS.WritableStream): boolean {
  return Boolean((output as { isTTY?: boolean }).isTTY);
}

/**
 * Enter the alternate screen on `output` (idempotent). Returns true iff a
 * sequence was actually written, so callers can pair it with a redraw.
 */
export function enterAltScreen(output: NodeJS.WritableStream): boolean {
  if (!outputIsTty(output)) return false;
  if (altScreenOn.get(output)) return false;
  altScreenOn.set(output, true);
  resetHistoryFrameDiffCache(output);
  notifyAltScreenInvalidators(output);
  output.write("\x1b[?1049h");
  return true;
}

/**
 * Leave the alternate screen on `output` (idempotent). Safe to call from
 * disable(), signal handlers, and process.exit — repeats are no-ops once
 * the output has already returned to the main screen.
 */
export function leaveAltScreen(output: NodeJS.WritableStream): boolean {
  if (!outputIsTty(output)) return false;
  if (!altScreenOn.get(output)) return false;
  altScreenOn.set(output, false);
  resetHistoryFrameDiffCache(output);
  notifyAltScreenInvalidators(output);
  output.write("\x1b[?1049l");
  return true;
}

/** True iff `output` is currently on the alternate screen (mainly for tests). */
export function isAltScreenOn(output: NodeJS.WritableStream): boolean {
  return Boolean(altScreenOn.get(output));
}

/** Soft-highlight collapsed paste chips so they read as chips, not typed text. */
function styleCollapsedPastePlaceholders(
  text: string,
  colorEnabled: boolean,
): string {
  if (!colorEnabled || !text.includes("[paste #")) return text;
  COLLAPSED_PASTE_PLACEHOLDER_RE.lastIndex = 0;
  return text.replace(COLLAPSED_PASTE_PLACEHOLDER_RE, (match) =>
    themeText(match, "accent", true),
  );
}

export type FixedInputController = {
  active: boolean;
  init(): void;
  /**
   * Enter the mid-turn phase after the user submits a line.
   *
   * `submittedText` is accepted for call-site clarity but intentionally not
   * rendered here — the transcript history owns the submitted user turn. The
   * docked composer stays visible with an empty draft so the bottom chrome
   * does not flash away during the agent turn.
   */
  enterOutputMode(submittedText: string): void;
  exitOutputMode(buffer: string, cursorPos?: number): void;
  repaint(buffer: string, cursorPos?: number, force?: boolean): void;
  pause(): void;
  resumeFromSubprocess(): void;
  resumeFromDialog(): void;
  disable(): void;
  getInputLines(): number;
  /** True while a picker/confirm dialog or subprocess owns the screen. */
  isPaused(): boolean;
  /**
   * Toggle terminal mouse reporting. Off = the terminal handles drag-select
   * natively (copy works without Shift) but the wheel no longer scrolls the
   * transcript; keyboard scrolling stays available.
   */
  setMouseEnabled(enabled: boolean): void;
  /**
   * Toggle the terminal alternate-screen buffer (DECSET 1049).
   *
   * On  = enter the private screen so the TUI's own scroll state is isolated
   *        from the shell's scrollback (wheel no longer desyncs the viewport).
   * Off = leave the alternate screen, restoring the shell's prior content.
   *
   * Both directions are idempotent (guarded per-output) so repeated disable()
   * calls and process-exit/signal handlers never write the sequence twice.
   */
  setAltScreenEnabled(enabled: boolean): void;
};

export function createNoopFixedInput(): FixedInputController {
  return {
    active: false,
    init() {},
    enterOutputMode() {},
    exitOutputMode() {},
    repaint() {},
    pause() {},
    resumeFromSubprocess() {},
    resumeFromDialog() {},
    disable() {},
    getInputLines: () => 1,
    isPaused: () => false,
    setMouseEnabled() {},
    setAltScreenEnabled() {},
  };
}

type FixedInputConfig = {
  getStatusLine: () => string;
  /** Optional title line rendered above the status line. */
  getTitleLine?: () => string | null;
  /** turn 进行中的活动行；无活动时返回 null。 */
  getActivityLine?: () => string | null;
  /** 可选多行活动面板（如子 Agent 执行状态与日志行）。优先于 getActivityLine。 */
  getActivityLines?: () => string[] | string | null;
  /**
   * Optional extra lines rendered above the composer (below the status line),
   * e.g. a preview of queued follow-up messages. Each entry is one line.
   */
  getQueueLines?: () => string[];
  /**
   * Composer 高度变化时通知外部，让 readlineWorkspace 触发一次历史重绘。
   * 活动行首次出现时 composer 从 3 行变 4 行，repaintAt 据此 setScrollRegion
   * 收缩历史可视区，但历史是按旧 inputLines 画的、最底行被盖住；这个回调
   * 让外部在 scrollRegion 改变后补一次 renderHistory。在 setScrollRegion
   * 之后调用，避免回调里又读旧 region。
   */
  onInputLinesChange?: (lines: number) => void;
};

export function createFixedInput(
  output: NodeJS.WritableStream,
  config: FixedInputConfig,
): FixedInputController {
  const isTTY = (output as { isTTY?: boolean }).isTTY;
  const getRows = () => (output as { rows?: number }).rows ?? 24;
  const getColumns = () => (output as { columns?: number }).columns ?? 80;
  let inputLines = 1;
  let paused = false;

  const write = (seq: string) => {
    output.write(seq);
  };

  let lastScrollBottom = -1;
  const setScrollRegion = (lines: number, force = false) => {
    const bottom = Math.max(1, getRows() - lines);
    if (force || lastScrollBottom !== bottom) {
      write(`\x1b[1;${bottom}r`);
      lastScrollBottom = bottom;
    }
  };
  const saveCursor = () => write("\x1b7");
  const resetScrollRegion = () => {
    lastScrollBottom = -1;
    write("\x1b[r");
  };

  // Wheel & drag reporting: SGR format (1006) + normal tracking / drag (1002).
  // Without these the terminal never delivers wheel or drag events, so the
  // transcript could not be scrolled or drag-selected by mouse.
  let mouseEnabled = true;
  const enableMouse = () => {
    if (mouseEnabled) write("\x1b[?1006h\x1b[?1002h");
  };
  const disableMouse = () => write("\x1b[?1002l\x1b[?1006l");

  let lastRenderedText: string | null = null;
  let lastStartRow = -1;
  let lastCursorRow = -1;
  let lastCursorCol = -1;
  const invalidateComposerCache = () => {
    lastScrollBottom = -1;
    lastRenderedText = null;
    lastStartRow = -1;
    lastCursorRow = -1;
    lastCursorCol = -1;
  };

  let invalidatorSet = altScreenInvalidators.get(output);
  if (!invalidatorSet) {
    invalidatorSet = new Set();
    altScreenInvalidators.set(output, invalidatorSet);
  }
  invalidatorSet.add(invalidateComposerCache);

  /**
   * OMP-style composer:
   * ──────────────────────── top rule
   * nolo > agent · mode > 📁 path > branch
   * ❯ Type a message...
   * ──────────────────────── bottom rule
   * No side borders, no rainbow powerline blocks, status never wraps.
   */
  const renderInputArea = (
    buffer: string,
    cursorPos?: number,
  ): { text: string; lines: number; cursorCol: number; cursorRow: number } => {
    const colorEnabled = resolveCliColorEnabled();
    const cols = Math.max(1, getColumns());

    const completions = completeSlashCommand(buffer);
    const sections: string[] = [];
    if (completions.length > 0) {
      sections.push(fitAnsiLine(dimCliText(completions.join("  "), colorEnabled), cols));
    }

    // Activity line(s) (e.g. active tool execution or sub-agent run panel)
    // sit ABOVE the top divider rule so ongoing step operations appear in the
    // scrollback stream area, keeping the composer chrome (status, queues, prompt)
    // cleanly bounded below the line.
    const rawActivity = config.getActivityLines
      ? config.getActivityLines()
      : config.getActivityLine
        ? config.getActivityLine()
        : null;
    const activityLines = Array.isArray(rawActivity)
      ? rawActivity.filter((line) => line !== null && line !== undefined)
      : typeof rawActivity === "string" && rawActivity.length > 0
        ? [rawActivity]
        : [];

    for (const actLine of activityLines) {
      sections.push(fitAnsiLine(actLine.replace(/\r?\n/g, " "), cols));
    }

    // The composer rules follow the theme's chrome token rather than a
    // hardcoded bright-black, so /theme actually reaches the input area
    // instead of leaving it stuck on the terminal's default gray.
    const rule = colorEnabled
      ? `\x1b[2m${themeColorSequence("chrome")}${"─".repeat(cols)}\x1b[0m`
      : "─".repeat(cols);
    sections.push(rule);

    const titleLine = config.getTitleLine?.();
    if (titleLine) {
      sections.push(fitAnsiLine(titleLine.replace(/\r?\n/g, " "), cols));
    }
    sections.push(fitAnsiLine(config.getStatusLine(), cols));

    // Queued follow-up preview lines sit between the status line and the input
    // prompt so the user sees the actual staged text, not just a count.
    const queueLines = config.getQueueLines?.() ?? [];
    for (const line of queueLines) {
      // Collapse any newline so each queued entry occupies exactly one physical
      // row. headerRows counts entries, not physical rows, so an embedded "\n"
      // would emit extra rows and drift the input cursor upward.
      sections.push(fitAnsiLine(line.replace(/\r?\n/g, " "), cols));
    }

    const promptRaw = t("promptLabel");
    const promptWidth = displayWidth(promptRaw);
    // Accent-colored chevron so the input area feels active, not inert.
    const prompt = colorEnabled
      ? `${themeColorSequence("accent")}${promptRaw}\x1b[39m`
      : promptRaw;
    const contentWidth = Math.max(1, cols - promptWidth);
    const logicalLines = buffer.length === 0 ? [""] : buffer.split("\n");

    const targetPos = Math.max(0, Math.min(buffer.length, cursorPos ?? buffer.length));
    let charOffset = 0;
    let cursorCol = promptWidth;
    let cursorRow = 0;
    let inputRows = 0;
    let cursorFound = false;

    for (let i = 0; i < logicalLines.length; i += 1) {
      const logical = logicalLines[i] ?? "";
      const isFirst = i === 0;
      const prefix = isFirst ? prompt : " ".repeat(promptWidth);

      if (buffer.length === 0) {
        const placeholder = themeText(t("placeholder"), "chrome", colorEnabled);
        sections.push(fitAnsiLine(`${prefix}${placeholder}`, cols));
        cursorCol = promptWidth;
        cursorRow = 0;
        inputRows = 1;
        cursorFound = true;
        continue;
      }

      const wrapped = wrapTextToLines(logical, contentWidth);
      const rows = wrapped.length > 0 ? wrapped : [""];
      for (let j = 0; j < rows.length; j += 1) {
        const rowPrefix = j === 0 ? prefix : " ".repeat(promptWidth);
        const rowText = rows[j] ?? "";
        sections.push(
          `${rowPrefix}${styleCollapsedPastePlaceholders(rowText, colorEnabled)}`,
        );

        const rowLen = rowText.length;
        if (!cursorFound) {
          if (
            targetPos <= charOffset + rowLen ||
            (j === rows.length - 1 && i === logicalLines.length - 1)
          ) {
            const subOffset = Math.max(0, Math.min(rowLen, targetPos - charOffset));
            const subStr = rowText.slice(0, subOffset);
            cursorCol = promptWidth + displayWidth(subStr);
            cursorRow = inputRows;
            cursorFound = true;
          }
        }
        charOffset += rowLen;
        inputRows += 1;
      }
      charOffset += 1; // count newline between logical lines
    }

    const text = sections.join("\n");
    const lines = sections.length;
    const headerRows =
      (completions.length > 0 ? 1 : 0) +
      2 +
      (titleLine ? 1 : 0) +
      activityLines.length +
      queueLines.length; // completion? + top rule + status + activity lines + queued preview
    return { text, lines, cursorCol, cursorRow: headerRows + cursorRow };
  };

  const repaintAt = (buffer: string, cursorPos?: number, force = false) => {
    const { text, lines, cursorCol, cursorRow } = renderInputArea(buffer, cursorPos);
    let linesChanged = false;
    if (lines !== inputLines) {
      inputLines = lines;
      linesChanged = true;
    }
    setScrollRegion(inputLines);
    // composer 高度变化后通知外部补一次历史重绘：历史是按旧 inputLines 画的，
    // repaintAt 只重画 composer 不重画历史，活动行首次出现那帧历史最底行会被
    // 长高一行的 composer 盖住（刚提交的用户消息正好在那）。必须在
    // setScrollRegion 之后回调，否则回调里读到的还是旧 region。
    if (linesChanged) {
      config.onInputLinesChange?.(inputLines);
    }
    const startRow = getRows() - inputLines + 1;
    const cursorLine = startRow + cursorRow;
    const targetCursorCol = cursorCol + 1;

    const contentChanged =
      force ||
      linesChanged ||
      lastRenderedText !== text ||
      lastStartRow !== startRow;
    const cursorChanged =
      force ||
      linesChanged ||
      lastCursorRow !== cursorLine ||
      lastCursorCol !== targetCursorCol;

    if (contentChanged) {
      write(`\x1b[${startRow};1H\x1b[J${text}`);
      lastRenderedText = text;
      lastStartRow = startRow;
    }

    if (cursorChanged || contentChanged) {
      // CUP (H), not CHA (G): G takes only a column — extra params make Ghostty
      // drop the whole sequence (cursor stays at the end of the bottom rule),
      // and xterm-family would move to column=row on the wrong line.
      write(`\x1b[${cursorLine};${targetCursorCol}H`);
      lastCursorRow = cursorLine;
      lastCursorCol = targetCursorCol;
    }
  };

  if (!isTTY) return createNoopFixedInput();

  return {
    active: true,
    init() {
      invalidateComposerCache();
      saveCursor();
      setScrollRegion(inputLines);
      enableMouse();
    },
    enterOutputMode(_submittedText: string) {
      // Keep the docked composer visible while the agent turn runs. The
      // submitted text is already painted into the history pane; tearing the
      // bottom chrome down here is what made the bar flash away on Enter.
      repaintAt("");
    },
    exitOutputMode(buffer: string, cursorPos?: number) {
      saveCursor();
      repaintAt(buffer, cursorPos);
    },
    repaint(buffer: string, cursorPos?: number, force?: boolean) {
      repaintAt(buffer, cursorPos, force);
    },
    pause() {
      paused = true;
      invalidateComposerCache();
      disableMouse();
      resetScrollRegion();
    },
    resumeFromSubprocess() {
      paused = false;
      invalidateComposerCache();
      resetHistoryFrameDiffCache(output);
      setScrollRegion(inputLines);
      enableMouse();
      const scrollBottom = Math.max(1, getRows() - inputLines);
      write(`\x1b[${scrollBottom};1H\n`);
    },
    resumeFromDialog() {
      paused = false;
      invalidateComposerCache();
      resetHistoryFrameDiffCache(output);
      saveCursor();
      setScrollRegion(inputLines);
      enableMouse();
    },
    disable() {
      invalidatorSet?.delete(invalidateComposerCache);
      disableMouse();
      resetScrollRegion();
      // Leave the alternate screen last: mouse reporting and the scroll
      // region belong to the private buffer, so they must be reset while we
      // still own it. Switching back to the main screen restores the shell's
      // prior content, so the old cursor-positioning write below is dropped
      // (it cleared a row that the main screen already repopulated).
      leaveAltScreen(output);
    },
    getInputLines: () => inputLines,
    isPaused: () => paused,
    setMouseEnabled(enabled: boolean) {
      mouseEnabled = enabled;
      if (enabled) {
        write("\x1b[?1006h\x1b[?1002h");
      } else {
        write("\x1b[?1002l\x1b[?1006l");
      }
    },
    setAltScreenEnabled(enabled: boolean) {
      if (enabled) {
        enterAltScreen(output);
      } else {
        leaveAltScreen(output);
      }
    },
  };
}

function readCsiSequence(input: string, start: number): string | null {
  if (!input.startsWith("\x1b[", start)) return null;
  let index = start + 2;
  while (index < input.length) {
    const code = input.charCodeAt(index);
    if (code >= 0x30 && code <= 0x3f) {
      index += 1;
      continue;
    }
    if (code >= 0x20 && code <= 0x2f) {
      index += 1;
      continue;
    }
    if (code >= 0x40 && code <= 0x7e) {
      index += 1;
      return input.slice(start, index);
    }
    return null;
  }
  return null;
}

/** OSC (DCS-equivalent) starts with ESC ] and ends at BEL (0x07) or ST (ESC \). */
function parseOscEnd(input: string, start: number): number | null {
  if (!input.startsWith("\x1b]", start)) return null;
  const bodyStart = start + 2;
  const bel = input.indexOf("\x07", bodyStart);
  const st = input.indexOf("\x1b\\", bodyStart);
  let end = -1;
  if (bel !== -1) end = bel + 1;
  if (st !== -1) {
    const stEnd = st + 2;
    if (end === -1 || stEnd < end) end = stEnd;
  }
  return end === -1 ? null : end;
}

/** An OSC reply that has not yet reached its BEL (0x07) or ST (ESC \\) terminator. */
function isIncompleteOsc(input: string): boolean {
  return input.startsWith("\x1b]") && parseOscEnd(input, 0) === null;
}

export function isIncompleteTail(input: string, start: number): boolean {
  if (start >= input.length) return false;
  const rem = input.slice(start);
  if (rem === "\x1b") return true;
  if (rem === "\x1b[") return true;
  if (rem.startsWith("\x1b[")) {
    let index = start + 2;
    while (index < input.length) {
      const code = input.charCodeAt(index);
      if ((code >= 0x30 && code <= 0x3f) || (code >= 0x20 && code <= 0x2f)) {
        index += 1;
        continue;
      }
      if (code >= 0x40 && code <= 0x7e) {
        return false;
      }
      return false;
    }
    return true;
  }
  if (parseOscEnd(input, start) === null && input.startsWith("\x1b]", start)) {
    // An OSC reply that hasn't reached its BEL / ST terminator yet — hold it
    // until the next chunk arrives.
    return true;
  }
  if (rem.startsWith("\x1bO") && rem.length < 3) {
    return true;
  }
  return false;
}

/**
 * Bracketed-paste markers the *terminal sends* around clipboard content.
 *
 * Do not confuse with DECSET 2004 enable/disable (`\x1b[?2004h` / `\x1b[?2004l`),
 * which the app writes *to* the terminal. Using those here silently disables
 * paste detection: real pastes arrive as `\x1b[200~…\x1b[201~` and get treated
 * as ordinary keystrokes, so collapse-to-chip never fires.
 */
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * xterm bracketed-paste end marker. Per protocol the *first* CSI 201~ after
 * CSI 200~ terminates the paste — a literal `\x1b[201~` inside the payload
 * therefore closes early (inherent limitation; remainder is reparsed and may
 * still collapse via the unmarked-burst heuristic below).
 */
function findBracketedPasteEnd(input: string, contentStart: number): number {
  return input.indexOf(PASTE_END, contentStart);
}

function emitPlainRunAsTokens(run: string): string[] {
  if (run.length === 0) return [];
  if (shouldCollapsePaste(normalizePasteNewlines(run))) {
    return [`${PASTE_TOKEN_PREFIX}${run}`];
  }
  const tokens: string[] = [];
  for (let index = 0; index < run.length; ) {
    const codePoint = run.codePointAt(index);
    if (codePoint === undefined) break;
    const value = String.fromCodePoint(codePoint);
    tokens.push(value);
    index += value.length;
  }
  return tokens;
}

export function splitRawInputWithTail(
  input: string,
  options?: { forceCompleteOpenPaste?: boolean },
): { tokens: string[]; tail: string } {
  const tokens: string[] = [];
  for (let index = 0; index < input.length; ) {
    if (isIncompleteTail(input, index)) {
      return { tokens, tail: input.slice(index) };
    }
    const oscEnd = parseOscEnd(input, index);
    if (oscEnd !== null) {
      // Terminal OSC reply (e.g. \x1b]11;rgb:… from a background query) — skip
      // wholesale, it is not a keystroke.
      index = oscEnd;
      continue;
    }
    if (input.startsWith(PASTE_START, index)) {
      const contentStart = index + PASTE_START.length;
      const endPos = findBracketedPasteEnd(input, contentStart);
      if (endPos !== -1) {
        const payload = input.slice(contentStart, endPos);
        tokens.push(`${PASTE_TOKEN_PREFIX}${payload}`);
        index = endPos + PASTE_END.length;
      } else if (options?.forceCompleteOpenPaste) {
        // Explicit flush / non-streaming callers only: terminal dropped the
        // end marker. Treat remainder as paste.
        const payload = input.slice(contentStart);
        tokens.push(`${PASTE_TOKEN_PREFIX}${payload}`);
        index = input.length;
      } else {
        // Paste start seen but end not yet — keep buffered across data chunks.
        return { tokens, tail: input.slice(index) };
      }
      continue;
    }
    if (input.startsWith("\x1b[13;2~", index)) {
      tokens.push("\x1b[13;2~");
      index += "\x1b[13;2~".length;
      continue;
    }
    if (input.startsWith("\x1b[27;2;13~", index)) {
      tokens.push("\x1b[27;2;13~");
      index += "\x1b[27;2;13~".length;
      continue;
    }
    if (input.startsWith("\x1b\r", index)) {
      tokens.push("\x1b\r");
      index += 2;
      continue;
    }
    const csi = readCsiSequence(input, index);
    if (csi) {
      tokens.push(csi);
      index += csi.length;
      continue;
    }

    // Plain run until next ESC (or end). Oversized unmarked bursts become one
    // PASTE token here — this is the real unmarked-paste path (decoder feeds
    // whole chunks; per-code-point applyTuiInputKey never sees them).
    const nextEsc = input.indexOf("\x1b", index);
    const runEnd = nextEsc === -1 ? input.length : nextEsc;
    const run = input.slice(index, runEnd);
    if (run.length === 0) {
      const codePoint = input.codePointAt(index);
      if (codePoint === undefined) break;
      const value = String.fromCodePoint(codePoint);
      tokens.push(value);
      index += value.length;
      continue;
    }
    tokens.push(...emitPlainRunAsTokens(run));
    index = runEnd;
  }
  return { tokens, tail: "" };
}

export function splitRawInput(input: string): string[] {
  // Force-complete an open paste so callers that don't stream (tests / flush)
  // still get a PASTE token instead of leaking raw `\x1b[200~` + body chars.
  const { tokens, tail } = splitRawInputWithTail(input, {
    forceCompleteOpenPaste: true,
  });
  if (!tail) return tokens;
  return [...tokens, ...emitPlainRunAsTokens(tail)];
}

export type RawInputDecoder = {
  (chunk: Buffer | string): void;
  flush(): void;
  destroy(): void;
};

/**
 * A bare ESC arriving within this window after a complete mouse report is
 * treated as the head of a split report rather than an Esc keypress.
 */
const MOUSE_ACTIVE_WINDOW_MS = 250;

export function createRawInputDecoder(
  emitToken: (token: string) => void,
  options?: {
    escTimeoutMs?: number;
    /** @deprecated Open pastes no longer force-complete on a timer. */
    openPasteTimeoutMs?: number;
    /** Debounce for coalescing multi-chunk unmarked paste bursts. */
    unmarkedPasteDebounceMs?: number;
    /**
     * Grace window for a bare ESC that arrived while the mouse was actively
     * reporting — it is far more likely the head of a split wheel report than
     * a real Esc keypress. Defaults to 120ms.
     */
    mouseSplitGraceMs?: number;
  },
): RawInputDecoder {
  const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
  let pendingBuffer = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutMs = options?.escTimeoutMs ?? 15;
  const unmarkedPasteDebounceMs = options?.unmarkedPasteDebounceMs ?? 40;
  const mouseSplitGraceMs = options?.mouseSplitGraceMs ?? 120;
  // Timestamp of the last complete mouse report seen. Used to widen the bare-ESC
  // grace window only while the mouse is actively reporting (see decodeFn).
  let lastMouseReportAt = -Infinity;

  /**
   * Single emit path: records when a complete mouse report goes out so the
   * bare-ESC handling can tell "mouse is streaming reports right now" from
   * "user pressed Esc".
   */
  const onToken = (token: string) => {
    if (consumeSgrMouseSequence(token)) lastMouseReportAt = Date.now();
    emitToken(token);
  };

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const emitCodePoints = (text: string) => {
    for (let index = 0; index < text.length; ) {
      const codePoint = text.codePointAt(index);
      if (codePoint === undefined) break;
      const value = String.fromCodePoint(codePoint);
      onToken(value);
      index += value.length;
    }
  };

  const flushPlainPending = () => {
    clearTimer();
    if (pendingBuffer.length === 0) return;
    const text = pendingBuffer;
    pendingBuffer = "";
    for (const token of emitPlainRunAsTokens(text)) {
      onToken(token);
    }
  };

  const flushEscPending = (forceCompleteOpenPaste: boolean) => {
    clearTimer();
    if (pendingBuffer.length === 0) return;
    const textToFlush = pendingBuffer;
    pendingBuffer = "";
    const { tokens, tail } = splitRawInputWithTail(textToFlush, {
      forceCompleteOpenPaste,
    });
    for (const token of tokens) {
      onToken(token);
    }
    if (!tail) return;
    if (forceCompleteOpenPaste) {
      // Stream/explicit end: never stall on a partial CSI — emit raw.
      // Except a partial SGR mouse report (\x1b[<… without trailing M/m)
      // or an unterminated OSC reply (\x1b]… without BEL/ST): neither is a
      // keypress, and emitting them raw would surface as a lone \x1b
      // (cooperative stop) plus `[<65;…` / `]11;rgb:…` typed into the
      // composer. Drop them — the report either completes in a later chunk
      // or is lost (one scroll step / a dropped theme probe, harmless).
      if (
        consumeSgrMouseSequence(tail) === undefined ||
        isIncompleteOsc(tail)
      ) {
        return;
      }
      emitCodePoints(tail);
      return;
    }
    // Keep incomplete open-paste / CSI buffered.
    pendingBuffer = tail;
  };

  const decodeFn = (chunk: Buffer | string) => {
    clearTimer();
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    const text = decoder.decode(bytes, { stream: true });
    pendingBuffer += text;

    // Open bracketed paste: keep buffering until 201~ (or explicit flush).
    // Never arm a force-complete timer — slow SSH would tear the paste into
    // a half chip + keystroke flood.
    if (pendingBuffer.startsWith(PASTE_START)) {
      const endPos = findBracketedPasteEnd(
        pendingBuffer,
        PASTE_START.length,
      );
      if (endPos === -1) return;
      const { tokens, tail } = splitRawInputWithTail(pendingBuffer);
      pendingBuffer = tail;
      for (const token of tokens) onToken(token);
      if (pendingBuffer.startsWith(PASTE_START)) return;
      // Fall through to handle any plain remainder (e.g. early 201~ close).
    }

    if (pendingBuffer.includes("\x1b")) {
      const { tokens, tail } = splitRawInputWithTail(pendingBuffer);
      pendingBuffer = tail;
      for (const token of tokens) onToken(token);
      if (pendingBuffer.startsWith(PASTE_START)) return;
      if (pendingBuffer.length > 0) {
        // Incomplete SGR mouse report (`\x1b[<…`) or OSC reply (`\x1b]…`):
        // wait indefinitely. These are real reports that complete in a later
        // chunk, or flush()/destroy() drops them. Emitting them now would leak
        // the report body into the composer.
        if (
          consumeSgrMouseSequence(pendingBuffer) === undefined ||
          isIncompleteOsc(pendingBuffer)
        ) {
          return;
        }
        if (pendingBuffer === "\x1b") {
          // Bare ESC: normally the Esc key, but a wheel/drag report can be
          // split exactly at `\x1b` | `[<…M` when a streaming repaint stalls
          // the event loop. While the mouse is actively reporting, give the
          // next chunk a longer grace window before committing to "Esc
          // pressed" — otherwise scrolling mid-stream stops the turn and leaks
          // the report body as text. Esc still works, just a frame later.
          const graceMs =
            Date.now() - lastMouseReportAt < MOUSE_ACTIVE_WINDOW_MS
              ? mouseSplitGraceMs
              : timeoutMs;
          timer = setTimeout(() => flushEscPending(true), graceMs);
          return;
        }
        // Generic partial CSI/SS3 (`\x1b[`, `\x1bO`, malformed `\x1b[…]`) that
        // isn't a recognized report: it's never a keypress on its own, and
        // force-emitting it would type `[<65;…` into the composer. Wait a
        // bounded timeout for the rest; if it never completes, DROP the bytes
        // rather than leak them or stall input forever.
        timer = setTimeout(() => {
          pendingBuffer = "";
        }, timeoutMs);
      }
      return;
    }

    // Pure plain text: coalesce briefly so multi-chunk unmarked pastes merge,
    // then promote oversized bursts to a PASTE token.
    if (shouldCollapsePaste(normalizePasteNewlines(pendingBuffer))) {
      timer = setTimeout(flushPlainPending, unmarkedPasteDebounceMs);
      return;
    }

    if (!pendingBuffer.includes("\n") && !pendingBuffer.includes("\r")) {
      emitCodePoints(pendingBuffer);
      pendingBuffer = "";
      return;
    }

    // Some newlines but below collapse threshold — wait one debounce tick in
    // case more chunks arrive and push it over the threshold.
    timer = setTimeout(flushPlainPending, unmarkedPasteDebounceMs);
  };

  decodeFn.flush = () => {
    if (
      pendingBuffer.startsWith(PASTE_START) ||
      pendingBuffer.includes("\x1b")
    ) {
      flushEscPending(true);
      return;
    }
    flushPlainPending();
  };
  decodeFn.destroy = () => {
    clearTimer();
    pendingBuffer = "";
  };

  return decodeFn;
}