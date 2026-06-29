// 文件路径: chat/sendOpenAICompletionsRequest.ts

import {
  addActiveController,
  removeActiveController,
  tokenUsageLiveUpdate,
} from "../../chat/dialog/dialogSlice";
import {
  messageStreamEnd,
  messageStreaming,
} from "../../chat/messages/messageSlice";
import { handleToolCalls } from "../../chat/messages/toolThunks";
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
import { createDialogMessageKeyAndId } from "../../database/keys";
import { selectCurrentToken } from "../../auth/authSlice";
import { extractCustomId } from "../../core/prefix";

import { performFetchRequest } from "./fetchUtils";
import { createSSEParser } from "./parseMultilineSSE";
import { parseApiError } from "./parseApiError";
import { updateTotalUsage } from "./updateTotalUsage";
import { accumulateToolCallChunks } from "./accumulateToolCallChunks";
import { prepareTools } from "../tools/prepareTools";
import {
  inlineImageUrlsForCustomProvider,
  shouldInlineImageUrlsForAgent,
} from "./inlineImageUrlsForCustomProvider";

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
  "openAIGptImageEdit",
  "geminiProImagePreview",
]);

function getStreamErrorMessage(data: any): string {
  const message =
    typeof data?.error?.message === "string" && data.error.message.trim()
      ? data.error.message.trim()
      : typeof data?.error?.msg === "string" && data.error.msg.trim()
        ? data.error.msg.trim()
        : typeof data?.message === "string" && data.message.trim()
          ? data.message.trim()
          : null;
  if (message) return message;

  const code =
    typeof data?.error?.code === "string" && data.error.code.trim()
      ? data.error.code.trim()
      : typeof data?.code === "string" && data.code.trim()
        ? data.code.trim()
        : null;
  if (code) return code;

  const type =
    typeof data?.error?.type === "string" && data.error.type.trim()
      ? data.error.type.trim()
      : null;
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
  const messageContent = choice?.message?.content;
  if (typeof messageContent === "string" && messageContent.trim()) {
    return messageContent.trim();
  }
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
  if (disableToolsForThisRequest) return bodyData;

  // 如果模型拥有图像输出能力，则不组装任何 tools
  const modelInfo = getModelInfo(agentConfig.model);
  if (modelInfo?.hasImageOutput) {
    return bodyData;
  }

  const rawTools = agentConfig.tools;
  if (!Array.isArray(rawTools) || rawTools.length === 0) return bodyData;
  const hasExplicitImageTool = rawTools.some(
    (toolName: unknown) =>
      typeof toolName === "string" && EXPLICIT_IMAGE_TOOL_NAMES.has(toolName)
  );
  if (supportsImageGeneration(agentConfig) && !hasExplicitImageTool) {
    return bodyData;
  }

  const tools = prepareTools(rawTools, { provider: agentConfig.provider });
  if (!tools.length) return bodyData;

  return {
    ...bodyData,
    tools,
    tool_choice: bodyData.tool_choice ?? "auto",
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
        ...(typeof ctx.agentConfig?.name === "string" && ctx.agentConfig.name.trim()
          ? { agentName: ctx.agentConfig.name.trim() }
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
      ...(typeof ctx.agentConfig?.name === "string" && ctx.agentConfig.name.trim()
        ? { agentName: ctx.agentConfig.name.trim() }
        : {}),
      ...(ctx.messageMetadata ?? {}),
    })
  );
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

  const result = await ctx
    .dispatch(
      handleToolCalls({
        accumulatedCalls: state.accumulatedToolCalls,
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
  reader: ReadableStreamDefaultReader<Uint8Array>
) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(
            new Error(
              `模型响应流 ${Math.round(STREAM_READ_TIMEOUT_MS / 1000)} 秒内没有返回新内容`
            )
          );
        }, STREAM_READ_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
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
          ...(typeof agentConfig?.name === "string" && agentConfig.name.trim()
            ? { agentName: agentConfig.name.trim() }
            : {}),
          ...(activeMessageMetadata ?? {}),
          isStreaming: true,
        })
      );
    }

    const api = getApiEndpoint(agentConfig);
    const token = selectCurrentToken(getState() as RootState);
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
          ...(typeof agentConfig?.name === "string" && agentConfig.name.trim()
            ? { agentName: agentConfig.name.trim() }
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
      streamState = await finalizeStream(streamState, finalizeCtx);
      return buildMeta();
    }

    const decoder = new TextDecoder();
    let loggedFirstStreamChunk = false;
    let loggedFirstParsedEvent = false;
    let loggedFirstVisibleDelta = false;

    while (true) {
      const { done, value } = await readStreamChunkWithTimeout(reader);

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
    if (error?.name === "AbortError") {
      errorText = "\n[用户中断]";
    } else {
      errorText = `\n[错误: ${error?.message || String(error)}]`;
    }

    console.error("[SSE] sendOpenAICompletionsRequest error:", error);

    streamState = {
      ...streamState,
      contentBuffer: appendTextChunk(streamState.contentBuffer, errorText),
    };
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
