import type { LocalAgentToolEvent } from "../../agent-runtime/localLoop";
import { dimCliText, resolveCliColorEnabled, styleCliText } from "./terminalStyles";

export type ToolDisplayMode = "hide" | "compact" | "verbose";

export function normalizeToolDisplayMode(
  raw: string | undefined,
  fallback: ToolDisplayMode = "compact"
): ToolDisplayMode {
  const normalized = raw?.trim().toLowerCase();
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
  const legacyTrace = env.NOLO_TRACE_TOOLS?.trim().toLowerCase();
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
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function compactResultHint(event: LocalAgentToolEvent, toolName: string) {
  const rawAction = event.metadata?.requiresUserAction;
  if (rawAction && typeof rawAction === "object" && !Array.isArray(rawAction)) {
    const action = rawAction as Record<string, unknown>;
    const command = typeof action.displayCommand === "string"
      ? action.displayCommand
      : Array.isArray(action.argv)
        ? action.argv.filter((item): item is string => typeof item === "string").join(" ")
        : "";
    return command.trim()
      ? `needs terminal: ${clip(command, 120)}`
      : "needs terminal";
  }
  if (event.metadata?.timedOut) return "timed out";

  const summary = event.summary;
  if (!summary) return "";
  const exitMatch = summary.match(/exit=(\d+)/);
  if (exitMatch && exitMatch[1] !== "0") return `exit ${exitMatch[1]}`;
  const linesMatch = summary.match(/(\d+)\s+lines?/);
  if (linesMatch) {
    if (toolName === "readFile" || toolName === "listFiles" || toolName === "globFiles") {
      return `${linesMatch[1]} lines`;
    }
    if (toolName === "execShell" || toolName === "runCommand") {
      return `${linesMatch[1]} lines`;
    }
  }
  return "";
}

function isFailedToolResult(event: LocalAgentToolEvent) {
  const exitCode = event.metadata?.exitCode;
  if (typeof exitCode === "number" && exitCode !== 0) return true;
  return Boolean(event.metadata?.timedOut || event.metadata?.requiresUserAction);
}

function formatToolTraceLine(text: string, colorEnabled: boolean, accent: "none" | "error" = "none") {
  if (!colorEnabled) return `${text}\n`;
  if (accent === "error") {
    return `${styleCliText(text, "red", true)}\n`;
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
  const args = clip(event.argumentsPreview || pending?.argumentsPreview || "");
  const label = args ? `${toolName} ${args}` : toolName;
  const ms = typeof event.elapsedMs === "number" ? `${event.elapsedMs}ms` : "";

  if (event.type === "tool-error") {
    const message = clip(event.message ?? "failed", 96);
    const timing = ms ? ` · ${ms}` : "";
    return formatToolTraceLine(`  ▸ ${label}  ✗ ${message}${timing}`, colorEnabled, "error");
  }

  const hint = compactResultHint(event, toolName);
  const timing = ms ? ` ${ms}` : "";
  const suffix = hint ? ` · ${hint}` : "";
  const marker = isFailedToolResult(event) ? "✗" : "✓";
  const accent = isFailedToolResult(event) ? "error" : "none";
  return formatToolTraceLine(`  ▸ ${label}  ${marker}${timing}${suffix}`, colorEnabled, accent);
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
