import type { AgentRuntimeAgentConfig } from "./hostAdapter";
import type { CredentialBroker } from "./credentialBroker";
import type {
  AgentRuntimeChatMessage,
  AgentRuntimeResult,
} from "./types";
import {
  shouldStripReasoningContentForOutbound,
  toOpenAiCompatibleMessages,
} from "./openAiCompatibleMessages";
import {
  convertMessagesToResponsesInput,
  extractTextFromResponseOutput,
  extractToolCallsFromResponseOutput,
  toResponsesTools,
} from "../integrations/openai/responsesHelpers";
import { providerHttpFailure } from "../core/chat/providerFailureMessage";
import { normalizeServerOrigin } from "../core/serverOrigin";
import { asNonEmptyStringArray } from "../core/stringArray";
import {
  buildProviderExecutionPlan,
  canUsePlatformChatProvider as canUsePlatformChatProviderFromEnv,
  hasDirectOpenAiCompatibleProvider as hasDirectOpenAiCompatibleProviderFromEnv,
  resolveAgentRuntimeLocation,
  resolvePlatformAuthToken,
  resolvePlatformServerUrl,
  resolveProviderTransportDecision,
  type ApiKeyRefResolver,
} from "./providerResolution";
import {
  createThinkParserState,
  extractThinkContent,
} from "./thinkTagParser";
import type { ThinkParseState } from "./thinkTagParser";
import {
  applyChatCompletionDelta,
  extractChatCompletionStreamError,
  flushChatCompletionStream,
  throwIfChatCompletionStreamFailed,
  type ChatCompletionStreamError,
  type ChatCompletionStreamState,
} from "./processChatCompletionDelta";
import { readSseFrames } from "./sseFrames";
import {
  createToolCallAccumulator,
  finalizeAccumulatedToolCalls,
} from "./toolCallAccumulator";
// resolvePlatformChatCompletionsEndpoint no longer needed —
// DeepSeek legacy fallback retired with the official provider.

type EnvLike = Record<string, string | undefined>;

const CHAT_PROXY_PATH = "/api/v1/chat";

export type PlatformChatProviderConfig = {
  serverUrl: string;
  authToken: string;
  agentKey: string;
  model: string;
  provider: string;
  endpoint: string;
  requestOptions: Record<string, number | string>;
  apiKey?: string;
  apiKeyHeader?: string;
  apiSource?: string;
};

type PlatformChatTool = Record<string, unknown>;

function shouldDisableThinking(providerConfig: PlatformChatProviderConfig) {
  return (
    providerConfig.provider.toLowerCase() === "mimo" ||
    /xiaomimimo\.com/i.test(providerConfig.endpoint)
  );
}

function isResponsesEndpoint(endpoint: string) {
  return /\/responses$/i.test(endpoint.trim());
}

function toResponsesRequestOptions(options: Record<string, number | string>) {
  const next: Record<string, number | string> = { ...options };
  const reasoningEffort = next.reasoning_effort;
  if (typeof reasoningEffort === "string" && reasoningEffort) {
    (next as Record<string, any>).reasoning = { effort: reasoningEffort };
    delete next.reasoning_effort;
  }
  if (next.max_tokens !== undefined) {
    next.max_output_tokens = next.max_tokens;
    delete next.max_tokens;
  }
  return next;
}

