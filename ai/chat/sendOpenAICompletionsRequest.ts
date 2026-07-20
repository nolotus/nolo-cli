// 文件路径: chat/sendOpenAICompletionsRequest.ts

import {
  addActiveController,
  removeActiveController,
  tokenUsageLiveUpdate,
} from "../../chat/dialog/dialogSlice";
import {
  messageStreamEnd,
  messageStreaming,
  addToolMessage,
  updateToolMessage,
} from "../../chat/messages/messageSlice";
import { handleToolCalls } from "../../chat/messages/toolThunks";
import { persistToolMessage } from "../../chat/messages/persistToolMessage";
import {
  MessageContentPart,
  ImageGenerationState,
  Message,
  OpenAITextContent,
} from "../../chat/messages/types";
import {
  createThinkParserState,
  flushThinkParser,
  processThinkChunk,
  type ThinkParseState,
} from "../../agent-runtime/thinkTagParser";
import { selectCurrentServer } from "../../app/settings/settingSlice";
import { selectCurrentSpaceId } from "../../create/space/spaceSlice";
import { getApiEndpoint } from "../llm/providers";
import { createDialogMessageKeyAndId, dialogMessageKey } from "../../database/keys";
import { selectIdentityToken } from "identity/selectors";
import { isAbortError } from "../../core/abortError";
import { toErrorMessage } from "../../core/errorMessage";
import { asOptionalTrimmedString } from "../../core/optionalString";
import { extractCustomId } from "../../core/prefix";

import { performFetchRequest } from "./fetchUtils";
import { createSSEParser } from "./parseMultilineSSE";
import { parseApiError } from "./parseApiError";
import { updateTotalUsage } from "./updateTotalUsage";
import { accumulateToolCallChunks } from "./accumulateToolCallChunks";
import {
  parseToolCallArguments,
  buildInvalidToolCallSelfHealResult,
  INVALID_TOOL_ARGS_REPLACEMENT,
  sanitizeOutboundMessages,
} from "./toolCallArgumentGuard";
import { prepareTools } from "../tools/prepareTools";
import {
  inlineImageUrlsForCustomProvider,
  shouldInlineImageUrlsForAgent,
} from "./inlineImageUrlsForCustomProvider";
import { readStreamChunk } from "./streamReader";

import { getModelInfo } from "../llm/getModelContextWindow";
import { supportsImageGeneration } from "../agent/utils/imageOutput";

import type { RootState } from "../../app/store";

/**
 * 追加文本 chunk 到 contentBuffer（不可变更新）
 */
function appendTextChunk(
  currentContentBuffer: MessageContentPart[],
  textChunk: string
): MessageContentPart[] {
  if (!textChunk) return currentContentBuffer;

  const updatedContentBuffer = [...currentContentBuffer];
  const lastIndex = updatedContentBuffer.length - 1;

  if (lastIndex >= 0 && updatedContentBuffer[lastIndex].type === "text") {
    const last = updatedContentBuffer[lastIndex] as OpenAITextContent;
    updatedContentBuffer[lastIndex] = {
      ...last,
      text: (last.text || "") + textChunk,
    };
  } else {
    updatedContentBuffer.push({ type: "text", text: textChunk });
  }

  return updatedContentBuffer;
}

/** OpenAI 标准 tool_call 结构 */
type AssistantToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

const EXPLICIT_IMAGE_TOOL_NAMES = new Set([
  "openAIGptImage",
  "openAIGptImageGenerate",
  "chatgptWebImageGenerate",
  "openAIGptImageEdit",
  "geminiProImagePreview",
]);

function getStreamErrorMessage(data: any): string {
  const message =
    asOptionalTrimmedString(data?.error?.message) ??
    asOptionalTrimmedString(data?.error?.msg) ??
    asOptionalTrimmedString(data?.message);
  if (message) return message;

  const code =
    asOptionalTrimmedString(data?.error?.code) ??
    asOptionalTrimmedString(data?.code);
  if (code) return code;

  const type = asOptionalTrimmedString(data?.error?.type);
  if (type) return type;

  return "Unknown error";
}

function formatStreamErrorMessage(data: any): string {
  const rawMessage = getStreamErrorMessage(data);
  if (
    /prohibited|violation|terms\s+of\s+service|content\s+policy|safety/i.test(
      rawMessage
    )
  ) {
    return "当前模型服务商拒绝了这次请求。你可以稍后重试，或切换到其他模型继续。";
  }
  return rawMessage;
}

function getChoiceFinishErrorMessage(data: any, choice: any): string | null {
  if (choice?.error || choice?.message || choice?.code) {
    const message = formatStreamErrorMessage(choice);
    if (message && message !== "Unknown error") return message;
  }
  if (data?.error || data?.message || data?.code) {
    const message = formatStreamErrorMessage(data);
    if (message && message !== "Unknown error") return message;
  }
  const messageContent = asOptionalTrimmedString(choice?.message?.content);
  if (messageContent) return messageContent;
  return null;
}

