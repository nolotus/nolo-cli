import { clipCompactText } from "../../core/clipCompactText";
import { compactWhitespace } from "../../core/compactWhitespace";
import { asTrimmedLowercaseString } from "../../core/trimmedLowercaseString";
import type { LocalAgentToolEvent } from "../../agent-runtime/localLoop";
import { readActionGate, readCommandActionGatePayload } from "../../agent-runtime/actionGate";
import { parseUiAskChoiceContent } from "../../ai/tools/uiAskChoiceTool";
import { dimCliText, resolveCliColorEnabled, styleCliText } from "./terminalStyles";
import { diffLineSequences, themeText } from "../tui/theme";
import { t, toolLabel } from "../tui/i18n";


export type ToolDisplayMode = "hide" | "compact" | "verbose";

export function normalizeToolDisplayMode(
  raw: string | undefined,
  fallback: ToolDisplayMode = "compact"
): ToolDisplayMode {
  const normalized = asTrimmedLowercaseString(raw);
  if (normalized === "hide" || normalized === "off" || normalized === "false" || normalized === "0") {
    return "hide";
  }
  if (
    normalized === "verbose" ||
    normalized === "debug" ||
    normalized === "trace" ||
    normalized === "full"
  ) {
    return "verbose";
  }
  if (normalized === "compact" || normalized === "minimal" || normalized === "short") {
    return "compact";
  }
  return fallback;
}

export function resolveToolDisplayMode(env: Record<string, string | undefined> = process.env) {
  const legacyTrace = asTrimmedLowercaseString(env.NOLO_TRACE_TOOLS);
  if (legacyTrace === "0" || legacyTrace === "false" || legacyTrace === "off") {
    return "hide";
  }
  if (legacyTrace === "verbose" || legacyTrace === "full") {
    return "verbose";
  }
  return normalizeToolDisplayMode(env.NOLO_CLI_TOOLS ?? env.NOLO_TOOLS, "compact");
}

export function shouldEmitToolEvents(mode: ToolDisplayMode) {
  return mode !== "hide";
}

function clip(value: string, max = 72) {
  return clipCompactText(value, max, "…");
}

/**
 * Path-aware clip: keeps the leading segment and the filename, eliding the
 * middle, so a long path stays identifiable. Non-path values fall back to the
 * shared tail clip.
 *
 * The path branch is for posix-style tool args (this repo's tool args are
 * always posix); Windows backslash paths are intentionally not special-cased.
 * Shares compact-then-clip preconditions with `clipCompactText` so short
 * values behave byte-identically.
 */
export function clipPathAware(value: string, max = 72): string {
  const compact = compactWhitespace(value);
  if (compact.length <= max) return compact;

  // "Looks like a path" = no spaces after compaction and contains "/".
  // Otherwise (commands with args, prose, etc.) keep the shared tail clip so
  // non-path output is byte-identical to before.
  if (compact.includes(" ") || !compact.includes("/")) {
    return clipCompactText(value, max, "…");
  }

  const segments = compact.split("/");
  const filename = segments[segments.length - 1];

  // Filename alone already meets/exceeds budget — can't keep a prefix, fall
  // back to the shared tail clip.
  if (filename.length >= max) {
    return clipCompactText(value, max, "…");
  }

  // Keep as many leading segments as the budget allows. Retaining only the
  // first one is nearly worthless in a monorepo, where every path starts with
  // the same top-level directory ("packages/…/foo.ts" says almost nothing);
  // "packages/cli/tui/…/foo.ts" actually locates the file.
  const ELISION = "/…/";
  // Rebuild from the slice rather than appending to `prefix`: an absolute path
  // starts with an empty first segment, and an empty accumulator is falsy, so
  // append-style logic silently drops the leading "/" and renders "/Users/x/y"
  // as the relative-looking "Users/x/y".
  let prefix = "";
  for (let i = 0; i < segments.length - 1; i += 1) {
    const candidate = segments.slice(0, i + 1).join("/");
    if (candidate.length + ELISION.length + filename.length > max) break;
    prefix = candidate;
  }
  if (prefix) return `${prefix}${ELISION}${filename}`;

  // Drop the leading segment, keep only the ellipsis + filename.
  const filenameOnly = `…/${filename}`;
  if (filenameOnly.length <= max) return filenameOnly;

  return clipCompactText(value, max, "…");
}

