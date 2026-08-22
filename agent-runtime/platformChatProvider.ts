import { getUsageRequestOptions } from "../ai/llm/usageRequestOptions";
import { extractUsageFromSsePayload, hasUsageTokens } from "../ai/token/sseUsageExtract";
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
import { sanitizeForOutbound } from "./outboundHistorySanitize";
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
import { createToolCallTextParserState } from "./toolCallTextParser";
import {
  createDsmlParserState,
  finishDsml,
  parseDsml,
  pushDsmlChunk,
  type DsmlParserState,
} from "./deepseekDsmlParser";
import {
  addResponsesToolCall,
  applyResponsesToolEvent,
  createResponsesToolAccumulator,
  finalizeResponsesToolCalls,
} from "./responsesToolCallAccumulator";
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
// Platform endpoint selection is resolved before this adapter; this module
// handles both chat.completions and Responses wire formats.

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

function buildDsmlToolCallId(baseCount: number, index: number): string {
  return `dsml-${baseCount + index + 1}`;
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
  /**
   * 计费归因用的对话 id。chatProxyRouting 会把它从 payload 里剥掉，不转发给
   * 上游 provider；缺省时 chatProxyBilling 兜底写 "chat-proxy"，报表里所有
   * runtime 调用会塌成同一个桶。
   */
  dialogId?: string;
}) {
  const usesResponsesApi = isResponsesEndpoint(args.providerConfig.endpoint);
  const requestOptions = usesResponsesApi
    ? toResponsesRequestOptions(args.providerConfig.requestOptions)
    : args.providerConfig.requestOptions;
  const shouldStripReasoning = shouldStripReasoningContentForOutbound(
    args.providerConfig.provider,
    args.providerConfig.model,
  );
  // Sanitize cross-wire history BEFORE the wire-specific converter turns it
  // into the request body: pair tool_calls with results, and downgrade
  // tool_calls whose name is not in the current `tools` array to text
  // (gateways like ollama reject unknown tool names on inbound history with
  // HTTP 400). Doing it here covers both the completions and responses wire,
  // so the two converters below only shape, never sanitize.
  //
  // NOTE: reasoning_content stripping is deliberately NOT done by sanitize —
  // it is a wire-specific concern applied by the converters below
  // (toOpenAiCompatibleMessages / convertMessagesToResponsesInput).
  const sanitizedMessages = sanitizeForOutbound(args.messages, args.tools);
  const body = {
    model: args.providerConfig.model,
    ...(usesResponsesApi
      ? {
          input: convertMessagesToResponsesInput(sanitizedMessages as any),
        }
      : {
          messages: toOpenAiCompatibleMessages(sanitizedMessages, {
            stripReasoningContent: shouldStripReasoning,
          }),
        }),
    stream: args.stream ?? false,
    ...(args.stream
      ? getUsageRequestOptions(args.providerConfig.provider, { api: "chat-completions" })
      : {}),
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
    ...(args.dialogId?.trim() ? { dialogId: args.dialogId.trim() } : {}),
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
  // 线格式以响应体形状为准，endpoint 只是形状缺失时的兜底。客户端按自己的
  // model→wire 表选线格式，服务端代理按当前部署选上游（nolo provider 的
  // flash 在官方 Responses ↔ DeepInfra chat.completions 之间切换过），两边
  // 不一致时 body 的 choices[].message.content 会被 Responses 提取器静默
  // 丢成空串，落进 localLoop 的空轮 repair 也救不回来。
  const hasCompletionsShape = Array.isArray(args.data?.choices);
  if (!hasCompletionsShape && isResponsesEndpoint(args.providerConfig.endpoint)) {
    const rawContent = extractTextFromResponseOutput(args.data);
    const dsml = parseDsml(rawContent);
    const tool_calls = extractToolCallsFromResponseOutput(args.data);
    const normalizedToolCalls = tool_calls.length > 0
      ? tool_calls
      : dsml.toolCalls.map((call, index) => ({
          id: buildDsmlToolCallId(tool_calls.length, index),
          type: "function" as const,
          function: { name: call.name, arguments: call.arguments },
        }));
    return {
      content: dsml.content,
      model: args.providerConfig.model,
      provider: args.providerConfig.provider,
      ...(normalizedToolCalls.length > 0 ? { tool_calls: normalizedToolCalls } : {}),
      stream_complete: true,
      usage: args.data?.usage,
      trace: args.trace,
    };
  }

  const choiceMessage = args.data?.choices?.[0]?.message ?? {};
  const rawContent = String(choiceMessage?.content ?? "");
  const { content, reasoning } = extractThinkContent(rawContent);
  const rawFinishReason = args.data?.choices?.[0]?.finish_reason;
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
    ...(typeof rawFinishReason === "string" && rawFinishReason.length > 0
      ? { finish_reason: rawFinishReason }
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
    responsesToolCalls: ReturnType<typeof createResponsesToolAccumulator>;
    dsmlToolCallState: DsmlParserState;
    billing?: Record<string, unknown>;
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

    if (parsed?.billing && typeof parsed.billing === "object") {
      // 独立 billing 帧（chatBillingSse.formatBillingUsageEvent 注入，[DONE]
      // 前）携带 cost/billing_* 元数据，用于 TUI 积分 chip。与真实 usage
      // 分离存储——不覆盖 state.usage，避免把 input_tokens/output_tokens
      // 冲掉（此前 billing 帧复用顶层 `usage` key，把 usage 覆盖成只剩
      // billing 字段，TUI context chip 永远不更新）。
      state.billing = parsed.billing as Record<string, unknown>;
    }

    const extractedUsage = extractUsageFromSsePayload(parsed);
    if (extractedUsage) {
      state.usage = extractedUsage;
    } else if (
      parsed?.usage &&
      typeof parsed.usage === "object" &&
      !hasUsageTokens(parsed.usage)
    ) {
      // 防御：旧 server / 第三方代理仍把 billing 元数据塞在顶层 `usage`
      // 里（无 token 字段）。不算真实 usage 帧——不覆盖已解析的 token 数，
      // 只把它当作 legacy billing 元数据合并（保住 cost，credits chip 不丢）。
      state.billing = {
        ...(state.billing ?? {}),
        ...(parsed.usage as Record<string, unknown>),
      };
    }

    // 帧路由同 parsePlatformChatCompletionResponse：以形状为准。客户端预期
    // Responses 线时，代理仍可能回传 chat.completions 上游的 delta chunk
    // （nolo provider 上游切换的 rollout 窗口）；choices 数组无论预期哪条线
    // 都必须走 applyChatCompletionDelta，否则正文在流式路径同样被静默丢弃。
    if (Array.isArray(parsed?.choices)) {
      applyChatCompletionDelta(parsed, state);
      continue;
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
      const dsml = pushDsmlChunk(parsed.delta, state.dsmlToolCallState);
      for (const [index, call] of dsml.toolCalls.entries()) {
        const id = buildDsmlToolCallId(state.responsesToolCalls.size, index);
        addResponsesToolCall(state.responsesToolCalls, {
          id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        });
      }
      if (dsml.content) {
        state.content += dsml.content;
        state.onTextDelta?.(dsml.content);
      }
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
    if (
      eventType === "response.output_item.added" ||
      eventType === "response.output_item.done" ||
      eventType === "response.function_call_arguments.delta" ||
      eventType === "response.function_call_arguments.done"
    ) {
      applyResponsesToolEvent(state.responsesToolCalls, parsed);
      continue;
    }
    if (eventType === "response.completed" && parsed?.response) {
      state.completedResponsesPayload = parsed.response;
      // usage 已在帧顶部经 extractUsageFromSsePayload 统一提取
      // （response.completed.response.usage 形状），这里不再重复赋值。
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
    billing: undefined as Record<string, unknown> | undefined,
    usesResponsesApi: args.usesResponsesApi,
    onTextDelta: args.onTextDelta,
    onReasoningDelta: args.onReasoningDelta,
    completedResponsesPayload: undefined as any,
    responsesToolCalls: createResponsesToolAccumulator(),
    dsmlToolCallState: createDsmlParserState(),
    streamError: undefined as ChatCompletionStreamError | undefined,
    accumulatedToolCalls: createToolCallAccumulator(),
    thinkState: createThinkParserState(),
    toolCallTextState: createToolCallTextParserState(),
    finishReason: undefined as string | undefined,
  };

  for await (const frame of readSseFrames(args.response)) {
    processPlatformChatSseEvent(frame, state);
  }

  // Flush any think-tag parser state held across chunk boundaries (mirrors
  // readOpenAiCompatibleSseCompletion). No-op for the Responses-API branch
  // since its events carry complete text deltas, not inline <think> tags.
  flushChatCompletionStream(state);
  if (state.usesResponsesApi) {
    const dsml = finishDsml(state.dsmlToolCallState);
    for (const [index, call] of dsml.toolCalls.entries()) {
      const id = buildDsmlToolCallId(state.responsesToolCalls.size, index);
      addResponsesToolCall(state.responsesToolCalls, {
        id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      });
    }
    if (dsml.content) state.content += dsml.content;
  }
  // 代理把上游故障编成 HTTP 200 + 错误帧；不抛就会伪装成空回答落进对话历史。
  throwIfChatCompletionStreamFailed(state);

  if (state.usesResponsesApi) {
    const response = state.completedResponsesPayload;
    const completedToolCalls = response
      ? extractToolCallsFromResponseOutput(response)
      : [];
    const finalContent = response ? extractTextFromResponseOutput(response) : "";
    const normalizedFinal = finalContent
      ? parseDsml(finalContent)
      : { content: "", toolCalls: [] };
    const normalizedDsmlCalls = normalizedFinal.toolCalls.map((call, index) => ({
      id: buildDsmlToolCallId(completedToolCalls.length, index),
      type: "function" as const,
      function: { name: call.name, arguments: call.arguments },
    }));
    // 形状路由后本分支也可能收到 chat.completions 帧，其 tool_calls 进的是
    // accumulatedToolCalls 而非 responsesToolCalls——终局聚合两边都要回收，
    // 否则工具调用意图被吞掉，伪装成无输出的空轮。
    const completionsToolCalls = finalizeAccumulatedToolCalls(
      state.accumulatedToolCalls,
    );
    const tool_calls =
      completedToolCalls.length > 0
        ? completedToolCalls
        : normalizedDsmlCalls.length > 0
          ? normalizedDsmlCalls
          : completionsToolCalls.length > 0
            ? completionsToolCalls
            : finalizeResponsesToolCalls(state.responsesToolCalls);
    const finalUsage = mergeBillingIntoUsage(state.usage, state.billing);
    return {
      content: normalizedFinal.content || state.content,
      ...(state.reasoning ? { reasoning_content: state.reasoning } : {}),
      ...(tool_calls.length > 0 ? { tool_calls } : {}),
      ...(finalUsage ? { usage: finalUsage, stream_complete: true } : {}),
      // finish_reason 供 executePlatformChatCompletion 穿透给 localLoop 的
      // 空轮/截断判定；此前 reader 从不回传，流式路径恒缺。
      ...(state.finishReason ? { finish_reason: state.finishReason } : {}),
    };
  }

  const tool_calls = finalizeAccumulatedToolCalls(state.accumulatedToolCalls);
  const finalUsage = mergeBillingIntoUsage(state.usage, state.billing);
  return {
    content: state.content,
    ...(state.reasoning ? { reasoning_content: state.reasoning } : {}),
    ...(tool_calls.length > 0 ? { tool_calls } : {}),
    ...(finalUsage ? { usage: finalUsage, stream_complete: true } : {}),
    ...(state.finishReason ? { finish_reason: state.finishReason } : {}),
  };
}

/**
 * Merge the independent billing frame (cost/billing_*) into the real token
 * usage before returning, so downstream buildTurnTokenUsage can read
 * `usage.cost` for the TUI credits chip. Token fields stay untouched —
 * billing never overwrites input/output tokens.
 *
 * 有意取舍：若 provider 自带 usage.cost（如 openrouter），平台 billing 帧的
 * cost 会覆盖它——平台计价才是用户实际扣费口径，方向合理。
 */
function mergeBillingIntoUsage(
  usage: Record<string, unknown> | undefined,
  billing: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!billing) return usage;
  if (!usage) return billing;
  return { ...usage, ...billing };
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
  /** 计费归因用；透传给 buildPlatformChatCompletionRequest。 */
  dialogId?: string;
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
    ...(args.dialogId ? { dialogId: args.dialogId } : {}),
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
      // 流式 finish_reason 此前在 reader 与本返回两处都断掉，localLoop 的
      // finish_reason==="length" 截断诊断在流式路径从未生效——与
      // openAiCompatibleProvider 的穿透对齐。
      ...(streamed.finish_reason ? { finish_reason: streamed.finish_reason } : {}),
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
  /** 计费归因用；透传给 executePlatformChatCompletion。 */
  dialogId?: string;
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
      ...(args.dialogId ? { dialogId: args.dialogId } : {}),
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
        ...(args.dialogId ? { dialogId: args.dialogId } : {}),
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