/** 单次流式请求过程中的全部中间状态（显式 state） */
type StreamState = {
  contentBuffer: MessageContentPart[];
  totalUsage: any | null;
  accumulatedToolCalls: any[];
  reasoningBuffer: string;
  thinkState: ThinkParseState;
  assistantToolCalls?: AssistantToolCall[];
  hasHandedOff: boolean;
  hasProcessedToolCalls: boolean;
  alreadyFinalized: boolean;
  finishReason: string | null;
};

type FinalizeContext = {
  dispatch: any;
  msgKey: string;
  dialogId: string;
  dialogKey: string;
  messageId: string;
  agentConfig: any;
  spaceId?: string;
  messageMetadata?: Partial<Message>;
};

type ToolCallsContext = {
  dispatch: any;
  agentConfig: any;
  dialogId: string;
  dialogKey: string;
  messageId: string;
  messageMetadata?: Partial<Message>;
};

type StreamCompletionContext = {
  dispatch: any;
  dialogId: string;
  dialogKey: string;
  messageId: string;
  agentConfig: any;
};

const withImageGenerationStage = (
  messageMetadata: Partial<Message> | undefined,
  stage: ImageGenerationState["stage"]
): Partial<Message> | undefined => {
  const previousState = messageMetadata?.imageGenerationState;
  if (previousState?.kind !== "image_generation") {
    return messageMetadata;
  }

  return {
    ...(messageMetadata ?? {}),
    imageGenerationState: {
      ...previousState,
      stage,
    },
  };
};

const shouldShowImageSavingState = (contentBuffer: MessageContentPart[]) =>
  contentBuffer.some((part) => part?.type === "image_url") &&
  !contentBuffer.some(
    (part) =>
      part?.type === "text" &&
      typeof part.text === "string" &&
      part.text.trim().length > 0
  );

/** 单轮调用后返回给 Agent Loop 的元信息 */
export type CompletionMeta = {
  hasToolCalls: boolean;
  hasPendingInteraction: boolean;
  hasHandedOff: boolean;
  finishReason: string | null;
  messageId: string;
  usage?: any;
};

const STREAM_READ_TIMEOUT_MS = 45_000;

const logQuickChatPerfStage = (
  startedAt: number | undefined,
  stage: string,
  details?: Record<string, unknown>
) => {
  if (!startedAt) return;
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  console.info("[QuickChatPerf]", {
    stage,
    elapsedMs: now - startedAt,
    ...(typeof performance !== "undefined" ? { atMs: now } : {}),
    ...(details ?? {}),
  });
};

/**
 * 初始化流式状态
 */
function createInitialStreamState(): StreamState {
  return {
    contentBuffer: [],
    totalUsage: null,
    accumulatedToolCalls: [],
    reasoningBuffer: "",
    thinkState: createThinkParserState(),
    assistantToolCalls: undefined,
    hasHandedOff: false,
    hasProcessedToolCalls: false,
    alreadyFinalized: false,
    finishReason: null,
  };
}

/**
 * 根据 tools 配置生成本次请求体（不改动外部传入的 bodyData）
 */
function buildRequestBodyWithTools(
  bodyData: any,
  agentConfig: any,
  disableToolsForThisRequest: boolean
): any {
  // 防护 B：出站清洗。无论本轮是否启用 tools，历史 messages 里都可能
  // 含被截断的 tool_calls（arguments 无法 JSON.parse），provider 会直接
  // 拒绝并让对话永久卡死。这里在所有 tools 相关早退之前先清洗，确保
  // 出站 body 的 tool_calls[].function.arguments 全部是合法 JSON 字符串，
  // 并为缺配对结果的 tool_call 补占位 tool 消息，避免孤儿 tool 消息触发
  // 另一类 400。
  const messagesForBody = Array.isArray(bodyData?.messages)
    ? sanitizeOutboundMessages(bodyData.messages)
    : bodyData?.messages;
  const baseBody =
    messagesForBody !== bodyData?.messages
      ? { ...bodyData, messages: messagesForBody }
      : bodyData;

  if (disableToolsForThisRequest) return baseBody;

  // 如果模型拥有图像输出能力，则不组装任何 tools
  const modelInfo = getModelInfo(agentConfig.model);
  if (modelInfo?.hasImageOutput) {
    return baseBody;
  }

  const rawTools = agentConfig.tools;
  if (!Array.isArray(rawTools) || rawTools.length === 0) return baseBody;
  const hasExplicitImageTool = rawTools.some(
    (toolName: unknown) =>
      typeof toolName === "string" && EXPLICIT_IMAGE_TOOL_NAMES.has(toolName)
  );
  if (supportsImageGeneration(agentConfig) && !hasExplicitImageTool) {
    return baseBody;
  }

  const tools = prepareTools(rawTools, { provider: agentConfig.provider });
  if (!tools.length) return baseBody;

  return {
    ...baseBody,
    tools,
    tool_choice: baseBody.tool_choice ?? "auto",
  };
}