export async function resolvePlatformChatProviderConfig(args: {
  agentConfig: AgentRuntimeAgentConfig;
  env: EnvLike;
  apiKeyRefResolver?: ApiKeyRefResolver;
  /** Local-first OS credential broker (API keys). Prefer over raw agent.apiKey. */
  credentialBroker?: CredentialBroker;
  syncFetcher?: (credentialRef: string) => Promise<string | null>;
}): Promise<PlatformChatProviderConfig> {
  const plan = await buildProviderExecutionPlan({
    agentConfig: args.agentConfig,
    env: args.env,
    runtimeKind: "local",
    ...(args.apiKeyRefResolver ? { apiKeyRefResolver: args.apiKeyRefResolver } : {}),
    ...(args.credentialBroker ? { credentialBroker: args.credentialBroker } : {}),
    ...(args.syncFetcher ? { syncFetcher: args.syncFetcher } : {}),
  });
  if (plan.mode === "cli") {
    throw new Error("Platform chat provider does not support cli agents.");
  }
  if (plan.transport === "direct") {
    return {
      serverUrl: resolvePlatformServerUrl(args.env),
      authToken: resolvePlatformAuthToken(args.env),
      agentKey: args.agentConfig.key,
      model: plan.model,
      provider: plan.provider,
      endpoint: plan.endpoint,
      requestOptions: plan.requestOptions,
      ...(plan.apiKey ? { apiKey: plan.apiKey } : {}),
      ...(plan.apiKeyHeader ? { apiKeyHeader: plan.apiKeyHeader } : {}),
      ...(args.agentConfig.apiSource ? { apiSource: args.agentConfig.apiSource } : {}),
    };
  }
  return {
    serverUrl: plan.serverUrl,
    authToken: plan.authToken,
    agentKey: plan.agentKey,
    model: plan.model,
    provider: plan.provider,
    endpoint: plan.endpoint,
    requestOptions: plan.requestOptions,
    ...(plan.apiKey ? { apiKey: plan.apiKey } : {}),
    ...(plan.apiKeyHeader ? { apiKeyHeader: plan.apiKeyHeader } : {}),
    ...(plan.apiSource ? { apiSource: plan.apiSource } : {}),
  };
}

