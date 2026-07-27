import type { LocalAgentToolEvent } from "../../agent-runtime/localLoop";
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
    if (event.type === "tool-call") {
      thinkingFilter.flush();
      renderWriter.flush();
      if (streamedAssistantText) {
        options.output.write("\n");
        streamedAssistantText = false;
      }
    }

    const chunk =
      eventMode === "jsonl"
        ? formatToolJsonEvent(event)
        : formatToolEvent(event);

    if (
      eventMode !== "jsonl" &&
      toolDisplayMode === "compact" &&
      event.type === "tool-call"
    ) {
      const activeLabel = formatActiveToolLabel(event);
      spinner.show(activeLabel);
      options.activityReporter?.(activeLabel);
      return;
    }

    if (!chunk) return;
    spinner.stop();
    options.activityReporter?.(null);
    options.output.write(chunk);
    if (event.type === "tool-call") {
      const activeLabel = formatActiveToolLabel(event);
      spinner.show(activeLabel);
      options.activityReporter?.(activeLabel);
    }
  };

  return {
    spinner,
    thinkingMode,
    toolDisplayMode,
    traceLocalTools,
    eventMode,
    pushText(chunk: string) {
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