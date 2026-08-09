import type { LocalAgentToolEvent } from "../agent-runtime/localLoop";
import { createRenderAwareStreamWriter, formatAssistantDisplay } from "./assistantOutput";
import {
  createThinkingAwareStreamFilter,
  createThinkingEventSink,
  formatAssistantTextForCli,
  resolveThinkingDisplayMode,
} from "./thinkingOutput";
import {
  createToolEventFormatter,
  formatActiveToolLabel,
  resolveToolDisplayMode,
  shouldEmitToolEvents,
} from "./toolOutput";
import {
  isAgentNameFallback,
  resolveRunLabel,
} from "../ai/tools/agent/agentRunDisplayHelpers";
import { Spinner } from "./agentRunSpinner";
import type { RunAgentTurnOptions } from "./agentRunTypes";

export interface CliTurnOutputOptions {
  options: RunAgentTurnOptions;
  workingLabel?: string;
  spinner?: Spinner;
}

export function formatAssistantResponseForCli(
  text: string,
  options: RunAgentTurnOptions,
) {
  const thinkingMode = resolveThinkingDisplayMode(options.env);
  return formatAssistantDisplay(
    formatAssistantTextForCli(text, thinkingMode),
  );
}

export function resolveAgentEventMode(options: RunAgentTurnOptions): "text" | "jsonl" {
  if (options.eventsMode === "jsonl") return "jsonl";
  return options.env.NOLO_AGENT_EVENTS === "jsonl" ? "jsonl" : "text";
}

function formatToolJsonEvent(event: LocalAgentToolEvent) {
  return `${JSON.stringify({
    schemaVersion: 1,
    type: event.type,
    round: event.round + 1,
    tool: event.toolName,
    toolCallId: event.toolCallId,
    ...(event.argumentsPreview ? { argsPreview: event.argumentsPreview } : {}),
    ...(typeof event.elapsedMs === "number"
      ? { elapsedMs: event.elapsedMs }
      : {}),
    ...(event.summary ? { summary: event.summary } : {}),
    ...(event.message ? { message: event.message } : {}),
    ...(event.metadata ? { metadata: event.metadata } : {}),
  })}\n`;
}

/**
 * CLI turn output coordinator: owns the spinner, streaming text writer,
 * thinking sink, and tool-event formatter for one agent turn. Both the local
 * runtime path and the HTTP/SSE path share this so chrome behavior stays
 * consistent.
 */