export function formatActiveToolLabel(
  event: Pick<LocalAgentToolEvent, "toolName" | "argumentsPreview">
) {
  const toolName = event.toolName || "tool";
  const args = clipPathAware(event.argumentsPreview ?? "");
  const label = toolLabel(toolName);
  return args ? `${label} ${args}` : label;
}

/**
 * Trailing status for a finished tool.
 *
 * Two kinds of signal survive here:
 *  1. states the user can act on — a pending confirmation, a timeout, a
 *     non-zero exit;
 *  2. content visibility for file tools — readFile's read range (so the user
 *     can spot an agent paging a large file in disjoint chunks and ask it to
 *     split the work) and editFile's actual added/removed snippets.
 *
 * Generic output size (line counts on every successful tool) is still dropped:
 * it padded every line without telling the user anything actionable.
 */
function compactResultHint(event: LocalAgentToolEvent): { inline: string; detail?: string } {
  const gate = readActionGate(event.metadata?.actionGate);
  if (gate) {
    const commandPayload = gate.kind === "handoff" ? readCommandActionGatePayload(gate.payload) : null;
    const command = commandPayload?.displayCommand ?? commandPayload?.command.join(" ") ?? "";
    const detail = command.trim() ? command : gate.title;
    return { inline: `${t("toolNeedsAction")}: ${clip(detail, 120)}` };
  }
  if (event.metadata?.timedOut) return { inline: t("toolTimedOut") };

  // readFile: show the read range only when the file was sliced, not when read
  // in full (1..N/N would be noise on every ordinary read).
  if (event.toolName === "readFile" && event.metadata) {
    const range = readReadFileRange(event.metadata);
    if (range) return { inline: range };
  }

  // editFile: show the actual added/removed snippet so the user can see what
  // changed without opening the file.
  if (event.toolName === "editFile" && event.metadata) {
    const detail = formatEditFileSnippet(event.metadata);
    if (detail) return { inline: "", detail };
  }

  const summary = event.summary;
  if (!summary) return { inline: "" };
  const exitMatch = summary.match(/exit=(\d+)/);
  if (exitMatch && exitMatch[1] !== "0") return { inline: `${t("toolExitCode")} ${exitMatch[1]}` };
  return { inline: "" };
}

function readReadFileRange(metadata: Record<string, unknown>): string | undefined {
  const startLine = metadata.startLine;
  const endLine = metadata.endLine;
  const totalLines = metadata.totalLines;
  const truncated = metadata.truncated;
  if (
    typeof startLine !== "number" ||
    typeof endLine !== "number" ||
    typeof totalLines !== "number"
  ) {
    return undefined;
  }
  // Only surface when the read was a slice of a larger file. A full read
  // (startLine 1, endLine === totalLines, not truncated) is the common case and
  // showing "1-2560/2560" on every read would be noise.
  if (!truncated && startLine === 1 && endLine === totalLines) return undefined;
  return `${startLine}-${endLine}/${totalLines}`;
}

const EDIT_SNIPPET_MAX_LINES = 5;
const EDIT_SNIPPET_MAX_WIDTH = 96;

function formatEditFileSnippet(metadata: Record<string, unknown>): string | undefined {
  const oldSnippet = typeof metadata.oldSnippet === "string" ? metadata.oldSnippet : undefined;
  const newSnippet = typeof metadata.newSnippet === "string" ? metadata.newSnippet : undefined;
  if (!oldSnippet && !newSnippet) return undefined;
  const lines: string[] = [];
  if (oldSnippet) {
    for (const line of snippetLines(oldSnippet)) lines.push(`- ${line}`);
  }
  if (newSnippet) {
    for (const line of snippetLines(newSnippet)) lines.push(`+ ${line}`);
  }
  return lines.length ? lines.join("\n") : undefined;
}

