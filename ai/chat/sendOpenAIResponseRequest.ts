import {
  addActiveController,
  removeActiveController,
  tokenUsageLiveUpdate,
} from "../../chat/dialog/dialogSlice";
import {
  messageStreaming,
  messageStreamEnd,
} from "../../chat/messages/messageSlice";
import { handleToolCalls } from "../../chat/messages/toolThunks";
import type { ImageGenerationState, Message } from "../../chat/messages/types";
import { selectRuntimeCurrentServer } from "../../app/stateViews/runtime";
import { selectCurrentSpaceId } from "../../create/space/spaceSlice";
import { getApiEndpoint } from "../llm/providers";
import { createDialogMessageKeyAndId } from "../../database/keys";
import { selectCurrentToken } from "../../auth/authSlice";
import { extractCustomId } from "../../core/prefix";
import type { RootState } from "../../app/store";
import { performFetchRequest } from "./fetchUtils";
import { createSSEParser } from "./parseMultilineSSE";
import { parseApiError } from "./parseApiError";
import {
  isRetryableInitialStreamError,
  MAX_INITIAL_STREAM_RETRIES,
  waitForInitialStreamRetry,
} from "./streamRetry";
import { updateTotalUsage } from "./updateTotalUsage";
import type { CompletionMeta } from "./sendOpenAICompletionsRequest";
import { prepareTools } from "../tools/prepareTools";
import {
  extractImagePartsFromResponseOutput,
  extractTextFromResponseOutput,
  toResponsesTools,
  type AssistantToolCall,
} from "../../integrations/openai/responsesHelpers";
import { getModelInfo } from "../llm/getModelContextWindow";
import {
  getPublicImageAgentDefaultProfile,
  getPublicImageAgentMode,
} from "../agent/utils/publicImageAgentMode";

type Segment = { type: "text"; text: string };
const seg = (txt: string): Segment[] => [{ type: "text", text: txt ?? "" }];

const shouldEnableBuiltInImageGeneration = (agentConfig: any): boolean =>
  String(agentConfig?.provider || "").toLowerCase() === "openai" &&
  !getModelInfo(String(agentConfig?.model || ""))?.hasImageOutput &&
  !!agentConfig?.imageConfig?.enabled;

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

