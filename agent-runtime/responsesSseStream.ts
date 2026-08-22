import type { AgentRuntimeToolCall } from "./types";
import {
  applyResponsesToolEvent,
  createResponsesToolAccumulator,
  finalizeResponsesToolCalls,
} from "./responsesToolCallAccumulator";
import {
  extractReasoningFromResponseOutput,
  extractTextFromResponseOutput,
  extractToolCallsFromResponseOutput,
} from "../integrations/openai/responsesHelpers";
import { parseSseDataLineObject } from "./sseDataLine";
import { readSseFrames } from "./sseFrames";

export type ResponsesStreamFailure = {
  code?: string;
  type?: string;
  message: string;
};

export type CodexStreamFailure = ResponsesStreamFailure;

export function toResponsesStreamFailure(
  raw: unknown,
  fallbackPrefix: string = "Responses",
): ResponsesStreamFailure | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const err = raw as Record<string, unknown>;
  const reason = typeof err.reason === "string" ? err.reason : undefined;
  const message =
    typeof err.message === "string" && err.message
      ? err.message
      : reason
        ? `${fallbackPrefix} upstream ended incomplete: ${reason}.`
        : "";
  if (!message) return undefined;
  const code = typeof err.code === "string" ? err.code : reason;
  return {
    ...(code ? { code } : {}),
    ...(typeof err.type === "string" ? { type: err.type } : {}),
    message,
  };
}

export function responsesStreamFailureStatus(failure: ResponsesStreamFailure): number {
  const marker = `${failure.code ?? ""} ${failure.type ?? ""}`.toLowerCase();
  if (marker.includes("overload") || marker.includes("service_unavailable")) return 503;
  if (marker.includes("rate_limit") || marker.includes("usage_limit")) return 429;
  return 502;
}

export const codexStreamFailureStatus = responsesStreamFailureStatus;

export type ResponsesStreamAggregation = {
  content: string;
  reasoning_content?: string;
  tool_calls?: AgentRuntimeToolCall[];
  usage?: Record<string, unknown>;
  finish_reason?: string;
  stream_complete?: boolean;
  failure?: ResponsesStreamFailure;
};

export function createResponsesStreamCollector(callbacks?: {
  onTextDelta?: (chunk: string) => void;
  onReasoningDelta?: (chunk: string) => void;
  fallbackPrefix?: string;
}) {
  let content = "";
  let reasoning = "";
  const toolCallsAcc = createResponsesToolAccumulator();
  let usage: Record<string, unknown> | undefined;
  let failure: ResponsesStreamFailure | undefined;
  let completedResponse: Record<string, unknown> | undefined;

  const processEvent = (ev: Record<string, unknown>) => {
    const type = String(ev.type ?? "");
    if (type === "error") {
      failure = failure ?? toResponsesStreamFailure(ev.error, callbacks?.fallbackPrefix);
      return;
    }
    if (type === "response.failed" || type === "response.incomplete") {
      const response = ev.response as Record<string, unknown> | undefined;
      failure =
        failure ??
        toResponsesStreamFailure(response?.error, callbacks?.fallbackPrefix) ??
        toResponsesStreamFailure(response?.incomplete_details, callbacks?.fallbackPrefix) ?? {
          code: type === "response.incomplete" ? "response_incomplete" : "response_failed",
          message: `${callbacks?.fallbackPrefix ?? "Responses"} upstream ended with ${type}.`,
        };
      return;
    }
    if (type === "response.output_text.delta" && typeof ev.delta === "string") {
      content += ev.delta;
      callbacks?.onTextDelta?.(ev.delta);
      return;
    }
    if (
      (type === "response.reasoning_text.delta" || type === "response.reasoning.delta") &&
      typeof ev.delta === "string"
    ) {
      reasoning += ev.delta;
      callbacks?.onReasoningDelta?.(ev.delta);
      return;
    }
    if (
      type === "response.output_item.added" ||
      type === "response.output_item.done" ||
      type === "response.function_call_arguments.delta" ||
      type === "response.function_call_arguments.done"
    ) {
      applyResponsesToolEvent(toolCallsAcc, ev);
      return;
    }
    if (type === "response.completed") {
      const response = ev.response as Record<string, unknown> | undefined;
      if (response) {
        completedResponse = response;
        const u = response.usage as Record<string, unknown> | undefined;
        if (u) {
          const prompt = typeof u.input_tokens === "number" ? u.input_tokens : (typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0);
          const completion = typeof u.output_tokens === "number" ? u.output_tokens : (typeof u.completion_tokens === "number" ? u.completion_tokens : 0);
          const total =
            typeof u.total_tokens === "number" ? u.total_tokens : prompt + completion;
          usage = {
            prompt_tokens: prompt,
            completion_tokens: completion,
            total_tokens: total,
          };
        }
      }
    }
  };

  const finalize = (): ResponsesStreamAggregation => {
    let finalToolCalls = finalizeResponsesToolCalls(toolCallsAcc);
    if (finalToolCalls.length === 0 && completedResponse) {
      finalToolCalls = extractToolCallsFromResponseOutput(completedResponse) as AgentRuntimeToolCall[];
    }
    if (!content && completedResponse) {
      content = extractTextFromResponseOutput(completedResponse);
    }
    if (!reasoning && completedResponse) {
      reasoning = extractReasoningFromResponseOutput(completedResponse);
    }

    return {
      content,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      ...(finalToolCalls.length > 0 ? { tool_calls: finalToolCalls } : {}),
      ...(usage ? { usage } : {}),
      finish_reason: finalToolCalls.length > 0 ? "tool_calls" : "stop",
      stream_complete: true,
      ...(failure ? { failure } : {}),
    };
  };

  return {
    processEvent,
    finalize,
  };
}

export function aggregateResponsesStream(
  events: Record<string, unknown>[],
  options?: { fallbackPrefix?: string },
) {
  const collector = createResponsesStreamCollector({ fallbackPrefix: options?.fallbackPrefix ?? "Codex" });
  for (const ev of events) {
    collector.processEvent(ev);
  }
  const finalized = collector.finalize();
  return {
    text: finalized.content,
    toolCalls: finalized.tool_calls ?? [],
    usage: finalized.usage,
    failure: finalized.failure,
  };
}

export async function readResponsesSseCompletion(args: {
  response: Response;
  onTextDelta?: (chunk: string) => void;
  onReasoningDelta?: (chunk: string) => void;
  fallbackPrefix?: string;
}): Promise<ResponsesStreamAggregation> {
  const collector = createResponsesStreamCollector({
    onTextDelta: args.onTextDelta,
    onReasoningDelta: args.onReasoningDelta,
    fallbackPrefix: args.fallbackPrefix ?? "Responses",
  });

  for await (const frame of readSseFrames(args.response)) {
    for (const line of frame.split("\n")) {
      const parsed = parseSseDataLineObject(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        collector.processEvent(parsed as Record<string, unknown>);
      }
    }
  }

  const result = collector.finalize();
  if (result.failure) {
    const status = responsesStreamFailureStatus(result.failure);
    const err = new Error(result.failure.message) as any;
    err.status = status;
    err.code = result.failure.code;
    err.type = result.failure.type;
    throw err;
  }

  return result;
}
