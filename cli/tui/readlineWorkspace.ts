import { createInterface } from "node:readline";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { runAgentTurn, type RunAgentTurnResult } from "../client/agentRun";
import type { LocalAgentActionGate } from "../../agent-runtime/localLoop";
import { readCommandActionGatePayload } from "../../agent-runtime/actionGate";
import type { PermissionRequest } from "../../agent-runtime/actionGate";
import type { AgentRuntimeToolResult } from "../agentRuntimeLocal";
import { compactDialog, type CompactDialogResult } from "../client/compactDialog";
import { saveProfileAgentSelection } from "../client/profileConfig";
import { runSelfUpdate } from "../updateCommands";
import { readPipeText, spawnProcess } from "../processSpawn";
import { runConfirmDialog } from "./confirmDialog";
import { formatAgentSwitchMessage, runAgentPicker } from "./agentPicker";
import { mergeAttachedImages, readImagePaths, resolveImageSource, summarizeAttachment } from "./pasteImage";
import {
  applyTuiInputKey,
  completeSlashCommand,
  createInitialTuiState,
  handleTuiInput,
  renderPrompt,
  renderStatusLine,
  renderWelcome,
  type TuiState,
} from "./session";
import { dimCliText, resolveCliColorEnabled } from "../client/terminalStyles";
import { toErrorMessage } from "../../core/errorMessage";
import { t } from "./i18n";

export type SelfUpdater = (
  output: NodeJS.WritableStream
) => Promise<number>;

type WorkspaceOptions = {
  scriptDir: string;
  env?: NodeJS.ProcessEnv;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  cliEntrypointPath?: string;
  agentRunner?: typeof runAgentTurn;
  cliCommandRunner?: CliCommandRunner;
  compactRunner?: (options: {
    serverUrl: string;
    authToken: string;
    dialogId: string;
  }) => Promise<CompactDialogResult>;
  selfUpdater?: SelfUpdater;
  spawnRunner?: typeof spawnProcess;
};

type CliCommandRunner = (
  args: string[],
  context: {
    env: NodeJS.ProcessEnv;
    output: NodeJS.WritableStream;
    scriptDir: string;
    cliEntrypointPath: string;
  }
) => Promise<number>;

type RawModeInput = NodeJS.ReadableStream & {
  isRaw?: boolean;
  setRawMode: (mode: boolean) => unknown;
};

type TurnRole = "user" | "assistant";

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
};

const MAX_TUI_HISTORY_TURNS = 500;

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

// CSI: ESC [ params intermediates final. Covers colors, cursor, erase, and
// private modes like hide/show cursor (\x1b[?25l / \x1b[?25h).
// eslint-disable-next-line no-control-regex
export const ANSI_ESCAPE_REGEX =
  /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_REGEX, "");
}