function snippetLines(snippet: string): string[] {
  const lines = snippet.split(/\r?\n/).filter((line) => line.length > 0);
  const shown = lines.slice(0, EDIT_SNIPPET_MAX_LINES);
  return shown.map((line) => (line.length > EDIT_SNIPPET_MAX_WIDTH
    ? `${line.slice(0, EDIT_SNIPPET_MAX_WIDTH)}…`
    : line));
}

function isFailedToolResult(event: LocalAgentToolEvent) {
  const exitCode = event.metadata?.exitCode;
  if (event.metadata?.actionGate) return false;
  if (typeof exitCode === "number" && exitCode !== 0) return true;
  return Boolean(event.metadata?.timedOut);
}

function isNeedsActionToolResult(event: LocalAgentToolEvent) {
  return Boolean(event.metadata?.actionGate);
}

/**
 * Parse a ui_ask_choice tool result into a question + numbered option list
 * for CLI display. Returns null when the content is not a ui_ask_choice
 * payload (so non-choice tools fall through to the generic compact line).
 * Delegates wire parsing to the shared parseUiAskChoiceContent source of
 * truth; keeps the display-specific trim/filter of choices here.
 */
function parseUiAskChoiceForCli(event: LocalAgentToolEvent): {
  question: string;
  choices: Array<{ label: string; userMessage?: string }>;
} | null {
  if (event.toolName !== "ui_ask_choice" && !event.metadata?.uiAskChoice) {
    return null;
  }
  const parsed = parseUiAskChoiceContent(event.content);
  if (!parsed) return null;
  const question = typeof parsed.question === "string" ? parsed.question.trim() : "";
  const choices = (Array.isArray(parsed.choices) ? parsed.choices : [])
    .filter((c): c is { label?: string; userMessage?: string } =>
      Boolean(c && typeof c === "object"),
    )
    .map((c) => ({
      label: String(c.label ?? "").trim(),
      userMessage: typeof c.userMessage === "string" ? c.userMessage : undefined,
    }))
    .filter((c) => c.label.length > 0);
  if (!question || choices.length === 0) return null;
  return { question, choices };
}