const shouldShowImageSavingState = (
  contentBuffer: Array<
    { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
  >
) =>
  contentBuffer.some((part) => part?.type === "image_url") &&
  !contentBuffer.some(
    (part) => part?.type === "text" && typeof part.text === "string" && part.text.trim()
  );

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

type StreamState = {
  content: string;
  contentBuffer: Array<
    { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
  >;
  reasoning: string;
  usage: any | null;
  assistantToolCalls: AssistantToolCall[];
  completedResponse: any | null;
};

const safeCancel = async (
  reader?: ReadableStreamDefaultReader<Uint8Array>
): Promise<void> => {
  if (!reader) return;
  try {
    await reader.cancel();
  } catch {
    /* noop */
  }
};

const ensureToolCall = (
  state: StreamState,
  key: string,
  partial: Partial<AssistantToolCall>
) => {
  let toolCall = state.assistantToolCalls.find((call) => call.id === key);
  if (!toolCall) {
    toolCall = {
      id: key,
      type: "function",
      function: { name: "", arguments: "" },
    };
    state.assistantToolCalls.push(toolCall);
  }

  if (partial.id) toolCall.id = partial.id;
  if (partial.function?.name) toolCall.function.name = partial.function.name;
  if (typeof partial.function?.arguments === "string") {
    toolCall.function.arguments = partial.function.arguments;
  }

  return toolCall;
};

const extractTextFromOutputItem = (item: any): string => {
  if (item?.type !== "message" || !Array.isArray(item.content)) return "";
  return item.content
    .filter(
      (content: any) =>
        content?.type === "output_text" && typeof content.text === "string"
    )
    .map((content: any) => content.text)
    .join("");
};

const getStreamErrorMessage = (event: any): string => {
  const directMessage =
    typeof event?.message === "string" && event.message.trim()
      ? event.message.trim()
      : null;
  if (directMessage) return directMessage;

  const nestedMessage =
    typeof event?.error?.message === "string" && event.error.message.trim()
      ? event.error.message.trim()
      : typeof event?.error?.msg === "string" && event.error.msg.trim()
        ? event.error.msg.trim()
        : null;
  if (nestedMessage) return nestedMessage;

  const nestedCode =
    typeof event?.error?.code === "string" && event.error.code.trim()
      ? event.error.code.trim()
      : typeof event?.code === "string" && event.code.trim()
        ? event.code.trim()
        : null;
  if (nestedCode) return nestedCode;

  const nestedType =
    typeof event?.error?.type === "string" && event.error.type.trim()
      ? event.error.type.trim()
      : typeof event?.type === "string" && event.type.trim() && event.type !== "error"
        ? event.type.trim()
        : null;
  if (nestedType) return nestedType;

  return "Unknown error";
};

export const sendOpenAIResponseRequest = async ({
  bodyData,
  agentConfig,
  thunkApi,
  dialogKey,
  parentMessageId,
  messageMetadata,
  quickChatPerfStartedAt,
}: {
  bodyData: any;
  agentConfig: any;
  thunkApi: any;
  dialogKey: string;
  parentMessageId?: string;
  messageMetadata?: Partial<Message>;
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

  const state: StreamState = {
    content: "",
    contentBuffer: [],
    reasoning: "",
    usage: null,
    assistantToolCalls: [],
    completedResponse: null,
  };
  let activeMessageMetadata = messageMetadata;

  const buildMeta = (
    hasPendingInteraction = false,
    hasHandedOff = false,
    finishReason: string | null = null
  ): CompletionMeta => ({
    hasToolCalls: state.assistantToolCalls.length > 0,
    hasPendingInteraction,
    hasHandedOff,
    finishReason,
    messageId,
    usage: state.usage ?? undefined,
  });
  const resetStateForRetry = () => {
    state.content = "";
    state.contentBuffer = [];
    state.reasoning = "";
    state.usage = null;
    state.assistantToolCalls = [];
    state.completedResponse = null;
    activeMessageMetadata = messageMetadata;
  };
  const canRetryInitialResponseAttempt = (
    attempt: number,
    loggedFirstVisibleDelta: boolean,
    finishReason: string | null
  ) =>
    attempt < MAX_INITIAL_STREAM_RETRIES &&
    !loggedFirstVisibleDelta &&
    !state.assistantToolCalls.length &&
    !finishReason &&
    !state.completedResponse;

  const flush = () =>
    dispatch(
      messageStreaming({
        id: messageId,
        dialogId,
      dbKey: msgKey,
      content: state.contentBuffer,
      thinkContent: state.reasoning,
      role: "assistant",
      agentKey: agentConfig.dbKey,
      cybotKey: agentConfig.dbKey,
      ...(typeof agentConfig?.name === "string" && agentConfig.name.trim()
        ? { agentName: agentConfig.name.trim() }
        : {}),
      ...(activeMessageMetadata ?? {}),
    })
  );

  const finalize = async () => {
    if (!state.content) {
      const completedText = extractTextFromResponseOutput(state.completedResponse);
      if (completedText) {
        state.content = completedText;
      }
    }

    const completedImages = extractImagePartsFromResponseOutput(state.completedResponse);
    if (state.contentBuffer.length === 0) {
      state.contentBuffer = [
        ...(state.content ? seg(state.content) : []),
        ...completedImages,
      ];
    } else if (
      completedImages.length > 0 &&
      !state.contentBuffer.some((part) => part.type === "image_url")
    ) {
      state.contentBuffer = [...state.contentBuffer, ...completedImages];
    }

    if (state.contentBuffer.length === 0 && state.content) {
      state.contentBuffer = seg(state.content);
    }

    activeMessageMetadata = withImageGenerationStage(
      activeMessageMetadata,
      "saving"
    );
    if (
      activeMessageMetadata?.imageGenerationState &&
      shouldShowImageSavingState(state.contentBuffer)
    ) {
      dispatch(
        messageStreaming({
          id: messageId,
          dialogId,
          dbKey: msgKey,
          content: "",
          thinkContent: state.reasoning,
          role: "assistant",
          agentKey: agentConfig.dbKey,
          cybotKey: agentConfig.dbKey,
          ...(typeof agentConfig?.name === "string" && agentConfig.name.trim()
            ? { agentName: agentConfig.name.trim() }
            : {}),
          ...(activeMessageMetadata ?? {}),
        })
      );
    } else {
      flush();
    }
    await dispatch(
      messageStreamEnd({
        finalContentBuffer: state.contentBuffer,
        totalUsage: state.usage,
        msgKey,
        agentConfig,
        dialogId,
        dialogKey,
        messageId,
        reasoningBuffer: state.reasoning,
        messageMetadata: activeMessageMetadata,
        toolCalls: state.assistantToolCalls,
        spaceId: streamSpaceId,
      })
    );
  };

  const processToolCalls = async () => {
    if (!state.assistantToolCalls.length) {
      await finalize();
      return buildMeta(false, false, null);
    }

    if (state.usage) {
      dispatch(
        tokenUsageLiveUpdate({
          input_tokens: state.usage.prompt_tokens ?? state.usage.input_tokens,
          output_tokens:
            state.usage.completion_tokens ?? state.usage.output_tokens,
          cost: state.usage.cost,
          dialogKey,
        })
      );
    }

    const result = await dispatch(
      handleToolCalls({
        accumulatedCalls: state.assistantToolCalls,
        currentContentBuffer: state.contentBuffer,
        agentConfig,
        messageId,
        dialogId,
        dialogKey,
        parallelSessionId: activeMessageMetadata?.parallelSessionId,
        parallelBranchId: activeMessageMetadata?.parallelBranchId,
        parallelLabel: activeMessageMetadata?.parallelLabel,
        parallelIndex: activeMessageMetadata?.parallelIndex,
      })
    ).unwrap();

    state.content = Array.isArray(result.finalContentBuffer)
      ? result.finalContentBuffer
        .filter((part: any) => part?.type === "text")
        .map((part: any) => part.text ?? "")
        .join("")
      : state.content;
    state.contentBuffer = Array.isArray(result.finalContentBuffer)
      ? result.finalContentBuffer
      : state.contentBuffer;

    await finalize();
    return buildMeta(result.hasPendingInteraction, result.hasHandedOff, null);
  };

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

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

    const functionTools = getModelInfo(agentConfig.model)?.hasImageOutput
      ? []
      : prepareTools(agentConfig.tools ?? [], { provider: agentConfig.provider });

    const imageMode = getPublicImageAgentMode(agentConfig);
    const imageProfile =
      imageMode === "continuous"
        ? getPublicImageAgentDefaultProfile("continuous")
        : null;

    const tools = [
      ...(toResponsesTools(functionTools) ?? []),
      ...(shouldEnableBuiltInImageGeneration(agentConfig)
        ? [{ type: "image_generation" as const }]
        : []),
      ...(imageMode === "continuous"
        ? [
            {
              type: "image_generation" as const,
              action: "auto" as const,
              quality: imageProfile?.quality,
              output_format: imageProfile?.outputFormat,
            },
          ]
        : []),
    ];
    const requestBody = {
      ...bodyData,
      ...(tools.length ? { tools, tool_choice: bodyData.tool_choice ?? "auto" } : {}),
      stream: true,
    };

    const api = getApiEndpoint(agentConfig);
    const token = selectCurrentToken(getState() as RootState);
    logQuickChatPerfStage(quickChatPerfStartedAt, "openai-response-fetch-starting", {
      api,
      dialogKey,
    });
    attemptLoop:
    for (let attempt = 0; attempt <= MAX_INITIAL_STREAM_RETRIES; attempt += 1) {
      const response = await performFetchRequest({
        agentConfig,
        api,
        bodyData: requestBody,
        currentServer: selectRuntimeCurrentServer(getState() as RootState),
        signal,
        token,
      });
      logQuickChatPerfStage(quickChatPerfStartedAt, "openai-response-fetch-response", {
        ok: response.ok,
        status: response.status,
        dialogKey,
      });
      activeMessageMetadata = withImageGenerationStage(
        activeMessageMetadata,
        "generating"
      );
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
        state.content = `[错误: ${errorMessage}]`;
        await finalize();
        return buildMeta();
      }

      reader = response.body?.getReader();
      if (!reader) {
        if (canRetryInitialResponseAttempt(attempt, false, null)) {
          resetStateForRetry();
          await waitForInitialStreamRetry(1_500, signal);
          continue;
        }
        await finalize();
        return buildMeta();
      }

      const parseSSE = createSSEParser();
      const decoder = new TextDecoder();
      let finishReason: string | null = null;
      let loggedFirstStreamChunk = false;
      let loggedFirstParsedEvent = false;
      let loggedFirstVisibleDelta = false;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (canRetryInitialResponseAttempt(attempt, loggedFirstVisibleDelta, finishReason)) {
              await safeCancel(reader);
              reader = undefined;
              resetStateForRetry();
              await waitForInitialStreamRetry(1_500, signal);
              continue attemptLoop;
            }
            const meta = await processToolCalls();
            return {
              ...meta,
              finishReason: meta.finishReason ?? finishReason,
            };
          }

          if (!loggedFirstStreamChunk) {
            loggedFirstStreamChunk = true;
            logQuickChatPerfStage(
              quickChatPerfStartedAt,
              "openai-response-first-stream-chunk",
              { dialogKey, byteLength: value.byteLength }
            );
          }

          const chunk = decoder.decode(value, { stream: true });
          const events = parseSSE(chunk);
          if (events.length > 0 && !loggedFirstParsedEvent) {
            loggedFirstParsedEvent = true;
            logQuickChatPerfStage(
              quickChatPerfStartedAt,
              "openai-response-first-sse-event",
              { dialogKey, eventCount: events.length }
            );
          }
          const eventList = Array.isArray(events) ? events : [events];

          for (const event of eventList) {
            if (event?.usage) {
              state.usage = updateTotalUsage(state.usage, event.usage);
            }

            if (event?.type === "error" || event?.error) {
              const streamError = new Error(getStreamErrorMessage(event));
              if (
                canRetryInitialResponseAttempt(attempt, loggedFirstVisibleDelta, finishReason) &&
                isRetryableInitialStreamError(streamError)
              ) {
                await safeCancel(reader);
                reader = undefined;
                resetStateForRetry();
                await waitForInitialStreamRetry(1_500, signal);
                continue attemptLoop;
              }
              state.content += `\n[Error: ${getStreamErrorMessage(event)}]`;
              await finalize();
              return buildMeta();
            }

            switch (event?.type) {
              case "response.output_text.delta":
                if (event.delta) {
                  state.content += event.delta;
                  state.contentBuffer = seg(state.content);
                  if (!loggedFirstVisibleDelta) {
                    loggedFirstVisibleDelta = true;
                    logQuickChatPerfStage(
                      quickChatPerfStartedAt,
                      "openai-response-first-visible-delta",
                      { dialogKey }
                    );
                  }
                  flush();
                }
                break;
              case "response.reasoning.delta":
                if (event.delta?.text) {
                  state.reasoning += event.delta.text;
                  flush();
                }
                break;
              case "response.reasoning.done":
                if (event.text) {
                  state.reasoning += event.text;
                  flush();
                }
                break;
              case "response.output_item.added":
              case "response.output_item.done": {
                const item = event.item;
                if (!state.content) {
                  const itemText = extractTextFromOutputItem(item);
                  if (itemText) {
                    state.content = itemText;
                    state.contentBuffer = seg(state.content);
                    if (!loggedFirstVisibleDelta) {
                      loggedFirstVisibleDelta = true;
                      logQuickChatPerfStage(
                        quickChatPerfStartedAt,
                        "openai-response-first-visible-delta",
                        { dialogKey }
                      );
                    }
                    flush();
                  }
                }
                if (item?.type === "function_call") {
                  ensureToolCall(state, item.call_id || item.id, {
                    id: item.call_id || item.id,
                    function: {
                      name: item.name || "",
                      arguments:
                        typeof item.arguments === "string" ? item.arguments : "",
                    },
                  });
                }
                break;
              }
              case "response.function_call_arguments.delta": {
                const key = event.call_id || event.item_id || `${event.output_index ?? 0}`;
                const toolCall = ensureToolCall(state, key, {
                  id: event.call_id || key,
                  function: { name: event.name || "", arguments: "" },
                });
                toolCall.function.arguments += event.delta ?? "";
                break;
              }
              case "response.function_call_arguments.done": {
                const key = event.call_id || event.item_id || `${event.output_index ?? 0}`;
                ensureToolCall(state, key, {
                  id: event.call_id || key,
                  function: {
                    name: event.name || "",
                    arguments:
                      typeof event.arguments === "string"
                        ? event.arguments
                        : typeof event.output?.arguments === "string"
                          ? event.output.arguments
                          : "",
                  },
                });
                break;
              }
              case "response.completed":
                state.completedResponse = event.response ?? null;
                finishReason =
                  event.response?.status === "completed"
                    ? "stop"
                    : event.response?.status ?? null;
                if (event.response?.usage) {
                  state.usage = updateTotalUsage(state.usage, event.response.usage);
                }
                break;
              case "response.failed":
                state.content += `\n[API Failed: ${event.response?.error?.message || "unknown"}]`;
                finishReason = "error";
                await finalize();
                return buildMeta(false, false, finishReason);
              case "response.incomplete":
                state.content += `\n[Incomplete: ${event.response?.incomplete_details?.reason || "unknown"}]`;
                finishReason = "incomplete";
                await finalize();
                return buildMeta(false, false, finishReason);
              default:
                break;
            }
          }
        }
      } catch (error: any) {
        if (
          canRetryInitialResponseAttempt(attempt, loggedFirstVisibleDelta, finishReason) &&
          isRetryableInitialStreamError(
            error ?? new Error("response stream ended before first visible delta")
          )
        ) {
          await safeCancel(reader);
          reader = undefined;
          resetStateForRetry();
          await waitForInitialStreamRetry(1_500, signal);
          continue;
        }
        throw error;
      }
    }
  } catch (error: any) {
    state.content +=
      error?.name === "AbortError"
        ? "[用户中断]"
        : `[异常: ${error?.message || "unknown"}]`;
    await finalize();
    return buildMeta(false, false, "error");
  } finally {
    logQuickChatPerfStage(quickChatPerfStartedAt, "openai-response-stream-finished", {
      dialogKey,
    });
    dispatch(removeActiveController({ messageId, dialogKey }));
    await safeCancel(reader);
  }
};