/** SGR (color/style) sequences only: ESC [ params m. */
// eslint-disable-next-line no-control-regex
const SGR_SEQUENCE_REGEX = /^\x1b\[[0-9;]*m/;
// eslint-disable-next-line no-control-regex
const TRAILING_SGR_REGEX = /(?:\x1b\[[0-9;]*m)+$/;

/**
 * Apply a terminal-style output chunk onto a transcript buffer.
 *
 * Spinner / progress writers use `\\r` to redraw one status line in place.
 * The history stream used to append those frames as plain text, which produced
 * a wall of "working locally (Ns)" lines and left raw `\\r` artifacts that
 * broke later rows. Interpret the common control semantics instead:
 * - keep SGR color/style sequences (the transcript renderer is ANSI-aware);
 *   strip every other escape sequence (cursor moves, erase, private modes)
 * - `\\r` rewinds to the start of the current line (after the last `\\n`)
 * - `\\b` deletes one character on the current line
 * - other C0 controls (except tab/newline) are dropped
 */
export function applyTerminalOutputToText(existing: string, chunk: string): string {
  if (!chunk) return existing;

  let text = existing;
  let index = 0;
  while (index < chunk.length) {
    if (chunk[index] === "\x1b") {
      const sgr = SGR_SEQUENCE_REGEX.exec(chunk.slice(index));
      if (sgr) {
        text += sgr[0];
        index += sgr[0].length;
        continue;
      }
      const csi = chunk.slice(index).match(/^\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/);
      if (csi) {
        index += csi[0].length;
        continue;
      }
      index += 1;
      continue;
    }
    const ch = chunk[index];
    if (ch === "\r") {
      const lastNl = text.lastIndexOf("\n");
      text = lastNl === -1 ? "" : text.slice(0, lastNl + 1);
      index += 1;
      continue;
    }
    if (ch === "\n") {
      text += "\n";
      index += 1;
      continue;
    }
    if (ch === "\b") {
      // Delete the last visible character, keeping any trailing SGR codes.
      const trailing = TRAILING_SGR_REGEX.exec(text);
      const sgrTail = trailing ? trailing[0] : "";
      const head = sgrTail ? text.slice(0, -sgrTail.length) : text;
      if (head.length > 0 && head[head.length - 1] !== "\n") {
        text = head.slice(0, -1) + sgrTail;
      }
      index += 1;
      continue;
    }
    const code = ch.charCodeAt(0);
    if ((code < 0x20 && ch !== "\t") || code === 0x7f) {
      index += 1;
      continue;
    }
    text += ch;
    index += 1;
  }
  return text;
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

  const visibleStart = history.scrollTop;
  const visibleEnd = Math.min(totalLines, visibleStart + visibleHeight);
  const visibleLines = lines.slice(visibleStart, visibleEnd);

  // Clear + paint ONLY the main transcript rows. Never use ED (\x1b[J) from
  // the top of the screen — many terminals wipe the docked composer below
  // the scroll region too, which is why the input bar "vanishes" mid-turn.
  for (let i = 0; i < visibleHeight; i++) {
    const line = visibleLines[i] ?? "";
    const padded = padOrTruncateToWidth(line, contentWidth);
    const thumb = renderScrollbarRow(i, visibleHeight, totalLines, history.scrollTop);
    output.write(`\x1b[${i + 1};1H`);
    output.write("\x1b[2K");
    output.write(padded);
    output.write(`\x1b[${columns}G`);
    output.write(thumb);
  }

  const mainBottom = Math.max(1, rows - inputLines);
  output.write(`\x1b[${mainBottom};1H`);
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

async function runAgentChat(
  scriptDir: string,
  state: TuiState,
  message: string,
  env: NodeJS.ProcessEnv,
  output: NodeJS.WritableStream,
  agentRunner: typeof runAgentTurn = runAgentTurn,
  options: {
    imageUrls?: string[];
    actionGateHandler?: (gate: LocalAgentActionGate) => Promise<AgentRuntimeToolResult | void>;
    confirmDestructiveAction?: (request: PermissionRequest) => Promise<boolean>;
  } = {}
) {
  const result: RunAgentTurnResult = await agentRunner({
    agentName: state.agentName,
    agentKey: state.agentKey,
    serverUrl: state.serverUrl,
    message,
    continueDialogId: state.dialogId,
    runtimeMode: state.runtimeMode,
    localRuntimeCwd: process.cwd(),
    scriptDir,
    env: {
      ...env,
      NOLO_CLI_THINKING: state.thinkingDisplay,
      NOLO_CLI_TOOLS: state.toolDisplay,
      NOLO_CLI_RENDER: state.renderDisplay,
    },
    output,
    ...(options.imageUrls && options.imageUrls.length > 0
      ? { imageUrls: options.imageUrls }
      : {}),
    ...(options.actionGateHandler ? { actionGateHandler: options.actionGateHandler } : {}),
    ...(options.confirmDestructiveAction
      ? { confirmDestructiveAction: options.confirmDestructiveAction }
      : {}),
  });
  return result;
}

function waitForActionGate(
  rl: ReturnType<typeof createInterface>,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  gate: LocalAgentActionGate,
  spawnRunner: typeof spawnProcess,
): Promise<AgentRuntimeToolResult> {
  const commandPayload = gate.kind === "handoff"
    ? readCommandActionGatePayload(gate.payload)
    : null;
  const displayCommand = commandPayload?.displayCommand ?? commandPayload?.command.join(" ") ?? gate.title;
  output.write("\n[nolo] Action needed in your terminal\n");
  output.write(`[nolo] ${gate.title}\n`);
  if (gate.body) output.write(`[nolo] ${gate.body}\n`);
  output.write(`  ${displayCommand}\n`);
  output.write("[nolo] Press Enter to run it now. Follow any prompts below, or Ctrl+C to cancel.\n");
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: AgentRuntimeToolResult) => {
      if (settled) return;
      settled = true;
      rl.off("close", onClose);
      rl.off("SIGINT", onSigint);
      resolve(result);
    };
    const cancelResult = (reason: string): AgentRuntimeToolResult => ({
      content: `action gate cancelled: ${gate.title}`,
      metadata: {
        exitCode: 130,
        actionGateResult: { gateId: gate.id, status: "cancelled", output: reason },
      },
    });
    const failResult = (message: string): AgentRuntimeToolResult => ({
      content: `action gate failed: ${gate.title}`,
      metadata: {
        exitCode: 1,
        actionGateResult: { gateId: gate.id, status: "failed", output: message },
      },
    });
    const onClose = () => finish(cancelResult("readline closed"));
    const onSigint = () => finish(cancelResult("interrupted"));
    rl.once("close", onClose);
    rl.once("SIGINT", onSigint);
    rl.question("", async () => {
      if (settled) return;
      if (!commandPayload) {
        finish(failResult("unsupported gate payload"));
        return;
      }
      const rawInput = input as RawModeInput;
      const restoreRawMode = Boolean(rawInput.isRaw);
      rl.pause();
      rawInput.setRawMode?.(false);
      let exitCode = 1;
      let errorMessage = "";
      try {
        const proc = spawnRunner({
          cmd: commandPayload.command,
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });
        exitCode = await proc.exited;
      } catch (error) {
        errorMessage = toErrorMessage(error);
      } finally {
        if (restoreRawMode) rawInput.setRawMode?.(true);
        rl.resume();
      }
      finish({
        content: exitCode === 0 && !errorMessage
          ? `action gate completed: ${displayCommand}`
          : errorMessage
            ? `action gate failed: ${errorMessage}`
            : `action gate failed with exit code ${exitCode}: ${displayCommand}`,
        metadata: {
          exitCode,
          actionGateResult: {
            gateId: gate.id,
            status: exitCode === 0 && !errorMessage ? "completed" : "failed",
            output: errorMessage || displayCommand,
          },
          argv: commandPayload.command,
          displayCommand,
        },
      });
    });
  });
}

