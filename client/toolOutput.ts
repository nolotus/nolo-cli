import { clipPathAware, formatFetchTreeLines, formatHomePath, formatReadItemPath, formatReadTreeLines, formatRunTreeLines, formatSearchItemQuery, formatSearchTreeLines } from "./formatReadPathTree";
export { clipPathAware };
import { clipCompactText } from "../core/clipCompactText";
import { compactWhitespace } from "../core/compactWhitespace";
import { asTrimmedLowercaseString } from "../core/trimmedLowercaseString";
import { clipHeadAndTail } from "../core/clipHeadAndTail";
export { clipHeadAndTail };
import type { LocalAgentToolEvent } from "../agent-runtime/localLoop";
import { readActionGate, readCommandActionGatePayload } from "../agent-runtime/actionGate";
import { parseUiAskChoiceContent } from "../ai/tools/uiAskChoiceTool";
import { formatAgentListCard } from "../ai/tools/noloWorkspaceReadTools";
import { getAgentRunStatusIcon } from "../ai/tools/agent/agentRunDisplayHelpers";
import { dimCliText, resolveCliColorEnabled, styleCliText } from "./terminalStyles";
import { type DiffLineKind, renderDiffLine, themeText } from "../tui/theme";
import { displayWidth } from "../tui/tuiAnsi";
import { diffLines } from "diff";
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
export type EditSnippetLine = { kind: DiffLineKind; text: string };

