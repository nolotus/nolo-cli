import { createInterface } from "node:readline";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { runAgentTurn, type RunAgentTurnResult } from "../client/agentRun";
import type { LocalAgentActionGate } from "../agent-runtime/localLoop";
import { readCommandActionGatePayload } from "../agent-runtime/actionGate";
import type { PermissionRequest } from "../agent-runtime/actionGate";
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
import { toErrorMessage } from "../core/errorMessage";
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

// eslint-disable-next-line no-control-regex
export const ANSI_ESCAPE_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_REGEX, "");
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

  output.write("\x1b[1;1H");
  output.write("\x1b[J");

  for (let i = 0; i < visibleHeight; i++) {
    const line = visibleLines[i] ?? "";
    const padded = padOrTruncateToWidth(line, contentWidth);
    const thumb = renderScrollbarRow(i, visibleHeight, totalLines, history.scrollTop);
    output.write(padded);
    output.write(`\x1b[${columns}G`);
    output.write(thumb);
    if (i < visibleHeight - 1) {
      output.write("\n");
    }
  }

  const mainBottom = Math.max(1, rows - inputLines);
  output.write(`\x1b[${mainBottom};1H`);
}

export function createHistoryOutputStream(
  history: TurnHistory,
  onUpdate: () => void
): NodeJS.WritableStream {
  return {
    write(chunk: string | Buffer): boolean {
      const text = typeof chunk === "string" ? chunk : chunk.toString();
      appendToCurrentTurn(history, stripAnsi(text));
      onUpdate();
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
  const textWidth = displayWidth(text);
  if (textWidth > width) {
    return takeDisplayWidth(text, width).prefix;
  }
  return `${text}${" ".repeat(width - textWidth)}`;
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
  for (const line of lines) {
    wrapped.push(...wrapTextToLines(line, contentWidth));
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
  | "bottom";

export function parseScrollAction(sequence: string): ScrollAction | null {
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

  const renderInputArea = (buffer: string): { text: string; lines: number; cursorCol: number; cursorRow: number } => {
    const colorEnabled = resolveCliColorEnabled();
    const cols = getColumns();
    const statusLine = config.getStatusLine();
    const completions = completeSlashCommand(buffer);
    const sections: string[] = [];
    if (completions.length > 0) {
      sections.push(dimCliText(completions.join("  ")));
    }

    const padToWidth = (content: string, prefix: string, suffix: string) => {
      const contentWidth = displayWidth(content);
      const padding = Math.max(0, cols - contentWidth - displayWidth(prefix) - displayWidth(suffix));
      return `${prefix}${content}${" ".repeat(padding)}${suffix}`;
    };

    const topBorder = padToWidth(` ${statusLine} `, "╭──", "──╮");
    sections.push(topBorder);

    let cursorCol: number;
    let cursorRow: number;
    const inputLines = buffer.split("\n");

    if (inputLines.length === 1) {
      if (buffer === "") {
        const placeholder = dimCliText(t("placeholder"), colorEnabled);
        const line = padToWidth(placeholder, "╰─ ", " ──╯");
        sections.push(dimCliText(line, colorEnabled));
        cursorCol = 3;
        cursorRow = 0;
      } else {
        const line = padToWidth(inputLines[0], "╰─ ", " ──╯");
        sections.push(line);
        cursorCol = 3 + displayWidth(inputLines[0]);
        cursorRow = 0;
      }
    } else {
      for (let i = 0; i < inputLines.length - 1; i++) {
        const line = padToWidth(inputLines[i], "│  ", " │");
        sections.push(line);
      }
      const lastLine = inputLines[inputLines.length - 1];
      const line = padToWidth(lastLine, "╰─ ", " ──╯");
      sections.push(line);
      cursorCol = 3 + displayWidth(lastLine);
      cursorRow = inputLines.length - 1;
    }

    const text = sections.join("\n");
    const lines = countPhysicalLines(text, cols);
    const promptRow = (completions.length > 0 ? 1 : 0) + 1 + cursorRow;
    return { text, lines, cursorCol, cursorRow: promptRow };
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
    write(`\x1b[${cursorLine};${cursorCol + 1}G`);
  };

  if (!isTTY) return createNoopFixedInput();

  return {
    active: true,
    init() {
      saveCursor();
      setScrollRegion(inputLines);
    },
    enterOutputMode(submittedText: string) {
      const startRow = getRows() - inputLines + 1;
      write(`\x1b[${startRow};1H`);
      write("\x1b[J");
      const mainBottom = getRows() - inputLines;
      write(`\x1b[${mainBottom};1H`);
      write(`${renderInput(submittedText)}\n`);
    },
    exitOutputMode(buffer: string) {
      saveCursor();
      repaintAt(buffer);
    },
    repaint(buffer: string) {
      repaintAt(buffer);
    },
    pause() {
      resetScrollRegion();
    },
    resumeFromSubprocess() {
      setScrollRegion(inputLines);
      const scrollBottom = Math.max(1, getRows() - inputLines);
      write(`\x1b[${scrollBottom};1H\n`);
    },
    resumeFromDialog() {
      saveCursor();
      setScrollRegion(inputLines);
    },
    disable() {
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
      fixedInput.pause();
      try {
        const pickResult = await runAgentPicker({
          currentKey: state.agentKey,
          env: options.env ?? process.env,
          input: input as NodeJS.ReadStream,
          output: output as NodeJS.WritableStream,
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
      renderHistoryToOutput();

      startTurn(history, "assistant");
      const agentOutput = isInteractiveInput(input)
        ? createHistoryOutputStream(history, () => {
            renderHistoryToOutput();
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
    let buffer = "";
    let busy = false;
    let done = false;
    fixedInput = createFixedInput(output, {
      getStatusLine: () => renderStatusLine(state),
    });
    fixedInput.init();
    const finish = () => {
      done = true;
      input.off("data", onData);
      input.setRawMode?.(false);
    };
    const handleInputToken = async (sequence: string) => {
      if (busy || done) return;
      const scrollAction = parseScrollAction(sequence);
      if (scrollAction) {
        applyScrollAction(history, scrollAction, output, fixedInput.getInputLines());
        renderHistoryToOutput();
        fixedInput.repaint(buffer);
        return;
      }
      const result = applyTuiInputKey(buffer, sequence);
      if (result.abort) {
        fixedInput.disable();
        finish();
        return;
      }
      if (result.submit !== undefined) {
        busy = true;
        const submittedText = result.submit;
        buffer = "";
        input.off("data", onData);
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
        input.on("data", onData);
        busy = false;
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
