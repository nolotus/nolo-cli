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
import { displayWidth, fitAnsiLine, wrapTextToLines } from "./tuiAnsi";
import { dimCliText, resolveCliColorEnabled } from "../client/terminalStyles";
import { themeColorSequence } from "./theme";
import { t } from "./i18n";
import { completeSlashCommand } from "./sessionInput";
import { PASTE_TOKEN_PREFIX } from "./session";

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
  exitOutputMode(buffer: string): void;
  repaint(buffer: string): void;
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
  };
}

type FixedInputConfig = {
  getStatusLine: () => string;
  /** turn 进行中的活动行；无活动时返回 null。 */
  getActivityLine?: () => string | null;
  /**
   * Optional extra lines rendered above the composer (below the status line),
   * e.g. a preview of queued follow-up messages. Each entry is one line.
   */
  getQueueLines?: () => string[];
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

  const setScrollRegion = (lines: number) => {
    const bottom = Math.max(1, getRows() - lines);
    write(`\x1b[1;${bottom}r`);
  };
  const saveCursor = () => write("\x1b7");
  const resetScrollRegion = () => write("\x1b[r");

  // Wheel reporting: SGR format (1006) + basic tracking (1000). Without these
  // the terminal never delivers wheel events, so the transcript could not be
  // scrolled by trackpad/mouse at all. Selection still works via the
  // terminal's bypass modifier (e.g. Shift in Ghostty/iTerm2), and /mouse off
  // flips mouseEnabled so drag-select works without a modifier.
  let mouseEnabled = true;
  const enableMouse = () => {
    if (mouseEnabled) write("\x1b[?1006h\x1b[?1000h");
  };
  const disableMouse = () => write("\x1b[?1000l\x1b[?1006l");

  /**
   * OMP-style composer:
   * ──────────────────────── top rule
   * nolo > agent · mode > 📁 path > branch
   * ❯ Type a message...
   * ──────────────────────── bottom rule
   * No side borders, no rainbow powerline blocks, status never wraps.
   */
  const renderInputArea = (buffer: string): { text: string; lines: number; cursorCol: number; cursorRow: number } => {
    const colorEnabled = resolveCliColorEnabled();
    const cols = Math.max(1, getColumns());

    const completions = completeSlashCommand(buffer);
    const sections: string[] = [];
    if (completions.length > 0) {
      sections.push(fitAnsiLine(dimCliText(completions.join("  "), colorEnabled), cols));
    }

    // The composer rules follow the theme's chrome token rather than a
    // hardcoded bright-black, so /theme actually reaches the input area
    // instead of leaving it stuck on the terminal's default gray.
    const rule = colorEnabled
      ? `\x1b[2m${themeColorSequence("chrome")}${"─".repeat(cols)}\x1b[0m`
      : "─".repeat(cols);
    sections.push(rule);

    sections.push(fitAnsiLine(config.getStatusLine(), cols));

    const activityLine = config.getActivityLine?.() ?? null;
    if (activityLine) {
      sections.push(fitAnsiLine(activityLine.replace(/\r?\n/g, " "), cols));
    }

    // Queued follow-up preview lines sit between the status line and the input
    // prompt so the user sees the actual staged text, not just a count.
    const queueLines = config.getQueueLines?.() ?? [];
    for (const line of queueLines) {
      // Collapse any newline so each queued entry occupies exactly one physical
      // row. headerRows counts entries, not physical rows, so an embedded "\n"
      // would emit extra rows and drift the input cursor upward.
      sections.push(fitAnsiLine(line.replace(/\r?\n/g, " "), cols));
    }

    const prompt = t("promptLabel");
    const promptWidth = displayWidth(prompt);
    const contentWidth = Math.max(1, cols - promptWidth);
    const logicalLines = buffer.length === 0 ? [""] : buffer.split("\n");

    let cursorCol = promptWidth;
    let cursorRow = 0;
    let inputRows = 0;

    for (let i = 0; i < logicalLines.length; i += 1) {
      const logical = logicalLines[i] ?? "";
      const isFirst = i === 0;
      const prefix = isFirst ? prompt : " ".repeat(promptWidth);

      if (buffer.length === 0) {
        const placeholder = dimCliText(t("placeholder"), colorEnabled);
        sections.push(fitAnsiLine(`${prefix}${placeholder}`, cols));
        cursorCol = promptWidth;
        cursorRow = 0;
        inputRows = 1;
        continue;
      }

      const wrapped = wrapTextToLines(logical, contentWidth);
      const rows = wrapped.length > 0 ? wrapped : [""];
      for (let j = 0; j < rows.length; j += 1) {
        const rowPrefix = j === 0 ? prefix : " ".repeat(promptWidth);
        sections.push(`${rowPrefix}${rows[j]}`);
        cursorCol = displayWidth(rowPrefix) + displayWidth(rows[j]);
        cursorRow = inputRows;
        inputRows += 1;
      }
    }

    const text = sections.join("\n");
    const lines = sections.length;
    const headerRows =
      (completions.length > 0 ? 1 : 0) +
      2 +
      (activityLine ? 1 : 0) +
      queueLines.length; // completion? + top rule + status + activity + queued preview
    return { text, lines, cursorCol, cursorRow: headerRows + cursorRow };
  };

  const repaintAt = (buffer: string) => {
    const { text, lines, cursorCol, cursorRow } = renderInputArea(buffer);
    if (lines !== inputLines) {
      inputLines = lines;
    }
    setScrollRegion(inputLines);
    const startRow = getRows() - inputLines + 1;
    write(`\x1b[${startRow};1H`);
    write("\x1b[J");
    write(text);
    const cursorLine = startRow + cursorRow;
    // CUP (H), not CHA (G): G takes only a column — extra params make Ghostty
    // drop the whole sequence (cursor stays at the end of the bottom rule),
    // and xterm-family would move to column=row on the wrong line.
    write(`\x1b[${cursorLine};${cursorCol + 1}H`);
  };

  if (!isTTY) return createNoopFixedInput();

  return {
    active: true,
    init() {
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
    exitOutputMode(buffer: string) {
      saveCursor();
      repaintAt(buffer);
    },
    repaint(buffer: string) {
      repaintAt(buffer);
    },
    pause() {
      paused = true;
      disableMouse();
      resetScrollRegion();
    },
    resumeFromSubprocess() {
      paused = false;
      setScrollRegion(inputLines);
      enableMouse();
      const scrollBottom = Math.max(1, getRows() - inputLines);
      write(`\x1b[${scrollBottom};1H\n`);
    },
    resumeFromDialog() {
      paused = false;
      saveCursor();
      setScrollRegion(inputLines);
      enableMouse();
    },
    disable() {
      disableMouse();
      resetScrollRegion();
      const rows = getRows();
      write(`\x1b[${rows};1H\x1b[2K\x1b[${Math.max(1, rows - 1)};1H`);
    },
    getInputLines: () => inputLines,
    isPaused: () => paused,
    setMouseEnabled(enabled: boolean) {
      mouseEnabled = enabled;
      if (enabled) {
        write("\x1b[?1006h\x1b[?1000h");
      } else {
        write("\x1b[?1000l\x1b[?1006l");
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
  if (rem.startsWith("\x1bO") && rem.length < 3) {
    return true;
  }
  return false;
}

const PASTE_START = "\x1b[?2004h";
const PASTE_END = "\x1b[?2004l";

export function splitRawInputWithTail(input: string): { tokens: string[]; tail: string } {
  const tokens: string[] = [];
  for (let index = 0; index < input.length;) {
    if (isIncompleteTail(input, index)) {
      return { tokens, tail: input.slice(index) };
    }
    if (input.startsWith(PASTE_START, index)) {
      const contentStart = index + PASTE_START.length;
      const endPos = input.indexOf(PASTE_END, contentStart);
      if (endPos !== -1) {
        const payload = input.slice(contentStart, endPos);
        tokens.push(`${PASTE_TOKEN_PREFIX}${payload}`);
        index = endPos + PASTE_END.length;
      } else {
        const payload = input.slice(contentStart);
        tokens.push(`${PASTE_TOKEN_PREFIX}${payload}`);
        index = input.length;
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
    const codePoint = input.codePointAt(index);
    if (codePoint === undefined) break;
    const value = String.fromCodePoint(codePoint);
    tokens.push(value);
    index += value.length;
  }
  return { tokens, tail: "" };
}

export function splitRawInput(input: string): string[] {
  const { tokens, tail } = splitRawInputWithTail(input);
  if (!tail) return tokens;
  const tailTokens: string[] = [];
  for (let index = 0; index < tail.length;) {
    const codePoint = tail.codePointAt(index);
    if (codePoint === undefined) break;
    const value = String.fromCodePoint(codePoint);
    tailTokens.push(value);
    index += value.length;
  }
  return [...tokens, ...tailTokens];
}

export type RawInputDecoder = {
  (chunk: Buffer | string): void;
  flush(): void;
  destroy(): void;
};

export function createRawInputDecoder(
  onToken: (token: string) => void,
  options?: { escTimeoutMs?: number }
): RawInputDecoder {
  const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
  let pendingBuffer = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutMs = options?.escTimeoutMs ?? 15;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const flush = () => {
    clearTimer();
    if (pendingBuffer.length > 0) {
      const textToFlush = pendingBuffer;
      pendingBuffer = "";
      for (const token of splitRawInput(textToFlush)) {
        onToken(token);
      }
    }
  };

  const decodeFn = (chunk: Buffer | string) => {
    clearTimer();
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    const text = decoder.decode(bytes, { stream: true });
    pendingBuffer += text;

    const { tokens, tail } = splitRawInputWithTail(pendingBuffer);
    pendingBuffer = tail;

    for (const token of tokens) {
      onToken(token);
    }

    if (pendingBuffer.length > 0) {
      timer = setTimeout(flush, timeoutMs);
    }
  };

  decodeFn.flush = flush;
  decodeFn.destroy = () => {
    clearTimer();
    pendingBuffer = "";
  };

  return decodeFn;
}