async function pipeReadableToOutput(
  stream: Readable | null,
  output: NodeJS.WritableStream
) {
  const text = await readPipeText(stream);
  if (text) output.write(text);
}

function resolveDefaultCliEntrypoint(scriptDir: string) {
  if (process.argv[1]) return process.argv[1];
  return join(scriptDir, "..", "packages", "cli", "index.ts");
}

async function runCliCommandInChildProcess(
  args: string[],
  context: {
    env: NodeJS.ProcessEnv;
    output: NodeJS.WritableStream;
    cliEntrypointPath: string;
  }
) {
  const proc = spawnProcess({
    cmd: [process.execPath, context.cliEntrypointPath, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: context.env,
  });
  await Promise.all([
    pipeReadableToOutput(proc.stdout, context.output),
    pipeReadableToOutput(proc.stderr, context.output),
  ]);
  return proc.exited;
}

function persistAgentSelection(
  state: TuiState,
  env: NodeJS.ProcessEnv | undefined
) {
  try {
    saveProfileAgentSelection({
      agentKey: state.agentKey,
      agentName: state.agentName,
    });
  } catch {
    // profile persistence is best-effort in the workspace loop
  }
  if (env) {
    env.NOLO_AGENT = state.agentKey;
    env.NOLO_AGENT_NAME = state.agentName;
  }
}

function isInteractiveInput(input: NodeJS.ReadableStream): input is RawModeInput & { isTTY: true } {
  const candidate = input as RawModeInput & { isTTY?: boolean };
  return Boolean(candidate.isTTY) && typeof candidate.setRawMode === "function";
}

function renderInput(buffer: string) {
  const lines = buffer.split("\n");
  return lines
    .map((line) => line)
    .join("\n");
}

export function displayWidth(str: string): number {
  let width = 0;
  for (const char of str) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2600 && code <= 0x27bf) ||
      (code >= 0x2e80 && code <= 0x303e) ||
      (code >= 0x3040 && code <= 0x33bf) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff01 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff) ||
      (code >= 0x20000 && code <= 0x2fffd) ||
      (code >= 0x30000 && code <= 0x3fffd)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

/** Visible columns after stripping ANSI (status lines, borders, chips). */
export function visibleWidth(str: string): number {
  return displayWidth(stripAnsi(str));
}

/**
 * Truncate a possibly-ANSI string to `maxWidth` visible columns.
 * Preserves CSI sequences so colors don't bleed; always ends with reset when truncated.
 */
export function truncateAnsi(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;

  let width = 0;
  let out = "";
  let i = 0;
  let sawAnsi = false;
  while (i < text.length) {
    if (text[i] === "\x1b" && text[i + 1] === "[") {
      sawAnsi = true;
      let j = i + 2;
      while (j < text.length) {
        const code = text.charCodeAt(j);
        j += 1;
        if (code >= 0x40 && code <= 0x7e) break;
      }
      out += text.slice(i, j);
      i = j;
      continue;
    }
    const codePoint = text.codePointAt(i) ?? 0;
    const char = String.fromCodePoint(codePoint);
    const charWidth = displayWidth(char);
    if (width + charWidth > maxWidth) break;
    out += char;
    width += charWidth;
    i += char.length;
  }
  // Only force a reset when ANSI was present — plain text should stay plain.
  return sawAnsi ? `${out}\x1b[0m` : out;
}

export function fitAnsiLine(text: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  const ellipsisWidth = displayWidth(ellipsis);
  // Double-width ellipsis (e.g. "⋯") that cannot fit: fall back to a single-width cut.
  if (width < ellipsisWidth) return truncateAnsi(text, width);
  if (width === ellipsisWidth) return truncateAnsi(ellipsis, width) || truncateAnsi(text, width);
  return `${truncateAnsi(text, width - ellipsisWidth)}${ellipsis}`;
}

export function countPhysicalLines(text: string, columns: number): number {
  const lines = text.split("\n");
  let total = 0;
  for (const line of lines) {
    const width = displayWidth(line);
    total += Math.max(1, Math.ceil(width / columns));
  }
  return Math.max(total, 1);
}

export function takeDisplayWidth(
  text: string,
  width: number
): { prefix: string; rest: string } {
  let used = 0;
  let index = 0;
  for (const char of text) {
    const charWidth = displayWidth(char);
    if (used + charWidth > width && used > 0) break;
    used += charWidth;
    index += char.length;
  }
  return { prefix: text.slice(0, index), rest: text.slice(index) };
}

export function padOrTruncateToWidth(text: string, width: number): string {
  const textWidth = visibleWidth(text);
  if (textWidth > width) {
    return truncateAnsi(text, width);
  }
  return `${text}${" ".repeat(width - textWidth)}`;
}

