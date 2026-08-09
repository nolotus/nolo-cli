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
import { createDialogMessageKeyAndId } from "../../database/keys";
import type { CompletionFinishReason, Message } from "./types";
import { buildEditedMessageContent } from "./messageEditContent";
import { planDeleteMessageCascade } from "./messageDeleteCascade";
import { planEditUserMessageAndReplay } from "./messageEditReplayPlan";
import { resolveFinalizeTransientOnError } from "./messageFinalizeOnError";
import {
  resolveInitMsgsFulfilledWriteMode,
  resolveInitMsgsHasMoreOlder,
} from "./messageInitMsgsPolicy";
import { resolveInitMsgsSummaryResume } from "./messageInitMsgsSummaryResume";
import { isValidMessage } from "./messageValidation";
import { selectIdentityUserId } from "identity/selectors";
import { fetchAndCacheMessages, fetchAndCacheMessagesLocalFirst } from "./fetchAndCacheMessages";
import { toErrorMessage } from "../../core/errorMessage";
import { extractCustomId } from "../../core/prefix";
import { asTrimmedString } from "../../core/trimmedString";
import type { DialogConfig } from "../../app/types";
import { selectCurrentDialogKey, updateDialogTitle, updateTokens } from "../dialog/dialogSlice";
import { updateDialogSummaryAction } from "../dialog/actions/updateDialogSummaryAction";
import { normalizeAssistantContentBuffer } from "./messageContent";
import {
  appendSaveFailureToContent,
  finalizeAssistantMessageContent,
} from "./messageContract";
import { resolveHandleSendMessageContext } from "../dialog/actions/handleSendMessageResolver";
import { resolveMessageOwner } from "./resolveMessageOwner";
import { assemblePersistedUserMessage } from "./messageUserPersistAssemble";
import { assembleFinalAssistantMessage } from "./messageStreamEndAssemble";
import { applyMessageStreamingUpsert } from "./messageStreamApply";
import { resolveStreamEndBillingUsages } from "./messageStreamEndBilling";
import { resolveStreamEndFinalMetadata } from "./messageStreamEndFinalMetadata";
import { resolveStreamEndPostWritePolicy } from "./messageStreamEndPostWritePolicy";
import { prepareStreamEndPersistInputs } from "./messageStreamEndPersistPrep";
import {
  captureUnderstandingFromCompletedUiTurn as captureUnderstandingFromCompletedUiTurnCore,
} from "./messageUnderstandingCapture";
import {
  GLOBAL_MESSAGE_DIALOG_ID,
  deleteMessageSession,
  ensureMessageSession,
  getActiveMessageDialogId,
  getHasStreamingMessage,
  getMessageSession,
  markMessageStreamActivity,
  patchMessageSession,
  resetAllMessageSessions,
  setActiveMessageDialogId,
  setStreamingMessageId,
} from "./messageSessionStore";

export { buildEditedMessageContent } from "./messageEditContent";
export { resolveMessageOwner } from "./resolveMessageOwner";
export {
  GLOBAL_MESSAGE_DIALOG_ID,
  selectFirstStreamProcessed,
  selectIsLoadingInitial,
  selectIsLoadingOlder,
  selectHasMoreOlder,
  selectMessageError,
  selectLastStreamTimestamp,
  selectMessagesLoadingState,
  selectHasStreamingMessage,
  selectCurrentDialogId,
  useCurrentMessageDialogId,
  useFirstStreamProcessed,
  useIsLoadingInitial,
  useIsLoadingOlder,
  useHasMoreOlder,
  useMessageSessionError,
  useLastStreamTimestamp,
  useMessagesLoadingState,
  useHasStreamingMessage,
} from "./messageSessionStore";

const OLDER_LOAD_LIMIT = 30;

export interface MessageSliceState {
  dialogStateById: Record<string, MessageDialogState>;
}

/** Wave10: session flash lives in messageSessionStore; only msgs remain here. */
export interface MessageDialogState {
  msgs: EntityState<Message, string>;
}

const createSliceWithThunks = buildCreateSlice({
  creators: { asyncThunk: asyncThunkCreator },
});

const messagesAdapter = createEntityAdapter<Message, string>({
  selectId: (message) => message.id,
  sortComparer: (a, b) => a.id.localeCompare(b.id),
});