/**
 * 结束当前流式消息，派发 messageStreamEnd（带幂等保护）
 */
async function finalizeStream(
  state: StreamState,
  ctx: FinalizeContext
): Promise<StreamState> {
  if (state.hasHandedOff || state.alreadyFinalized) return state;

  const savingMetadata = withImageGenerationStage(
    ctx.messageMetadata,
    "saving"
  );
  if (savingMetadata && shouldShowImageSavingState(state.contentBuffer)) {
    ctx.dispatch(
      messageStreaming({
        id: ctx.messageId,
        dialogId: ctx.dialogId,
        dbKey: ctx.msgKey,
        content: "",
        thinkContent: state.reasoningBuffer,
        role: "assistant",
        agentKey: ctx.agentConfig.dbKey,
        cybotKey: ctx.agentConfig.dbKey,
        ...(asOptionalTrimmedString(ctx.agentConfig?.name)
          ? { agentName: asOptionalTrimmedString(ctx.agentConfig?.name) }
          : {}),
        ...(savingMetadata ?? {}),
      })
    );
    ctx.messageMetadata = savingMetadata;
  }

  await ctx.dispatch(
    messageStreamEnd({
      finalContentBuffer: state.contentBuffer,
      totalUsage: state.totalUsage,
      msgKey: ctx.msgKey,
      agentConfig: ctx.agentConfig,
      dialogId: ctx.dialogId,
      dialogKey: ctx.dialogKey,
      messageId: ctx.messageId,
      reasoningBuffer: state.reasoningBuffer,
      messageMetadata: ctx.messageMetadata,
      toolCalls: state.assistantToolCalls,
      spaceId: ctx.spaceId,
    })
  );

  return {
    ...state,
    alreadyFinalized: true,
  };
}

/**
 * 上游偶发返回 200 + 立即结束的空流(无 delta、无 tool call、无 usage)。
 * 若按正常完成落库,消息 content 为空,UI 只能显示误导性的
 * "未收到回复内容,请检查网络"兜底文案。这里改走异常终止语义:
 * 写入明确的错误文案 + metadata.error 标记,让用户知道该重试。
 */
const EMPTY_UPSTREAM_STREAM_MESSAGE =
  "模型返回了空响应，请重试或切换其他模型";

function markEmptyCompletionAsError(
  state: StreamState,
  ctx: FinalizeContext
): StreamState {
  const producedNothing =
    state.contentBuffer.length === 0 &&
    !state.reasoningBuffer.trim() &&
    (state.assistantToolCalls?.length ?? 0) === 0;
  if (!producedNothing || state.hasHandedOff || state.alreadyFinalized) {
    return state;
  }

  markStreamMessageAborted(ctx, EMPTY_UPSTREAM_STREAM_MESSAGE);
  return {
    ...state,
    contentBuffer: appendTextChunk(
      state.contentBuffer,
      `[错误: ${EMPTY_UPSTREAM_STREAM_MESSAGE}]`
    ),
  };
}

/**
 * 把流式消息标记为"异常终止"(截断 / 超时 / 连接中断),而不是当成正常完成。
 *
 * 与 streamAgentChatTurn 里 `finalizeTransientMessageOnError` 的语义对齐:
 * 保留已累积的部分内容(并附带错误说明),但在持久化元数据上打上
 * `metadata.error` 标记,让 UI 渲染出错误状态,而不是显示成"正常说完"。
 *
 * 注意:用户主动中断(AbortError)不算截断,不应当作异常终止处理。
 */
function markStreamMessageAborted(
  ctx: FinalizeContext,
  errorMessage: string,
): void {
  const base = ctx.messageMetadata ?? {};
  const previousMetadata =
    (base as any).metadata && typeof (base as any).metadata === "object"
      ? (base as any).metadata
      : {};
  ctx.messageMetadata = {
    ...base,
    metadata: {
      ...previousMetadata,
      error: true,
      message: errorMessage,
    },
  } as Partial<Message>;
}

/**
 * 累积 usage
 */
function applyUsage(state: StreamState, data: any): StreamState {
  if (!data.usage) return state;

  return {
    ...state,
    totalUsage: updateTotalUsage(state.totalUsage, data.usage),
  };
}

/**
 * 处理单个 delta（文本 / 推理 / tool_calls / 图片）
 */
