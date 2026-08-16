import type {
  AgentRuntimeChatMessage,
  AgentRuntimeResult,
} from "./types";
import {
  requiresBareImageUrl,
  toBareImageUrlMessages,
} from "../core/chat/bareImageUrlShape";
import { providerHttpFailure } from "../core/chat/providerFailureMessage";
import {
  shouldStripReasoningContentForOutbound,
  toOpenAiCompatibleMessages,
} from "./openAiCompatibleMessages";
import { buildProviderAuthHeaders } from "./providerResolution";
import { kimiIdentityHeaders } from "./kimiUserAgent";
import { parseSseDataLineJson } from "./sseDataLine";
import { readSseFrames } from "./sseFrames";
import { extractThinkContent, createThinkParserState } from "./thinkTagParser";
import { createToolCallTextParserState } from "./toolCallTextParser";
import {
  applyChatCompletionDelta,
  flushChatCompletionStream,
  throwIfChatCompletionStreamFailed,
  type ChatCompletionStreamState,
} from "./processChatCompletionDelta";
import {
  createToolCallAccumulator,
  finalizeAccumulatedToolCalls,
} from "./toolCallAccumulator";
import { sanitizeForOutbound } from "./outboundHistorySanitize";

export type OpenAiCompatibleProviderConfig = {
  model: string;
  endpoint: string;
  apiKey: string;
  apiKeyHeader?: string;
  provider: string;
  requestOptions: Record<string, number | string>;
};

type OpenAiCompatibleTool = Record<string, unknown>;

export function buildOpenAiCompatibleChatCompletionRequest(args: {
  providerConfig: OpenAiCompatibleProviderConfig;
  messages: AgentRuntimeChatMessage[];
  tools?: OpenAiCompatibleTool[];
  stream?: boolean;
}) {
  const shouldStripReasoning = shouldStripReasoningContentForOutbound(
    args.providerConfig.provider,
    args.providerConfig.model,
  );
  // Sanitize cross-wire history here so this builder is the single seam — any
  // caller (internal `send` or a future direct importer) is covered without
  // remembering to sanitize separately. Downgrades tool_calls not in the
  // current `tools` array to text and pairs tool_calls with results, so strict
  // gateways (ollama) accept the replayed history instead of 400-ing.
  const sanitizedMessages = sanitizeForOutbound(args.messages, args.tools);
  const messages = toOpenAiCompatibleMessages(sanitizedMessages, {
    stripReasoningContent: shouldStripReasoning,
  });
  const body = {
    model: args.providerConfig.model,
    messages: requiresBareImageUrl({
      endpoint: args.providerConfig.endpoint,
      provider: args.providerConfig.provider,
      model: args.providerConfig.model,
    })
      ? toBareImageUrlMessages(messages)
      : messages,
    stream: args.stream ?? false,
    ...args.providerConfig.requestOptions,
    ...(args.tools && args.tools.length > 0 ? { tools: args.tools } : {}),
    ...(args.stream ? { stream_options: { include_usage: true } } : {}),
  };

  const endpoint = args.providerConfig.endpoint;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...buildProviderAuthHeaders({
      endpoint,
      apiKey: args.providerConfig.apiKey,
      apiKeyHeader: args.providerConfig.apiKeyHeader,
    }),
    ...kimiIdentityHeaders(endpoint),
  };

  return {
    url: endpoint,
    init: {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
  };
}

export function parseOpenAiCompatibleChatCompletionResponse(args: {
  providerConfig: OpenAiCompatibleProviderConfig;
  data: any;
  trace: AgentRuntimeChatMessage[];
}): AgentRuntimeResult {
  const choiceMessage = args.data?.choices?.[0]?.message ?? {};
  const rawContent = String(choiceMessage?.content ?? "");
  const { content, reasoning } = extractThinkContent(rawContent);
  const rawFinishReason = args.data?.choices?.[0]?.finish_reason;
  return {
    content,
    model: args.providerConfig.model,
    provider: args.providerConfig.provider,
    ...(Array.isArray(choiceMessage?.tool_calls) ? { tool_calls: choiceMessage.tool_calls } : {}),
    ...(reasoning ? { reasoning_content: reasoning } : {}),
    ...(typeof choiceMessage?.reasoning_content === "string" && choiceMessage.reasoning_content
      ? { reasoning_content: choiceMessage.reasoning_content }
      : {}),
    ...(typeof rawFinishReason === "string" && rawFinishReason.length > 0
      ? { finish_reason: rawFinishReason }
      : {}),
    // 非流式：拿到完整的 200 JSON body 本身就证明这次调用走完了，
    // 不必等 finish_reason（有从不发它的上游，见 AgentRuntimeResult）。
    stream_complete: true,
    usage: args.data?.usage,
    trace: args.trace,
  };
}

