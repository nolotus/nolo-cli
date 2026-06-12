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
}) {
  const body = {
    model: args.providerConfig.model,
    messages: toOpenAiCompatibleMessages(args.messages),
    stream: false,
    ...args.providerConfig.requestOptions,
    ...(args.tools && args.tools.length > 0 ? { tools: args.tools } : {}),
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
