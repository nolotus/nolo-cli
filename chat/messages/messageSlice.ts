// 文件路径: chat/messages/messageSlice.ts

/*
 * ==================================================================
 *  /chat/messages/messageSlice.ts
 * ==================================================================
 */

import {
  asyncThunkCreator,
  buildCreateSlice,
  createSelector,
  createEntityAdapter,
  type PayloadAction,
  type EntityState,
} from "@reduxjs/toolkit";
import { addReferenceKeysAction } from "../dialog/actions/addReferenceKeysAction";
import type { RootState } from "../../app/store";
import { getRuntimeServerContext } from "../../database/runtimeServerContext";
import { DataType } from "../../create/types";
import { remove, write, patch, selectById as selectDbRecordById } from "../../database/dbSlice";
import type { Message } from "./types";
import { selectUserId } from "../../auth/authSlice";
import { fetchAndCacheMessages } from "./fetchAndCacheMessages";
import { createDialogMessageKeyAndId } from "../../database/keys";
import { extractCustomId } from "../../core/prefix";
import type { DialogConfig } from "../../app/types";
import { updateDialogTitle, updateTokens } from "../dialog/dialogSlice";
import { updateDialogSummaryAction } from "../dialog/actions/updateDialogSummaryAction";
import {
  normalizeAssistantContentBuffer,
  serializeMessageContent,
} from "./messageContent";
import {
  appendSaveFailureToContent,
  finalizeAssistantMessageContent,
} from "./messageContract";
import { inferAssistantActivityCompletionMetadata } from "./activityCompletion";
import { estimateMissingUsage } from "../../ai/token/missingUsageEstimate";
import {
  countImageGenerationOutputsInContent,
  isOpenAIBuiltInImageGenerationAgent,
  withImageGenerationCount,
} from "../../ai/token/openaiImageGenerationUsage";
import { resolveHandleSendMessageContext } from "../dialog/actions/handleSendMessageResolver";


const OLDER_LOAD_LIMIT = 30;

const isValidMessage = (msg: unknown): msg is Message =>
  !!msg && typeof msg === "object" && typeof (msg as Message).id === "string";

export interface MessageSliceState {
  currentDialogId: string | null;
  dialogStateById: Record<string, MessageDialogState>;
}

export interface MessageDialogState {
  msgs: EntityState<Message>;
  firstStreamProcessed: boolean;
  isLoadingInitial: boolean;
  isLoadingOlder: boolean;
  hasMoreOlder: boolean;
  error: Error | null;
  lastStreamTimestamp: number;
  currentInitMsgsRequestId?: string;
  currentLoadOlderRequestId?: string;
}

const createSliceWithThunks = buildCreateSlice({
  creators: { asyncThunk: asyncThunkCreator },
});

const messagesAdapter = createEntityAdapter<Message>({
  selectId: (message) => message.id,
  sortComparer: (a, b) => a.id.localeCompare(b.id),
});

const GLOBAL_MESSAGE_DIALOG_ID = "__global__";

const createEmptyMessageDialogState = (): MessageDialogState => ({
  msgs: messagesAdapter.getInitialState(),
  firstStreamProcessed: false,
  isLoadingInitial: false,
  isLoadingOlder: false,
  hasMoreOlder: true,
  error: null,
  lastStreamTimestamp: 0,
  currentInitMsgsRequestId: undefined,
  currentLoadOlderRequestId: undefined,
});

const initialState: MessageSliceState = {
  currentDialogId: null,
  dialogStateById: {
    [GLOBAL_MESSAGE_DIALOG_ID]: createEmptyMessageDialogState(),
  },
};

// messageStreamEnd 的 payload 类型
interface MessageStreamEndPayload {
  finalContentBuffer: any[];
  totalUsage: any;
  msgKey: string;
  agentConfig: any;
  dialogId: string;
  dialogKey: string;
  messageId: string;
  reasoningBuffer: string;
  spaceId?: string;
  messageMetadata?: Partial<Message>;
  toolCalls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

type DialogScopedMessage = Message & { dialogId?: string };
type DialogScopedStreamingMessage = Partial<Message> & {
  id: string;
  dialogId?: string;
};

type MessageScopePayload = { dialogId?: string; dialogKey?: string; all?: boolean };

const getLatestUserInputForUnderstanding = (
  state: RootState,
  dialogId: string
): string | null => {
  const messages = selectAllMsgs(state, dialogId);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "user") continue;
    const serialized = serializeMessageContent(message.content, "[图片]")?.trim();
    if (serialized) return serialized;
  }
  return null;
};

const getDialogSpaceIdForUnderstanding = (
  state: RootState,
  dialogKey?: string
): string | undefined => {
  if (!dialogKey) return undefined;
  const dialog = selectDbRecordById(state, dialogKey) as DialogConfig | undefined;
  return typeof dialog?.spaceId === "string" ? dialog.spaceId : undefined;
};