const SGR_RESET_REGEX = /^\x1b\[0?m$/;

type WrapToken = { kind: "sgr" | "char"; value: string; width: number };

function tokenizeAnsiLine(line: string): WrapToken[] {
  const tokens: WrapToken[] = [];
  let index = 0;
  while (index < line.length) {
    if (line[index] === "\x1b") {
      const sgr = SGR_SEQUENCE_REGEX.exec(line.slice(index));
      if (sgr) {
        tokens.push({ kind: "sgr", value: sgr[0], width: 0 });
        index += sgr[0].length;
        continue;
      }
    }
    const codePoint = line.codePointAt(index) ?? 0;
    const value = String.fromCodePoint(codePoint);
    tokens.push({ kind: "char", value, width: displayWidth(value) });
    index += value.length;
  }
  return tokens;
}

/**
 * Wrap one transcript line to `columns` visible cells.
 *
 * Unlike `wrapTextToLines` (composer draft; must stay byte-per-cell simple so
 * cursor math holds), this wrapper:
 * - treats SGR color sequences as zero-width and re-opens the active style on
 *   the continuation line, closing every styled line with a reset so colors
 *   never bleed into the scrollbar column or the next row;
 * - prefers breaking after the last space/tab so latin words survive wrapping
 *   (CJK breaks anywhere, which is correct for those scripts).
 */
export function wrapTranscriptLine(line: string, columns: number): string[] {
  if (line === "") return [""];
  const tokens = tokenizeAnsiLine(line);
  const result: string[] = [];

  let activeStyles: string[] = [];
  const applyStyleToken = (value: string) => {
    if (SGR_RESET_REGEX.test(value)) {
      activeStyles = [];
    } else {
      activeStyles.push(value);
    }
  };

  let start = 0;
  while (start < tokens.length) {
    // Only zero-width style tokens left: fold them into the previous line
    // instead of emitting a visually blank row.
    if (tokens.slice(start).every((token) => token.kind === "sgr")) {
      if (result.length > 0) break;
    }
    const openingStyles = [...activeStyles];
    let width = 0;
    let end = start;
    let lastBreak = -1; // index just after a breakable char
    while (end < tokens.length) {
      const token = tokens[end];
      if (token.kind === "sgr") {
        end += 1;
        continue;
      }
      if (width + token.width > columns && width > 0) break;
      width += token.width;
      end += 1;
      if (token.value === " " || token.value === "\t") {
        lastBreak = end;
      }
    }

    let segmentEnd = end;
    if (end < tokens.length && lastBreak > start) {
      // Mid-word overflow with a space earlier in the segment: break there.
      const overflowToken = tokens[end];
      if (overflowToken.kind === "char" && overflowToken.value !== " " && overflowToken.width === 1) {
        segmentEnd = lastBreak;
      }
    }
    if (segmentEnd === start) segmentEnd = start + 1;

    let segment = "";
    let sawStyle = openingStyles.length > 0;
    for (let i = start; i < segmentEnd; i += 1) {
      const token = tokens[i];
      segment += token.value;
      if (token.kind === "sgr") {
        sawStyle = true;
        applyStyleToken(token.value);
      }
    }
    const prefix = openingStyles.join("");
    const needsReset =
      (sawStyle || activeStyles.length > 0) && !segment.endsWith("\x1b[0m");
    result.push(`${prefix}${segment}${needsReset ? "\x1b[0m" : ""}`);
    start = segmentEnd;
    // Continuation rows never start with the space we just wrapped at.
    while (start < tokens.length) {
      const token = tokens[start];
      if (token.kind === "char" && token.value === " ") {
        start += 1;
        continue;
      }
      break;
    }
  }

  return result.length > 0 ? result : [""];
}

export function wrapTextToLines(text: string, columns: number): string[] {
  const result: string[] = [];
  for (const logicalLine of text.split("\n")) {
    if (logicalLine === "") {
      result.push("");
      continue;
    }
    let remaining = logicalLine;
    while (remaining.length > 0) {
      const { prefix, rest } = takeDisplayWidth(remaining, columns);
      result.push(prefix);
      remaining = rest;
    }
  }
  return result;
}

function buildHistoryLines(history: TurnHistory, contentWidth: number): string[] {
  const lines: string[] = [];
  for (const turn of history.turns) {
    if (turn.role === "user") {
      lines.push("", `❯ ${turn.content}`);
    } else {
      lines.push(turn.content);
    }
  }
  if (history.currentRole !== null && history.currentContent) {
    if (history.currentRole === "user") {
      lines.push("", `❯ ${history.currentContent}`);
    } else {
      lines.push(history.currentContent);
    }
  }
  const wrapped: string[] = [];
  for (const entry of lines) {
    for (const logicalLine of entry.split("\n")) {
      wrapped.push(...wrapTranscriptLine(logicalLine, contentWidth));
    }
  }
  return wrapped;
}

function renderScrollbarRow(
  rowIndex: number,
  visibleHeight: number,
  totalLines: number,
  scrollTop: number
): string {
  if (totalLines <= visibleHeight) return " ";
  const trackHeight = visibleHeight;
  const thumbSize = Math.max(
    1,
    Math.floor((visibleHeight * visibleHeight) / totalLines)
  );
  const maxScrollTop = totalLines - visibleHeight;
  const thumbTop = Math.floor(
    (scrollTop / maxScrollTop) * (trackHeight - thumbSize)
  );
  const thumbBottom = thumbTop + thumbSize;
  if (rowIndex >= thumbTop && rowIndex < thumbBottom) {
    return "█";
  }
  return "│";
}

export type ScrollAction =
  | "page-up"
  | "page-down"
  | "half-page-up"
  | "half-page-down"
  | "top"
  | "bottom"
  | "wheel-up"
  | "wheel-down";

/** SGR mouse report: ESC [ < button ; col ; row (M=press/wheel, m=release). */
// eslint-disable-next-line no-control-regex
const SGR_MOUSE_REGEX = /^\x1b\[<(\d+);\d+;\d+[Mm]$/;

export function parseScrollAction(sequence: string): ScrollAction | null {
  const mouse = SGR_MOUSE_REGEX.exec(sequence);
  if (mouse) {
    const button = Number(mouse[1]);
    // Wheel events carry bit 6 (64): 64=up, 65=down, 66/67=horizontal.
    if ((button & 64) === 0) return null;
    if ((button & 2) !== 0) return null; // horizontal wheel: no mapping
    return (button & 1) !== 0 ? "wheel-down" : "wheel-up";
  }
  switch (sequence) {
    case "\x1b[5~":
      return "page-up";
    case "\x1b[6~":
      return "page-down";
    case "\x1b[5;2~":
    case "\x1b[5;5~":
      return "half-page-up";
    case "\x1b[6;2~":
    case "\x1b[6;5~":
      return "half-page-down";
    case "\x1b[H":
    case "\x1b[1~":
    case "\x1b[7~":
      return "top";
    case "\x1b[F":
    case "\x1b[4~":
    case "\x1b[8~":
      return "bottom";
    default:
      return null;
  }
}

const WHEEL_SCROLL_LINES = 3;

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

function repaintInput(output: NodeJS.WritableStream, buffer: string, renderedLines = 1) {
  const text = renderInput(buffer);
  const columns = (output as { columns?: number }).columns ?? 80;
  const physicalLines = countPhysicalLines(text, columns);
  if ((output as { isTTY?: boolean }).isTTY) {
    for (let index = 0; index < renderedLines; index += 1) {
      output.write("\r\x1b[2K");
      if (index < renderedLines - 1) output.write("\x1b[1A");
    }
  } else {
    output.write("\n");
  }
  output.write(text);
  return physicalLines;
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
  exitOutputMode(buffer: string): void;
  repaint(buffer: string): void;
  pause(): void;
  resumeFromSubprocess(): void;
  resumeFromDialog(): void;
  disable(): void;
  getInputLines(): number;
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
  };
}

type FixedInputConfig = {
  getStatusLine: () => string;
};

export function createFixedInput(
  output: NodeJS.WritableStream,
  config: FixedInputConfig,
): FixedInputController {
  const isTTY = (output as { isTTY?: boolean }).isTTY;
  const getRows = () => (output as { rows?: number }).rows ?? 24;
  const getColumns = () => (output as { columns?: number }).columns ?? 80;
  let inputLines = 1;
  const write = (seq: string) => { output.write(seq); };

  const setScrollRegion = (lines: number) => {
    const bottom = Math.max(1, getRows() - lines);
    write(`\x1b[1;${bottom}r`);
  };
  const saveCursor = () => write("\x1b7");
  const restoreCursor = () => write("\x1b8");
  const resetScrollRegion = () => write("\x1b[r");
  // Wheel reporting: SGR format (1006) + basic tracking (1000). Without these
  // the terminal never delivers wheel events, so the transcript could not be
  // scrolled by trackpad/mouse at all. Selection still works via the
  // terminal's bypass modifier (e.g. Shift in Ghostty/iTerm2).
  const enableMouse = () => write("\x1b[?1006h\x1b[?1000h");
  const disableMouse = () => write("\x1b[?1000l\x1b[?1006l");

  /**
   * OMP-style composer:
   *   ────────────────────────  top rule
   *   nolo > agent · mode > 📁 path > branch
   *   ❯ Type a message...
   *   ────────────────────────  bottom rule
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

    const rule = colorEnabled
      ? `\x1b[2m\x1b[35m${"─".repeat(cols)}\x1b[0m`
      : "─".repeat(cols);
    sections.push(rule);
    sections.push(fitAnsiLine(config.getStatusLine(), cols));

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

    sections.push(rule);

    const text = sections.join("\n");
    const lines = sections.length;
    const headerRows = (completions.length > 0 ? 1 : 0) + 2; // completion? + top rule + status
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
      disableMouse();
      resetScrollRegion();
    },
    resumeFromSubprocess() {
      setScrollRegion(inputLines);
      enableMouse();
      const scrollBottom = Math.max(1, getRows() - inputLines);
      write(`\x1b[${scrollBottom};1H\n`);
    },
    resumeFromDialog() {
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

export function splitRawInput(input: string) {
  const chunks: string[] = [];
  for (let index = 0; index < input.length;) {
    if (input.startsWith("\x1b[13;2~", index)) {
      chunks.push("\x1b[13;2~");
      index += "\x1b[13;2~".length;
      continue;
    }
    if (input.startsWith("\x1b[27;2;13~", index)) {
      chunks.push("\x1b[27;2;13~");
      index += "\x1b[27;2;13~".length;
      continue;
    }
    if (input.startsWith("\x1b\r", index)) {
      chunks.push("\x1b\r");
      index += 2;
      continue;
    }
    const csi = readCsiSequence(input, index);
    if (csi) {
      chunks.push(csi);
      index += csi.length;
      continue;
    }
    const codePoint = input.codePointAt(index);
    if (codePoint === undefined) break;
    const value = String.fromCodePoint(codePoint);
    chunks.push(value);
    index += value.length;
  }
  return chunks;
}

export function createRawInputDecoder(
  onToken: (token: string) => void
): (chunk: Buffer | string) => void {
  const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
  return (chunk) => {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    const text = decoder.decode(bytes, { stream: true });
    for (const token of splitRawInput(text)) {
      onToken(token);
    }
  };
}

function waitForRawActionGate(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  gate: LocalAgentActionGate,
  spawnRunner: typeof spawnProcess,
  hooks?: { beforeSubprocess?: () => void; afterSubprocess?: () => void },
): Promise<AgentRuntimeToolResult> {
  const commandPayload = gate.kind === "handoff"
    ? readCommandActionGatePayload(gate.payload)
    : null;
  const displayCommand = commandPayload?.displayCommand ?? commandPayload?.command.join(" ") ?? gate.title;
  output.write("\n[nolo] Action needed in your terminal\n");
  output.write(`[nolo] ${gate.title}\n`);
  if (gate.body) output.write(`[nolo] ${gate.body}\n`);
  output.write(`  ${displayCommand}\n`);
  output.write("[nolo] Press Enter to run it now. Follow any prompts below, or Ctrl+C to cancel.\n");

  return new Promise((resolve) => {
    const rawInput = input as RawModeInput;
    const finish = (result: AgentRuntimeToolResult) => {
      input.off("data", onData);
      resolve(result);
    };
    const cancel = (reason: string) =>
      finish({
        content: `action gate cancelled: ${gate.title}`,
        metadata: {
          exitCode: 130,
          actionGateResult: { gateId: gate.id, status: "cancelled", output: reason },
        },
      });
    const fail = (message: string) =>
      finish({
        content: `action gate failed: ${gate.title}`,
        metadata: {
          exitCode: 1,
          actionGateResult: { gateId: gate.id, status: "failed", output: message },
        },
      });
    const onData = async (chunk: Buffer | string) => {
      const text = String(chunk);
      if (text.includes("\u0003")) {
        cancel("interrupted");
        return;
      }
      if (!text.includes("\r") && !text.includes("\n")) return;
      if (!commandPayload) {
        fail("unsupported gate payload");
        return;
      }
      const wasRaw = Boolean(rawInput.isRaw);
      rawInput.setRawMode?.(false);
      hooks?.beforeSubprocess?.();
      let exitCode = 1;
      let errorMessage = "";
      try {
        const proc = spawnRunner({
          cmd: commandPayload.command,
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });
        exitCode = await proc.exited;
      } catch (error) {
        errorMessage = toErrorMessage(error);
      } finally {
        hooks?.afterSubprocess?.();
        if (wasRaw) rawInput.setRawMode?.(true);
      }
      finish({
        content: exitCode === 0 && !errorMessage
          ? `action gate completed: ${displayCommand}`
          : errorMessage
            ? `action gate failed: ${errorMessage}`
            : `action gate failed with exit code ${exitCode}: ${displayCommand}`,
        metadata: {
          exitCode,
          actionGateResult: {
            gateId: gate.id,
            status: exitCode === 0 && !errorMessage ? "completed" : "failed",
            output: errorMessage || displayCommand,
          },
          argv: commandPayload.command,
          displayCommand,
        },
      });
    };
    input.on("data", onData);
  });
}

export async function startTuiWorkspace(options: WorkspaceOptions) {
  let state = createInitialTuiState(options.env ?? process.env);
  const input = options.input ?? defaultInput;
  const output = options.output ?? defaultOutput;
  const cliEntrypointPath =
    options.cliEntrypointPath ?? resolveDefaultCliEntrypoint(options.scriptDir);
  const cliCommandRunner = options.cliCommandRunner ?? runCliCommandInChildProcess;
  const spawnRunner = options.spawnRunner ?? spawnProcess;
  const selfUpdater: SelfUpdater =
    options.selfUpdater ?? ((target) => runSelfUpdate({ output: target }));

  output.write(renderWelcome(state));

  let fixedInput: FixedInputController = createNoopFixedInput();
  // Composer draft buffer. Hoisted to this scope (rather than the
  // isInteractiveInput block) so that runSubmittedLine's streaming callback
  // can repaint the user's in-progress draft while an agent turn is running.
  let buffer = "";
  const history = createTurnHistory();
  const renderHistoryToOutput = () => {
    renderHistory(output, history, fixedInput.getInputLines());
  };
  const runSubmittedLine = async (
    line: string,
    actionGateHandler: (gate: LocalAgentActionGate) => Promise<AgentRuntimeToolResult | void>,
    confirmDestructiveAction?: (request: PermissionRequest) => Promise<boolean>,
  ) => {
    if (!line.trim()) return false;
    const result = handleTuiInput(line, state);
    const previousAgentKey = state.agentKey;
    state = result.nextState;

    if (result.output) {
      output.write(`${result.output}\n`);
    }

    if (
      state.agentKey !== previousAgentKey &&
      result.output?.startsWith("Switched to ")
    ) {
      persistAgentSelection(state, options.env ?? process.env);
    }

    if (result.action?.type === "exit") return true;

    if (result.action?.type === "clear") {
      history.turns.length = 0;
      history.currentRole = null;
      history.currentContent = "";
      history.scrollTop = 0;
      history.followBottom = true;
      renderHistoryToOutput();
      output.write(`${t("startedFreshDialog")}\n`);
    }
    if (result.action?.type === "compact") {
      const runner = options.compactRunner ?? compactDialog;
      const authToken =
        options.env?.AUTH_TOKEN ?? options.env?.AUTH ?? options.env?.BENCHMARK_AUTH_TOKEN ?? "";
      try {
        const compactResult = await runner({
          serverUrl: state.serverUrl,
          authToken,
          dialogId: result.action.dialogId,
        });
        state = {
          ...state,
          dialogId: compactResult.dialogId,
          dialogLabel: compactResult.dialogId,
        };
      } catch (error: any) {
        output.write(
          `[nolo] Compact failed: ${toErrorMessage(error)}\n`
        );
      }
    }

    if (result.action?.type === "self-update") {
      try {
        const exitCode = await selfUpdater(output);
        if (exitCode === 0) {
          output.write("Update finished. Restart nolo to use the new version.\n");
        } else {
          output.write("Update failed. Check the error above, then run /update again or use nolo update.\n");
        }
      } catch (error) {
        output.write(`${toErrorMessage(error)}\n`);
        output.write("Update failed. Check the error above, then run /update again or use nolo update.\n");
      }
    }

    if (result.action?.type === "pick-agent") {
      const pickerInputLines = fixedInput.getInputLines();
      const ttyRows =
        typeof output === "object" &&
        output !== null &&
        "rows" in output &&
        typeof output.rows === "number"
          ? output.rows
          : 24;
      const bottomRow = Math.max(1, ttyRows - pickerInputLines);
      fixedInput.pause();
      try {
        const pickResult = await runAgentPicker({
          currentKey: state.agentKey,
          env: options.env ?? process.env,
          input: input as NodeJS.ReadStream,
          output: output as NodeJS.WritableStream,
          bottomAnchored: true,
          bottomRow,
        });
        if (pickResult.kind === "list") {
          output.write(`${pickResult.output}\n`);
        } else if (pickResult.kind === "selected") {
          state = {
            ...state,
            agentName: pickResult.name,
            agentKey: pickResult.key,
          };
          persistAgentSelection(state, options.env ?? process.env);
          output.write(
            `${formatAgentSwitchMessage({
              name: pickResult.name,
              dialogId: state.dialogId,
            })}\n`
          );
        } else {
          output.write("Agent switch cancelled.\n");
        }
      } catch (error) {
        output.write(
          `[nolo] Agent picker failed: ${toErrorMessage(error)}\n`
        );
      } finally {
        fixedInput.resumeFromDialog();
      }
    }

    if (result.action?.type === "list-agents") {
      try {
        const pickResult = await runAgentPicker({
          currentKey: state.agentKey,
          env: options.env ?? process.env,
          input: input as NodeJS.ReadStream,
          output: output as NodeJS.WritableStream,
          interactive: false,
        });
        if (pickResult.kind === "list") {
          output.write(`${pickResult.output}\n`);
        }
      } catch (error) {
        output.write(
          `[nolo] Agent list failed: ${toErrorMessage(error)}\n`
        );
      }
    }

    if (result.action?.type === "cli-command") {
      try {
        const exitCode = await cliCommandRunner(result.action.args, {
          env: options.env ?? process.env,
          output,
          scriptDir: options.scriptDir,
          cliEntrypointPath,
        });
        if (exitCode !== 0) {
          output.write(`[nolo] CLI command exited with code ${exitCode}.\n`);
        }
      } catch (error) {
        output.write(
          `[nolo] CLI command failed: ${toErrorMessage(error)}\n`
        );
      }
    }

    if (result.action?.type === "chat") {
      const pathsToRead = [
        ...(result.action.imagePaths ?? []),
        ...state.attachedImages.map((img) => img.sourcePath),
      ];
      let imageUrls: string[] = [];
      if (pathsToRead.length > 0) {
        const readResult = await readImagePaths(pathsToRead, {
          onFailure: (_path, err) =>
            output.write(`[nolo] image skipped: ${err.message}\n`),
        });
        imageUrls = readResult.images.map((img) => img.dataUrl);
        if (readResult.images.length > 0) {
          state = {
            ...state,
            attachedImages: mergeAttachedImages(state.attachedImages, readResult.images),
          };
        }
      }

      history.followBottom = true;
      startTurn(history, "user");
      appendToCurrentTurn(history, result.action.message);
      finalizeCurrentTurn(history);
      // Keep the docked composer painted under the transcript for the whole turn.
      renderHistoryToOutput();
      if (fixedInput.active) fixedInput.repaint(buffer);

      startTurn(history, "assistant");
      const agentOutput = isInteractiveInput(input)
        ? createHistoryOutputStream(history, () => {
            renderHistoryToOutput();
            // Repaint the user's live draft (not "") so typing during the
            // agent turn is preserved on every streaming update.
            if (fixedInput.active) fixedInput.repaint(buffer);
          })
        : output;
      const runResult = await runAgentChat(
        options.scriptDir,
        state,
        result.action.message,
        options.env ?? process.env,
        agentOutput,
        options.agentRunner,
        {
          ...(imageUrls.length > 0 ? { imageUrls } : {}),
          actionGateHandler,
          ...(confirmDestructiveAction
            ? { confirmDestructiveAction }
            : {}),
        }
      );
      if (isInteractiveInput(input)) {
        finalizeCurrentTurn(history);
        renderHistoryToOutput();
        // Show the user's accumulated draft (typed while busy) now that the
        // turn has finished.
        if (fixedInput.active) fixedInput.repaint(buffer);
      }
      if (runResult.dialogId || runResult.turnTokens) {
        state = {
          ...state,
          ...(runResult.dialogId
            ? {
                dialogId: runResult.dialogId,
                dialogLabel: runResult.dialogId,
              }
            : {}),
          ...(runResult.turnTokens ? { turnTokens: runResult.turnTokens } : {}),
        };
      }
    }

    if (result.action?.type === "attach-images") {
      const readResult = await readImagePaths(result.action.paths, {
        resolve: (raw) => resolveImageSource(raw, state.cwd),
        onSuccess: (img) => output.write(`${summarizeAttachment(img)}\n`),
        onFailure: (_path, err) =>
          output.write(`[nolo] image skipped: ${err.message}\n`),
      });
      if (readResult.images.length > 0) {
        state = {
          ...state,
          attachedImages: mergeAttachedImages(state.attachedImages, readResult.images),
        };
      }
    }

    return false;
  };

  if (isInteractiveInput(input)) {
    input.setRawMode(true);
    let busy = false;
    let done = false;
    fixedInput = createFixedInput(output, {
      getStatusLine: () => renderStatusLine(state),
    });
    fixedInput.init();
    const paintFrame = (draft: string) => {
      renderHistoryToOutput();
      fixedInput.repaint(draft);
    };
    const onResize = () => {
      if (done) return;
      // Re-measure rows/cols, rebuild scroll region + full-width rules, repaint.
      // Keep the user's current draft visible even during an agent turn so
      // typing is not lost on terminal resize.
      paintFrame(buffer);
    };
    const resizeTarget = output as NodeJS.WritableStream & {
      on?: (event: string, listener: () => void) => void;
      off?: (event: string, listener: () => void) => void;
    };
    resizeTarget.on?.("resize", onResize);
    const finish = () => {
      done = true;
      resizeTarget.off?.("resize", onResize);
      input.off("data", onData);
      input.setRawMode?.(false);
    };
    const handleInputToken = async (sequence: string) => {
      if (done) return;
      // While an agent turn is running we let the user keep typing into the
      // docked composer (draft buffer) but ignore submit/scroll so a second
      // turn cannot race the in-flight one. The draft is preserved and shown
      // once the turn finishes via fixedInput.exitOutputMode(buffer).
      const busyLock = busy;
      const scrollAction = parseScrollAction(sequence);
      if (scrollAction) {
        if (busyLock) return;
        applyScrollAction(history, scrollAction, output, fixedInput.getInputLines());
        paintFrame(buffer);
        return;
      }
      const result = applyTuiInputKey(buffer, sequence);
      if (result.abort) {
        fixedInput.disable();
        finish();
        return;
      }
      if (result.submit !== undefined) {
        if (busyLock) {
          // Ignore Enter while the agent is replying; the draft stays intact
          // and the user can send it after the turn completes.
          return;
        }
        busy = true;
        const submittedText = result.submit;
        buffer = "";
        // Note: we intentionally keep the `data` listener attached. During the
        // agent turn the user can still type into the composer; submit is
        // gated by `busy` above. This avoids tearing the input chrome down
        // and lets the draft persist across the turn.
        fixedInput.enterOutputMode(submittedText);
        const shouldExit = await runSubmittedLine(
          submittedText,
          (gate) =>
            waitForRawActionGate(input, output, gate, spawnRunner, {
              beforeSubprocess: () => fixedInput.pause(),
              afterSubprocess: () => fixedInput.resumeFromSubprocess(),
            }),
          async (request) => {
            fixedInput.pause();
            try {
              return await runConfirmDialog({
                request,
                input: input as any,
                output: output as any,
              });
            } finally {
              fixedInput.resumeFromDialog();
            }
          },
        );
        if (shouldExit) {
          fixedInput.disable();
          finish();
          return;
        }
        busy = false;
        // Status may have picked up token usage during the turn — repaint chips.
        // Restore the user's draft (which may have been edited while busy).
        fixedInput.exitOutputMode(buffer);
        return;
      }
      buffer = result.buffer;
      fixedInput.repaint(buffer);
    };
    const onData = createRawInputDecoder((token) => {
      void handleInputToken(token);
    });
    input.on("data", onData);
    fixedInput.repaint(buffer);
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (done) {
          clearInterval(check);
          resolve();
        }
      }, 10);
    });
    return;
  }

  const rl = createInterface({ input, output });
  rl.setPrompt(renderPrompt(state));
  rl.prompt();

  try {
    for await (const line of rl) {
      const shouldExit = await runSubmittedLine(line, (gate) =>
        waitForActionGate(rl, input, output, gate, spawnRunner)
      );
      if (shouldExit) break;
      output.write(`\n${renderStatusLine(state)}\n`);
      rl.setPrompt(renderPrompt(state));
      rl.prompt();
    }
  } finally {
    rl.close();
  }
}