const createEmptyMessageDialogState = (): MessageDialogState => ({
  msgs: messagesAdapter.getInitialState() as EntityState<Message, string>,
});

const initialState: MessageSliceState = {
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
  /**
   * Provider 报告的收尾原因，由 streamAgentChatTurn 桌面分支从
   * streamResult.finish_reason 透传下来。assembleFinalAssistantMessage
   * 据此决定是否把 finishReason 写进最终 Message。
   */
  finishReason?: CompletionFinishReason;
}

type DialogScopedMessage = Message & { dialogId?: string };
type DialogScopedStreamingMessage = Partial<Message> & {
  id: string;
  dialogId?: string;
};

type MessageScopePayload = { dialogId?: string; dialogKey?: string; all?: boolean };

/** Thin adapter: fills `messages` from Redux so existing call sites stay stable. */
export const captureUnderstandingFromCompletedUiTurn = async (input: {
  state: any;
  agentKey?: string | null;
  dialogId: string;
  dialogKey?: string;
  spaceId?: string;
  assistantText: string;
  toolCalls?: MessageStreamEndPayload["toolCalls"];
  messages?: Message[];
}): Promise<void> =>
  captureUnderstandingFromCompletedUiTurnCore({
    ...input,
    messages:
      input.messages ??
      (selectAllMsgs(input.state, input.dialogId) as Message[]),
  });