function formatUiAskChoiceBlock(
  event: LocalAgentToolEvent,
  colorEnabled: boolean,
): string | null {
  const parsed = parseUiAskChoiceForCli(event);
  if (!parsed) return null;
  const lines: string[] = [];
  lines.push("");
  if (colorEnabled) {
    lines.push(`${themeText("❓ ", "info", true)}${styleCliText(parsed.question, "cyan", true)}`);
  } else {
    lines.push(`❓ ${parsed.question}`);
  }
  parsed.choices.forEach((choice, i) => {
    const num = String(i + 1);
    const label = choice.label;
    if (colorEnabled) {
      lines.push(
        `  ${themeText(num + ".", "chrome", true)} ${label}`,
      );
    } else {
      lines.push(`  ${num}. ${label}`);
    }
  });
  const hint = "请输入序号选择，或直接回复：";
  if (colorEnabled) {
    lines.push(`  ${dimCliText(hint, true)}`);
  } else {
    lines.push(`  ${hint}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatToolTraceLine(text: string, colorEnabled: boolean, accent: "none" | "error" = "none") {
  if (!colorEnabled) return `${text}\n`;
  if (accent === "error") {
    return `${themeText(text, "danger", true)}\n`;
  }
  return `${dimCliText(text, true)}\n`;
}

function formatVerboseToolEvent(event: LocalAgentToolEvent, colorEnabled: boolean) {
  const round = event.round + 1;
  const detail = event.argumentsPreview ? ` ${event.argumentsPreview}` : "";
  if (event.type === "tool-call") {
    return formatToolTraceLine(`[nolo:tool] #${round} -> ${event.toolName}${detail}`, colorEnabled);
  }
  if (event.type === "tool-error") {
    const elapsed = typeof event.elapsedMs === "number" ? ` ${event.elapsedMs}ms` : "";
    return formatToolTraceLine(
      `[nolo:tool] #${round} !! ${event.toolName}${elapsed}: ${event.message ?? "failed"}`,
      colorEnabled,
      "error"
    );
  }
  const elapsed = typeof event.elapsedMs === "number" ? ` ${event.elapsedMs}ms` : "";
  // ui_ask_choice: render the question + numbered choices even in verbose mode.
  if (event.type === "tool-result" && (event.toolName === "ui_ask_choice" || event.metadata?.uiAskChoice)) {
    const block = formatUiAskChoiceBlock(event, colorEnabled);
    if (block) return `${formatToolTraceLine(`[nolo:tool] #${round} <- ${event.toolName}${elapsed}`, colorEnabled)}${block}`;
  }
  const summary = event.summary ? ` ${event.summary}` : "";
  return formatToolTraceLine(
    `[nolo:tool] #${round} <- ${event.toolName}${elapsed}${summary}`,
    colorEnabled
  );
}

function formatCompactToolLine(
  event: LocalAgentToolEvent,
  pending: { toolName: string; argumentsPreview?: string } | undefined,
  colorEnabled: boolean
) {
  const toolName = event.toolName || pending?.toolName || "tool";
  const rawArgs = clipPathAware(event.argumentsPreview || pending?.argumentsPreview || "", 72);
  const rawLabel = toolLabel(toolName);
  const label = rawArgs ? `${rawLabel} ${rawArgs}` : rawLabel;

  if (event.type === "tool-error") {
    const message = clip(event.message ?? t("toolFailed"), 96);
    return formatToolTraceLine(`  ▸ ${label}  ✗ ${message}`, colorEnabled, "error");
  }

  // ui_ask_choice: render question + numbered choices instead of a generic
  // tool trace line, so CLI users get an interactive-looking menu they can
  // reply to by typing the number or their own answer.
  if (event.type === "tool-result" && (event.toolName === "ui_ask_choice" || event.metadata?.uiAskChoice)) {
    const block = formatUiAskChoiceBlock(event, colorEnabled);
    if (block) return block;
  }

  const hint = compactResultHint(event);
  const suffix = hint.inline ? ` ${hint.inline}` : "";
  const failed = isFailedToolResult(event);
  const marker = failed ? "✗" : isNeedsActionToolResult(event) ? "!" : "✓";

  let mainLine: string;
  if (!colorEnabled) {
    mainLine = `  ▸ ${label}  ${marker}${suffix}\n`;
  } else {
    const chromePointer = themeText("▸", "chrome", true);
    const mutedLabel = themeText(rawLabel, "muted", true);
    const argsPart = rawArgs ? ` ${dimCliText(rawArgs, true)}` : "";
    const statusToken = failed
      ? themeText("✗", "danger", true)
      : isNeedsActionToolResult(event)
        ? themeText("!", "warning", true)
        : themeText("✓", "success", true);
    const suffixPart = hint.inline ? ` ${dimCliText(hint.inline, true)}` : "";
    mainLine = `  ${chromePointer} ${mutedLabel}${argsPart}  ${statusToken}${suffixPart}\n`;
  }

  if (!hint.detail) return mainLine;
  const detailLines = hint.detail
    .split("\n")
    .map((line) => formatEditDetailLine(line, colorEnabled))
    .join("");
  return `${mainLine}${detailLines}`;
}

function formatEditDetailLine(line: string, colorEnabled: boolean): string {
  const marker = line.slice(0, 2);
  const rest = line.slice(2);
  if (!colorEnabled) return `    ${line}\n`;

  const diff = diffLineSequences();
  if (!diff) {
    const color = marker === "- " ? "red" : marker === "+ " ? "green" : undefined;
    if (color) {
      return `    ${styleCliText(marker, color, true)}${dimCliText(rest, true)}\n`;
    }
    return `    ${dimCliText(line, true)}\n`;
  }

  const RESET = "\x1b[0m";

  if (marker === "- ") {
    return `    ${diff.removed.bg}${diff.removed.fg}- ${rest}${RESET}\n`;
  }

  if (marker === "+ ") {
    return `    ${diff.added.bg}${diff.added.fg}+ ${rest}${RESET}\n`;
  }

  return `    ${dimCliText(line, true)}\n`;
}

export function formatToolEventForCli(
  event: LocalAgentToolEvent,
  mode: ToolDisplayMode,
  colorEnabled = resolveCliColorEnabled()
) {
  if (mode === "hide") return "";
  if (mode === "verbose") return formatVerboseToolEvent(event, colorEnabled);
  if (event.type === "tool-call") return "";
  return formatCompactToolLine(event, undefined, colorEnabled);
}

export function createToolEventFormatter(
  mode: ToolDisplayMode,
  colorEnabled = resolveCliColorEnabled()
) {
  const pending = new Map<string, { toolName: string; argumentsPreview?: string }>();

  return (event: LocalAgentToolEvent): string => {
    if (mode === "hide") return "";
    if (mode === "verbose") return formatVerboseToolEvent(event, colorEnabled);

    if (event.type === "tool-call") {
      pending.set(event.toolCallId, {
        toolName: event.toolName,
        argumentsPreview: event.argumentsPreview,
      });
      return "";
    }

    const call = pending.get(event.toolCallId);
    pending.delete(event.toolCallId);
    return formatCompactToolLine(event, call, colorEnabled);
  };
}

export function createSseToolEventAdapter(
  onEvent?: (event: LocalAgentToolEvent) => void
) {
  let round = 0;
  let callIndex = 0;
  let pendingCalls: Array<{ toolCallId: string; toolName: string }> = [];

  const emit = (event: LocalAgentToolEvent): LocalAgentToolEvent => {
    onEvent?.(event);
    return event;
  };

  return {
    onToolStart(payload: { calls?: string[] } | string[]): LocalAgentToolEvent[] {
      const calls = Array.isArray(payload) ? payload : payload?.calls ?? [];
      pendingCalls = [];
      const events: LocalAgentToolEvent[] = [];
      for (const name of calls) {
        callIndex++;
        const toolCallId = `sse-call-${callIndex}`;
        const toolName = name || "tool";
        pendingCalls.push({ toolCallId, toolName });
        const event: LocalAgentToolEvent = {
          type: "tool-call",
          toolCallId,
          toolName,
          round,
        };
        events.push(emit(event));
      }
      return events;
    },

    onToolResult(payload: {
      toolCallId?: string;
      toolName?: string;
      content?: string;
      metadata?: Record<string, any>;
    }): LocalAgentToolEvent {
      const pending = payload.toolCallId
        ? pendingCalls.find((p) => p.toolCallId === payload.toolCallId)
        : pendingCalls.shift();

      if (pending && payload.toolCallId) {
        pendingCalls = pendingCalls.filter((p) => p.toolCallId !== payload.toolCallId);
      }

      const toolCallId = payload.toolCallId || pending?.toolCallId || `sse-call-${callIndex}`;
      const toolName = payload.toolName || pending?.toolName || "tool";
      const rawContent = typeof payload.content === "string" ? payload.content : "";
      const summary = rawContent ? clipCompactText(rawContent, 120, "…") : undefined;

      const event: LocalAgentToolEvent = {
        type: "tool-result",
        toolCallId,
        toolName,
        summary,
        metadata: payload.metadata,
        round,
      };
      return emit(event);
    },

    onToolEnd() {
      round++;
      pendingCalls = [];
    },
  };
}