export const captureUnderstandingFromCompletedUiTurn = async (input: {
  state: RootState;
  db?: any;
  agentKey?: string | null;
  dialogId: string;
  dialogKey?: string;
  spaceId?: string;
  assistantText: string;
  toolCalls?: MessageStreamEndPayload["toolCalls"];
}): Promise<void> => {
  if (input.assistantText.trim() === "") return;
  if (input.toolCalls && input.toolCalls.length > 0) return;
  if (!input.agentKey) return;

  const latestUserInput = getLatestUserInputForUnderstanding(
    input.state,
    input.dialogId
  );
  if (!latestUserInput) return;

  const { captureUnderstandingMemoryFromDialog } = await import("../../ai/memory/understanding");
  await captureUnderstandingMemoryFromDialog({
    db: input.db,
    userId: selectUserId(input.state),
    spaceId:
      input.spaceId ??
      getDialogSpaceIdForUnderstanding(input.state, input.dialogKey),
    agentKey: input.agentKey,
    dialogId: input.dialogId,
    userInput: latestUserInput,
    trace: [
      {
        role: "assistant",
        content: input.assistantText,
      } as Message,
    ],
  });
};

const resolveMessageDialogId = (
  state: Pick<MessageSliceState, "currentDialogId">,
  dialogId?: string | null,
  dialogKey?: string | null
) =>
  dialogId ??
  (dialogKey ? extractCustomId(dialogKey) : null) ??
  state.currentDialogId ??
  GLOBAL_MESSAGE_DIALOG_ID;

const ensureMessageDialogState = (
  state: MessageSliceState,
  dialogId?: string | null,
  dialogKey?: string | null
): MessageDialogState => {
  const resolvedDialogId = resolveMessageDialogId(state, dialogId, dialogKey);
  if (!state.dialogStateById) {
    state.dialogStateById = {
      [GLOBAL_MESSAGE_DIALOG_ID]: createEmptyMessageDialogState(),
    };
  }
  if (!state.dialogStateById[resolvedDialogId]) {
    state.dialogStateById[resolvedDialogId] = createEmptyMessageDialogState();
  }
  return state.dialogStateById[resolvedDialogId];
};

const getMessageDialogState = (
  state: MessageSliceState,
  dialogId?: string | null,
  dialogKey?: string | null
): MessageDialogState => {
  const dialogStateById = state.dialogStateById ?? {};
  const resolvedDialogId = resolveMessageDialogId(state, dialogId, dialogKey);
  const bucket = dialogStateById[resolvedDialogId];
  if (bucket) return bucket;

  const legacyMsgs = (state as any).msgs;
  if (legacyMsgs && typeof legacyMsgs === "object") {
    return {
      msgs: legacyMsgs,
      firstStreamProcessed: (state as any).firstStreamProcessed ?? false,
      isLoadingInitial: (state as any).isLoadingInitial ?? false,
      isLoadingOlder: (state as any).isLoadingOlder ?? false,
      hasMoreOlder: (state as any).hasMoreOlder ?? true,
      error: (state as any).error ?? null,
      lastStreamTimestamp: (state as any).lastStreamTimestamp ?? 0,
      currentInitMsgsRequestId: (state as any).currentInitMsgsRequestId,
      currentLoadOlderRequestId: (state as any).currentLoadOlderRequestId,
    };
  }

  return createEmptyMessageDialogState();
};

const inferDialogIdFromDbKey = (dbKey?: string): string | null => {
  if (!dbKey) return null;
  const parts = dbKey.split("-");
  if (parts.length >= 4 && parts[0] === DataType.DIALOG && parts[2] === "msg") {
    return parts[1];
  }
  return null;
};

const inferDialogIdFromMessage = (
  message: Partial<Message> & { dialogId?: string }
): string | null => message.dialogId ?? inferDialogIdFromDbKey(message.dbKey);

export const buildEditedMessageContent = (
  originalContent: Message["content"],
  nextText: string
): Message["content"] => {
  const trimmedText = nextText.trim();

  if (typeof originalContent === "string") {
    return trimmedText;
  }

  if (Array.isArray(originalContent)) {
    const nextParts = originalContent.filter(
      (part) => part && typeof part === "object" && part.type !== "text"
    );

    if (trimmedText) {
      nextParts.unshift({ type: "text", text: trimmedText } as any);
    }

    return nextParts;
  }

  return trimmedText;
};

const findDialogIdByMessageId = (
  state: MessageSliceState,
  messageId: string
): string | null => {
  for (const [dialogId, dialogState] of Object.entries(state.dialogStateById)) {
    if (dialogState.msgs.entities[messageId]) {
      return dialogId;
    }
  }
  return null;
};

const findDialogIdByMessageDbKey = (
  state: MessageSliceState,
  dbKey: string
): string | null => {
  for (const [dialogId, dialogState] of Object.entries(state.dialogStateById)) {
    const hasDbKey = Object.values(dialogState.msgs.entities).some(
      (message) => message?.dbKey === dbKey
    );
    if (hasDbKey) {
      return dialogId;
    }
  }
  return inferDialogIdFromDbKey(dbKey);
};

const upsertOneMessage = (dialogState: MessageDialogState, message: Message) => {
  dialogState.msgs = messagesAdapter.upsertOne(dialogState.msgs, message);
};

const upsertManyMessages = (
  dialogState: MessageDialogState,
  messages: Message[]
) => {
  dialogState.msgs = messagesAdapter.upsertMany(dialogState.msgs, messages);
};

const addOneMessage = (dialogState: MessageDialogState, message: Message) => {
  dialogState.msgs = messagesAdapter.addOne(dialogState.msgs, message);
};

const updateOneMessage = (
  dialogState: MessageDialogState,
  payload: { id: string; changes: Partial<Message> }
) => {
  dialogState.msgs = messagesAdapter.updateOne(dialogState.msgs, payload);
};

