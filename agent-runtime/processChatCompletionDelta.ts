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

/** In-band stream failure carried by an SSE frame instead of an HTTP status. */
export type ChatCompletionStreamError = { message: string; code?: string };

/** Mutable accumulator shared across delta chunks for one stream. */
export type ChatCompletionStreamState = {
  content: string;
  reasoning: string;
  usage?: Record<string, unknown>;
  /** 最后一轮 provider 报告的收尾原因；非空才覆盖，避免被中间 chunk 的 null 冲掉。 */
  finishReason?: string;
  /**
   * 流内错误帧。首个非空错误胜出——后续帧不覆盖，保留最先发生的真实原因。
   * 由读流函数在收尾时抛出，见 `throwIfChatCompletionStreamFailed`。
   */
  streamError?: ChatCompletionStreamError;
  accumulatedToolCalls: Record<number, AccumulatedToolCall>;
  thinkState: ThinkParseState;
  onTextDelta?: (chunk: string) => void;
  onReasoningDelta?: (chunk: string) => void;
};

/**
 * 从一个已解析的 SSE data 对象里提取错误帧。
 *
 * 三种线格式都要认，它们只在 200 OK 的流体里出现，HTTP 状态码看不到：
 *   - nolo chat 代理：`{"error":{"msg":"服务器紧张","code":"PLATFORM_LLM_BUSY"}}`
 *     （代理的 idle guard 也用这个形状发 `code:"IDLE"`）
 *   - OpenAI / Ollama 兼容上游：`{"error":{"message":"...","type":"..."}}`
 *   - 少数上游只发字符串：`{"error":"..."}`
 */
export function extractChatCompletionStreamError(
  parsed: any,
): ChatCompletionStreamError | null {
  const raw = parsed?.error;
  if (!raw) return null;
  if (typeof raw === "string") {
    return raw.trim() ? { message: raw.trim() } : null;
  }
  if (typeof raw !== "object") return null;
  const message =
    typeof raw.msg === "string" && raw.msg.trim()
      ? raw.msg.trim()
      : typeof raw.message === "string" && raw.message.trim()
        ? raw.message.trim()
        : "";
  const code =
    typeof raw.code === "string" && raw.code.trim()
      ? raw.code.trim()
      : typeof raw.type === "string" && raw.type.trim()
        ? raw.type.trim()
        : undefined;
  if (!message && !code) return null;
  return {
    message: message || "upstream stream error",
    ...(code ? { code } : {}),
  };
}

/**
 * 读流收尾时调用：流内出现过错误帧就抛出，让失败以异常形式浮到调用方。
 *
 * 不这么做的话，代理把上游故障编码成 HTTP 200 + 一个错误帧，读流函数会返回
 * `content: ""`，整条链路把故障伪装成「模型返回空内容」——既不重试、不 fallback、
 * 退出码还是 0，而那条空轮次会被当成正常回答写进对话历史。
 *
 * 已经流出过内容时同样抛：半截回答重试一次，好过把截断当完整答案落库。
 */
export function throwIfChatCompletionStreamFailed(
  state: Pick<ChatCompletionStreamState, "streamError">,
): void {
  const failure = state.streamError;
  if (!failure) return;
  const error = new Error(
    failure.code
      ? `${failure.message} (${failure.code})`
      : failure.message,
  ) as Error & { code?: string };
  if (failure.code) error.code = failure.code;
  throw error;
}

/**
 * Fold one parsed SSE data object's `choices[0].delta` into `state`.
 * Returns true when a delta was processed, false when the object had no
 * usable delta (caller may use this to skip/continue).
 */
export function applyChatCompletionDelta(
  parsed: any,
  state: ChatCompletionStreamState,
): boolean {
  // 错误帧优先于 delta 判定：它没有 choices，走到下面会被当成「无可用 delta」
  // 静默丢弃，故障就此消失。首个错误胜出，保留最先发生的原因。
  const streamError = extractChatCompletionStreamError(parsed);
  if (streamError && !state.streamError) {
    state.streamError = streamError;
  }

  if (parsed?.usage && typeof parsed.usage === "object") {
    state.usage = parsed.usage;
  }

  // finish_reason 通常只在最后一个 chunk 非空；非空才覆盖，前面的 null 不冲掉。
  const rawFinishReason = parsed?.choices?.[0]?.finish_reason;
  if (typeof rawFinishReason === "string" && rawFinishReason.length > 0) {
    state.finishReason = rawFinishReason;
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