function processOpenAiCompatibleSseEvent(
  event: string,
  state: ChatCompletionStreamState,
) {
  for (const line of event.split("\n")) {
    const parsed = parseSseDataLineJson(line) as any;
    if (parsed == null) continue;
    applyChatCompletionDelta(parsed, state);
  }
}

export async function readOpenAiCompatibleSseCompletion(args: {
  response: Response;
  onTextDelta?: (chunk: string) => void;
  onReasoningDelta?: (chunk: string) => void;
}) {
  const state: ChatCompletionStreamState = {
    content: "",
    reasoning: "",
    usage: undefined,
    accumulatedToolCalls: createToolCallAccumulator(),
    thinkState: createThinkParserState(),
    toolCallTextState: createToolCallTextParserState(),
    onTextDelta: args.onTextDelta,
    onReasoningDelta: args.onReasoningDelta,
  };

  for await (const frame of readSseFrames(args.response)) {
    processOpenAiCompatibleSseEvent(frame, state);
  }

  flushChatCompletionStream(state);
  // 200 OK 的流体里带错误帧时必须抛，否则故障会伪装成空回答。
  throwIfChatCompletionStreamFailed(state);

  const tool_calls = finalizeAccumulatedToolCalls(state.accumulatedToolCalls);
  return {
    content: state.content,
    ...(state.reasoning ? { reasoning_content: state.reasoning } : {}),
    ...(tool_calls.length > 0 ? { tool_calls } : {}),
    ...(state.usage ? { usage: state.usage, stream_complete: true } : {}),
    ...(state.finishReason ? { finish_reason: state.finishReason } : {}),
  };
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function executeOpenAiCompatibleChatCompletion(args: {
  providerConfig: OpenAiCompatibleProviderConfig;
  messages: AgentRuntimeChatMessage[];
  tools?: OpenAiCompatibleTool[];
  fetchImpl: FetchLike;
  stream?: boolean;
  onTextDelta?: (chunk: string) => void;
  onReasoningDelta?: (chunk: string) => void;
  signal?: AbortSignal;
  /**
   * 每次请求前解析 bearer。OAuth provider 的 access token 可能短于
   * 一次工具循环的时长，不能复用 provider 创建时捕获的 token。
   * `force` 表示即便本地认为仍新鲜也重新换一次（401 重试路径）。
   * 返回 null 时回落到 providerConfig.apiKey。
   */
  resolveApiKey?: (opts: { force: boolean }) => Promise<string | null>;
}): Promise<AgentRuntimeResult> {
  const send = async (apiKey: string) => {
    const request = buildOpenAiCompatibleChatCompletionRequest({
      providerConfig:
        apiKey === args.providerConfig.apiKey
          ? args.providerConfig
          : { ...args.providerConfig, apiKey },
      messages: args.messages,
      tools: args.tools,
      stream: args.stream,
    });
    return args.fetchImpl(request.url, {
      ...request.init,
      ...(args.signal ? { signal: args.signal } : {}),
    });
  };

  let apiKey = args.providerConfig.apiKey;
  if (args.resolveApiKey) {
    apiKey = (await args.resolveApiKey({ force: false })) ?? apiKey;
  }
  let res = await send(apiKey);

  // token 可能在服务端被提前失效，或在本轮请求发出前刚好过期。强刷一次重试一次。
  if (res.status === 401 && args.resolveApiKey) {
    const refreshed = await args.resolveApiKey({ force: true });
    if (refreshed && refreshed !== apiKey) {
      await res.body?.cancel().catch(() => {});
      res = await send(refreshed);
    }
  }

  if (!res.ok) {
    throw providerHttpFailure({
      label: "local provider",
      status: res.status,
      raw: await res.text().catch(() => ""),
      messages: args.messages,
    });
  }

  const contentType = res.headers.get("content-type") ?? "";
  const isEventStream = contentType.includes("text/event-stream");

  if (isEventStream) {
    const streamed = await readOpenAiCompatibleSseCompletion({
      response: res,
      ...(args.onTextDelta ? { onTextDelta: args.onTextDelta } : {}),
      ...(args.onReasoningDelta ? { onReasoningDelta: args.onReasoningDelta } : {}),
    });
    return {
      content: streamed.content,
      model: args.providerConfig.model,
      provider: args.providerConfig.provider,
      ...(streamed.tool_calls ? { tool_calls: streamed.tool_calls } : {}),
      ...(streamed.reasoning_content ? { reasoning_content: streamed.reasoning_content } : {}),
      ...(streamed.usage ? { usage: streamed.usage } : {}),
      ...(streamed.stream_complete ? { stream_complete: true } : {}),
      ...(streamed.finish_reason ? { finish_reason: streamed.finish_reason } : {}),
      trace: args.messages,
    };
  }

  const raw = await res.text().catch(() => "");
  let data: any = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = {};
  }
  return parseOpenAiCompatibleChatCompletionResponse({
    providerConfig: args.providerConfig,
    data,
    trace: args.messages,
  });
}