const updateManyMessages = (
  dialogState: MessageDialogState,
  payload: Array<{ id: string; changes: Partial<Message> }>
) => {
  dialogState.msgs = messagesAdapter.updateMany(dialogState.msgs, payload);
};

const removeOneMessage = (dialogState: MessageDialogState, messageId: string) => {
  dialogState.msgs = messagesAdapter.removeOne(dialogState.msgs, messageId);
};

const removeAllMessages = (dialogState: MessageDialogState) => {
  dialogState.msgs = messagesAdapter.removeAll(dialogState.msgs);
};

const setAllMessages = (dialogState: MessageDialogState, messages: Message[]) => {
  dialogState.msgs = messagesAdapter.setAll(dialogState.msgs, messages);
};

export const messageSlice = createSliceWithThunks({
  name: "message",
  initialState,
  reducers: (create) => ({
    addUserMessage: create.reducer<DialogScopedMessage>((state, action) => {
      const { dialogId, ...message } = action.payload;
      const dialogState = ensureMessageDialogState(
        state,
        dialogId ?? inferDialogIdFromMessage(action.payload)
      );
      upsertOneMessage(dialogState, {
        ...message,
        isStreaming: false,
      });
    }),

    messageStreaming: create.reducer<DialogScopedStreamingMessage>(
      (state, action) => {
        const { dialogId, ...message } = action.payload;
        const dialogState = ensureMessageDialogState(
          state,
          dialogId ?? inferDialogIdFromMessage(action.payload)
        );
        upsertOneMessage(dialogState, {
          isStreaming: true,
          content: "",
          thinkContent: "",
          ...message,
        });
        dialogState.firstStreamProcessed = true;
        dialogState.lastStreamTimestamp = Date.now();
      }
    ),

    resetMsgs: create.reducer((state, action: PayloadAction<MessageScopePayload | undefined>) => {
      if (action.payload?.all) {
        state.dialogStateById = {
          [GLOBAL_MESSAGE_DIALOG_ID]: createEmptyMessageDialogState(),
        };
        state.currentDialogId = null;
        return;
      }

      const dialogId = resolveMessageDialogId(
        state,
        action.payload?.dialogId,
        action.payload?.dialogKey
      );
      delete state.dialogStateById[dialogId];

      if (dialogId === state.currentDialogId) {
        state.currentDialogId = null;
      }

      if (!state.dialogStateById[GLOBAL_MESSAGE_DIALOG_ID]) {
        state.dialogStateById[GLOBAL_MESSAGE_DIALOG_ID] =
          createEmptyMessageDialogState();
      }
    }),

    clearAllStreaming: create.reducer((state, action: PayloadAction<MessageScopePayload | undefined>) => {
      const targetStates = action.payload?.all
        ? Object.values(state.dialogStateById)
        : [getMessageDialogState(state, action.payload?.dialogId, action.payload?.dialogKey)];

      targetStates.forEach((dialogState) => {
        const updates = Object.values(dialogState.msgs.entities)
          .filter((m) => m?.isStreaming)
          .map((m) => ({ id: m!.id, changes: { isStreaming: false } }));
        if (updates.length > 0) {
          updateManyMessages(dialogState, updates);
        }
      });
    }),

    removeTransientMessage: create.reducer(
      (state, action: PayloadAction<string | { id: string; dialogId?: string }>) => {
        const payload =
          typeof action.payload === "string"
            ? { id: action.payload }
            : action.payload;
        const dialogId =
          payload.dialogId ?? findDialogIdByMessageId(state, payload.id);
        const dialogState = ensureMessageDialogState(state, dialogId);
        removeOneMessage(dialogState, payload.id);
      }
    ),

    addToolMessage: create.reducer<Message & { dialogId?: string }>((state, action) => {
      const dialogState = ensureMessageDialogState(
        state,
        inferDialogIdFromMessage(action.payload)
      );
      addOneMessage(dialogState, action.payload);
    }),

    updateToolMessage: create.reducer<{
      id: string;
      changes: Partial<Message>;
      dialogId?: string;
    }>((state, action) => {
      const dialogState = ensureMessageDialogState(
        state,
        action.payload.dialogId ?? findDialogIdByMessageId(state, action.payload.id)
      );
      updateOneMessage(dialogState, action.payload);
    }),

    removeMessagesByIds: create.reducer<{
      ids: string[];
      dialogId?: string;
    }>((state, action) => {
      const dialogState = ensureMessageDialogState(state, action.payload.dialogId);
      dialogState.msgs = messagesAdapter.removeMany(dialogState.msgs, action.payload.ids);
    }),



    prepareAndPersistMessage: create.asyncThunk(
      async (
        args: {
          message: Omit<Message, "id" | "dbKey" | "userId">;
          dialogConfig: DialogConfig;
        },
        thunkApi
      ) => {
        const { message, dialogConfig } = args;
        const { getState, dispatch, rejectWithValue } = thunkApi;
        const state = getState() as RootState;

        if (!dialogConfig) {
          return rejectWithValue("Missing dialogConfig");
        }

        const dialogKey = dialogConfig.dbKey || dialogConfig.id;
        const dialogId = extractCustomId(dialogKey);
        const userId = selectUserId(state);

        const { key: messageDbKey, messageId } =
          createDialogMessageKeyAndId(dialogId);

        const fullMessage: Message = {
          ...message,
          id: messageId,
          dbKey: messageDbKey,
          userId,
        };

        // 提取并保存引用 keys
        dispatch(
          addReferenceKeysAction({
            content: message.content,
            dialogKey,
          })
        ).catch((err) => console.error("Failed to add refs:", err));

        dispatch(messageSlice.actions.addUserMessage({ ...fullMessage, dialogId }));

        const { controller, ...messageToWrite } = fullMessage;
        dispatch(
          write({
            data: { ...messageToWrite, type: DataType.MSG },
            customKey: fullMessage.dbKey,
          })
        );

        return fullMessage;
      }
    ),

    prepareAndPersistUserMessage: create.asyncThunk(
      async (
        args: { userInput: string; dialogConfig: DialogConfig },
        thunkApi
      ) => {
        const { userInput, dialogConfig } = args;
        const { dispatch } = thunkApi;

        return dispatch(
          messageSlice.actions.prepareAndPersistMessage({
            message: {
              role: "user",
              content: userInput,
            },
            dialogConfig,
          })
        ).unwrap();
      }
    ),

    /**
     * 初始化当前对话消息
     */
    initMsgs: create.asyncThunk(
      async (
        {
          dialogId,
          dialogKey,
          limit,
          isNew,
        }: {
          dialogId: string;
          dialogKey?: string;
          limit: number;
          isNew?: boolean;
        },
        thunkApi
      ): Promise<Message[]> => {
        const { db } = thunkApi.extra;
        const { getState, signal } = thunkApi;

        const state = getState() as RootState;
        const { currentToken: token, remoteServers } =
          getRuntimeServerContext(state);
        const finalMessages = (
          await fetchAndCacheMessages({
            db,
            dialogId,
            dialogKey,
            limit,
            token,
            remoteServers,
            signal,
          })
        ).filter(isValidMessage);

        // --- Post-fetch check: Resume suspended summary tasks ---
        try {
          // Note: We need to find the dialogKey. We have dialogId.
          // Usually we can query state, but state might be stale if we just loaded.
          // However, dialogConfig should be in 'dbSlice' or 'dialogSlice' state.
          // Let's try to find it from the Redux state.
          const rootState = getState() as RootState;
          const { entities } = rootState.db; // Access raw DB entities if needed, or use selectors

          const dialogConfig = Object.values(entities).find(
            (entity): entity is DialogConfig => {
              if (!entity || typeof entity !== "object") return false;
              const value = entity as { type?: unknown; id?: unknown };
              return value.type === DataType.DIALOG && value.id === dialogId;
            }
          );

          if (dialogConfig && dialogConfig.summaryPending && dialogConfig.dbKey) {
            console.log("[initMsgs] Found suspended summary task, resuming...", dialogConfig.dbKey);
            // Clear the flag first to avoid loops (though action has lock)
            thunkApi.dispatch(patch({
              dbKey: dialogConfig.dbKey,
              changes: { summaryPending: false }
            }));

            // 2. Resume summary update (directly calling async function)
            updateDialogSummaryAction(
              { dialogKey: dialogConfig.dbKey, preFetchedMessages: finalMessages },
              thunkApi
            ).catch(err => console.error("Resume summary failed:", err));
          }
        } catch (e) {
          console.error("[initMsgs] Failed to resume summary:", e);
        }

        return finalMessages;
      },
      {
        pending: (state, action) => {
          const { dialogId, isNew } = action.meta.arg as {
            dialogId: string;
            limit: number;
            isNew?: boolean;
          };
          const dialogState = ensureMessageDialogState(state, dialogId);

          // 不在 pending 阶段清空消息，保留旧消息供用户查看，
          // 避免切换对话时出现消息列表短暂变空的闪烁。
          // 新消息将在 fulfilled 阶段原子性替换。
          if (isNew) {
            // 全新对话才需要立即清空（没有历史消息）
            // 只有内存中确实没有任何已有消息时才清空，防止抹除已经 optimistic 抢先写入的首条消息
            if (Object.keys(dialogState.msgs.entities).length === 0) {
              removeAllMessages(dialogState);
            }
          }

          dialogState.firstStreamProcessed = false;
          dialogState.isLoadingInitial = true;
          dialogState.isLoadingOlder = false;
          dialogState.hasMoreOlder = true;
          dialogState.error = null;
          dialogState.lastStreamTimestamp = 0;
          state.currentDialogId = dialogId;
          dialogState.currentInitMsgsRequestId = action.meta.requestId;
        },
        fulfilled: (state, action) => {
          const dialogState = ensureMessageDialogState(state, action.meta.arg.dialogId);
          if (dialogState.currentInitMsgsRequestId !== action.meta.requestId) {
            return;
          }

          dialogState.isLoadingInitial = false;
          if (action.meta.arg.isNew) {
            upsertManyMessages(dialogState, action.payload);
          } else {
            // 用从 DB 加载的消息原子性替换，确保不遗留已删除消息或旧的流式消息
            setAllMessages(dialogState, action.payload);
          }

          // Check for pending summary tasks and resume them
          // We need access to the dialog config. We can try to find it in the store via thunkAPI (not available here)
          // OR we can do a fire-and-forget logic if we had access to dispatch.
          // Since we are in a reducer, we CANNOT dispatch actions or access other slices easily.
          // The correct way is to use a Listener Middleware or AppThunk, but for minimal changes:
          // We can piggyback on the thunk's promise handling if we return extra data, but initMsgs returns Message[].
          // Alternatively, we use `initMsgs.fulfilled` in a separate listener or component.

          // BETTER: Do it in the component layer or use a thunk wrapper. 
          // However, for "minimal changes" requested by user:
          // We can try to do this in the `swallowNonAbortError` or logic inside the thunk? 
          // NO, the user moved logic OUT of the thunk body because of P1 error (empty state).
          // user said: "Move to initMsgs.fulfilled IS NOT POSSIBLE because it is a reducer".
          // Actually user said: "Remove from initMsgs async ... and use updateDialogSummaryAction with preFetchedMessages".
          // So we should put it BACK into the thunk body, but pass `allMessages` explicitly!

        },
        rejected: (state, action) => {
          const dialogState = ensureMessageDialogState(state, action.meta.arg.dialogId);
          if (dialogState.currentInitMsgsRequestId !== action.meta.requestId) {
            return;
          }

          dialogState.isLoadingInitial = false;

          if (action.meta?.aborted) {
            return;
          }

          dialogState.error =
            action.error instanceof Error
              ? action.error
              : new Error(String(action.error));
          console.error(`${action.type} failed:`, action.error);
        },
      }
    ),

    /**
     * 加载更早的历史消息
     */
    loadOlderMessages: create.asyncThunk(
      async (
        {
          dialogId,
          dialogKey,
          beforeKey,
          limit = OLDER_LOAD_LIMIT,
        }: { dialogId: string; dialogKey?: string; beforeKey?: string; limit?: number },
        thunkApi
      ): Promise<{ messages: Message[]; limit: number }> => {
        const { getState, extra, signal } = thunkApi;
        const { db } = extra;

        const state = getState() as RootState;
        const { currentToken: token, remoteServers } =
          getRuntimeServerContext(state);
        const messages = (
          await fetchAndCacheMessages({
            db,
            dialogId,
            dialogKey,
            limit,
            beforeKey,
            token,
            remoteServers,
            signal,
          })
        ).filter(isValidMessage);

        return { messages, limit };
      },
      {
        pending: (state, action) => {
          const dialogState = ensureMessageDialogState(state, action.meta.arg.dialogId);
          dialogState.isLoadingOlder = true;
          dialogState.error = null;
          dialogState.currentLoadOlderRequestId = action.meta.requestId;
        },
        fulfilled: (state, action) => {
          const dialogState = ensureMessageDialogState(state, action.meta.arg.dialogId);
          if (dialogState.currentLoadOlderRequestId !== action.meta.requestId) {
            return;
          }

          dialogState.isLoadingOlder = false;
          const { messages, limit } = action.payload;

          if (messages.length > 0) {
            upsertManyMessages(dialogState, messages);
          }
          if (messages.length < limit) {
            dialogState.hasMoreOlder = false;
          }
        },
        rejected: (state, action) => {
          const dialogState = ensureMessageDialogState(state, action.meta.arg.dialogId);
          if (dialogState.currentLoadOlderRequestId !== action.meta.requestId) {
            return;
          }

          dialogState.isLoadingOlder = false;

          if (action.meta?.aborted) {
            return;
          }

          dialogState.error =
            action.error instanceof Error
              ? action.error
              : new Error(String(action.error));
          console.error(`${action.type} failed:`, action.error);
        },
      }
    ),

    /**
     * 一条流式回复结束
     */
    messageStreamEnd: create.asyncThunk(
      async (payload: MessageStreamEndPayload, { dispatch, getState, extra }) => {
        const {
          finalContentBuffer,
          totalUsage,
          msgKey,
          agentConfig,
          dialogId,
          dialogKey,
          messageId,
          reasoningBuffer,
          toolCalls,
        } = payload;

        // 1. 先把 contentBuffer 中的 dataURL 图像上传为文件 URL
        const spaceId = payload.spaceId;
        const rawAgentName = typeof agentConfig?.name === "string" ? agentConfig.name.trim() : "";
        const normalizedContentBuffer = await normalizeAssistantContentBuffer(
          finalContentBuffer,
          dialogId,
          messageId,
          dispatch,
          getState,
          spaceId ? { spaceId, agentName: rawAgentName || undefined } : undefined
        );

        const finalUsageData =
          totalUsage && totalUsage.completion_tokens != null
            ? { completion_tokens: totalUsage.completion_tokens }
            : undefined;

        const {
          thinkContent,
          textContent,
          visibleContent: finalVisibleContent,
        } =
          finalizeAssistantMessageContent(
            normalizedContentBuffer,
            reasoningBuffer
          );
        const imageGenerationCount = countImageGenerationOutputsInContent(
          finalVisibleContent
        );
        const billedUsage =
          isOpenAIBuiltInImageGenerationAgent(agentConfig)
            ? withImageGenerationCount(totalUsage, imageGenerationCount)
            : totalUsage;
        const estimatedUsage = estimateMissingUsage({
          content: finalVisibleContent,
        });
        const billedEstimatedUsage =
          isOpenAIBuiltInImageGenerationAgent(agentConfig)
            ? withImageGenerationCount(estimatedUsage, imageGenerationCount)
            : estimatedUsage;

        // 从 Agent 配置里提取名称，写入消息（供后续多 Agent 视角使用）
        const rawName =
          typeof agentConfig?.name === "string"
            ? agentConfig.name.trim()
            : "";
        const agentName = rawName || undefined;
        const { imageGenerationState: _transientImageGenerationState, ...persistedMessageMetadata } =
          payload.messageMetadata ?? {};
        const {
          metadata: persistedMetadata,
          ...otherPersistedMessageMetadata
        } = persistedMessageMetadata;
        const shouldInferActivityCompletion =
          !(persistedMetadata as Record<string, unknown> | undefined)?.activity &&
          (!toolCalls || toolCalls.length === 0);
        const inferredActivityCompletionMetadata = shouldInferActivityCompletion
          ? inferAssistantActivityCompletionMetadata({
              messages: selectAllMsgs(getState() as RootState, dialogId),
              finalContent: finalVisibleContent,
            })
          : undefined;
        const finalMetadata =
          inferredActivityCompletionMetadata
            ? { ...(persistedMetadata ?? {}), ...inferredActivityCompletionMetadata }
            : persistedMetadata;

        const finalMessage: Message = {
          id: messageId,
          dbKey: msgKey,
          content: finalVisibleContent,
          thinkContent,
          role: "assistant",
          agentKey: agentConfig.dbKey,
          cybotKey: agentConfig.dbKey,
          usage: finalUsageData,
          isStreaming: false,
          ...otherPersistedMessageMetadata,
          ...(finalMetadata ? { metadata: finalMetadata } : {}),
          ...(agentName ? { agentName } : {}),
          ...(toolCalls && toolCalls.length > 0
            ? { tool_calls: toolCalls }
            : {}),
        };

        const { controller, ...messageToWrite } = finalMessage;

        dispatch(
          write({
            data: { ...messageToWrite, type: DataType.MSG },
            customKey: msgKey,
          })
        );

        if (totalUsage) {
          dispatch(
            updateTokens({
              dialogId,
              dialogKey,
              usage: billedUsage,
              agentConfig,
            })
          );
        } else if (agentConfig?.provider && agentConfig.provider !== "custom") {
          dispatch(
            updateTokens({
              dialogId,
              dialogKey,
              usage: billedEstimatedUsage,
              agentConfig,
            })
          );
          console.warn("[billing] Missing usage at messageStreamEnd; using estimated token update", {
            dialogId,
            dialogKey,
            provider: agentConfig.provider,
            model: agentConfig.model,
            endpointKey: agentConfig.endpointKey,
          });
        }

        const titleEligibleContent =
          serializeMessageContent(finalVisibleContent, "[图片]") ?? "";

        if (titleEligibleContent.trim() !== "") {
          dispatch(updateDialogTitle({ dialogKey, agentConfig }));
        }

        if (textContent.trim() !== "") {
          const messagesForSummary = [
            ...selectAllMsgs(getState() as RootState, dialogId),
            finalMessage,
          ];

          // 后台触发摘要更新（fire-and-forget，不阻塞主流程）
          updateDialogSummaryAction(
            {
              dialogKey,
              preFetchedMessages: messagesForSummary,
              force: !toolCalls || toolCalls.length === 0,
              reason:
                !toolCalls || toolCalls.length === 0
                  ? "task_completed"
                  : "context_budget",
            },
            { dispatch, getState }
          )
            .catch(err => console.error("Summary update failed:", err));

          // 提取并保存引用 keys (Assistant)
          dispatch(addReferenceKeysAction({
            content: finalVisibleContent,
            dialogKey
          })).catch(err => console.error("Failed to add assistant refs:", err));
        }

        await captureUnderstandingFromCompletedUiTurn({
          state: getState() as RootState,
          db: extra?.db,
          agentKey: agentConfig?.dbKey,
          dialogId,
          dialogKey,
          spaceId: payload.spaceId,
          assistantText: textContent,
          toolCalls,
        });

        return {
          id: messageId,
          content: finalMessage.content,
          thinkContent: finalMessage.thinkContent,
          usage: finalMessage.usage,
          agentKey: finalMessage.agentKey,
          cybotKey: finalMessage.cybotKey,
          tool_calls: (finalMessage as any).tool_calls,
          dialogId,
          agentName: finalMessage.agentName,
        };
      },
      {
        fulfilled: (state, action) => {
          const { dialogId, agentName } = action.payload as {
            dialogId: string;
            agentName?: string;
          };
          const dialogState = ensureMessageDialogState(state, dialogId);
          updateOneMessage(dialogState, {
            id: action.payload.id,
            changes: {
              isStreaming: false,
              imageGenerationState: undefined,
              content: action.payload.content,
              thinkContent: action.payload.thinkContent,
              usage: action.payload.usage,
              ...(action.payload.agentKey
                ? { agentKey: action.payload.agentKey }
                : {}),
              cybotKey: action.payload.cybotKey,
              ...(action.payload.tool_calls
                ? { tool_calls: action.payload.tool_calls }
                : {}),
              ...(agentName ? { agentName } : {}),
            },
          });

          // === 一轮流式回复结束后的 dev-reload 行为（仅限无工具调用的简单轮次）===
          if (
            typeof window !== "undefined" &&
            typeof window.location?.reload === "function"
          ) {
            const w = window as any;
            const isProd = w.__IS_PRODUCTION_BUILD__ === true;

            // Agent Loop / 工具调用场景下，本轮结束后很可能还会有后续轮次。
            // 为避免在中途刷新打断 Agent Loop，当本条消息包含 tool_calls 时，
            // 仅重置自举保护计数，不做自动 reload。
            const hasToolCalls =
              Array.isArray((action.payload as any).tool_calls) &&
              (action.payload as any).tool_calls.length > 0;

            // 结束一轮后，无论成败，清空自举保护计数
            if (typeof w.__DEV_RELOAD_SUPPRESS_COUNT__ === "number") {
              w.__DEV_RELOAD_SUPPRESS_COUNT__ = 0;
            }

            // 开发环境：如果这轮期间有 pending 的新构建，且本轮没有工具调用，自动刷新一次
            if (!hasToolCalls && !isProd && w.__DEV_RELOAD_PENDING__) {
              w.__DEV_RELOAD_PENDING__ = false;
              try {

                // 延迟到当前事件循环尾部，避免影响 Redux 自身逻辑
                setTimeout(() => {
                  window.location.reload();
                }, 0);
              } catch (e) {
                console.error("自动 dev reload 失败:", e);
              }
            }
          }
          // === dev-reload 逻辑结束 ===

          // === 新增结束 ===
        },
        rejected: (state, action) => {
          const arg = action.meta?.arg as MessageStreamEndPayload | undefined;
          const messageId = arg?.messageId;
          const dialogId = arg?.dialogId;

          console.error("messageStreamEnd failed:", action.error);
          if (messageId && dialogId) {
            const dialogState = ensureMessageDialogState(state, dialogId);
            updateOneMessage(dialogState, {
              id: messageId,
              changes: {
                isStreaming: false,
                imageGenerationState: undefined,
                content: appendSaveFailureToContent(
                  dialogState.msgs.entities[messageId]?.content
                ),
              },
            });
          }
        },
      }
    ),

    deleteMessage: create.asyncThunk(
      async (dbKey: string, { dispatch, getState }) => {
        const state = getState() as RootState;
        const dialogId = findDialogIdByMessageDbKey(state.message, dbKey);
        const dialogState = dialogId
          ? state.message.dialogStateById[dialogId]
          : undefined;
        const entities = dialogState?.msgs.entities ?? {};

        // 找到被删除的这条 message
        const msg = Object.values(entities).find((m) => m?.dbKey === dbKey);
        const msgId = msg?.id;

        // 默认只删除当前这条
        let extraRemoveId: string | undefined;
        let extraRemoveDbKey: string | undefined;

        // 如果是工具消息，尝试一并清理对应的「assistant tool stub」
        if (msg?.role === "tool" && msg.parentMessageId) {
          const parent = entities[msg.parentMessageId];

          if (parent && parent.role === "assistant") {
            const content = (parent as any).content;
            const toolCalls = (parent as any).tool_calls;

            const isAssistantToolStub =
              (
                content == null ||
                (typeof content === "string" && content.trim().length === 0) ||
                (Array.isArray(content) && content.length === 0)
              ) &&
              Array.isArray(toolCalls) &&
              toolCalls.length > 0;

            if (isAssistantToolStub) {
              const hasOtherToolMsgs = Object.values(entities).some(
                (m) =>
                  m &&
                  m.role === "tool" &&
                  m.parentMessageId === msg.parentMessageId &&
                  m.dbKey !== dbKey
              );

              if (!hasOtherToolMsgs) {
                extraRemoveId = parent.id;
                extraRemoveDbKey = parent.dbKey as string | undefined;
              }
            }
          }
        }

        // 先删当前这条
        await dispatch(remove(dbKey));

        // 再删 parent stub（如果需要）
        if (extraRemoveDbKey) {
          await dispatch(remove(extraRemoveDbKey));
        }

        return { id: msgId, extraRemoveId, dialogId };
      },
      {
        fulfilled: (state, action) => {
          const { id, extraRemoveId, dialogId } = action.payload as {
            id?: string;
            extraRemoveId?: string;
            dialogId?: string;
          };
          const dialogState = ensureMessageDialogState(state, dialogId);

          if (id) {
            removeOneMessage(dialogState, id);
          }
          if (extraRemoveId) {
            removeOneMessage(dialogState, extraRemoveId);
          }
        },
      }
    ),

    editUserMessageAndReplay: create.asyncThunk(
      async (
        args: {
          dialogKey?: string;
          messageId: string;
          originalContent: Message["content"];
          nextText: string;
          runtimeOptions?: any;
          targetAgentKey?: string;
          quickChatPerfStartedAt?: number;
        },
        thunkApi
      ) => {
        const { dispatch, getState, rejectWithValue } = thunkApi;

        try {
          const state = getState() as RootState;
          const dialogKey = args.dialogKey ?? state.dialog?.currentDialogKey;
          if (!dialogKey) {
            throw new Error("editUserMessageAndReplay: dialogKey is required.");
          }

          const dialogConfig = selectDbRecordById(state, dialogKey) as DialogConfig | null;
          if (!dialogConfig) {
            throw new Error("editUserMessageAndReplay: dialog config is missing.");
          }

          const dialogId = dialogConfig.id ?? extractCustomId(dialogKey);
          const messages = selectAllMsgs(state, dialogId);
          const targetIndex = messages.findIndex((message) => message.id === args.messageId);
          if (targetIndex < 0) {
            throw new Error("editUserMessageAndReplay: target message not found.");
          }

          const targetMessage = messages[targetIndex];
          if (!targetMessage || targetMessage.role !== "user") {
            throw new Error("只能编辑用户消息。");
          }

          if (messages.some((message) => message.isStreaming)) {
            throw new Error("请等待当前回复完成后再编辑历史消息。");
          }

          const nextContent = buildEditedMessageContent(
            args.originalContent ?? targetMessage.content,
            args.nextText
          );
          const trailingMessages = messages.slice(targetIndex + 1);

          dispatch(
            messageSlice.actions.updateToolMessage({
              id: targetMessage.id,
              dialogId,
              changes: {
                content: nextContent,
              },
            })
          );

          if (trailingMessages.length > 0) {
            dispatch(
              messageSlice.actions.removeMessagesByIds({
                dialogId,
                ids: trailingMessages.map((message) => message.id),
              })
            );
          }

          await dispatch(
            patch({
              dbKey: targetMessage.dbKey,
              changes: {
                content: nextContent,
              },
            })
          ).unwrap();

          await dispatch(
            patch({
              dbKey: dialogKey,
              changes: {
                summary: null,
                summarizedBeforeId: null,
                proactiveSummary: null,
                proactiveSummaryBeforeId: null,
              },
            })
          ).unwrap();

          for (const message of trailingMessages) {
            if (message?.dbKey) {
              await dispatch(remove(message.dbKey)).unwrap();
            }
          }

          const { agentKeyToUse, effectiveRuntimeOptions } =
            resolveHandleSendMessageContext({
              dialogConfig,
              targetAgentKey: args.targetAgentKey,
              runtimeOptions: args.runtimeOptions,
            });

          if (agentKeyToUse) {
            const { streamAgentChatTurn } = await import("../../ai/agent/agentSlice");
            await dispatch(
              streamAgentChatTurn({
                agentKey: agentKeyToUse,
                userInput: nextContent,
                dialogKey,
                parentMessageId: undefined,
                runtimeOptions: effectiveRuntimeOptions,
                quickChatPerfStartedAt: args.quickChatPerfStartedAt,
              })
            ).unwrap();
          }

          return {
            editedMessageId: targetMessage.id,
            removedMessageIds: trailingMessages.map((message) => message.id),
          };
        } catch (error) {
          return rejectWithValue(
            error instanceof Error ? error.message : String(error)
          );
        }
      }
    ),
  }),
  selectors: {
    selectCurrentDialogId: (state) => state.currentDialogId,
  },
});