const resolveMessageDialogId = (
  _state: unknown,
  dialogId?: string | null,
  dialogKey?: string | null
) =>
  dialogId ??
  (dialogKey ? extractCustomId(dialogKey) : null) ??
  getActiveMessageDialogId() ??
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
    return { msgs: legacyMsgs };
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
        const resolvedDialogId =
          dialogId ?? inferDialogIdFromMessage(action.payload);
        const dialogState = ensureMessageDialogState(state, resolvedDialogId);
        const existing = dialogState.msgs.entities[message.id];
        upsertOneMessage(
          dialogState,
          applyMessageStreamingUpsert(existing, message as Partial<Message> & { id: string })
        );
        // Wave11: keep the streaming index in lockstep with isStreaming.
        setStreamingMessageId(resolvedDialogId, message.id);
        markMessageStreamActivity(resolvedDialogId);
      }
    ),

    resetMsgs: create.reducer((state, action: PayloadAction<MessageScopePayload | undefined>) => {
      if (action.payload?.all) {
        state.dialogStateById = {
          [GLOBAL_MESSAGE_DIALOG_ID]: createEmptyMessageDialogState(),
        };
        resetAllMessageSessions();
        return;
      }

      const dialogId = resolveMessageDialogId(
        state,
        action.payload?.dialogId,
        action.payload?.dialogKey
      );
      delete state.dialogStateById[dialogId];
      deleteMessageSession(dialogId);

      if (dialogId === getActiveMessageDialogId()) {
        setActiveMessageDialogId(null);
      }

      if (!state.dialogStateById[GLOBAL_MESSAGE_DIALOG_ID]) {
        state.dialogStateById[GLOBAL_MESSAGE_DIALOG_ID] =
          createEmptyMessageDialogState();
      }
    }),

    clearAllStreaming: create.reducer((state, action: PayloadAction<MessageScopePayload | undefined>) => {
      const targetStates = action.payload?.all
        ? Object.entries(state.dialogStateById)
        : [[
            resolveMessageDialogId(
              state,
              action.payload?.dialogId,
              action.payload?.dialogKey
            ),
            getMessageDialogState(state, action.payload?.dialogId, action.payload?.dialogKey),
          ] as [string, MessageDialogState]];

      targetStates.forEach(([dialogId, dialogState]) => {
        const updates = Object.values(dialogState.msgs.entities)
          .filter((m) => m?.isStreaming)
          .map((m) => ({ id: m!.id, changes: { isStreaming: false } }));
        if (updates.length > 0) {
          updateManyMessages(dialogState, updates);
        }
        // Wave11: clear the streaming index for this dialog in lockstep.
        setStreamingMessageId(dialogId, null);
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
    // instead of wiping the trace. Decision rules live in messageFinalizeOnError
    // (Wave15); this reducer applies them + clears the streaming index.
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
        const decision = resolveFinalizeTransientOnError(
          existing,
          payload.error
        );
        if (decision.kind === "noop") return;
        if (decision.kind === "remove") {
          removeOneMessage(dialogState, payload.id);
          setStreamingMessageId(dialogId, null);
          return;
        }
        updateOneMessage(dialogState, {
          id: payload.id,
          changes: decision.changes,
        });
        setStreamingMessageId(dialogId, null);
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
        patchMessageSession(action.payload.dialogId, {
          isLoadingInitial: action.payload.isLoadingInitial,
        });
      }
    }),

    /**
     * Append a run-overlay presentation as a non-streaming assistant message.
     *
     * This is a pure UI presentation action — it does NOT trigger a new agent
     * turn, does NOT call the LLM, and is therefore not billed. The message
     * is upserted into the dialog's message list so the user sees the run
     * status snapshot at turn-end. A fresh message id/dbKey are minted from
     * the dialog id so repeated overlays across turns don't collide.
     *
     * The message is marked role:"assistant" with isStreaming:false. Callers
     * that want to keep it out of the LLM context can post-filter by the
     * `metadata.overlayMessage` flag set here.
     */
    appendOverlayMessage: create.reducer<{
      dialogKey: string;
      text: string;
    }>((state, action) => {
      const dialogId = extractCustomId(action.payload.dialogKey);
      if (!dialogId) return;
      const dialogState = ensureMessageDialogState(state, dialogId);
      const { key: msgKey, messageId } = createDialogMessageKeyAndId(dialogId);
      upsertOneMessage(dialogState, {
        id: messageId,
        dbKey: msgKey,
        role: "assistant",
        content: action.payload.text,
        isStreaming: false,
        metadata: { overlayMessage: true },
      } as Message);
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

        const { fullMessage } = assemblePersistedUserMessage({
          message,
          dialogId,
          dialogKey,
          currentAccountUserId,
          dialogConfigUserId:
            typeof dialogConfigUserId === "string" ? dialogConfigUserId : null,
        });
        const userId = fullMessage.userId;

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
        // Wave21: dialog 查找 + summaryPending/dbKey 判定抽到
        // `messageInitMsgsSummaryResume`（Redux-free core，可独立单测）。
        try {
          const rootState = getState() as any;
          const decision = resolveInitMsgsSummaryResume({
            entities: rootState.db?.entities,
            dialogId,
          });
          if (decision.resume) {
            console.log("[initMsgs] Found suspended summary task, resuming...", decision.dialogKey);
            thunkApi.dispatch(patch({ dbKey: decision.dialogKey, changes: { summaryPending: false } }));
            updateDialogSummaryAction(
              { dialogKey: decision.dialogKey, preFetchedMessages: finalMessages },
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

          ensureMessageSession(dialogId);
          setActiveMessageDialogId(dialogId);
          patchMessageSession(dialogId, {
            firstStreamProcessed: false,
            isLoadingInitial: true,
            isLoadingOlder: false,
            // Full-history init: no older page. Partial limit still allows load-older.
            hasMoreOlder:
              typeof limit === "number" && Number.isFinite(limit) && limit > 0,
            error: null,
            lastStreamTimestamp: 0,
            currentInitMsgsRequestId: action.meta.requestId,
          });
        },
        fulfilled: (state, action) => {
          const dialogId = action.meta.arg.dialogId;
          const dialogState = ensureMessageDialogState(state, dialogId);
          const session = getMessageSession(dialogId);
          if (session.currentInitMsgsRequestId !== action.meta.requestId) {
            return;
          }

          const limit = action.meta.arg.limit;
          patchMessageSession(dialogId, {
            currentInitMsgsRequestId: undefined,
            isLoadingInitial: false,
            hasMoreOlder: resolveInitMsgsHasMoreOlder({
              limit,
              fetchedCount: action.payload.length,
            }),
          });
          // Write mode policy: messageInitMsgsPolicy (Wave16). Streaming /
          // isNew → upsert so DB snapshot cannot wipe a live reply ("从0").
          const hasLocalStreaming =
            getHasStreamingMessage(dialogId) ||
            Object.values(dialogState.msgs.entities).some(
              (message) => message?.isStreaming
            );
          const writeMode = resolveInitMsgsFulfilledWriteMode({
            isNew: action.meta.arg.isNew,
            hasLocalStreaming,
          });
          if (writeMode === "upsert") {
            upsertManyMessages(dialogState, action.payload);
          } else {
            setAllMessages(dialogState, action.payload);
          }
        },
        rejected: (state, action) => {
          const dialogId = action.meta.arg.dialogId;
          ensureMessageDialogState(state, dialogId);
          const session = getMessageSession(dialogId);
          if (session.currentInitMsgsRequestId !== action.meta.requestId) {
            return;
          }

          if (action.meta?.aborted) {
            patchMessageSession(dialogId, {
              currentInitMsgsRequestId: undefined,
              isLoadingInitial: false,
            });
            return;
          }

          patchMessageSession(dialogId, {
            currentInitMsgsRequestId: undefined,
            isLoadingInitial: false,
            error:
              action.error instanceof Error
                ? action.error
                : new Error(String(action.error)),
          });
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
          const dialogId = action.meta.arg.dialogId;
          ensureMessageDialogState(state, dialogId);
          patchMessageSession(dialogId, {
            isLoadingOlder: true,
            error: null,
            currentLoadOlderRequestId: action.meta.requestId,
          });
        },
        fulfilled: (state, action) => {
          const dialogId = action.meta.arg.dialogId;
          const dialogState = ensureMessageDialogState(state, dialogId);
          const session = getMessageSession(dialogId);
          if (session.currentLoadOlderRequestId !== action.meta.requestId) {
            return;
          }

          const { messages, limit } = action.payload;
          patchMessageSession(dialogId, {
            isLoadingOlder: false,
            currentLoadOlderRequestId: undefined,
            ...(messages.length < limit ? { hasMoreOlder: false } : {}),
          });

          if (messages.length > 0) {
            upsertManyMessages(dialogState, messages);
          }
        },
        rejected: (state, action) => {
          const dialogId = action.meta.arg.dialogId;
          ensureMessageDialogState(state, dialogId);
          const session = getMessageSession(dialogId);
          if (session.currentLoadOlderRequestId !== action.meta.requestId) {
            return;
          }

          if (action.meta?.aborted) {
            patchMessageSession(dialogId, {
              isLoadingOlder: false,
              currentLoadOlderRequestId: undefined,
            });
            return;
          }

          patchMessageSession(dialogId, {
            isLoadingOlder: false,
            currentLoadOlderRequestId: undefined,
            error:
              action.error instanceof Error
                ? action.error
                : new Error(String(action.error)),
          });
          console.error(`${action.type} failed:`, action.error);
        },
      }
    ),

    /**
     * 一条流式回复结束
     */
    messageStreamEnd: create.asyncThunk(
      async (payload: MessageStreamEndPayload, { dispatch, getState }: any) => {
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
          finishReason,
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

        const {
          thinkContent,
          textContent,
          visibleContent: finalVisibleContent,
        } =
          finalizeAssistantMessageContent(
            normalizedContentBuffer,
            reasoningBuffer
          );
        const {
          billedUsage,
          billedEstimatedUsage,
          hasReportedUsage,
          titleEligible,
        } = resolveStreamEndBillingUsages({
          agentConfig,
          totalUsage,
          finalVisibleContent,
        });

        // Wave20: persist prep (usage / agentName / metadata split) extracted to
        // a Redux-free core. `rawAgentName` above is kept separate for normalize's
        // upload agentName so normalize input behavior is unchanged; the
        // agentName here is the one fed to `assemble`, equivalent to the former
        // second `asTrimmedString(agentConfig?.name)`.
        const {
          finalUsageData,
          agentName,
          persistedMetadata,
          otherPersistedMessageMetadata,
        } = prepareStreamEndPersistInputs({
          totalUsage,
          agentConfig,
          messageMetadata: payload.messageMetadata,
        });
        const { finalMetadata } = resolveStreamEndFinalMetadata({
          persistedMetadata,
          toolCalls,
          messages: selectAllMsgs(getState() as any, dialogId) as any,
          finalContent: finalVisibleContent,
        });

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

        const finalMessage: Message = assembleFinalAssistantMessage({
          messageId,
          msgKey,
          finalVisibleContent,
          thinkContent,
          agentConfig,
          finalUsageData,
          toolCalls,
          finishReason,
          otherPersistedMessageMetadata,
          finalMetadata,
          agentName,
          // Authoritative owner last so metadata cannot overwrite it.
          userId,
        });

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

        // Wave18: post-write dispatch policy (Redux-free pure decision).
        const {
          billingMode,
          updateTitle,
          updateSummary,
          summaryForce,
          summaryReason,
          addRefs,
        } = resolveStreamEndPostWritePolicy({
          hasReportedUsage,
          agentProvider: agentConfig?.provider,
          titleEligible,
          textContent,
          toolCalls,
        });

        if (billingMode === "reported") {
          dispatch(
            (updateTokens as any)({
              dialogId,
              dialogKey,
              usage: billedUsage,
              agentConfig,
            })
          );
        } else if (billingMode === "estimated") {
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

        if (updateTitle) {
          dispatch((updateDialogTitle as any)({ dialogKey, agentConfig }));
        }

        if (updateSummary) {
          const messagesForSummary = [
            ...selectAllMsgs(getState() as any, dialogId),
            finalMessage,
          ];

          // 后台触发摘要更新（fire-and-forget，不阻塞主流程）
          updateDialogSummaryAction(
            {
              dialogKey,
              preFetchedMessages: messagesForSummary,
              force: summaryForce,
              reason: summaryReason,
            },
            { dispatch, getState }
          )
            .catch(err => console.error("Summary update failed:", err));

          if (addRefs) {
            // 提取并保存引用 keys (Assistant)
            dispatch(addReferenceKeysAction({
              content: finalVisibleContent,
              dialogKey
            })).catch((err: unknown) => console.error("Failed to add assistant refs:", err));
          }
        }

        // Fire-and-forget: capture is now a server round-trip, and a
        // best-effort memory write must not add latency to turn completion.
        // Mirrors the summary update above.
        // `state` is a synchronous snapshot taken here, not read later inside
        // the promise, so a message the user sends while this is in flight
        // cannot shift which turn gets captured. Keep it that way — passing a
        // getter instead would reintroduce that race.
        captureUnderstandingFromCompletedUiTurn({
          state: getState() as any,
          agentKey: agentConfig?.dbKey,
          dialogId,
          dialogKey,
          spaceId: payload.spaceId,
          assistantText: textContent,
          toolCalls,
        }).catch((err: unknown) =>
          console.error("Understanding memory capture failed:", err)
        );

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
          // Wave11: stream ended cleanly; clear the streaming index.
          setStreamingMessageId(payload.dialogId, null);
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
          // Wave11: stream ended on error; clear the streaming index for this dialog.
          if (dialogId) {
            setStreamingMessageId(dialogId, null);
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
        // Wave15: cascade plan (tool → orphan assistant stub) is Redux-free core.
        const { id: msgId, extraRemoveId, extraRemoveDbKey } =
          planDeleteMessageCascade(msg, entities);

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
          const dialogKey = args.dialogKey ?? selectCurrentDialogKey(state);
          if (!dialogKey) {
            throw new Error("editUserMessageAndReplay: dialogKey is required.");
          }

          const dialogConfig = selectDbRecordById(state, dialogKey) as DialogConfig | null;
          if (!dialogConfig) {
            throw new Error("editUserMessageAndReplay: dialog config is missing.");
          }

          const dialogId = dialogConfig.id ?? extractCustomId(dialogKey);
          const messages = selectAllMsgs(state, dialogId);
          const plan = planEditUserMessageAndReplay({
            messages,
            messageId: args.messageId,
            originalContent: args.originalContent,
            nextText: args.nextText,
          });
          if (!plan.ok) {
            throw new Error(plan.message);
          }

          const { targetMessage, nextContent, trailingMessages } = plan;

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
  selectors: {},
});

messageActions = messageSlice.actions;

const dialogMessageSelectors = messagesAdapter.getSelectors<MessageDialogState>(
  (dialogState) => dialogState.msgs
);

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

// selectHasStreamingMessage is re-exported from ./messageSessionStore above
// (Wave11): reads the session store's streamingMessageId index instead of
// scanning Redux msgs. React UI should use useHasStreamingMessage so the
// module-store mutation triggers re-render.

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
  appendOverlayMessage,
} = messageSlice.actions as any;


export default messageSlice.reducer;