function applyDelta(
  state: StreamState,
  delta: any
): { state: StreamState; hasNewVisibleContent: boolean } {
  let hasNewVisibleContent = false;
  let next: StreamState = { ...state };

  // reasoning_content 增量（DeepSeek）/ reasoning 增量（Ollama/Qwen3）
  const reasoningChunk: string = delta.reasoning_content ?? delta.reasoning ?? "";
  if (reasoningChunk) {
    next.reasoningBuffer = (next.reasoningBuffer || "") + reasoningChunk;
  }

  // tool_calls 累积 + 映射为 OpenAI 标准格式
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
    const accumulated = accumulateToolCallChunks(
      next.accumulatedToolCalls,
      delta.tool_calls
    );

    next = {
      ...next,
      accumulatedToolCalls: accumulated,
      assistantToolCalls: accumulated.map((call: any) => ({
        id: call.id,
        type: "function",
        function: {
          name: call.function?.name,
          arguments:
            typeof call.function?.arguments === "string"
              ? call.function.arguments
              : JSON.stringify(call.function?.arguments ?? {}),
        },
      })),
    };
  }

  // 图片增量
  const deltaAny = delta as any;
  if (Array.isArray(deltaAny.images) && deltaAny.images.length > 0) {
    next = {
      ...next,
      contentBuffer: [...next.contentBuffer, ...deltaAny.images],
    };
    hasNewVisibleContent = true;
  }

  // 文本增量：模型可能把思考过程直接包在 \u003cthink\u003e 标签里返回（如 MiniMax M3）
  const contentChunk = delta.content || "";
  if (contentChunk) {
    const parsed = processThinkChunk(contentChunk, next.thinkState);
    next.thinkState = parsed.state;
    if (parsed.reasoning) {
      next.reasoningBuffer = (next.reasoningBuffer || "") + parsed.reasoning;
    }
    if (parsed.content) {
      next = {
        ...next,
        contentBuffer: appendTextChunk(next.contentBuffer, parsed.content),
      };
      hasNewVisibleContent = true;
    }
  }

  return { state: next, hasNewVisibleContent };
}

/**
 * 如果有新可见内容，则派发一次 messageStreaming 更新前端
 */
function emitStreamingUpdate(
  hasNewVisibleContent: boolean,
  state: StreamState,
  ctx: {
    dispatch: any;
    agentConfig: any;
    messageId: string;
    msgKey: string;
    dialogId: string;
    messageMetadata?: Partial<Message>;
  }
) {
  if (!hasNewVisibleContent) return;

  ctx.dispatch(
    messageStreaming({
      id: ctx.messageId,
      dialogId: ctx.dialogId,
      dbKey: ctx.msgKey,
      content: state.contentBuffer,
      thinkContent: state.reasoningBuffer,
      role: "assistant",
      agentKey: ctx.agentConfig.dbKey,
      cybotKey: ctx.agentConfig.dbKey,
      ...(asOptionalTrimmedString(ctx.agentConfig?.name)
        ? { agentName: asOptionalTrimmedString(ctx.agentConfig?.name) }
        : {}),
      ...(ctx.messageMetadata ?? {}),
    })
  );
}

/**
 * 防护 A：对流结束时累积的 tool_calls 做 arguments JSON 校验。
 *
 * - 合法 call：原样保留，交给 handleToolCalls 执行。
 * - 非法 call（arguments 被截断 / 无法 JSON.parse）：
 *   1) 不执行该工具；
 *   2) 把 accumulatedToolCalls 与 assistantToolCalls 中该 call 的 arguments
 *      替换为合法 JSON 字符串 INVALID_TOOL_ARGS_REPLACEMENT，避免坏 arguments
 *      被持久化进 dialog 历史后卡死后续请求；
 *   3) 追加一条对应 call_id 的 tool 角色结果消息（内容指导模型自愈），
 *      与现有 toolThunks 的 tool 消息形态对齐，保证历史里 call_id 有配对结果。
 *
 * 返回 { validCalls, invalidCalls }，调用方据此只把 validCalls 派发给
 * handleToolCalls，并自行持久化 invalidCalls 的自愈 tool 结果。
 *
 * 该函数只做纯数据分区 + arguments 替换，不做 dispatch（dispatch 由
 * persistInvalidToolCallResults 负责，方便单测）。
 */
function validateAndPartitionToolCalls(state: StreamState): {
  validCalls: any[];
  invalidCalls: any[];
} {
  const validCalls: any[] = [];
  const invalidCalls: any[] = [];

  for (const call of state.accumulatedToolCalls) {
    if (!call) continue;
    const argsValid = parseToolCallArguments(call?.function?.arguments).valid;
    if (argsValid) {
      validCalls.push(call);
    } else {
      // 替换坏 arguments 为合法 JSON 占位（保留 id / name，配对关系不丢）
      const sanitized = {
        ...call,
        function: {
          ...(call.function ?? {}),
          name: call?.function?.name ?? "",
          arguments: INVALID_TOOL_ARGS_REPLACEMENT,
        },
      };
      invalidCalls.push(sanitized);
    }
  }

  return { validCalls, invalidCalls };
}

/**
 * 把 accumulatedToolCalls 中被替换为占位的非法 call，同步反映到
 * assistantToolCalls（用于持久化的 assistant 消息），保证落库的
 * tool_calls[].function.arguments 是合法 JSON 字符串。
 *
 * 纯函数：返回新的 assistantToolCalls 数组。
 */
