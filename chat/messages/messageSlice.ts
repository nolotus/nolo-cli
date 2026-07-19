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
import { DataType } from "../../create/types";
import { getRuntimeServerContext } from "../../database/runtimeServerContext";
import { remove, write, patch, selectById as selectDbRecordById } from "../../database/dbSlice";
import type { Message } from "./types";
import { selectIdentityUserId } from "../../app/identity/selectors";
import { fetchAndCacheMessages, fetchAndCacheMessagesLocalFirst } from "./fetchAndCacheMessages";
import { createDialogMessageKeyAndId } from "../../database/keys";
import { toErrorMessage } from "../../core/errorMessage";
import { extractCustomId } from "../../core/prefix";
import { asTrimmedString } from "../../core/trimmedString";
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
import { isAssistantToolStub } from "./web/assistantReplyPendingState";
import { estimateMissingUsage } from "../../ai/token/missingUsageEstimate";
import {
  countImageGenerationOutputsInContent,
  isOpenAIBuiltInImageGenerationAgent,
  withImageGenerationCount,
} from "../../ai/token/openaiImageGenerationUsage";
import { resolveHandleSendMessageContext } from "../dialog/actions/handleSendMessageResolver";
import { resolveMessageOwner } from "./resolveMessageOwner";

export { resolveMessageOwner } from "./resolveMessageOwner";

const OLDER_LOAD_LIMIT = 30;

const isValidMessage = (msg: unknown): msg is Message =>
  !!msg && typeof msg === "object" && typeof (msg as Message).id === "string";

export interface MessageSliceState {
  currentDialogId: string | null;
  dialogStateById: Record<string, MessageDialogState>;
}

export interface MessageDialogState {
  msgs: EntityState<Message, string>;
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

const messagesAdapter = createEntityAdapter<Message, string>({
  selectId: (message) => message.id,
  sortComparer: (a, b) => a.id.localeCompare(b.id),
});

const GLOBAL_MESSAGE_DIALOG_ID = "__global__";

const createEmptyMessageDialogState = (): MessageDialogState => ({
  msgs: messagesAdapter.getInitialState() as EntityState<Message, string>,
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
  state: any,
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
  state: any,
  dialogKey?: string
): string | undefined => {
  if (!dialogKey) return undefined;
  const dialog = selectDbRecordById(state, dialogKey) as DialogConfig | undefined;
  return typeof dialog?.spaceId === "string" ? dialog.spaceId : undefined;
};

export const captureUnderstandingFromCompletedUiTurn = async (input: {
  state: any;
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
    userId: selectIdentityUserId(input.state),
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
      } as any,
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

// Lazy accessor for this slice's own actions, used inside thunk bodies below.
// Referencing `messageSlice` directly in its own initializer creates a type
// inference cycle (TS7022); this indirection breaks the cycle while thunks
// still run after the slice is fully constructed.
let messageActions: any;

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
        } as Message);
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