function compactResultHint(event: LocalAgentToolEvent): {
  inline: string;
  detail?: EditSnippetLine[];
} {
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

const EDIT_SNIPPET_MAX_LINES = 10;
const EDIT_SNIPPET_MAX_WIDTH = 96;

function formatEditFileSnippet(
  metadata: Record<string, unknown>
): EditSnippetLine[] | undefined {
  const oldSnippet = typeof metadata.oldSnippet === "string" ? metadata.oldSnippet : undefined;
  const newSnippet = typeof metadata.newSnippet === "string" ? metadata.newSnippet : undefined;
  if (!oldSnippet && !newSnippet) return undefined;

  // Degraded path: one side missing — show whichever side we have, tagged
  // wholesale as removed/added so the user at least sees something.
  if (oldSnippet && !newSnippet) {
    return snippetLinesWithKind(oldSnippet, "removed");
  }
  if (newSnippet && !oldSnippet) {
    return snippetLinesWithKind(newSnippet, "added");
  }

  // Both present: produce a real line-level diff via `diffLines`.
  const parts = diffLines(oldSnippet!, newSnippet!);
  const all: EditSnippetLine[] = [];
  for (const part of parts) {
    const kind: DiffLineKind = part.added ? "added" : part.removed ? "removed" : "context";
    // `diffLines` values end with "\n", so split drops a trailing empty element.
    const raw = part.value.split("\n");
    if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
    for (const line of raw) all.push(buildEditLine(kind, line));
  }

  // No change at all (old === new) — nothing actionable to show.
  const changeCount = all.filter((l) => l.kind !== "context").length;
  if (changeCount === 0) return undefined;

  return windowAndTruncate(all, EDIT_SNIPPET_MAX_LINES);
}

function prefixFor(kind: DiffLineKind): string {
  return kind === "added" ? "+ " : kind === "removed" ? "- " : "  ";
}

/**
 * Build one diff line: kind prefix + width-clipped body. Clipping uses
 * display width (CJK-aware) so a 60-char CJK line (120 columns) is truncated
 * where a `.length` check would have let it overflow.
 */
function buildEditLine(kind: DiffLineKind, body: string): EditSnippetLine {
  return { kind, text: prefixFor(kind) + truncateByDisplayWidth(body, EDIT_SNIPPET_MAX_WIDTH) };
}

/** One-sided fallback: tag every line of a snippet with a single kind. */
function snippetLinesWithKind(
  snippet: string,
  kind: DiffLineKind
): EditSnippetLine[] {
  const lines = snippet.split(/\r?\n/).filter((line) => line.length > 0);
  return lines.slice(0, EDIT_SNIPPET_MAX_LINES).map((line) => buildEditLine(kind, line));
}

/**
 * Clip a line to a display-width budget, appending "…" when it overflows.
 * Width is measured by `displayWidth` (CJK-aware), not by code-unit count,
 * so a line of 60 CJK chars (120 display columns) is clipped where a
 * `.length`-based check would have let it through.
 */
function truncateByDisplayWidth(line: string, maxWidth: number): string {
  if (displayWidth(line) <= maxWidth) return line;
  // Walk code points, accumulating display width; stop just before overflowing
  // so the "…" fits within the budget.
  let width = 0;
  let kept = "";
  for (const char of line) {
    const w = displayWidth(char);
    if (width + w + 1 > maxWidth) break; // +1 reserves room for "…"
    kept += char;
    width += w;
  }
  return `${kept}…`;
}

/**
 * Keep the window centered on the first changed line so a change at the tail
 * of a long snippet isn't clipped away by a naive head truncation. When the
 * changed region plus its surrounding context fits within maxLines, the
 * contiguous run from the first change is kept; otherwise the window is
 * shifted so the first change is visible.
 */
function windowAndTruncate(lines: EditSnippetLine[], maxLines: number): EditSnippetLine[] {
  if (lines.length <= maxLines) return lines;
  const firstChange = lines.findIndex((l) => l.kind !== "context");
  if (firstChange === -1) return lines.slice(0, maxLines);
  // Center the window on the first change, clamped to [0, len-maxLines].
  const half = Math.floor(maxLines / 2);
  let start = Math.max(0, firstChange - half);
  if (start + maxLines > lines.length) start = Math.max(0, lines.length - maxLines);
  const kept = lines.slice(start, start + maxLines);
  const omitted = lines.length - kept.length;
  if (omitted > 0) {
    kept.push({ kind: "context", text: `  … +${omitted} more lines` });
  }
  return kept;
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
  selected?: { label: string; userMessage: string };
  answers?: Array<{
    questionId: string;
    selectedIds: string[];
    otherText: string;
    userMessage: string;
  }>;
  cancelled?: boolean;
  resolved: boolean;
} | null {
  if (event.toolName !== "ui_ask_choice" && !event.metadata?.uiAskChoice) {
    return null;
  }
  const parsed = parseUiAskChoiceContent(event.content);
  if (!parsed) return null;
  const question = typeof parsed.question === "string" ? parsed.question.trim() : "";
  const choices = (Array.isArray(parsed.choices) ? parsed.choices : [])
    // 运行时防御：choices 声明为 UiAskChoiceOption[]（label 必填），但内容来自
    // 线上 JSON，实际可能缺字段。这里只过滤非对象，不再声明类型谓词——
    // 原谓词把 label 写成可选，与元素类型不兼容（TS2677）；下面的 map 已用
    // `c.label ?? ""` 兜底，行为不变。
    .filter((c) => Boolean(c && typeof c === "object"))
    .map((c) => ({
      label: String(c.label ?? "").trim(),
      userMessage: typeof c.userMessage === "string" ? c.userMessage : undefined,
    }))
    .filter((c) => c.label.length > 0);
  const selected =
    parsed.selected && typeof parsed.selected === "object"
      ? {
          label: String(parsed.selected.label ?? "").trim(),
          userMessage: String(parsed.selected.userMessage ?? "").trim(),
        }
      : undefined;
  const answers = Array.isArray(parsed.answers) ? parsed.answers : undefined;
  const cancelled = Boolean(parsed.cancelled);
  const resolved = Boolean(
    event.metadata?.resolved || selected || cancelled || (answers && answers.length > 0),
  );
  // Unresolved interactive prompts need a question + at least one choice.
  // Resolved / cancelled payloads may omit choices (or only carry selected).
  if (!resolved && (!question || choices.length === 0)) return null;
  if (!question && !selected && !cancelled) return null;
  return {
    question,
    choices,
    ...(selected ? { selected } : {}),
    ...(answers ? { answers } : {}),
    ...(cancelled ? { cancelled: true } : {}),
    resolved,
  };
}

function formatUiAskChoiceBlock(
  event: LocalAgentToolEvent,
  colorEnabled: boolean,
): string | null {
  const parsed = parseUiAskChoiceForCli(event);
  if (!parsed) return null;
  const lines: string[] = [];
  lines.push("");

  const questionText = parsed.question || "";
  if (colorEnabled) {
    lines.push(`${themeText("❓ ", "info", true)}${styleCliText(questionText, "cyan", true)}`);
  } else {
    lines.push(`❓ ${questionText}`);
  }

  // Resolved: show what the user picked (or cancelled) instead of re-printing
  // the interactive menu + "type a number" hint into message history.
  if (parsed.resolved) {
    if (parsed.cancelled) {
      const cancelled = t("askChoiceHistoryCancelled");
      lines.push(
        colorEnabled
          ? `  ${themeText("·", "chrome", true)} ${themeText(cancelled, "muted", true)}`
          : `  · ${cancelled}`,
      );
      return `${lines.join("\n")}\n`;
    }

    const selectedLabel =
      parsed.selected?.label ||
      parsed.selected?.userMessage ||
      (parsed.answers
        ? parsed.answers
            .map((a) => a.userMessage)
            .filter(Boolean)
            .join(", ")
        : "");
    const marker = t("askChoiceHistorySelected");
    const displayLabel = selectedLabel || "—";
    if (colorEnabled) {
      lines.push(
        `  ${themeText("✓", "success", true)} ${themeText(marker, "muted", true)} ${displayLabel}`,
      );
    } else {
      lines.push(`  ✓ ${marker} ${displayLabel}`);
    }
    // Multi-question: list each answer on its own line when present.
    if (parsed.answers && parsed.answers.length > 1) {
      for (const answer of parsed.answers) {
        if (!answer.userMessage) continue;
        lines.push(
          colorEnabled
            ? `    ${themeText("·", "chrome", true)} ${answer.userMessage}`
            : `    · ${answer.userMessage}`,
        );
      }
    }
    return `${lines.join("\n")}\n`;
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
  const hint = t("askChoiceHistoryHint");
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

function recoverOrchestrationDisplayFromContent(toolName: string, content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return content;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (toolName === "listAgents") {
      const agents = Array.isArray(parsed.agents) ? parsed.agents : [];
      return formatAgentListCard(agents as Parameters<typeof formatAgentListCard>[0]);
    }
    if (toolName === "startAgentRun") {
      const runId = typeof parsed.runId === "string" ? parsed.runId : "—";
      const name =
        typeof parsed.agentName === "string" && parsed.agentName.trim()
          ? parsed.agentName.trim()
          : typeof parsed.name === "string" && parsed.name.trim()
            ? parsed.name.trim()
            : "agent";
      const pid =
        typeof parsed.pid === "number" || typeof parsed.pid === "string" ? String(parsed.pid) : undefined;
      const status = typeof parsed.status === "string" ? parsed.status : undefined;
      const lastLine =
        pid !== undefined
          ? `  pid     ${pid}`
          : `  status  ${status ? `${getAgentRunStatusIcon(status)} ${status}` : "—"}`;
      return `Run started\n  agent   ${name}\n  runId   ${runId}\n${lastLine}`;
    }
    if (toolName === "controlAgentRun") {
      if (Array.isArray(parsed.runs)) {
        const runs = parsed.runs as Array<Record<string, unknown>>;
        const lines = [`Runs (${runs.length})`];
        for (const run of runs) {
          const status = typeof run.status === "string" ? run.status : "—";
          const icon = getAgentRunStatusIcon(status);
          const name =
            typeof run.agentName === "string" && run.agentName.trim()
              ? run.agentName.trim()
              : typeof run.name === "string" && run.name.trim()
                ? run.name.trim()
                : "agent";
          const runId = typeof run.runId === "string" ? run.runId : "—";
          lines.push(`  ${icon}  ${name}  ${runId}`);
        }
        return lines.join("\n");
      }
      const runId = typeof parsed.runId === "string" ? parsed.runId : "—";
      const status = typeof parsed.status === "string" ? parsed.status : undefined;
      const icon = getAgentRunStatusIcon(status ?? "not_found");
      if (parsed.found === false || status === "not_found") {
        return `Run status\n  ? not_found\n  runId   ${runId}`;
      }
      if (status === "killed" || status === "cancelled" || status === "cancelling") {
        return `Run stopped\n  ${icon} ${status}\n  runId   ${runId}`;
      }
      const name =
        typeof parsed.agentName === "string" && parsed.agentName.trim()
          ? parsed.agentName.trim()
          : typeof parsed.name === "string" && parsed.name.trim()
            ? parsed.name.trim()
            : "agent";
      const lines = [`Run status`, `  ${icon} ${status ?? "—"}`, `  agent   ${name}`, `  runId   ${runId}`];
      if (parsed.pid != null) lines.push(`  pid     ${String(parsed.pid)}`);
      return lines.join("\n");
    }
  } catch {
    // Not JSON / unexpected shape — fall through.
  }
  return content;
}

function formatOrchestrationCardBlock(
  event: LocalAgentToolEvent,
  toolName: string,
  colorEnabled: boolean
): string {
  const rawLabel = toolLabel(toolName);
  let rawDataStr =
    typeof event.metadata?.displayData === "string" && event.metadata.displayData.trim()
      ? event.metadata.displayData
      : typeof event.content === "string"
      ? event.content
      : "";
  // Web → CLI bridge may only carry JSON content without metadata.displayData.
  // Recover a readable card before dumping the raw JSON blob into the transcript.
  if (
    typeof event.metadata?.displayData !== "string" &&
    typeof event.content === "string" &&
    event.content.trim()
  ) {
    rawDataStr = recoverOrchestrationDisplayFromContent(toolName, event.content);
  }
  const failed =
    event.type === "tool-error" ||
    isFailedToolResult(event) ||
    Boolean(event.metadata?.failed) ||
    /^Error:/i.test(rawDataStr.trim());

  if (failed) {
    const firstLine = rawDataStr.trim().split("\n")[0] || event.summary || event.message || t("toolFailed");
    const message = clip(firstLine, 96);
    if (!colorEnabled) {
      return `✗ ${rawLabel}  ${message}\n`;
    }
    const cross = themeText("✗", "danger", true);
    const labelPart = themeText(rawLabel, "muted", true);
    const msgPart = themeText(message, "danger", true);
    return `${cross} ${labelPart}  ${msgPart}\n`;
  }

  const displayData = rawDataStr.trim();
  const lines = displayData ? displayData.split("\n") : [];

  if (!colorEnabled) {
    let out = `● ${rawLabel}\n`;
    for (const line of lines) {
      out += `  ${line}\n`;
    }
    return out;
  }

  const bullet = themeText("●", "success", true);
  const labelPart = themeText(rawLabel, "muted", true);
  let out = `${bullet} ${labelPart}\n`;
  for (const line of lines) {
    out += `  ${themeText(line, "muted", true)}\n`;
  }
  return out;
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

function isReadToolName(name?: string): boolean {
  if (!name) return false;
  return name === "read" || name === "readFile" || name === "read_file" || name === "readWorkspaceFile";
}

function isSearchToolName(name?: string): boolean {
  if (!name) return false;
  return (
    name === "grep" ||
    name === "searchFiles" ||
    name === "search_files" ||
    name === "globFiles" ||
    name === "glob_files" ||
    name === "glob" ||
    name === "searchWorkspace" ||
    name === "search"
  );
}

/**
 * Run-class tools: execShell (synchronous shell), launchProcess (detached
 * background), runCommand (legacy alias). All expose `metadata.command` as
 * the canonical leaf text, so they fold into a single • Run (N) tree when
 * they appear back-to-back, just like Read/Search.
 *
 * Action-gated (interactive handoff) results stay on the generic line so the
 * "needs action" recovery hint keeps its visible prompt — folding those into
 * a tree would bury the one signal the user must act on.
 */
function isRunToolName(name?: string): boolean {
  if (!name) return false;
  return name === "execShell" || name === "runCommand" || name === "run_command" || name === "launchProcess";
}

/**
 * Fetch-class tools: fetchWebpage. Renders as a • Fetch (N) tree, mirroring
 * Read/Search/Run. The URL is the canonical leaf text.
 */
function isFetchToolName(name?: string): boolean {
  if (!name) return false;
  return name === "fetchWebpage" || name === "fetch_webpage";
}

function isRunResultFoldable(event: LocalAgentToolEvent): boolean {
  return Boolean(event.metadata?.actionGate) === false;
}

export function formatSearchTreeBlockForCli(
  items: Array<{ query: string; path?: string }>,
  colorEnabled: boolean
): string {
  if (items.length === 0) return "";
  const { count, lines } = formatSearchTreeLines(items);

  if (!colorEnabled) {
    const headerLine = `• Search (${count})\n`;
    const treeLines = lines.map((l) => `  ${l.connector}${l.queryText}`).join("\n");
    return `${headerLine}${treeLines}\n`;
  }

  const bullet = themeText("•", "chrome", true);
  const title = styleCliText("Search", "bold", true);
  const countText = themeText(`(${count})`, "muted", true);
  const headerLine = `${bullet} ${title} ${countText}\n`;

  const treeLines = lines
    .map((l) => {
      const connector = themeText(`  ${l.connector}`, "chrome", true);
      const queryText = themeText(l.queryText, "muted", true);
      return `${connector}${queryText}`;
    })
    .join("\n");

  return `${headerLine}${treeLines}\n`;
}

export function formatReadTreeBlockForCli(
  items: Array<{ path: string; metadata?: Record<string, unknown> }>,
  colorEnabled: boolean
): string {
  if (items.length === 0) return "";
  const { count, lines } = formatReadTreeLines(items);

  if (!colorEnabled) {
    const headerLine = `• Read (${count})\n`;
    const treeLines = lines.map((l) => `  ${l.connector}${l.pathWithRange}`).join("\n");
    return `${headerLine}${treeLines}\n`;
  }

  const bullet = themeText("•", "chrome", true);
  const title = styleCliText("Read", "bold", true);
  const countText = themeText(`(${count})`, "muted", true);
  const headerLine = `${bullet} ${title} ${countText}\n`;

  const treeLines = lines
    .map((l) => {
      const connector = themeText(`  ${l.connector}`, "chrome", true);
      const pathText = themeText(l.pathWithRange, "muted", true);
      return `${connector}${pathText}`;
    })
    .join("\n");

  return `${headerLine}${treeLines}\n`;
}

export function formatRunTreeBlockForCli(
  items: Array<{ command: string; exitCode?: number; timedOut?: boolean }>,
  colorEnabled: boolean
): string {
  if (items.length === 0) return "";
  const { count, lines } = formatRunTreeLines(items);

  if (!colorEnabled) {
    const headerLine = `• Run (${count})\n`;
    const treeLines = lines.map((l) => `  ${l.connector}${l.commandText}`).join("\n");
    return `${headerLine}${treeLines}\n`;
  }

  const bullet = themeText("•", "chrome", true);
  const title = styleCliText("Run", "bold", true);
  const countText = themeText(`(${count})`, "muted", true);
  const headerLine = `${bullet} ${title} ${countText}\n`;

  const treeLines = lines
    .map((l) => {
      const connector = themeText(`  ${l.connector}`, "chrome", true);
      const commandText = themeText(l.commandText, "muted", true);
      return `${connector}${commandText}`;
    })
    .join("\n");

  return `${headerLine}${treeLines}\n`;
}

export function formatFetchTreeBlockForCli(
  items: Array<{ url: string }>,
  colorEnabled: boolean
): string {
  if (items.length === 0) return "";
  const { count, lines } = formatFetchTreeLines(items);

  if (!colorEnabled) {
    const headerLine = `• Fetch (${count})\n`;
    const treeLines = lines.map((l) => `  ${l.connector}${l.urlText}`).join("\n");
    return `${headerLine}${treeLines}\n`;
  }

  const bullet = themeText("•", "chrome", true);
  const title = styleCliText("Fetch", "bold", true);
  const countText = themeText(`(${count})`, "muted", true);
  const headerLine = `${bullet} ${title} ${countText}\n`;

  const treeLines = lines
    .map((l) => {
      const connector = themeText(`  ${l.connector}`, "chrome", true);
      const urlText = themeText(l.urlText, "muted", true);
      return `${connector}${urlText}`;
    })
    .join("\n");

  return `${headerLine}${treeLines}\n`;
}

/**
 * Resolve the skill name for a loadSkill tool event. The tool contract puts
 * `{ name }` in the input; the success result content starts with
 * `Skill "<name>" loaded inline.`. Prefer the explicit metadata/arg name,
 * then fall back to extracting it from the result content so the renderer
 * stays correct even when only `content` is populated.
 */
function resolveLoadSkillName(event: LocalAgentToolEvent): string {
  const metaName = typeof event.metadata?.name === "string" ? event.metadata.name : undefined;
  if (metaName) return metaName;
  const argName = event.argumentsPreview?.trim();
  if (argName && !argName.startsWith("{")) return argName;
  const content = typeof event.content === "string" ? event.content : "";
  const match = content.match(/Skill "([^"]+)" loaded inline/);
  if (match?.[1]) return match[1];
  return argName || "skill";
}

function formatCompactToolLine(
  event: LocalAgentToolEvent,
  pending: { toolName: string; argumentsPreview?: string } | undefined,
  colorEnabled: boolean
) {
  const toolName = event.toolName || pending?.toolName || "tool";
  if (isReadToolName(toolName) && event.type === "tool-result") {
    const rawPath =
      (typeof event.metadata?.path === "string" ? event.metadata.path : undefined) ||
      (typeof event.metadata?.filePath === "string" ? event.metadata.filePath : undefined) ||
      event.argumentsPreview ||
      pending?.argumentsPreview ||
      "";
    return formatReadTreeBlockForCli([{ path: rawPath, metadata: event.metadata }], colorEnabled);
  }
  if (isSearchToolName(toolName) && event.type === "tool-result") {
    const rawQuery =
      (typeof event.metadata?.query === "string" ? event.metadata.query : undefined) ||
      (typeof event.metadata?.pattern === "string" ? event.metadata.pattern : undefined) ||
      event.argumentsPreview ||
      pending?.argumentsPreview ||
      "";
    const rawPath = typeof event.metadata?.path === "string" ? event.metadata.path : undefined;
    return formatSearchTreeBlockForCli([{ query: rawQuery, path: rawPath }], colorEnabled);
  }
  if (isFetchToolName(toolName) && event.type === "tool-result") {
    const rawUrl =
      (typeof event.metadata?.url === "string" ? event.metadata.url : undefined) ||
      event.argumentsPreview ||
      pending?.argumentsPreview ||
      "";
    return formatFetchTreeBlockForCli([{ url: rawUrl }], colorEnabled);
  }
  if (isRunToolName(toolName) && event.type === "tool-result" && isRunResultFoldable(event)) {
    const rawCommand =
      (typeof event.metadata?.command === "string" ? event.metadata.command : undefined) ||
      event.argumentsPreview ||
      pending?.argumentsPreview ||
      "";
    const exitCode = typeof event.metadata?.exitCode === "number" ? event.metadata.exitCode : undefined;
    const timedOut = Boolean(event.metadata?.timedOut);
    return formatRunTreeBlockForCli([{ command: rawCommand, exitCode, timedOut }], colorEnabled);
  }
  const rawArgs = clipPathAware(event.argumentsPreview || pending?.argumentsPreview || "", 72);
  const rawLabel = toolLabel(toolName);
  const label = rawArgs ? `${rawLabel} ${rawArgs}` : rawLabel;
  if (event.type === "tool-error") {
    const message = clip(event.message ?? t("toolFailed"), 96);
    return formatToolTraceLine(`▸ ${label}  ✗ ${message}`, colorEnabled, "error");
  }

  // loadSkill: render Kimi-style "● Used Skill (<name>)" with the inline
  // follow-instructions line indented below it. tool-error already returned
  // above. not-found is a plain tool-result (executors return text, never
  // throw), so detect it here — same minimal-prefix contract the web/RN
  // renderers use — and render a failure line instead of the success bullet.
  if (event.type === "tool-result" && toolName === "loadSkill") {
    const skillName = resolveLoadSkillName(event);
    const content = typeof event.content === "string" ? event.content : "";
    const failed =
      /^Skill\s+"[^"]*"\s+not found/.test(content) || isFailedToolResult(event);
    if (failed) {
      const message = clip(content.split("\n")[0] || t("toolFailed"), 96);
      return formatToolTraceLine(`▸ Used Skill (${skillName})  ✗ ${message}`, colorEnabled, "error");
    }
    const resultLine = `Skill "${skillName}" loaded inline. Follow its instructions.`;
    if (!colorEnabled) {
      return `● Used Skill (${skillName})\n  ${resultLine}\n`;
    }
    const bullet = themeText("●", "success", true);
    const labelPart = themeText("Used Skill", "muted", true);
    const namePart = themeText(`(${skillName})`, "chrome", true);
    const detail = themeText(`  ${resultLine}`, "muted", true);
    return `${bullet} ${labelPart} ${namePart}\n${detail}\n`;
  }

  // listAgents / startAgentRun / controlAgentRun orchestration card block
  if (
    event.type === "tool-result" &&
    (toolName === "listAgents" || toolName === "startAgentRun" || toolName === "controlAgentRun")
  ) {
    return formatOrchestrationCardBlock(event, toolName, colorEnabled);
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
    mainLine = `▸ ${label}  ${marker}${suffix}\n`;
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
    mainLine = `${chromePointer} ${mutedLabel}${argsPart}  ${statusToken}${suffixPart}\n`;
  }

  if (!hint.detail?.length) return mainLine;
  return `${mainLine}${formatEditDetailBlock(hint.detail, colorEnabled)}`;
}

function formatEditDetailBlock(lines: EditSnippetLine[], colorEnabled: boolean): string {
  if (!colorEnabled) {
    return lines.map((line) => `  ${line.text}\n`).join("");
  }
  // Block-level padTo so every diff line forms a rectangle of equal visible
  // width (Zed-style band). Measured with CJK-aware displayWidth.
  const padTo = Math.max(...lines.map((line) => displayWidth(line.text))) + 1;
  return lines
    .map((line) => `  ${renderDiffLine({ kind: line.kind, text: line.text, padTo, colorEnabled: true })}\n`)
    .join("");
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

export type ToolEventFormatter = ((event: LocalAgentToolEvent) => string) & {
  flush?: () => string;
};

export function createToolEventFormatter(
  mode: ToolDisplayMode,
  colorEnabled = resolveCliColorEnabled()
): ToolEventFormatter {
  const pending = new Map<string, { toolName: string; argumentsPreview?: string }>();
  let readBuffer: LocalAgentToolEvent[] = [];
  let searchBuffer: LocalAgentToolEvent[] = [];
  let runBuffer: LocalAgentToolEvent[] = [];
  let fetchBuffer: LocalAgentToolEvent[] = [];

  const flushBuffers = (): string => {
    let out = "";
    if (readBuffer.length > 0) {
      const items = readBuffer.map((evt) => {
        const call = pending.get(evt.toolCallId);
        const rawPath =
          (typeof evt.metadata?.path === "string" ? evt.metadata.path : undefined) ||
          (typeof evt.metadata?.filePath === "string" ? evt.metadata.filePath : undefined) ||
          evt.argumentsPreview ||
          call?.argumentsPreview ||
          "";
        return { path: rawPath, metadata: evt.metadata };
      });
      for (const evt of readBuffer) pending.delete(evt.toolCallId);
      readBuffer = [];
      out += formatReadTreeBlockForCli(items, colorEnabled);
    }

    if (searchBuffer.length > 0) {
      const items = searchBuffer.map((evt) => {
        const call = pending.get(evt.toolCallId);
        const rawQuery =
          (typeof evt.metadata?.query === "string" ? evt.metadata.query : undefined) ||
          (typeof evt.metadata?.pattern === "string" ? evt.metadata.pattern : undefined) ||
          evt.argumentsPreview ||
          call?.argumentsPreview ||
          "";
        const rawPath = typeof evt.metadata?.path === "string" ? evt.metadata.path : undefined;
        return { query: rawQuery, path: rawPath };
      });
      for (const evt of searchBuffer) pending.delete(evt.toolCallId);
      searchBuffer = [];
      out += formatSearchTreeBlockForCli(items, colorEnabled);
    }

    if (runBuffer.length > 0) {
      const items = runBuffer.map((evt) => {
        const call = pending.get(evt.toolCallId);
        const rawCommand =
          (typeof evt.metadata?.command === "string" ? evt.metadata.command : undefined) ||
          evt.argumentsPreview ||
          call?.argumentsPreview ||
          "";
        const exitCode = typeof evt.metadata?.exitCode === "number" ? evt.metadata.exitCode : undefined;
        const timedOut = Boolean(evt.metadata?.timedOut);
        return { command: rawCommand, exitCode, timedOut };
      });
      for (const evt of runBuffer) pending.delete(evt.toolCallId);
      runBuffer = [];
      out += formatRunTreeBlockForCli(items, colorEnabled);
    }

    if (fetchBuffer.length > 0) {
      const items = fetchBuffer.map((evt) => {
        const call = pending.get(evt.toolCallId);
        const rawUrl =
          (typeof evt.metadata?.url === "string" ? evt.metadata.url : undefined) ||
          evt.argumentsPreview ||
          call?.argumentsPreview ||
          "";
        return { url: rawUrl };
      });
      for (const evt of fetchBuffer) pending.delete(evt.toolCallId);
      fetchBuffer = [];
      out += formatFetchTreeBlockForCli(items, colorEnabled);
    }

    return out;
  };

  const formatter = (event: LocalAgentToolEvent): string => {
    if (mode === "hide") return "";
    if (mode === "verbose") return formatVerboseToolEvent(event, colorEnabled);

    if (isReadToolName(event.toolName)) {
      if (event.type === "tool-call") {
        pending.set(event.toolCallId, {
          toolName: event.toolName,
          argumentsPreview: event.argumentsPreview,
        });
        return "";
      }
      if (event.type === "tool-result") {
        readBuffer.push(event);
        return "";
      }
    }

    if (isSearchToolName(event.toolName)) {
      if (event.type === "tool-call") {
        pending.set(event.toolCallId, {
          toolName: event.toolName,
          argumentsPreview: event.argumentsPreview,
        });
        return "";
      }
      if (event.type === "tool-result") {
        searchBuffer.push(event);
        return "";
      }
    }

    if (isRunToolName(event.toolName)) {
      // Action-gated (interactive handoff) runs must NOT be buffered: their
      // recovery hint is the one signal the user must act on, and folding it
      // into a tree would hide the prompt. Flush prior runs, then fall
      // through to the generic compact line so the "! needs action" marker
      // still renders on its own line.
      if (event.type === "tool-result" && !isRunResultFoldable(event)) {
        const flushed = flushBuffers();
        const call = pending.get(event.toolCallId);
        pending.delete(event.toolCallId);
        return `${flushed}${formatCompactToolLine(event, call, colorEnabled)}`;
      }
      if (event.type === "tool-call") {
        pending.set(event.toolCallId, {
          toolName: event.toolName,
          argumentsPreview: event.argumentsPreview,
        });
        return "";
      }
      if (event.type === "tool-result") {
        runBuffer.push(event);
        return "";
      }
    }

    if (isFetchToolName(event.toolName)) {
      if (event.type === "tool-call") {
        pending.set(event.toolCallId, {
          toolName: event.toolName,
          argumentsPreview: event.argumentsPreview,
        });
        return "";
      }
      if (event.type === "tool-result") {
        fetchBuffer.push(event);
        return "";
      }
    }

    const flushed = flushBuffers();
    if (event.type === "tool-call") {
      pending.set(event.toolCallId, {
        toolName: event.toolName,
        argumentsPreview: event.argumentsPreview,
      });
      return flushed;
    }

    const call = pending.get(event.toolCallId);
    pending.delete(event.toolCallId);
    return `${flushed}${formatCompactToolLine(event, call, colorEnabled)}`;
  };
  formatter.flush = flushBuffers;
  return formatter;
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