function syncAssistantToolCallsAfterSanitize(
  state: StreamState,
  invalidCalls: any[]
): any[] {
  if (!invalidCalls.length) return state.assistantToolCalls ?? [];
  const invalidById = new Map<string, any>();
  for (const call of invalidCalls) {
    if (call?.id) invalidById.set(call.id, call);
  }
  const base = Array.isArray(state.assistantToolCalls)
    ? state.assistantToolCalls
    : state.accumulatedToolCalls.map((call: any) => ({
        id: call.id,
        type: "function",
        function: {
          name: call.function?.name,
          arguments:
            typeof call.function?.arguments === "string"
              ? call.function.arguments
              : JSON.stringify(call.function?.arguments ?? {}),
        },
      }));

  return base.map((call: any) => {
    if (!call?.id) return call;
    const invalid = invalidById.get(call.id);
    if (!invalid) return call;
    return {
      ...call,
      type: "function",
      function: {
        name: invalid.function?.name ?? call.function?.name ?? "",
        arguments: INVALID_TOOL_ARGS_REPLACEMENT,
      },
    };
  });
}

/**
 * 防护 A：为非法 tool calls 持久化自愈 tool 结果消息。
 *
 * 模仿 toolThunks.handleToolCalls 的 tool 消息形态：
 *   role=tool, tool_call_id=call.id, content=自愈提示 JSON,
 *   parentMessageId/messageId 派生，保证排在对应 assistant 之后。
 *
 * 这里只走「直接落最终结果」路径（不经过 processToolData，因为参数已坏，
 * 没有可执行的工具），把 toolPayload 标记为 failed。
 */