export function createCliTurnOutput(params: CliTurnOutputOptions) {
  const { options } = params;
  const workingLabel = params.workingLabel ?? `${options.agentName} -> working`;
  const spinner =
    params.spinner ??
    new Spinner(options.output, workingLabel, Boolean(options.activityReporter));

  const toolDisplayMode = resolveToolDisplayMode(options.env);
  const traceLocalTools = shouldEmitToolEvents(toolDisplayMode);
  const formatToolEvent = createToolEventFormatter(toolDisplayMode);
  const eventMode = resolveAgentEventMode(options);

  let streamedAssistantText = false;
  let everStreamedAnyText = false;
  let printedAssistantLabel = false;

  const thinkingMode = resolveThinkingDisplayMode(options.env);
  const renderWriter = createRenderAwareStreamWriter({
    write: (chunk) => options.output.write(chunk),
  });

  const writeVisibleAssistantChunk = (chunk: string) => {
    if (!chunk) return;
    spinner.stop();
    options.activityReporter?.(null);
    if (!printedAssistantLabel) {
      options.output.write(`\n${options.agentName} > `);
      printedAssistantLabel = true;
    }
    streamedAssistantText = true;
    everStreamedAnyText = true;
    renderWriter.push(chunk);
  };

  const thinkingFilter = createThinkingAwareStreamFilter(
    writeVisibleAssistantChunk,
    thinkingMode,
  );

  const thinkingSink = createThinkingEventSink((chunk) => {
    spinner.stop();
    options.activityReporter?.(null);
    options.output.write(chunk);
  }, thinkingMode);

  const handleToolEvent = (event: LocalAgentToolEvent) => {
    if (!traceLocalTools) return;

    const chunk =
      eventMode === "jsonl"
        ? formatToolJsonEvent(event)
        : formatToolEvent(event);

    if (eventMode === "jsonl") {
      options.output.write(chunk);
      return;
    }

    // A tool-call interrupts assistant text streaming. Flush any buffered
    // thinking/render text so it appears before the tool chrome. This must
    // happen before we stop the spinner for the tool chunk, because
    // writeVisibleAssistantChunk (called by the flush) manages its own
    // spinner stop + label writing. Tool-result events don't interrupt
    // text (it was already flushed by the preceding tool-call).
    if (event.type === "tool-call") {
      thinkingFilter.flush();
      renderWriter.flush();
    }

    // ── Stop spinner before writing tool content ───────────────────
    // The spinner's \r clear must hit the spinner's own line, not a line
    // we are about to emit. The old code placed `spinner.stop()` after
    // `if (!chunk) return`, so buffered-class tool-results (chunk="")
    // returned early and left the `· Read xxx (0s)` frame permanently in
    // the transcript. Stopping unconditionally here also makes stop() a
    // no-op when no spinner is active (see agentRunSpinner.ts).
    spinner.stop();
    options.activityReporter?.(null);

    // Mid-stream tool-calls interrupt assistant text. Break onto a new
    // line when assistant text was just flushed in this same event
    // (streamedAssistantText is set by writeVisibleAssistantChunk via
    // thinkingFilter.flush, and reset right after the newline). This
    // ensures exactly ONE separator between a text segment and the first
    // tool that follows it. Subsequent buffered tool-calls (chunk="")
    // do not re-trigger the newline because streamedAssistantText is
    // already false — that was the source of the ~19 stray blank lines.
    // Note: `printedAssistantLabel` is intentionally excluded: it stays
    // true for the entire turn and would re-trigger "\n" on every call.
    if (event.type === "tool-call" && streamedAssistantText) {
      options.output.write("\n");
      streamedAssistantText = false;
    }

    // Write tree / compact content. For buffered tools (read/search/run/
    // fetch) the formatter accumulates internally and returns ""; the tree
    // is flushed later when a non-buffered tool arrives or at finish().
    if (chunk) {
      options.output.write(chunk);
    }

    // ── Post-write: start spinner for in-flight tool-calls ──────────
    if (
      toolDisplayMode === "compact" &&
      event.type === "tool-call"
    ) {
      const activeLabel = formatActiveToolLabel(event);
      spinner.show(activeLabel);
      options.activityReporter?.(activeLabel);
    }

    if (
      event.type === "tool-result" &&
      options.onAgentRunStatus &&
      event.toolName === "startAgentRun"
    ) {
      const snapshot = extractAgentRunStatusSnapshot(event);
      if (snapshot) {
        options.onAgentRunStatus(snapshot);
      }
    }
  };

  return {
    spinner,
    thinkingMode,
    toolDisplayMode,
    traceLocalTools,
    eventMode,
    pushText(chunk: string) {
      // Buffered-class tools (read/search/run/fetch/webSearch) accumulate
      // their tree inside formatToolEvent and only flush when a non-buffered
      // tool arrives or at finish(). Without this, a turn that is all
      // read/search calls streams all text first and the tool tree pops in
      // at the very end. Flush the pending tree before each text delta so
      // tools and text stay interleaved in natural order.
      if (eventMode !== "jsonl" && formatToolEvent.flush) {
        const pendingToolOutput = formatToolEvent.flush();
        if (pendingToolOutput) {
          options.output.write(pendingToolOutput);
        }
      }
      thinkingFilter.push(chunk);
    },
    pushThinking(chunk: string) {
      thinkingSink.push(chunk);
    },
    handleToolEvent,
    showWorking(label?: string) {
      const activeLabel = label ?? workingLabel;
      spinner.show(activeLabel);
      options.activityReporter?.(activeLabel);
    },
    finish(fallbackContent?: string) {
      spinner.stop();
      options.activityReporter?.(null);
      const pendingToolOutput = formatToolEvent.flush ? formatToolEvent.flush() : "";
      if (pendingToolOutput) {
        options.output.write(pendingToolOutput);
      }
      if (streamedAssistantText) {
        thinkingFilter.flush();
        renderWriter.flush();
        options.output.write("\n");
      } else if (everStreamedAnyText) {
        // Text was streamed earlier but reset by a tool-call event; the last
        // segment (if any) was already flushed. Don't re-render the full
        // result.content — that would duplicate the streamed output.
        thinkingFilter.flush();
        options.output.write("\n");
      } else {
        const content = fallbackContent
          ? formatAssistantResponseForCli(fallbackContent.trim(), options)
          : "";
        if (content) {
          options.output.write(`\n${options.agentName} > ${content}\n`);
        } else {
          options.output.write(`\n${options.agentName} > (no text response)\n`);
        }
      }
    },
  };
}

function extractAgentRunStatusSnapshot(
  event: LocalAgentToolEvent
): import("../tui/activityIndicator").AgentRunStatusSnapshot | null {
  if (event.type !== "tool-result") return null;
  const content = typeof event.content === "string" ? event.content.trim() : "";
  if (!content.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const runId = typeof parsed.runId === "string" ? parsed.runId : "";
    const status = typeof parsed.status === "string" ? parsed.status : "running";
    // Same fallback chain as the run cards, minus runId: the panel already
    // renders a runId suffix, so resolving to one here would print it twice.
    // Undefined is kept as the "nothing to show" signal — the panel supplies
    // its own default ("sub-agent"), which deliberately differs from the
    // cards' literal.
    const label = resolveRunLabel({
      agentName: parsed.agentName,
      name: parsed.name,
      agentKey: parsed.agentKey,
    });
    const agentName = isAgentNameFallback(label) ? undefined : label;
    const logTail = typeof parsed.logTail === "string" ? parsed.logTail : undefined;
    const logLines = Array.isArray(parsed.logLines) ? (parsed.logLines as string[]) : undefined;
    const errorMessage = typeof parsed.errorMessage === "string" ? parsed.errorMessage : undefined;
    return {
      runId,
      agentName,
      status,
      logTail,
      logLines,
      errorMessage,
    };
  } catch {
    return null;
  }
}