    // Error-path finalizer: keep whatever the transient message already shows
    // instead of wiping the trace. Empty transients are removed (nothing to
    // show); non-empty ones stop streaming and get an error marker so the UI
    // renders the partial content alongside the error state.
    finalizeTransientMessageOnError: create.reducer(
      (
        state,
        action: PayloadAction<
          string | { id: string; dialogId?: string; error?: string }
        >
      ) => {
        const payload =
          typeof action.payload === "string"
            ? { id: action.payload }
            : action.payload;
        const dialogId =
          payload.dialogId ?? findDialogIdByMessageId(state, payload.id);
        const dialogState = ensureMessageDialogState(state, dialogId);
        const existing = dialogState.msgs.entities[payload.id];
        if (!existing) return;
        const content = existing.content;
        const hasContent =
          typeof content === "string"
            ? content.trim().length > 0
            : Array.isArray(content) && content.length > 0;
        if (!hasContent) {
          removeOneMessage(dialogState, payload.id);
          return;
        }
        updateOneMessage(dialogState, {
          id: payload.id,
          changes: {
            isStreaming: false,
            metadata: {
              ...((existing as any).metadata ?? {}),
              error: true,
              ...(payload.error ? { message: payload.error } : {}),
            },
          } as Partial<Message>,
        });
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

    setMessages: create.reducer<{
      dialogId: string;
      messages: Message[];
      isLoadingInitial?: boolean;
      /**
       * Default merges (upsert, keeps unknown ids).
       * Pass replace:true only for full-history reloads that must drop orphans.
       */
      replace?: boolean;
    }>((state, action) => {
      const dialogState = ensureMessageDialogState(state, action.payload.dialogId);
      if (action.payload.replace) {
        setAllMessages(dialogState, action.payload.messages);
      } else {
        upsertManyMessages(dialogState, action.payload.messages);
      }
      if (action.payload.isLoadingInitial !== undefined) {
        dialogState.isLoadingInitial = action.payload.isLoadingInitial;
      }
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
        const state = getState() as any;

        if (!dialogConfig) {
          return rejectWithValue("Missing dialogConfig");
        }

        const dialogKey = dialogConfig.dbKey || dialogConfig.id;
        const dialogId = extractCustomId(dialogKey);
        const currentAccountUserId =
          (selectIdentityUserId(state) as string | null | undefined) ?? null;
        const dialogConfigUserId = (dialogConfig as { userId?: unknown })
          .userId;
        const userId = resolveMessageOwner({
          dialogConfigUserId:
            typeof dialogConfigUserId === "string" ? dialogConfigUserId : null,
          dialogKey,
          currentAccountUserId,
        });

        const { key: messageDbKey, messageId } =
          createDialogMessageKeyAndId(dialogId);

        const fullMessage: Message = {
          ...message,
          id: messageId,
          dbKey: messageDbKey,
          userId,
        };

        // 提取并保存引用 keys（fire-and-forget；保留既有顺序）
        dispatch(
          addReferenceKeysAction({
            content: message.content,
            dialogKey,
          })
        ).catch((err) => console.error("Failed to add refs:", err));

        // 先做 Redux optimistic add（保持既有顺序，避免回放行为变化）
        dispatch(messageActions.addUserMessage({ ...fullMessage, dialogId }));

        const { controller, ...messageToWrite } = fullMessage;
        // 必须先 await 本地持久化成功，handleSendMessageAction 已经 await 此 thunk，
        // 才能保证用户消息落盘后 provider 才开始流式回复。
        await dispatch(
          write({
            data: { ...messageToWrite, type: DataType.MSG },
            customKey: fullMessage.dbKey,
            userId,
          })
        ).unwrap();

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
          messageActions.prepareAndPersistMessage({
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
          /** Positive page size, or omit/0 for full history (default). */
          limit?: number;
          isNew?: boolean;
        },
        thunkApi
      ): Promise<Message[]> => {
        const { db } = (thunkApi.extra as { db: any });
        const { getState, signal, dispatch } = thunkApi;

        const state = getState() as any;
        const { currentToken: token, remoteServers } =
          getRuntimeServerContext(state);

        const { localMessages, remotePromise, earlyReturned } =
          await fetchAndCacheMessagesLocalFirst({
            db,
            dialogId,
            dialogKey,
            limit,
            token,
            remoteServers,
            signal,
          });

        const validLocalMessages = localMessages.filter(isValidMessage);

        if (earlyReturned) {
          dispatch(
            messageActions.setMessages({
              dialogId,
              messages: validLocalMessages,
              isLoadingInitial: false,
            })
          );

          // Remote revalidation continues in the background. Do not block
          // bootstrap completion; the UI already shows local messages.
          remotePromise
            .then((finalMessages) => {
              dispatch(
                messageActions.setMessages({
                  dialogId,
                  messages: finalMessages.filter(isValidMessage),
                })
              );
            })
            .catch((err) => {
              console.error("[initMsgs] background remote revalidate failed:", err);
            });

          return validLocalMessages;
        }

        const finalMessages = (await remotePromise).filter(isValidMessage);

        // --- Post-fetch check: Resume suspended summary tasks ---
        try {
          const rootState = getState() as any;
          const { entities } = rootState.db;

          const dialogConfig = Object.values(entities).find(
            (entity): entity is DialogConfig => {
              if (!entity || typeof entity !== "object") return false;
              const value = entity as { type?: unknown; id?: unknown };
              return value.type === DataType.DIALOG && value.id === dialogId;
            }
          );

          if (dialogConfig && dialogConfig.summaryPending && dialogConfig.dbKey) {
            console.log("[initMsgs] Found suspended summary task, resuming...", dialogConfig.dbKey);
            thunkApi.dispatch(patch({
              dbKey: dialogConfig.dbKey,
              changes: { summaryPending: false }
            }));

            updateDialogSummaryAction(
              { dialogKey: dialogConfig.dbKey, preFetchedMessages: finalMessages },
              thunkApi
            ).catch((err) => console.error("Resume summary failed:", err));
          }
        } catch {
          console.error("[initMsgs] Failed to resume summary");
        }

        return finalMessages;
      },
      {
        pending: (state, action) => {
          const { dialogId, isNew, limit } = action.meta.arg as {
            dialogId: string;
            limit?: number;
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
          // Full-history init: no older page. Partial limit still allows load-older.
          dialogState.hasMoreOlder =
            typeof limit === "number" && Number.isFinite(limit) && limit > 0;
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

          dialogState.currentInitMsgsRequestId = undefined;
          dialogState.isLoadingInitial = false;
          const limit = action.meta.arg.limit;
          if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
            dialogState.hasMoreOlder = action.payload.length >= limit;
          } else {
            dialogState.hasMoreOlder = false;
          }
          // Same policy as setMessages: new dialogs merge (stream/optimistic rows
          // may already exist); established dialogs replace from authoritative fetch.
          if (action.meta.arg.isNew) {
            upsertManyMessages(dialogState, action.payload);
          } else {
            setAllMessages(dialogState, action.payload);
          }
        },
        rejected: (state, action) => {
          const dialogState = ensureMessageDialogState(state, action.meta.arg.dialogId);
          if (dialogState.currentInitMsgsRequestId !== action.meta.requestId) {
            return;
          }

          dialogState.currentInitMsgsRequestId = undefined;
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
        const { db } = extra as { db: any };

        const state = getState() as any;
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
      async (payload: MessageStreamEndPayload, { dispatch, getState, extra }: any) => {
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
        const rawAgentName = asTrimmedString(agentConfig?.name);
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
        const rawName = asTrimmedString(agentConfig?.name);
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
              messages: selectAllMsgs(getState() as any, dialogId) as any,
              finalContent: finalVisibleContent,
            })
          : undefined;
        const finalMetadata =
          inferredActivityCompletionMetadata
            ? { ...(persistedMetadata ?? {}), ...inferredActivityCompletionMetadata }
            : persistedMetadata;

        // Same owner authority as prepareAndPersistMessage: dialogConfig.userId
        // → dialog key (dialog-local-*) → logged-in account → "local".
        // Logged-out local dialogs must stamp userId=local so writeAction and
        // the shared device-local replication guard keep records on-device.
        const state = getState() as any;
        const dialogConfig = selectDbRecordById(state, dialogKey) as
          | DialogConfig
          | null
          | undefined;
        const dialogConfigUserId = (dialogConfig as { userId?: unknown } | null)
          ?.userId;
        const currentAccountUserId =
          (selectIdentityUserId(state) as string | null | undefined) ?? null;
        const userId = resolveMessageOwner({
          dialogConfigUserId:
            typeof dialogConfigUserId === "string" ? dialogConfigUserId : null,
          dialogKey,
          currentAccountUserId,
        });

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
          // Authoritative owner last so metadata cannot overwrite it.
          userId,
        };

        const { controller, ...messageToWrite } = finalMessage;

        // Terminal assistant write must settle before this thunk fulfills.
        // Await + unwrap so rejected write takes the standard rejected path
        // (save-failure content / isStreaming:false) instead of a false fulfilled.
        await dispatch(
          write({
            data: { ...messageToWrite, type: DataType.MSG },
            customKey: msgKey,
            userId,
          })
        ).unwrap();

        if (totalUsage) {
          dispatch(
            (updateTokens as any)({
              dialogId,
              dialogKey,
              usage: billedUsage,
              agentConfig,
            })
          );
        } else if (agentConfig?.provider && agentConfig.provider !== "custom") {
          dispatch(
            (updateTokens as any)({
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
          dispatch((updateDialogTitle as any)({ dialogKey, agentConfig }));
        }

        if (textContent.trim() !== "") {
          const messagesForSummary = [
            ...selectAllMsgs(getState() as any, dialogId),
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
          })).catch((err: unknown) => console.error("Failed to add assistant refs:", err));
        }

        await captureUnderstandingFromCompletedUiTurn({
          state: getState() as any,
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
          dbKey: msgKey,
          role: "assistant" as const,
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
          const payload = action.payload as Message & { dialogId: string };
          const dialogState = ensureMessageDialogState(state, payload.dialogId);
          const existing = dialogState.msgs.entities[payload.id];
          upsertOneMessage(dialogState, {
            ...(existing ?? {}),
            ...payload,
            role: payload.role ?? existing?.role ?? "assistant",
            dbKey: payload.dbKey ?? existing?.dbKey ?? action.meta.arg.msgKey,
            isStreaming: false,
            imageGenerationState: undefined,
          } as Message);
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
        const state = getState() as any;
        const dialogId = findDialogIdByMessageDbKey(state.message, dbKey);
        const dialogState = dialogId
          ? state.message.dialogStateById[dialogId]
          : undefined;
        const entities = (dialogState?.msgs.entities ?? {}) as Record<string, Message | undefined>;

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
            if (isAssistantToolStub(parent)) {
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
          const state = getState() as any;
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
            messageActions.updateToolMessage({
              id: targetMessage.id,
              dialogId,
              changes: {
                content: nextContent,
              },
            })
          );

          if (trailingMessages.length > 0) {
            dispatch(
              messageActions.removeMessagesByIds({
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

          await Promise.all(
            trailingMessages.map((m) =>
              m?.dbKey ? dispatch(remove(m.dbKey)).unwrap() : Promise.resolve(),
            ),
          );

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
          return rejectWithValue(toErrorMessage(error));
        }
      }
    ),
  }),
  selectors: {
    selectCurrentDialogId: (state) => state.currentDialogId,
  },
});

messageActions = messageSlice.actions;

const dialogMessageSelectors = messagesAdapter.getSelectors<MessageDialogState>(
  (dialogState) => dialogState.msgs
);

export const { selectCurrentDialogId } = messageSlice.selectors;

export const selectMessageState = (state: any) => state.message;

export const selectMessageDialogState = (
  state: any,
  dialogId?: string | null
) => getMessageDialogState(state.message, dialogId);

// 用 createSelector 包裹，避免 dialogMessageSelectors.selectAll 每次返回新数组引用
// 导致 useSelector 检测到引用变化而无限重渲染
export const selectAllMsgs = createSelector(
  [
    (state: any, dialogId?: string | null) =>
      selectMessageDialogState(state, dialogId),
  ],
  (dialogState) => dialogMessageSelectors.selectAll(dialogState)
);

export const selectMsgById = (
  state: any,
  messageId: string,
  dialogId?: string | null
) => dialogMessageSelectors.selectById(
  getMessageDialogState(state.message, dialogId),
  messageId
);

export const selectTotalMsgs = (state: any, dialogId?: string | null) =>
  dialogMessageSelectors.selectTotal(selectMessageDialogState(state, dialogId));

export const selectFirstStreamProcessed = (
  state: any,
  dialogId?: string | null
) => selectMessageDialogState(state, dialogId).firstStreamProcessed;

export const selectIsLoadingInitial = (
  state: any,
  dialogId?: string | null
) => selectMessageDialogState(state, dialogId).isLoadingInitial;

export const selectIsLoadingOlder = (
  state: any,
  dialogId?: string | null
) => selectMessageDialogState(state, dialogId).isLoadingOlder;

export const selectHasMoreOlder = (
  state: any,
  dialogId?: string | null
) => selectMessageDialogState(state, dialogId).hasMoreOlder;

export const selectMessageError = (
  state: any,
  dialogId?: string | null
) => selectMessageDialogState(state, dialogId).error;

export const selectLastStreamTimestamp = (
  state: any,
  dialogId?: string | null
) => selectMessageDialogState(state, dialogId).lastStreamTimestamp;

export const selectMessagesLoadingState = createSelector(
  [
    (state: any, dialogId?: string | null) =>
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
  state: any,
  dialogId?: string | null
) => selectAllMsgs(state, dialogId).some((m) => m.isStreaming);

/**
 * 最后一条 assistant 消息（用于通知）
 */
export const selectLastAssistantMessage = (
  state: any,
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

// cast: buildCreateSlice async thunks 会推断成 void|AsyncThunk|ActionCreator 联合
export const {
  addUserMessage,
  messageStreaming,
  setMessages,
  resetMsgs,
  clearAllStreaming,
  removeTransientMessage,
  finalizeTransientMessageOnError,
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
} = messageSlice.actions as any;


export default messageSlice.reducer;
