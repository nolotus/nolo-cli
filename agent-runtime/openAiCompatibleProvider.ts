import type {
  AgentRuntimeChatMessage,
  AgentRuntimeResult,
} from "./types";
import { buildProviderAuthHeaders } from "./providerResolution";

export type OpenAiCompatibleProviderConfig = {
  model: string;
  endpoint: string;
  apiKey: string;
  apiKeyHeader?: string;
  provider: string;
  requestOptions: Record<string, number | string>;
};

type OpenAiCompatibleTool = Record<string, unknown>;

type AccumulatedToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

function toOpenAiCompatibleMessages(messages: AgentRuntimeChatMessage[]) {
  return messages.map((message) => ({
    role: message.role,
    content: message.content ?? "",
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls } : {}),
    ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
  }));
}

export function buildOpenAiCompatibleChatCompletionRequest(args: {
  providerConfig: OpenAiCompatibleProviderConfig;
  messages: AgentRuntimeChatMessage[];
  tools?: OpenAiCompatibleTool[];
  stream?: boolean;
}) {
  const body = {
    model: args.providerConfig.model,
    messages: toOpenAiCompatibleMessages(args.messages),
    stream: args.stream ?? false,
    ...args.providerConfig.requestOptions,
    ...(args.tools && args.tools.length > 0 ? { tools: args.tools } : {}),
    ...(args.stream ? { stream_options: { include_usage: true } } : {}),
  };
  return {
    url: args.providerConfig.endpoint,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...buildProviderAuthHeaders({
          endpoint: args.providerConfig.endpoint,
          apiKey: args.providerConfig.apiKey,
          apiKeyHeader: args.providerConfig.apiKeyHeader,
        }),
      },
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
  return {
    content: String(choiceMessage?.content ?? ""),
    model: args.providerConfig.model,
    provider: args.providerConfig.provider,
    ...(Array.isArray(choiceMessage?.tool_calls) ? { tool_calls: choiceMessage.tool_calls } : {}),
    ...(typeof choiceMessage?.reasoning_content === "string" && choiceMessage.reasoning_content
      ? { reasoning_content: choiceMessage.reasoning_content }
      : {}),
    usage: args.data?.usage,
    trace: args.trace,
  };
}

function accumulateToolCallDelta(
  accumulated: Record<number, AccumulatedToolCall>,
  deltas: Array<Record<string, unknown>>
) {
  for (const delta of deltas) {
    const index = typeof delta.index === "number" ? delta.index : 0;
    const current = accumulated[index] ?? {
      id: "",
      type: "function" as const,
      function: { name: "", arguments: "" },
    };
    if (typeof delta.id === "string" && delta.id) current.id = delta.id;
    const fn = delta.function;
    if (fn && typeof fn === "object") {
      const functionDelta = fn as { name?: string; arguments?: string };
      if (typeof functionDelta.name === "string" && functionDelta.name) {
        current.function.name += functionDelta.name;
      }
      if (typeof functionDelta.arguments === "string" && functionDelta.arguments) {
        current.function.arguments += functionDelta.arguments;
      }
    }
    accumulated[index] = current;
  }
}

function finalizeAccumulatedToolCalls(accumulated: Record<number, AccumulatedToolCall>) {
  return Object.keys(accumulated)
    .map((key) => accumulated[Number(key)])
    .filter((call) => call?.function?.name);
}

function processOpenAiCompatibleSseEvent(
  event: string,
  state: {
    content: string;
    reasoning: string;
    usage?: Record<string, unknown>;
    accumulatedToolCalls: Record<number, AccumulatedToolCall>;
    onTextDelta?: (chunk: string) => void;
  }
) {
  for (const line of event.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;

    let parsed: any;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }

    if (parsed?.usage && typeof parsed.usage === "object") {
      state.usage = parsed.usage;
    }

    const delta = parsed?.choices?.[0]?.delta;
    if (!delta || typeof delta !== "object") continue;

    const reasoningChunk =
      typeof delta.reasoning_content === "string"
        ? delta.reasoning_content
        : typeof delta.reasoning === "string"
          ? delta.reasoning
          : "";
    if (reasoningChunk) state.reasoning += reasoningChunk;

    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      accumulateToolCallDelta(state.accumulatedToolCalls, delta.tool_calls);
    }

    const textChunk = typeof delta.content === "string" ? delta.content : "";
    if (textChunk) {
      state.content += textChunk;
      state.onTextDelta?.(textChunk);
    }
  }
}

export async function readOpenAiCompatibleSseCompletion(args: {
  response: Response;
  onTextDelta?: (chunk: string) => void;
}) {
  const reader = args.response.body?.getReader();
  if (!reader) {
    throw new Error("OpenAI-compatible stream response did not include a readable body.");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  const state = {
    content: "",
    reasoning: "",
    usage: undefined as Record<string, unknown> | undefined,
    accumulatedToolCalls: {} as Record<number, AccumulatedToolCall>,
    onTextDelta: args.onTextDelta,
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary === -1) break;
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      processOpenAiCompatibleSseEvent(event, state);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    processOpenAiCompatibleSseEvent(buffer, state);
  }

  const tool_calls = finalizeAccumulatedToolCalls(state.accumulatedToolCalls);
  return {
    content: state.content,
    ...(state.reasoning ? { reasoning_content: state.reasoning } : {}),
    ...(tool_calls.length > 0 ? { tool_calls } : {}),
    ...(state.usage ? { usage: state.usage } : {}),
  };
}

export async function executeOpenAiCompatibleChatCompletion(args: {
  providerConfig: OpenAiCompatibleProviderConfig;
  messages: AgentRuntimeChatMessage[];
  tools?: OpenAiCompatibleTool[];
  fetchImpl: typeof fetch;
  stream?: boolean;
  onTextDelta?: (chunk: string) => void;
  signal?: AbortSignal;
}): Promise<AgentRuntimeResult> {
  const request = buildOpenAiCompatibleChatCompletionRequest({
    providerConfig: args.providerConfig,
    messages: args.messages,
    tools: args.tools,
    stream: args.stream,
  });
  const res = await args.fetchImpl(request.url, {
    ...request.init,
    ...(args.signal ? { signal: args.signal } : {}),
  });

  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    let data: unknown = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      // keep raw text
    }
    throw new Error(`local provider failed: HTTP ${res.status} ${JSON.stringify(data)}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  const shouldStream =
    Boolean(args.stream && args.onTextDelta) &&
    contentType.includes("text/event-stream");

  if (shouldStream && args.onTextDelta) {
    const streamed = await readOpenAiCompatibleSseCompletion({
      response: res,
      onTextDelta: args.onTextDelta,
    });
    return {
      content: streamed.content,
      model: args.providerConfig.model,
      provider: args.providerConfig.provider,
      ...(streamed.tool_calls ? { tool_calls: streamed.tool_calls } : {}),
      ...(streamed.reasoning_content ? { reasoning_content: streamed.reasoning_content } : {}),
      ...(streamed.usage ? { usage: streamed.usage } : {}),
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