async function persistInvalidToolCallResults(
  invalidCalls: any[],
  ctx: ToolCallsContext,
  startIndex: number
): Promise<void> {
  for (let i = 0; i < invalidCalls.length; i++) {
    const call = invalidCalls[i];
    const callId =
      call?.id || `call_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const toolIndex = startIndex + i;
    const runningToolMessageId = `${ctx.messageId}-t${String(toolIndex).padStart(3, "0")}`;
    const runningToolDbKey = dialogMessageKey(ctx.dialogId, runningToolMessageId);
    const toolName = call?.function?.name || "unknown";
    const selfHealContent = buildInvalidToolCallSelfHealResult(callId, toolName);

    const toolMessage: Message = {
      id: runningToolMessageId,
      dbKey: runningToolDbKey,
      role: "tool",
      content: selfHealContent,
      toolCallId: callId,
      thinkContent: "",
      cybotKey: ctx.agentConfig.dbKey,
      isStreaming: false,
      toolName,
      parentMessageId: ctx.messageId,
      toolPayload: {
        toolName,
        status: "failed",
        input: {},
        rawToolCall: call,
        error: {
          type: "InvalidToolCallArguments",
          message:
            "工具参数 JSON 被截断或非法，已跳过执行并替换为占位 arguments。",
          retryable: true,
        },
        summary: `❌ ${toolName} 参数被截断，已跳过`,
      },
    } as any;

    ctx.dispatch(addToolMessage(toolMessage as any));
    // Shared durable path with toolThunks + desktop local runtime.
    // soft: invalid-call placeholder already shown; a write glitch must not
    // fail the stream turn (same policy as handleToolCalls).
    await persistToolMessage(ctx.dispatch, toolMessage, {
      isStreaming: false,
      soft: true,
    });
  }
}

/**
 * 处理已经累积好的 tool_calls
 */
async function processAccumulatedToolCalls(
  state: StreamState,
  ctx: ToolCallsContext
): Promise<{
  state: StreamState;
  hasHandedOff: boolean;
  hasPendingInteraction: boolean;
}> {
  if (!state.accumulatedToolCalls.length) {
    return {
      state,
      hasHandedOff: false,
      hasPendingInteraction: false,
    };
  }

  // 防护 A：流结束校验 arguments，分离合法 / 非法 call。
  const { validCalls, invalidCalls } = validateAndPartitionToolCalls(state);

  // 同步替换持久化用的 assistantToolCalls（无论后续是否执行，落库都要是合法 JSON）
  const sanitizedAssistantToolCalls = syncAssistantToolCallsAfterSanitize(
    state,
    invalidCalls
  );

  // 为非法 call 持久化自愈 tool 结果消息（不执行工具本身）。
  // startIndex 从合法 call 数量之后开始编号，避免与 handleToolCalls 的
  // `${messageId}-t00x` 消息 id 冲突（合法的先执行、占 0..validCount-1）。
  if (invalidCalls.length > 0) {
    await persistInvalidToolCallResults(
      invalidCalls,
      ctx,
      validCalls.length
    );
  }

  // 没有合法 call：直接返回，不再派发 handleToolCalls（避免空调用）
  if (!validCalls.length) {
    const nextState: StreamState = {
      ...state,
      accumulatedToolCalls: [],
      assistantToolCalls: sanitizedAssistantToolCalls,
      hasProcessedToolCalls: true,
      hasHandedOff: false,
    };
    return {
      state: nextState,
      hasHandedOff: false,
      hasPendingInteraction: false,
    };
  }

  const result = await ctx
    .dispatch(
      handleToolCalls({
        accumulatedCalls: validCalls,
        currentContentBuffer: state.contentBuffer,
        agentConfig: ctx.agentConfig,
        messageId: ctx.messageId,
        dialogId: ctx.dialogId,
        dialogKey: ctx.dialogKey,
      })
    )
    .unwrap();

  const nextState: StreamState = {
    ...state,
    contentBuffer: result.finalContentBuffer,
    accumulatedToolCalls: [],
    assistantToolCalls: sanitizedAssistantToolCalls,
    hasProcessedToolCalls: true,
    hasHandedOff: result.hasHandedOff,
  };

  return {
    state: nextState,
    hasHandedOff: result.hasHandedOff,
    hasPendingInteraction: result.hasPendingInteraction,
  };
}

async function readStreamChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
) {
  return readStreamChunk(reader, {
    signal,
    timeoutMs: STREAM_READ_TIMEOUT_MS,
    timeoutErrorMessage: `模型响应流 ${Math.round(STREAM_READ_TIMEOUT_MS / 1000)} 秒内没有返回新内容`,
  });
}

/**
 * 处理「流结束」场景（done === true）
 */
async function handleStreamCompletion(
  state: StreamState,
  ctx: StreamCompletionContext,
  finalizeCtx: FinalizeContext
): Promise<{
  state: StreamState;
  hasHandedOff: boolean;
  hasPendingInteraction: boolean;
}> {
  let hasHandedOff = false;
  let hasPendingInteraction = false;

  // Flush any buffered think-tag bytes so the final message is complete.
  const flushed = flushThinkParser(state.thinkState);
  state.thinkState = flushed.state;
  if (flushed.reasoning) {
    state.reasoningBuffer = (state.reasoningBuffer || "") + flushed.reasoning;
  }
  if (flushed.content) {
    state = {
      ...state,
      contentBuffer: appendTextChunk(state.contentBuffer, flushed.content),
    };
  }

  if (!state.hasProcessedToolCalls && state.accumulatedToolCalls.length > 0) {
    // Tool 开始前先更新 TopBar token 显示
    if (state.totalUsage) {
      ctx.dispatch(tokenUsageLiveUpdate({
        input_tokens: state.totalUsage.prompt_tokens ?? state.totalUsage.input_tokens,
        output_tokens: state.totalUsage.completion_tokens ?? state.totalUsage.output_tokens,
        cost: state.totalUsage.cost,
        dialogKey: ctx.dialogKey,
      }));
    }
    const toolResult = await processAccumulatedToolCalls(state, {
      dispatch: ctx.dispatch,
      agentConfig: ctx.agentConfig,
      dialogId: ctx.dialogId,
      dialogKey: ctx.dialogKey,
      messageId: ctx.messageId,
    });

    let next = toolResult.state;
    hasHandedOff ||= toolResult.hasHandedOff;
    hasPendingInteraction ||= toolResult.hasPendingInteraction;

    next = await finalizeStream(next, finalizeCtx);
    return { state: next, hasHandedOff, hasPendingInteraction };
  }

  state = markEmptyCompletionAsError(state, finalizeCtx);
  const finalized = await finalizeStream(state, finalizeCtx);
  return { state: finalized, hasHandedOff, hasPendingInteraction };
}

/**
 * 主流程：发送请求 + 处理流式 SSE + 工具调用
 */
export const sendOpenAICompletionsRequest = async ({
  bodyData,
  agentConfig,
  thunkApi,
  dialogKey,
  parentMessageId,
  messageMetadata,
  disableToolsForThisRequest = false,
  quickChatPerfStartedAt,
}: {
  bodyData: any;
  agentConfig: any;
  thunkApi: any;
  dialogKey: string;
  parentMessageId?: string;
  messageMetadata?: Partial<Message>;
  disableToolsForThisRequest?: boolean;
  quickChatPerfStartedAt?: number;
}): Promise<CompletionMeta> => {
  const { dispatch, getState, signal: thunkSignal } = thunkApi;

  const dialogId = extractCustomId(dialogKey);
  const controller = new AbortController();
  thunkSignal.addEventListener("abort", () => controller.abort());
  const signal = controller.signal;
  const streamSpaceId = selectCurrentSpaceId(getState() as RootState) || undefined;

  let messageId: string;
  let msgKey: string;

  if (parentMessageId) {
    messageId = parentMessageId;
    msgKey = `msg:${dialogId}:${messageId}`;
  } else {
    const newIds = createDialogMessageKeyAndId(dialogId);
    messageId = newIds.messageId;
    msgKey = newIds.key;
  }

  dispatch(addActiveController({ messageId, controller, dialogKey }));

  const requestBody = await inlineImageUrlsForCustomProvider(
    buildRequestBodyWithTools(
      bodyData,
      agentConfig,
      disableToolsForThisRequest
    ),
    {
      shouldInline: shouldInlineImageUrlsForAgent(agentConfig),
    },
  );

  let streamState: StreamState = createInitialStreamState();
  const parseSSE = createSSEParser();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  const finalizeCtx: FinalizeContext = {
    dispatch,
    msgKey,
    dialogId,
    dialogKey,
    messageId,
    agentConfig,
    spaceId: streamSpaceId,
    messageMetadata,
  };

  let hasHandedOffOverall = false;
  let hasPendingInteractionOverall = false;
  let lastFinishReason: string | null = null;
  let activeMessageMetadata = messageMetadata;

  const buildMeta = (): CompletionMeta => ({
    hasToolCalls:
      Array.isArray(streamState.assistantToolCalls) &&
      streamState.assistantToolCalls.length > 0,
    hasPendingInteraction: hasPendingInteractionOverall,
    hasHandedOff: hasHandedOffOverall,
    finishReason: lastFinishReason,
    messageId,
    usage: streamState.totalUsage ?? undefined,
  });

  try {
    if (!parentMessageId) {
      dispatch(
        messageStreaming({
          id: messageId,
          dialogId,
          dbKey: msgKey,
          content: "",
          role: "assistant",
          agentKey: agentConfig.dbKey,
          cybotKey: agentConfig.dbKey,
          ...(asOptionalTrimmedString(agentConfig?.name)
            ? { agentName: asOptionalTrimmedString(agentConfig?.name) }
            : {}),
          ...(activeMessageMetadata ?? {}),
          isStreaming: true,
        })
      );
    }

    const api = getApiEndpoint(agentConfig);
    const token = selectIdentityToken(getState() as RootState) ?? "";
    logQuickChatPerfStage(quickChatPerfStartedAt, "openai-completions-fetch-starting", {
      api,
      dialogKey,
    });
    const response = await performFetchRequest({
      agentConfig,
      api,
      bodyData: requestBody,
      currentServer: selectCurrentServer(getState() as RootState),
      signal,
      token,
      dialogId,
    });
    logQuickChatPerfStage(quickChatPerfStartedAt, "openai-completions-fetch-response", {
      ok: response.ok,
      status: response.status,
      dialogKey,
    });
    activeMessageMetadata = withImageGenerationStage(
      activeMessageMetadata,
      "generating"
    );
    finalizeCtx.messageMetadata = activeMessageMetadata;
    if (!parentMessageId && activeMessageMetadata?.imageGenerationState) {
      dispatch(
        messageStreaming({
          id: messageId,
          dialogId,
          dbKey: msgKey,
          content: "",
          role: "assistant",
          agentKey: agentConfig.dbKey,
          cybotKey: agentConfig.dbKey,
          ...(asOptionalTrimmedString(agentConfig?.name)
            ? { agentName: asOptionalTrimmedString(agentConfig?.name) }
            : {}),
          ...(activeMessageMetadata ?? {}),
          isStreaming: true,
        })
      );
    }

    if (!response.ok) {
      const errorMessage = await parseApiError(response);
      streamState = {
        ...streamState,
        contentBuffer: appendTextChunk(
          streamState.contentBuffer,
          `[错误: ${errorMessage}]`
        ),
      };
      streamState = await finalizeStream(streamState, finalizeCtx);
      return buildMeta();
    }

    reader = response.body?.getReader();
    if (!reader) {
      streamState = markEmptyCompletionAsError(streamState, finalizeCtx);
      streamState = await finalizeStream(streamState, finalizeCtx);
      return buildMeta();
    }

    const decoder = new TextDecoder();
    let loggedFirstStreamChunk = false;
    let loggedFirstParsedEvent = false;
    let loggedFirstVisibleDelta = false;

    while (true) {
      const { done, value } = await readStreamChunkWithTimeout(reader, signal);

      if (done) {
        const completion = await handleStreamCompletion(
          streamState,
      {
        dispatch,
        dialogId,
        dialogKey: finalizeCtx.dialogKey,
        messageId,
        agentConfig,
      },
          finalizeCtx
        );

        streamState = completion.state;
        hasHandedOffOverall ||= completion.hasHandedOff;
        hasPendingInteractionOverall ||= completion.hasPendingInteraction;

        break;
      }

      if (!loggedFirstStreamChunk) {
        loggedFirstStreamChunk = true;
        logQuickChatPerfStage(
          quickChatPerfStartedAt,
          "openai-completions-first-stream-chunk",
          { dialogKey, byteLength: value.byteLength }
        );
      }

      const chunk = decoder.decode(value, { stream: true });
      const parsedResults = parseSSE(chunk);
      if (parsedResults.length > 0 && !loggedFirstParsedEvent) {
        loggedFirstParsedEvent = true;
        logQuickChatPerfStage(
          quickChatPerfStartedAt,
          "openai-completions-first-sse-event",
          { dialogKey, eventCount: parsedResults.length }
        );
      }

      for (const parsedData of parsedResults) {
        const dataList = Array.isArray(parsedData) ? parsedData : [parsedData];

        for (const data of dataList) {
          streamState = applyUsage(streamState, data);

          if (data === "[DONE]") {
            // Web 端通常依赖 reader.read() 的 done 状态来结束，
            // 但如果流中显式包含 [DONE]，也可以直接 break。
            // 这里我们选择忽略它，让 reader 自然结束。
            continue;
          }

          if (data.error) {
            const errorMsg = `Error: ${formatStreamErrorMessage(data)}`;
            streamState = {
              ...streamState,
              contentBuffer: appendTextChunk(
                streamState.contentBuffer,
                `\n[API Error] ${errorMsg}`
              ),
            };
            await reader.cancel();
            break;
          }

          const choice = data.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta || {};

          const { state: updatedState, hasNewVisibleContent } = applyDelta(
            streamState,
            delta
          );
          streamState = updatedState;
          if (hasNewVisibleContent && !loggedFirstVisibleDelta) {
            loggedFirstVisibleDelta = true;
            logQuickChatPerfStage(
              quickChatPerfStartedAt,
              "openai-completions-first-visible-delta",
              { dialogKey }
            );
          }

          emitStreamingUpdate(hasNewVisibleContent, streamState, {
            dispatch,
            agentConfig,
            messageId,
            msgKey,
            dialogId,
            messageMetadata: activeMessageMetadata,
          });

          const finishReason = choice.finish_reason;
          if (finishReason) {
            lastFinishReason = finishReason;
            streamState.finishReason = finishReason;

            if (finishReason === "tool_calls") {
              // Tool 开始前先更新 TopBar token 显示
              if (streamState.totalUsage) {
                dispatch(tokenUsageLiveUpdate({
                  input_tokens: streamState.totalUsage.prompt_tokens ?? streamState.totalUsage.input_tokens,
                  output_tokens: streamState.totalUsage.completion_tokens ?? streamState.totalUsage.output_tokens,
                  cost: streamState.totalUsage.cost,
                  dialogKey,
                }));
              }
              const toolResult = await processAccumulatedToolCalls(
                streamState,
                {
                  dispatch,
                  agentConfig,
                  dialogId,
                  dialogKey,
                  messageId,
                  messageMetadata,
                }
              );

              streamState = toolResult.state;
              hasHandedOffOverall ||= toolResult.hasHandedOff;
              hasPendingInteractionOverall ||= toolResult.hasPendingInteraction;

              // 无论是否 handoff，都 finalize 当前 assistant 消息（stub）
              streamState = await finalizeStream(streamState, finalizeCtx);
            } else if (finishReason !== "stop") {
              const finishErrorMessage =
                finishReason === "error"
                  ? getChoiceFinishErrorMessage(data, choice)
                  : null;
              streamState = {
                ...streamState,
                contentBuffer: appendTextChunk(
                  streamState.contentBuffer,
                  finishErrorMessage
                    ? `\n[API Error] Error: ${finishErrorMessage}`
                    : finishReason === "error"
                      ? "\n[API Error] Error: 模型响应以 error 结束，但上游未返回具体错误。请重试，或切换到其他支持图片输入的模型。"
                      : `\n[流结束原因: ${finishReason}]`
                ),
              };
            }
          }
        }
      }
    }
  } catch (error: any) {
    let errorText: string;
    const isAbort = isAbortError(error);
    if (isAbort) {
      errorText = "\n[用户中断]";
    } else {
      errorText = `\n[错误: ${toErrorMessage(error)}]`;
    }

    console.error("[SSE] sendOpenAICompletionsRequest error:", error);

    streamState = {
      ...streamState,
      contentBuffer: appendTextChunk(streamState.contentBuffer, errorText),
    };
    // 用户主动中断(AbortError)不算截断,按原行为落库即可;
    // 其它错误(流读取超时 / 连接被静默中断等)属于"异常终止",
    // 在持久化元数据上打 error 标记,与 streamAgentChatTurn 的截断处理语义对齐,
    // 避免 UI 把被截断的内容显示成"正常说完"。
    if (!isAbort) {
      markStreamMessageAborted(
        finalizeCtx,
        toErrorMessage(error),
      );
    }
    streamState = await finalizeStream(streamState, finalizeCtx);
  } finally {
    logQuickChatPerfStage(quickChatPerfStartedAt, "openai-completions-stream-finished", {
      dialogKey,
    });
    dispatch(removeActiveController({ messageId, dialogKey }));
    try {
      await reader?.cancel();
    } catch (_e) {
      // ignore
    }
  }

  return buildMeta();
};