export function buildPlatformChatCompletionRequest(args: {
  providerConfig: PlatformChatProviderConfig;
  messages: AgentRuntimeChatMessage[];
  tools?: PlatformChatTool[];
  stream?: boolean;
}) {
  const usesResponsesApi = isResponsesEndpoint(args.providerConfig.endpoint);
  const requestOptions = usesResponsesApi
    ? toResponsesRequestOptions(args.providerConfig.requestOptions)
    : args.providerConfig.requestOptions;
  const shouldStripReasoning = shouldStripReasoningContentForOutbound(
    args.providerConfig.provider,
    args.providerConfig.model,
  );
  const body = {
    model: args.providerConfig.model,
    ...(usesResponsesApi
      ? {
          input: convertMessagesToResponsesInput(args.messages as any, {
            stripReasoningContent: shouldStripReasoning,
          }),
        }
      : {
          messages: toOpenAiCompatibleMessages(args.messages, {
            stripReasoningContent: shouldStripReasoning,
          }),
        }),
    stream: args.stream ?? false,
    ...(args.stream ? { stream_options: { include_usage: true } } : {}),
    ...requestOptions,
    ...(args.tools && args.tools.length > 0
      ? {
          tools: usesResponsesApi ? toResponsesTools(args.tools as any) : args.tools,
          ...(usesResponsesApi ? {} : { tool_choice: "auto" }),
        }
      : {}),
    ...(shouldDisableThinking(args.providerConfig) ? { thinking: { type: "disabled" } } : {}),
    url: args.providerConfig.endpoint,
    provider: args.providerConfig.provider,
    agentKey: args.providerConfig.agentKey,
    ...(args.providerConfig.apiSource ? { apiSource: args.providerConfig.apiSource } : {}),
    ...(args.providerConfig.apiKey ? { KEY: args.providerConfig.apiKey } : {}),
    ...(args.providerConfig.apiKeyHeader ? { apiKeyHeader: args.providerConfig.apiKeyHeader } : {}),
  };

  return {
    url: `${args.providerConfig.serverUrl}${CHAT_PROXY_PATH}`,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${args.providerConfig.authToken}`,
      },
      body: JSON.stringify(body),
    },
  };
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function tryParseJson(raw: string) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractJsonObjects(raw: string) {
  const objects: any[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char !== "}" || depth === 0) continue;

    depth -= 1;
    if (depth === 0 && start >= 0) {
      const parsed = tryParseJson(raw.slice(start, index + 1));
      if (parsed) objects.push(parsed);
      start = -1;
    }
  }

  return objects;
}

export function parsePlatformChatCompletionData(raw: string) {
  const direct = tryParseJson(raw.trim());
  if (direct) return direct;

  const objects = extractJsonObjects(raw);
  return objects.find((object) => Array.isArray(object?.choices)) ?? objects[0] ?? {};
}

export function parsePlatformChatCompletionResponse(args: {
  providerConfig: PlatformChatProviderConfig;
  data: any;
  trace: AgentRuntimeChatMessage[];
}): AgentRuntimeResult {
  if (isResponsesEndpoint(args.providerConfig.endpoint)) {
    const content = extractTextFromResponseOutput(args.data);
    const tool_calls = extractToolCallsFromResponseOutput(args.data);
    return {
      content,
      model: args.providerConfig.model,
      provider: args.providerConfig.provider,
      ...(tool_calls.length > 0 ? { tool_calls } : {}),
      stream_complete: true,
      usage: args.data?.usage,
      trace: args.trace,
    };
  }

  const choiceMessage = args.data?.choices?.[0]?.message ?? {};
  const rawContent = String(choiceMessage?.content ?? "");
  const { content, reasoning } = extractThinkContent(rawContent);
  return {
    content,
    model: args.providerConfig.model,
    provider: args.providerConfig.provider,
    ...(Array.isArray(choiceMessage?.tool_calls) ? { tool_calls: choiceMessage.tool_calls } : {}),
    ...(reasoning
      ? { reasoning_content: reasoning }
      : typeof choiceMessage?.reasoning_content === "string" && choiceMessage.reasoning_content
        ? { reasoning_content: choiceMessage.reasoning_content }
        : {}),
    // 非流式：完整的 200 JSON body 即证明调用走完，见 AgentRuntimeResult。
    stream_complete: true,
    usage: args.data?.usage,
    trace: args.trace,
  };
}

/**
 * Parse one SSE event frame for the platform chat proxy stream.
 *
 * The Nolo chat proxy (`/api/v1/chat`) forwards the upstream SSE verbatim, so
 * the wire format depends on the configured endpoint:
 *   - chat.completions endpoints emit OpenAI-compatible `choices[].delta` chunks
 *     (same shape `readOpenAiCompatibleSseCompletion` already understands).
 *   - OpenAI Responses endpoints emit `response.output_text.delta` /
 *     `response.completed` events.
 */
function processPlatformChatSseEvent(
  event: string,
  state: ChatCompletionStreamState & {
    usesResponsesApi: boolean;
    completedResponsesPayload?: any;
  },
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

    if (!state.usesResponsesApi) {
      applyChatCompletionDelta(parsed, state);
      continue;
    }

    // Responses 分支不经过 applyChatCompletionDelta，错误帧要在这里单独收。
    // 代理的错误帧形状与端点无关：两条分支必须同样看得见它。
    if (!state.streamError) {
      const responsesError = extractChatCompletionStreamError(parsed);
      if (responsesError) state.streamError = responsesError;
    }

    // Responses API streaming events
    const eventType = typeof parsed?.type === "string" ? parsed.type : "";
    if (eventType === "response.output_text.delta" && typeof parsed?.delta === "string") {
      state.content += parsed.delta;
      state.onTextDelta?.(parsed.delta);
      continue;
    }
    if (
      eventType === "response.reasoning_text.delta" &&
      typeof parsed?.delta === "string"
    ) {
      state.reasoning += parsed.delta;
      state.onReasoningDelta?.(parsed.delta);
      continue;
    }
    if (eventType === "response.completed" && parsed?.response) {
      state.completedResponsesPayload = parsed.response;
      if (parsed.response.usage && typeof parsed.response.usage === "object") {
        state.usage = parsed.response.usage;
      }
    }
  }
}

export async function readPlatformChatSseCompletion(args: {
  response: Response;
  usesResponsesApi: boolean;
  onTextDelta?: (chunk: string) => void;
  onReasoningDelta?: (chunk: string) => void;
}) {
  const state = {
    content: "",
    reasoning: "",
    usage: undefined as Record<string, unknown> | undefined,
    usesResponsesApi: args.usesResponsesApi,
    onTextDelta: args.onTextDelta,
    onReasoningDelta: args.onReasoningDelta,
    completedResponsesPayload: undefined as any,
    streamError: undefined as ChatCompletionStreamError | undefined,
    accumulatedToolCalls: createToolCallAccumulator(),
    thinkState: createThinkParserState(),
  };

  for await (const frame of readSseFrames(args.response)) {
    processPlatformChatSseEvent(frame, state);
  }

  // Flush any think-tag parser state held across chunk boundaries (mirrors
  // readOpenAiCompatibleSseCompletion). No-op for the Responses-API branch
  // since its events carry complete text deltas, not inline <think> tags.
  flushChatCompletionStream(state);
  // 代理把上游故障编成 HTTP 200 + 错误帧；不抛就会伪装成空回答落进对话历史。
  throwIfChatCompletionStreamFailed(state);

  if (state.usesResponsesApi && state.completedResponsesPayload) {
    const response = state.completedResponsesPayload;
    const tool_calls = extractToolCallsFromResponseOutput(response);
    const finalContent = extractTextFromResponseOutput(response);
    return {
      content: finalContent || state.content,
      ...(state.reasoning ? { reasoning_content: state.reasoning } : {}),
      ...(tool_calls.length > 0 ? { tool_calls } : {}),
      ...(state.usage ? { usage: state.usage, stream_complete: true } : {}),
    };
  }

  const tool_calls = finalizeAccumulatedToolCalls(state.accumulatedToolCalls);
  return {
    content: state.content,
    ...(state.reasoning ? { reasoning_content: state.reasoning } : {}),
    ...(tool_calls.length > 0 ? { tool_calls } : {}),
    ...(state.usage ? { usage: state.usage, stream_complete: true } : {}),
  };
}

/**
 * Execute a platform chat completion request, streaming text deltas when the
 * platform supports SSE and an `onTextDelta` callback is provided. Mirrors the
 * shape of `executeOpenAiCompatibleChatCompletion` so the desktop adapter can
 * treat both providers uniformly.
 */
export async function executePlatformChatCompletion(args: {
  providerConfig: PlatformChatProviderConfig;
  messages: AgentRuntimeChatMessage[];
  tools?: PlatformChatTool[];
  fetchImpl: FetchLike;
  stream?: boolean;
  onTextDelta?: (chunk: string) => void;
  onReasoningDelta?: (chunk: string) => void;
  signal?: AbortSignal;
  /**
   * 只约束「连接 + 响应头到达」的时长；响应头一到就解除计时，
   * 之后流式 body 想读多久读多久（长回答不能被请求超时掐断）。
   */
  requestTimeoutMs?: number;
}): Promise<AgentRuntimeResult> {
  const request = buildPlatformChatCompletionRequest({
    providerConfig: args.providerConfig,
    messages: args.messages,
    tools: args.tools,
    stream: args.stream,
  });
  const controller = args.requestTimeoutMs ? new AbortController() : undefined;
  const timer = controller
    ? setTimeout(
        () =>
          controller.abort(
            new DOMException(
              `platform chat request timed out after ${args.requestTimeoutMs}ms before response start`,
              "TimeoutError",
            ),
          ),
        args.requestTimeoutMs,
      )
    : undefined;
  let res: Response;
  try {
    res = await args.fetchImpl(request.url, {
      ...request.init,
      ...(controller
        ? { signal: controller.signal }
        : args.signal
          ? { signal: args.signal }
          : {}),
    });
  } finally {
    // 响应头已到（或请求失败）：解除计时，别掐正在流式输出的 body。
    if (timer !== undefined) clearTimeout(timer);
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    throw providerHttpFailure({
      label: "desktop platform provider",
      status: res.status,
      raw,
      messages: args.messages,
    });
  }

  const contentType = res.headers.get("content-type") ?? "";
  const usesResponsesApi = isResponsesEndpoint(args.providerConfig.endpoint);
  const shouldStream =
    Boolean(args.stream && (args.onTextDelta || args.onReasoningDelta)) &&
    contentType.includes("text/event-stream");

  if (shouldStream) {
    const streamed = await readPlatformChatSseCompletion({
      response: res,
      usesResponsesApi,
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
      trace: args.messages,
    };
  }

  const raw = await res.text().catch(() => "");
  const data = parsePlatformChatCompletionData(raw);
  return parsePlatformChatCompletionResponse({
    providerConfig: args.providerConfig,
    data,
    trace: args.messages,
  });
}

/**
 * Execute a platform chat completion, trying `serverUrls` in order. The first
 * server that returns a usable response wins; subsequent servers are only
 * contacted when an earlier server fails (network error, non-2xx status, or a
 * timeout reached before the response started). Once streaming text deltas
 * have begun we never fall back (that would double-emit deltas).
 *
 * This mirrors the local-first / main-server-first policy used by the hybrid
 * record store: fallback servers exist for data backup / cross-region reach,
 * not for racing every request.
 */
export async function executePlatformChatCompletionWithFallback(args: {
  providerConfig: PlatformChatProviderConfig;
  messages: AgentRuntimeChatMessage[];
  tools?: PlatformChatTool[];
  fetchImpl: FetchLike;
  serverUrls: string[];
  requestTimeoutMs?: number;
  stream?: boolean;
  onTextDelta?: (chunk: string) => void;
  onReasoningDelta?: (chunk: string) => void;
}): Promise<AgentRuntimeResult> {
  const serverUrls = asNonEmptyStringArray(args.serverUrls);
  if (serverUrls.length === 0) {
    return executePlatformChatCompletion({
      providerConfig: args.providerConfig,
      messages: args.messages,
      tools: args.tools,
      fetchImpl: args.fetchImpl,
      stream: args.stream,
      ...(args.onTextDelta ? { onTextDelta: args.onTextDelta } : {}),
      ...(args.onReasoningDelta ? { onReasoningDelta: args.onReasoningDelta } : {}),
    });
  }

  let lastError: unknown;
  // 一旦某台 server 已经向调用方吐过 delta，就不能再 fallback 重试，
  // 否则同一段文本会被下一台 server 重复 emit 给用户。
  let deltaEmitted = false;
  const wrapDelta = <T extends (chunk: string) => void>(cb: T | undefined): T | undefined =>
    cb
      ? (((chunk: string) => {
          deltaEmitted = true;
          cb(chunk);
        }) as T)
      : undefined;
  const onTextDelta = wrapDelta(args.onTextDelta);
  const onReasoningDelta = wrapDelta(args.onReasoningDelta);
  for (let index = 0; index < serverUrls.length; index += 1) {
    const serverUrl = normalizeServerOrigin(serverUrls[index]);
    const providerConfig: PlatformChatProviderConfig = {
      ...args.providerConfig,
      serverUrl,
    };
    try {
      return await executePlatformChatCompletion({
        providerConfig,
        messages: args.messages,
        tools: args.tools,
        fetchImpl: args.fetchImpl,
        stream: args.stream,
        ...(onTextDelta ? { onTextDelta } : {}),
        ...(onReasoningDelta ? { onReasoningDelta } : {}),
        // 只限「连接+首字节」；响应开始后长回答不受此超时影响。
        ...(args.requestTimeoutMs ? { requestTimeoutMs: args.requestTimeoutMs } : {}),
      });
    } catch (error) {
      lastError = error;
      if (deltaEmitted) throw error;
      // Only advance to the next server; do not race all of them in parallel.
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("All platform chat servers failed");
}

export function canUsePlatformChatProvider(env: EnvLike) {
  return canUsePlatformChatProviderFromEnv(env);
}

export function hasDirectOpenAiCompatibleProvider(env: EnvLike) {
  return hasDirectOpenAiCompatibleProviderFromEnv(env);
}

export function shouldUsePlatformChatProvider(
  env: EnvLike,
  agentConfig?: AgentRuntimeAgentConfig
) {
  if (!agentConfig) {
    return resolveProviderTransportDecision({
      agentConfig: { key: "default-platform" },
      env,
      runtimeLocation: "local-host",
    }).transport === "proxy";
  }
  return resolveProviderTransportDecision({
    agentConfig,
    env,
    runtimeLocation: resolveAgentRuntimeLocation({
      agentConfig,
      runtimeKind: "local",
    }),
  }).transport === "proxy";
}