const dialogMessageSelectors = messagesAdapter.getSelectors<MessageDialogState>(
  (dialogState) => dialogState.msgs
);

export const { selectCurrentDialogId } = messageSlice.selectors;

export const selectMessageState = (state: RootState) => state.message;

export const selectMessageDialogState = (
  state: RootState,
  dialogId?: string | null
) => getMessageDialogState(state.message, dialogId);

export const selectAllMsgs = (state: RootState, dialogId?: string | null) =>
  dialogMessageSelectors.selectAll(selectMessageDialogState(state, dialogId));

export const selectMsgById = (
  state: RootState,
  messageId: string,
  dialogId?: string | null
) => dialogMessageSelectors.selectById(
  getMessageDialogState(state.message, dialogId),
  messageId
);

export const selectTotalMsgs = (state: RootState, dialogId?: string | null) =>
  dialogMessageSelectors.selectTotal(selectMessageDialogState(state, dialogId));

export const selectFirstStreamProcessed = (
  state: RootState,
  dialogId?: string | null
) => selectMessageDialogState(state, dialogId).firstStreamProcessed;

export const selectIsLoadingInitial = (
  state: RootState,
  dialogId?: string | null
) => selectMessageDialogState(state, dialogId).isLoadingInitial;

export const selectIsLoadingOlder = (
  state: RootState,
  dialogId?: string | null
) => selectMessageDialogState(state, dialogId).isLoadingOlder;

