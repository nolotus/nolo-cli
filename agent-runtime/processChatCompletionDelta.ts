/**
 * Shared chat.completions streaming delta handler.
 *
 * Both `openAiCompatibleProvider` and `platformChatProvider` stream the same
 * OpenAI `choices[].delta` shape. This module owns the one correct way to fold
 * a delta into a stream state: read the reasoning field (`reasoning_content`
 * for DeepSeek, `reasoning` for Ollama/Qwen3), accumulate tool calls, and run
 * inline `٬think` tags in `content` through the think parser.
 *
 * `onReasoningDelta` is optional: OpenAI-compatible (direct) paths omit it;
 * the platform proxy path passes it so desktop SSE can forward thinking
 * deltas. The two cannot drift because they now call the same function.
 */
import { flushThinkParser, processThinkChunk, type ThinkParseState } from "./thinkTagParser";
import {
  accumulateToolCallDelta,
  type AccumulatedToolCall,
} from "./toolCallAccumulator";

/** Mutable accumulator shared across delta chunks for one stream. */
export type ChatCompletionStreamState = {
  content: string;
  reasoning: string;
  usage?: Record<string, unknown>;
  accumulatedToolCalls: Record<number, AccumulatedToolCall>;
  thinkState: ThinkParseState;
  onTextDelta?: (chunk: string) => void;
  onReasoningDelta?: (chunk: string) => void;
};

/**
 * Fold one parsed SSE data object's `choices[0].delta` into `state`.
 * Returns true when a delta was processed, false when the object had no
 * usable delta (caller may use this to skip/continue).
 */
export function applyChatCompletionDelta(
  parsed: any,
  state: ChatCompletionStreamState,
): boolean {
  if (parsed?.usage && typeof parsed.usage === "object") {
    state.usage = parsed.usage;
  }

  const delta = parsed?.choices?.[0]?.delta;
  if (!delta || typeof delta !== "object") return false;

  // reasoning_content (DeepSeek) / reasoning (Ollama, Qwen3)
  const reasoningChunk =
    typeof delta.reasoning_content === "string"
      ? delta.reasoning_content
      : typeof delta.reasoning === "string"
        ? delta.reasoning
        : "";
  if (reasoningChunk) {
    state.reasoning += reasoningChunk;
    state.onReasoningDelta?.(reasoningChunk);
  }

  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
    accumulateToolCallDelta(state.accumulatedToolCalls, delta.tool_calls);
  }

  // Text delta: some models (MiniMax M3, etc.) inline ٬think blocks in content
  const textChunk = typeof delta.content === "string" ? delta.content : "";
  if (textChunk) {
    const parsedChunk = processThinkChunk(textChunk, state.thinkState);
    state.thinkState = parsedChunk.state;
    if (parsedChunk.content) {
      state.content += parsedChunk.content;
      state.onTextDelta?.(parsedChunk.content);
    }
    if (parsedChunk.reasoning) {
      state.reasoning += parsedChunk.reasoning;
      state.onReasoningDelta?.(parsedChunk.reasoning);
    }
  }

  return true;
}

/** Flush the think parser at end-of-stream, folding residual buffer into state. */
export function flushChatCompletionStream(state: ChatCompletionStreamState): void {
  const flushed = flushThinkParser(state.thinkState);
  state.thinkState = flushed.state;
  if (flushed.content) {
    state.content += flushed.content;
    state.onTextDelta?.(flushed.content);
  }
  if (flushed.reasoning) {
    state.reasoning += flushed.reasoning;
    state.onReasoningDelta?.(flushed.reasoning);
  }
}