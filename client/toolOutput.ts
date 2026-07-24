import { clipCompactText } from "../core/clipCompactText";
import { asTrimmedLowercaseString } from "../core/trimmedLowercaseString";
import type { LocalAgentToolEvent } from "../agent-runtime/localLoop";
import { readActionGate, readCommandActionGatePayload } from "../agent-runtime/actionGate";
import { dimCliText, resolveCliColorEnabled, styleCliText } from "./terminalStyles";
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

export function formatActiveToolLabel(
  event: Pick<LocalAgentToolEvent, "toolName" | "argumentsPreview">
) {
  const toolName = event.toolName || "tool";
  const args = clip(event.argumentsPreview ?? "");
  const label = toolLabel(toolName);
  return args ? `${label} ${args}` : label;
}

/**
 * Trailing status for a finished tool.
 *
 * Only states the user can act on survive here — a pending confirmation, a
 * timeout, a non-zero exit. Output size (line counts) is deliberately dropped:
 * it padded every successful line without telling the user anything.
 */
function compactResultHint(event: LocalAgentToolEvent) {
  const gate = readActionGate(event.metadata?.actionGate);
  if (gate) {
    const commandPayload = gate.kind === "handoff" ? readCommandActionGatePayload(gate.payload) : null;
    const command = commandPayload?.displayCommand ?? commandPayload?.command.join(" ") ?? "";
    const detail = command.trim() ? command : gate.title;
    return `${t("toolNeedsAction")}: ${clip(detail, 120)}`;
  }
  if (event.metadata?.timedOut) return t("toolTimedOut");

  const summary = event.summary;
  if (!summary) return "";
  const exitMatch = summary.match(/exit=(\d+)/);
  if (exitMatch && exitMatch[1] !== "0") return `${t("toolExitCode")} ${exitMatch[1]}`;
  return "";
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
  const label = formatActiveToolLabel({
    toolName,
    argumentsPreview: event.argumentsPreview || pending?.argumentsPreview,
  });

  if (event.type === "tool-error") {
    const message = clip(event.message ?? t("toolFailed"), 96);
    return formatToolTraceLine(`  ▸ ${label}  ✗ ${message}`, colorEnabled, "error");
  }

  const hint = compactResultHint(event);
  // Plain space, not " · ": the dot existed to separate the elapsed time from
  // the hint, and with timing gone it would dangle off the status marker.
  const suffix = hint ? ` ${hint}` : "";
  const failed = isFailedToolResult(event);
  const marker = failed ? "✗" : isNeedsActionToolResult(event) ? "!" : "✓";
  const accent = failed ? "error" : "none";
  return formatToolTraceLine(`  ▸ ${label}  ${marker}${suffix}`, colorEnabled, accent);
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