export const selectHasMoreOlder = (
  state: RootState,
  dialogId?: string | null
) => selectMessageDialogState(state, dialogId).hasMoreOlder;

export const selectMessageError = (
  state: RootState,
  dialogId?: string | null
) => selectMessageDialogState(state, dialogId).error;

export const selectLastStreamTimestamp = (
  state: RootState,
  dialogId?: string | null
) => selectMessageDialogState(state, dialogId).lastStreamTimestamp;

export const selectMessagesLoadingState = createSelector(
  [
    (state: RootState, dialogId?: string | null) =>
      selectMessageDialogState(state, dialogId),
  ],
  (dialogState) => ({
    isLoadingInitial: dialogState.isLoadingInitial,
    isLoadingOlder: dialogState.isLoadingOlder,
    hasMoreOlder: dialogState.hasMoreOlder,
    error: dialogState.error,
  })
);

/**
 * 是否存在正在流式生成的消息（用于标题 / 状态展示）
 */
export const selectHasStreamingMessage = (
  state: RootState,
  dialogId?: string | null
) => selectAllMsgs(state, dialogId).some((m) => m.isStreaming);

/**
 * 最后一条 assistant 消息（用于通知）
 */
export const selectLastAssistantMessage = (
  state: RootState,
  dialogId?: string | null
) => {
  const msgs = selectAllMsgs(state, dialogId);
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const msg = msgs[i];
    if (msg && msg.role === "assistant") {
      return msg;
    }
  }
  return undefined;
};

export const {
  addUserMessage,
  messageStreaming,
  resetMsgs,
  clearAllStreaming,
  removeTransientMessage,
  prepareAndPersistMessage,
  prepareAndPersistUserMessage,
  initMsgs,
  loadOlderMessages,
  messageStreamEnd,
  deleteMessage,
  editUserMessageAndReplay,
  addToolMessage,
  updateToolMessage,
  removeMessagesByIds,
} = messageSlice.actions;


export default messageSlice.reducer;
