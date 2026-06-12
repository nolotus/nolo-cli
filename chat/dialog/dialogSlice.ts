// 文件路径: chat/dialog/dialogSlice.ts

import {
  type PayloadAction,
  asyncThunkCreator,
  buildCreateSlice,
  createSelector,
} from "@reduxjs/toolkit";
import type { RootState } from "../../app/store";
import { getRuntimeServerContext } from "../../database/runtimeServerContext";
import type { Descendant } from "slate";
import { resetMsgs, clearAllStreaming } from "../messages/messageSlice";
import { extractCustomId } from "../../core/prefix";
import { patch, read, remove, selectById } from "../../database/dbSlice";

import type { DialogConfig, DialogGoalState } from "../../app/types";
import { clearPlan } from "../../ai/agent/planSlice";
import { clearWorkflow } from "../../ai/workflow/workflowSlice";

import { scheduleDeleteReplication } from "../../database/actions/replication";
import {
  buildDialogAttachmentPlan,
  extractFileContentIds,
  type DialogAttachmentMessage,
} from "./dialogAttachmentCleanup";

// 外部 Actions
import { updateTokensAction } from "./actions/updateTokensAction";
import { cleanupCliSessionForDialog } from "./actions/cleanupCliSession";

import { createKey } from "../../database/keys";
import { mergeDialogTokenStats } from "./dialogTokenStats";
import { getDialogAgentIds, getPrimaryDialogAgentId } from "./dialogAgents";
import { buildDialogGoal, getDialogGoalReport } from "./goal";

const collectKeys = async (prefix: string, db: any): Promise<string[]> => {
  const keys: string[] = [];
  let iterator = db.iterator({
    gte: prefix,
    lte: prefix + "\uffff",
  });

  if (iterator && typeof iterator.then === 'function') {
    iterator = await iterator;
  }

  for await (const [key] of iterator) {
    keys.push(key as string);
  }

  return keys;
};

const collectEntries = async (prefix: string, db: any): Promise<Array<[string, any]>> => {
  const entries: Array<[string, any]> = [];
  let iterator = db.iterator({
    gte: prefix,
    lte: prefix + "\uffff",
  });

  if (iterator && typeof iterator.then === "function") {
    iterator = await iterator;
  }

  for await (const [key, value] of iterator) {
    entries.push([key as string, value]);
  }

  return entries;
};

const dbGetOrNull = async (db: any, key: string) => {
  if (!db || typeof db.get !== "function") return null;
  try {
    return await db.get(key);
  } catch {
    return null;
  }
};

const readLocalFileMetadata = async (db: any, fileId: string) => {
  const direct = await dbGetOrNull(db, fileId);
  if (direct) return direct;
  const index = await dbGetOrNull(db, createKey("file", "id", fileId));
  const mainKey =
    typeof index?.mainKey === "string" && index.mainKey.trim()
      ? index.mainKey.trim()
      : null;
  return mainKey ? await dbGetOrNull(db, mainKey) : null;
};

type DeleteDialogPayload =
  | string
  | {
      dialogKey: string;
      includeAttachments?: boolean;
    };

const normalizeDeleteDialogPayload = (payload: DeleteDialogPayload) =>
  typeof payload === "string"
    ? { dialogKey: payload, includeAttachments: false }
    : {
        dialogKey: payload.dialogKey,
        includeAttachments: payload.includeAttachments === true,
      };

const deleteOwnedDialogAttachments = async (args: {
  db: any;
  dialogId: string;
  entries: Array<[string, any]>;
  thunkApi: any;
}) => {
  const messages: DialogAttachmentMessage[] = args.entries.map(([dbKey, value]) => ({
    ...(value && typeof value === "object" ? value : {}),
    dbKey,
  }));
  const fileIds = [...new Set(messages.flatMap((message) => extractFileContentIds(message)))];
  const metadataByFileId: Record<string, any> = {};
  const metadataReadFailures: Array<{ fileId: string; error: string }> = [];

  for (const fileId of fileIds) {
    const metadata = await readLocalFileMetadata(args.db, fileId);
    if (metadata) {
      metadataByFileId[fileId] = metadata;
    } else {
      metadataReadFailures.push({ fileId, error: "local file metadata not found" });
    }
  }

  const plan = buildDialogAttachmentPlan({
    dialogId: args.dialogId,
    messages,
    metadataByFileId,
    metadataReadFailures,
  });
  if (!plan.deleteCandidates.length) return plan;

  const { deleteFileAction } = await import("../../database/actions/deleteFile");
  for (const candidate of plan.deleteCandidates) {
    if (candidate.fileDbKey) {
      await deleteFileAction(candidate.fileDbKey, args.thunkApi);
    }
  }
  return plan;
};

const createSliceWithThunks = buildCreateSlice({
  creators: { asyncThunk: asyncThunkCreator },
});

const runCreateDialogAction = async (args: any, thunkApi: any) => {
  const { createDialogAction } = await import("./actions/createDialogAction");
  return createDialogAction(args, thunkApi);
};

const runCreateScheduledTaskAction = async (args: any, thunkApi: any) => {
  const { createScheduledTaskAction } = await import("./actions/createScheduledTaskAction");
  return createScheduledTaskAction(args, thunkApi);
};

const runUpdateDialogTitleAction = async (args: any, thunkApi: any) => {
  const { updateDialogTitleAction } = await import("./actions/updateDialogTitleAction");
  return updateDialogTitleAction(args, thunkApi);
};

const runAddCybotAction = async (args: any, thunkApi: any) => {
  const { addCybotAction } = await import("./actions/addCybotAction");
  return addCybotAction(args, thunkApi);
};

const runRemoveCybotAction = async (args: any, thunkApi: any) => {
  const { removeCybotAction } = await import("./actions/removeCybotAction");
  return removeCybotAction(args, thunkApi);
};

const runReplacePrimaryCybotAction = async (args: any, thunkApi: any) => {
  const { replacePrimaryCybotAction } = await import("./actions/replacePrimaryCybotAction");
  return replacePrimaryCybotAction(args, thunkApi);
};

const runRemoveDialogAgentAction = async (args: any, thunkApi: any) => {
  const { removeDialogAgentAction } = await import("./actions/removeDialogAgentAction");
  return removeDialogAgentAction(args, thunkApi);
};

const runSetPrimaryDialogAgentAction = async (args: any, thunkApi: any) => {
  const { setPrimaryDialogAgentAction } = await import("./actions/setPrimaryDialogAgentAction");
  return setPrimaryDialogAgentAction(args, thunkApi);
};

const runHandleSendMessageAction = async (args: any, thunkApi: any) => {
  const { handleSendMessageAction } = await import("./actions/handleSendMessageAction");
  return handleSendMessageAction(args, thunkApi);
};

// --- Interfaces ---

export interface PendingFile {
  id: string;
  name: string;
  /** Source content key included in the message attachment. */
  pageKey?: string;
  /** Source dialog key included in the message attachment. Prefer sourceDialogKey in new code. */
  dialogKey?: string;
  sourceDialogKey?: string;
  /** Target dialog runtime that should receive this pending attachment. */
  targetDialogKey?: string;
  /** @deprecated Use targetDialogKey. Kept for older pending attachment payloads. */
  runtimeDialogKey?: string;
  type:
    | "excel"
    | "docx"
    | "pdf"
    | "page"
    | "txt"
    | "dialog"
    | "table"
    | "image"
    | "file"
    | "agent"
    | "cybot"
    | "app"
    | "ocr_text";
  groupId?: string;
  ocrText?: string;  // ← 新增：OCR 识别结果
}

export interface CreatePagePayload {
  slateData: Descendant[];
  jsonData?: Record<string, any>[];
  title: string;
  type: "excel" | "docx" | "pdf" | "txt" | "table";
  fileId: string;
  size: number;
  groupId?: string;
  dialogKey?: string;
}

export interface PendingRawData {
  pageKey: string;
  jsonData: Record<string, any>[];
}

export interface TokenStats {
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
}

type LiveTokenUsagePayload = {
  input_tokens: number;
  output_tokens: number;
  cost?: number;
  dialogKey?: string;
};

type CreateDialogGoalPayload = {
  objective: string;
  tokenBudget?: number;
  dialogKey?: string;
  now?: number;
};

type CompleteDialogGoalPayload = {
  dialogKey?: string;
  now?: number;
};

export type LoopStopReason =
  | "done"         // 模型主动结束，无工具调用
  | "handoff"      // 移交给子 Agent
  | "pending"      // 等待用户确认
  | "timeout"      // 超时
  | "error";       // 异常

interface DialogState {
  currentDialogKey: string | null;
  /**
   * 多对话运行态桶：
   * - 现阶段先服务“网页端切换对话不停止”
   * - token / controller / queue /附件等按 dialogKey 隔离
   * - 未来桌面端若支持多窗口/多 tab，还需要补跨窗口 stop 语义与同步策略
   */
  dialogRuntimeByKey: Record<string, DialogRuntimeState>;
  isUpdatingMode: boolean;
}

interface DialogRuntimeState {
  tokens: TokenStats;
  goal?: DialogGoalState;
  pendingFiles: PendingFile[];
  activeControllers: Record<string, AbortController>;
  pendingRawData: Record<string, PendingRawData>;
  loopStopReason: LoopStopReason | null;
  /** 用户在 agent loop 运行期间发送的消息队列，loop 每轮结束后依次注入 */
  pendingUserInputQueue: string[];
}

// --- Initial State ---

const GLOBAL_DIALOG_RUNTIME_KEY = "__global__";

const createEmptyTokenStats = (): TokenStats => ({
  inputTokens: 0,
  outputTokens: 0,
  totalCost: 0,
});

const createEmptyDialogRuntimeState = (): DialogRuntimeState => ({
  tokens: createEmptyTokenStats(),
  pendingFiles: [],
  activeControllers: {},
  pendingRawData: {},
  loopStopReason: null,
  pendingUserInputQueue: [],
});

const resetDialogRuntimeSessionState = (runtime: DialogRuntimeState) => {
  runtime.tokens = createEmptyTokenStats();
  runtime.loopStopReason = null;
};

const resolveDialogRuntimeKey = (
  state: Pick<DialogState, "currentDialogKey">,
  dialogKey?: string | null
) => dialogKey ?? state.currentDialogKey ?? GLOBAL_DIALOG_RUNTIME_KEY;

const ensureDialogRuntimeState = (
  state: DialogState,
  dialogKey?: string | null
): DialogRuntimeState => {
  const runtimeKey = resolveDialogRuntimeKey(state, dialogKey);
  if (!state.dialogRuntimeByKey[runtimeKey]) {
    state.dialogRuntimeByKey[runtimeKey] = createEmptyDialogRuntimeState();
  }
  return state.dialogRuntimeByKey[runtimeKey];
};

const getDialogRuntimeState = (
  state: DialogState,
  dialogKey?: string | null
): DialogRuntimeState =>
  state.dialogRuntimeByKey[resolveDialogRuntimeKey(state, dialogKey)] ??
  createEmptyDialogRuntimeState();

const initialState: DialogState = {
  currentDialogKey: null,
  dialogRuntimeByKey: {
    [GLOBAL_DIALOG_RUNTIME_KEY]: createEmptyDialogRuntimeState(),
  },
  isUpdatingMode: false,
};

// --- Slice Definition ---

const dialogSlice = createSliceWithThunks({
  name: "dialog",
  initialState,
  reducers: (create) => ({
    // --- Thunks ---
    createPageAndAddReference: create.asyncThunk(
      async (payload: CreatePagePayload, { dispatch, rejectWithValue }) => {
        const { slateData, jsonData, title, type, fileId, groupId, dialogKey } = payload;
        try {
          const { createDoc } = await import("../../render/page/docSlice");
          const pageKey = await (dispatch as any)(
            createDoc({ slateData, title })
          ).unwrap();

          const newReference: PendingFile = {
            id: fileId,
            name: title,
            pageKey,
            dialogKey,
            type,
            groupId,
          };
          const newRawData = jsonData ? { pageKey, jsonData } : null;

          return { reference: newReference, rawData: newRawData, dialogKey };
        } catch (error) {
          console.error("创建页面或引用失败:", error);
          return rejectWithValue((error as Error).message);
        }
      },
      {
        fulfilled: (state, action) => {
          const runtime = ensureDialogRuntimeState(
            state,
            action.payload.dialogKey ?? action.meta.arg.dialogKey
          );
          runtime.pendingFiles.push(action.payload.reference);
          if (action.payload.rawData && action.payload.rawData.pageKey) {
            runtime.pendingRawData[action.payload.rawData.pageKey] =
              action.payload.rawData;
          }
        },
      }
    ),

    deleteDialog: create.asyncThunk(
      async (payload: DeleteDialogPayload, thunkApi) => {
        const { dialogKey, includeAttachments } = normalizeDeleteDialogPayload(payload);
        const { dispatch, getState, extra } = thunkApi;
        const { db } = extra;
        const state = getState() as RootState;
        const { currentServer, syncServers } = getRuntimeServerContext(state);
        const currentDialogKey = state.dialog.currentDialogKey;
        const currentDialogId = currentDialogKey
          ? extractCustomId(currentDialogKey)
          : null;
        const targetDialogId = extractCustomId(dialogKey);
        const targetDialogConfig = selectById(state, dialogKey) as DialogConfig | null;

        const isCurrentDialog =
          currentDialogId !== null && currentDialogId === targetDialogId;
        await cleanupCliSessionForDialog({ dispatch, getState }, targetDialogConfig);
        // --- 无论是否是当前对话，都从当前空间删除该内容 ---
        await (dispatch as any)(remove(dialogKey));
        const prefix = createKey("dialog", targetDialogId, "msg");
        const deletedEntries = includeAttachments
          ? await collectEntries(prefix, db)
          : [];
        const attachmentPlan =
          includeAttachments && targetDialogId
            ? await deleteOwnedDialogAttachments({
                db,
                dialogId: targetDialogId,
                entries: deletedEntries,
                thunkApi,
              })
            : null;
        const deletedIds = includeAttachments
          ? deletedEntries.map(([key]) => key)
          : await collectKeys(prefix, db);
        if (!deletedIds.length) return { dialogKey, isCurrentDialog, attachmentPlan };

        const ops = deletedIds.map((key) => ({ type: "del" as const, key }));

        await db.batch(ops);

        scheduleDeleteReplication({
          currentServer,
          syncServers,
          dbKey: targetDialogId,
          deleteOptions: { type: "messages" },
          state,
        });
        // --- 如果是当前对话，清理当前相关状态 ---
        if (isCurrentDialog) {
          await thunkApi.dispatch(resetMsgs());
          dispatch(dialogSlice.actions.clearPendingAttachments());
          dispatch(clearPlan());
          dispatch(clearWorkflow());
        }

        return { dialogKey, isCurrentDialog, attachmentPlan };
      },
      {
        fulfilled: (state, action) => {
          delete state.dialogRuntimeByKey[action.payload.dialogKey];
          if (action.payload.isCurrentDialog) {
            state.currentDialogKey = null;
          }
        },
      }
    ),

    initDialog: create.asyncThunk(
      async (id: string, { dispatch, signal, getState }) => {
        dispatch(dialogSlice.actions.clearPendingAttachments());
        dispatch(clearPlan());
        dispatch(clearWorkflow());
        const { currentServer: preferredServerOrigin } = getRuntimeServerContext(
          getState() as RootState
        );
        return await (dispatch as any)(
          read({
            dbKey: id,
            signal,
            preferredServerOrigin,
          })
        ).unwrap();
      },
      {
        pending: (state, action) => {
          state.currentDialogKey = action.meta.arg;
          const runtime = ensureDialogRuntimeState(state, action.meta.arg);
          resetDialogRuntimeSessionState(runtime);
        },
        fulfilled: (state, action) => {
          if (state.currentDialogKey === action.meta.arg) {
            // No-op
          }
        },
        rejected: (state, action) => {
          const isAborted =
            action.error.name === "AbortError" ||
            action.error.message === "Aborted";
          const isCurrentDialog = state.currentDialogKey === action.meta.arg;

          if (!isAborted && isCurrentDialog) {
            // Log the error but keep currentDialogKey set — the dialog key is
            // valid (it came from the space content list), we just couldn't load
            // the config doc (e.g. not synced to server yet or network error).
            // Keeping the key allows MessageInput to send and MessageList to
            // display messages independently.
            console.info("Failed to load dialog config:", action.error.message);
          }
        },
      }
    ),

    handleSendMessage: create.asyncThunk(runHandleSendMessageAction),

    abortAllMessages: create.asyncThunk(
      async (
        args: { dialogKey?: string; all?: boolean } | undefined,
        { getState, dispatch }
      ) => {
        /**
         * 产品约束说明：
         * - 当前网页端 stop 默认只停“当前对话”，避免切换对话时把后台任务一起杀掉
         * - `all: true` 仅用于 logout / 全局 reset 这类明确的系统级清理
         * - 未来桌面端若要支持“从任务中心停任意 dialog”，应在 UI 层显式传 dialogKey
         */
        const dialogState = (getState() as RootState).dialog;
        const runtimeStates = args?.all
          ? Object.values(dialogState.dialogRuntimeByKey)
          : [getDialogRuntimeState(dialogState, args?.dialogKey)];

        runtimeStates.forEach((runtimeState) => {
          Object.values(runtimeState.activeControllers).forEach((controller) =>
            controller.abort()
          );
        });
        dispatch(clearAllStreaming(args));
        dispatch(dialogSlice.actions.clearActiveControllers(args));
      }
    ),

    // Passthrough thunks for external actions
    updateTokens: create.asyncThunk(updateTokensAction, {
      fulfilled: (state, action) => {
        const dialogKey = action.meta.arg.dialogKey;
        if (!dialogKey) return;

        const runtime = state.dialogRuntimeByKey[dialogKey];
        if (!runtime) return;

        runtime.tokens.inputTokens = Math.max(
          0,
          runtime.tokens.inputTokens - (action.payload.input_tokens ?? 0)
        );
        runtime.tokens.outputTokens = Math.max(
          0,
          runtime.tokens.outputTokens - (action.payload.output_tokens ?? 0)
        );
        runtime.tokens.totalCost = Math.max(
          0,
          runtime.tokens.totalCost - (action.payload.cost ?? 0)
        );
      },
    }),
    saveDialogGoal: create.asyncThunk(
      async (
        payload: CreateDialogGoalPayload,
        { dispatch, getState }
      ) => {
        const state = getState() as RootState;
        const dialogKey = payload.dialogKey ?? state.dialog.currentDialogKey;
        if (!dialogKey) {
          throw new Error("Cannot save dialog goal without a dialog key.");
        }

        const goal = buildDialogGoal(payload);
        await (dispatch as any)(
          patch({
            dbKey: dialogKey,
            changes: { goal },
          })
        ).unwrap();

        return { dialogKey, goal };
      },
      {
        fulfilled: (state, action) => {
          const runtime = ensureDialogRuntimeState(state, action.payload.dialogKey);
          runtime.goal = action.payload.goal;
        },
      }
    ),
    saveCompletedDialogGoal: create.asyncThunk(
      async (
        payload: CompleteDialogGoalPayload | undefined,
        { dispatch, getState }
      ) => {
        const state = getState() as RootState;
        const dialogKey = payload?.dialogKey ?? state.dialog.currentDialogKey;
        if (!dialogKey) {
          throw new Error("Cannot complete dialog goal without a dialog key.");
        }

        const runtimeGoal =
          state.dialog.dialogRuntimeByKey[dialogKey]?.goal ?? null;
        const persistedDialog = selectById(state, dialogKey) as DialogConfig | null;
        const goal = runtimeGoal ?? persistedDialog?.goal ?? null;
        if (!goal) {
          throw new Error("Cannot complete dialog goal before one is created.");
        }

        const completedGoal: DialogGoalState = {
          ...goal,
          status: "complete",
          completedAt: payload?.now ?? Date.now(),
        };
        await (dispatch as any)(
          patch({
            dbKey: dialogKey,
            changes: { goal: completedGoal },
          })
        ).unwrap();

        return { dialogKey, goal: completedGoal };
      },
      {
        fulfilled: (state, action) => {
          const runtime = ensureDialogRuntimeState(state, action.payload.dialogKey);
          runtime.goal = action.payload.goal;
        },
      }
    ),
    createDialog: create.asyncThunk(runCreateDialogAction),
    createScheduledTask: create.asyncThunk(runCreateScheduledTaskAction),
    updateDialogTitle: create.asyncThunk(runUpdateDialogTitleAction),
    addCybot: create.asyncThunk(runAddCybotAction),
    removeCybot: create.asyncThunk(runRemoveCybotAction),
    replacePrimaryCybot: create.asyncThunk(runReplacePrimaryCybotAction),
    addDialogAgent: create.asyncThunk(runAddCybotAction),
    removeDialogAgent: create.asyncThunk(runRemoveDialogAgentAction),
    setPrimaryDialogAgent: create.asyncThunk(runSetPrimaryDialogAgentAction),

    // --- Reducers ---
    addPendingFile: create.reducer(
      (state, action: PayloadAction<PendingFile>) => {
        const targetRuntimeKey =
          action.payload.targetDialogKey ??
          action.payload.runtimeDialogKey ??
          (action.payload.type === "dialog" ? state.currentDialogKey : action.payload.dialogKey);
        const runtime = ensureDialogRuntimeState(state, targetRuntimeKey);
        if (!runtime.pendingFiles.some((f) => f.id === action.payload.id)) {
          runtime.pendingFiles.push(action.payload);
        }
      }
    ),

    removePendingFile: create.reducer(
      (state, action: PayloadAction<string>) => {
        const runtime = ensureDialogRuntimeState(state);
        const fileToRemove = runtime.pendingFiles.find(
          (f) => f.id === action.payload
        );
        if (fileToRemove) {
          if (fileToRemove.pageKey) {
            delete runtime.pendingRawData[fileToRemove.pageKey];
          }
          runtime.pendingFiles = runtime.pendingFiles.filter(
            (file) => file.id !== action.payload
          );
        }
      }
    ),

    clearPendingAttachments: create.reducer(
      (state, action: PayloadAction<{ dialogKey?: string; all?: boolean } | undefined>) => {
        if (action.payload?.all) {
          Object.values(state.dialogRuntimeByKey).forEach((runtime) => {
            runtime.pendingFiles = [];
            runtime.pendingRawData = {};
          });
          return;
        }
        const runtime = ensureDialogRuntimeState(state, action.payload?.dialogKey);
        runtime.pendingFiles = [];
        runtime.pendingRawData = {};
      }
    ),

    setLoopStopReason: create.reducer(
      (
        state,
        action: PayloadAction<{ reason: LoopStopReason | null; dialogKey?: string }>
      ) => {
        const runtime = ensureDialogRuntimeState(state, action.payload.dialogKey);
        runtime.loopStopReason = action.payload.reason;
      }
    ),

    clearDialogRuntimeState: create.reducer(
      (state, action: PayloadAction<{ dialogKey: string }>) => {
        delete state.dialogRuntimeByKey[action.payload.dialogKey];
      }
    ),

    createDialogGoal: create.reducer(
      (state, action: PayloadAction<CreateDialogGoalPayload>) => {
        const objective = action.payload.objective.trim();
        if (!objective) return;
        const runtime = ensureDialogRuntimeState(state, action.payload.dialogKey);
        const tokenBudget =
          typeof action.payload.tokenBudget === "number" &&
          Number.isFinite(action.payload.tokenBudget) &&
          action.payload.tokenBudget > 0
            ? Math.floor(action.payload.tokenBudget)
            : undefined;
        runtime.goal = {
          objective,
          status: "active",
          ...(tokenBudget ? { tokenBudget } : {}),
          createdAt: action.payload.now ?? Date.now(),
        };
      }
    ),

    completeDialogGoal: create.reducer(
      (state, action: PayloadAction<CompleteDialogGoalPayload | undefined>) => {
        const runtime = ensureDialogRuntimeState(state, action.payload?.dialogKey);
        if (!runtime.goal) return;
        runtime.goal = {
          ...runtime.goal,
          status: "complete",
          completedAt: action.payload?.now ?? Date.now(),
        };
      }
    ),

    addActiveController: create.reducer(
      (
        state,
        action: PayloadAction<{
          messageId: string;
          controller: AbortController;
          dialogKey?: string;
        }>
      ) => {
        const runtime = ensureDialogRuntimeState(state, action.payload.dialogKey);
        runtime.activeControllers[action.payload.messageId] =
          action.payload.controller;
      }
    ),

    removeActiveController: create.reducer(
      (
        state,
        action: PayloadAction<{ messageId: string; dialogKey?: string } | string>
      ) => {
        const payload =
          typeof action.payload === "string"
            ? { messageId: action.payload }
            : action.payload;
        const runtime = ensureDialogRuntimeState(state, payload.dialogKey);
        delete runtime.activeControllers[payload.messageId];
      }
    ),

    clearActiveControllers: create.reducer(
      (state, action: PayloadAction<{ dialogKey?: string; all?: boolean } | undefined>) => {
        if (action.payload?.all) {
          Object.values(state.dialogRuntimeByKey).forEach((runtime) => {
            runtime.activeControllers = {};
          });
          return;
        }
        const runtime = ensureDialogRuntimeState(state, action.payload?.dialogKey);
        runtime.activeControllers = {};
      }
    ),

    enqueueUserInput: create.reducer(
      (state, action: PayloadAction<string | { text: string; dialogKey?: string }>) => {
        const payload =
          typeof action.payload === "string"
            ? { text: action.payload }
            : action.payload;
        const runtime = ensureDialogRuntimeState(state, payload.dialogKey);
        runtime.pendingUserInputQueue.push(payload.text);
      }
    ),

    dequeueUserInput: create.reducer(
      (state, action: PayloadAction<{ dialogKey?: string } | undefined>) => {
        const runtime = ensureDialogRuntimeState(state, action.payload?.dialogKey);
        runtime.pendingUserInputQueue.shift();
      }
    ),

    clearPendingUserInputQueue: create.reducer(
      (state, action: PayloadAction<{ dialogKey?: string; all?: boolean } | undefined>) => {
        if (action.payload?.all) {
          Object.values(state.dialogRuntimeByKey).forEach((runtime) => {
            runtime.pendingUserInputQueue = [];
          });
          return;
        }
        const runtime = ensureDialogRuntimeState(state, action.payload?.dialogKey);
        runtime.pendingUserInputQueue = [];
      }
    ),

    tokenUsageLiveUpdate: create.reducer(
      (
        state,
        action: PayloadAction<LiveTokenUsagePayload>
      ) => {
        const runtime = ensureDialogRuntimeState(state, action.payload.dialogKey);
        runtime.tokens.inputTokens += action.payload.input_tokens;
        runtime.tokens.outputTokens += action.payload.output_tokens;
        runtime.tokens.totalCost += action.payload.cost ?? 0;
      }
    ),

    clearDialogState: create.reducer((state) => {
      const previousDialogKey = state.currentDialogKey;
      const previousRuntime = previousDialogKey
        ? state.dialogRuntimeByKey[previousDialogKey]
        : null;
      const globalRuntime = ensureDialogRuntimeState(state, GLOBAL_DIALOG_RUNTIME_KEY);

      if (previousRuntime) {
        if (previousRuntime.pendingFiles.length > 0) {
          globalRuntime.pendingFiles = previousRuntime.pendingFiles;
          previousRuntime.pendingFiles = [];
        }
        previousRuntime.pendingRawData = {};
        previousRuntime.pendingUserInputQueue = [];
      }
      state.currentDialogKey = null;
      globalRuntime.pendingRawData = {};
      globalRuntime.pendingUserInputQueue = [];
    }),
  }),
  selectors: {
    selectCurrentDialogKey: (state) => state.currentDialogKey,
    selectIsUpdatingMode: (state) => state.isUpdatingMode,
    selectDialogRuntimeByKey: (state, dialogKey?: string) =>
      getDialogRuntimeState(state, dialogKey),
    selectPendingFiles: (state, dialogKey?: string) =>
      getDialogRuntimeState(state, dialogKey).pendingFiles,
    selectActiveControllers: (state, dialogKey?: string) =>
      getDialogRuntimeState(state, dialogKey).activeControllers,
    selectPendingRawData: (state, dialogKey?: string) =>
      getDialogRuntimeState(state, dialogKey).pendingRawData,
    selectDialogRuntimeTokens: (state, dialogKey?: string) =>
      getDialogRuntimeState(state, dialogKey).tokens,
    selectDialogRuntimeGoal: (state, dialogKey?: string) =>
      getDialogRuntimeState(state, dialogKey).goal ?? null,
    selectTotalDialogTokens: (state, dialogKey?: string) =>
      getDialogRuntimeState(state, dialogKey).tokens,
    selectPendingRawDataByPageKey: (state, pageKey: string) =>
      getDialogRuntimeState(state).pendingRawData[pageKey],
    selectPendingUserInputQueue: (state, dialogKey?: string) =>
      getDialogRuntimeState(state, dialogKey).pendingUserInputQueue,
    selectLoopStopReason: (state, dialogKey?: string) =>
      getDialogRuntimeState(state, dialogKey).loopStopReason,
  },
});

// --- Actions and Reducer Exports ---
export const {
  createPageAndAddReference,
  addPendingFile,
  removePendingFile,
  clearPendingAttachments,
  clearDialogRuntimeState,
  initDialog,
  deleteDialog,
  updateTokens,
  saveDialogGoal,
  saveCompletedDialogGoal,
  clearDialogState,
  createDialog,
  createScheduledTask,
  createDialogGoal,
  completeDialogGoal,
  updateDialogTitle,
  addCybot,
  addDialogAgent,
  removeCybot,
  removeDialogAgent,
  replacePrimaryCybot,
  setPrimaryDialogAgent,
  handleSendMessage,
  addActiveController,
  removeActiveController,
  abortAllMessages,
  clearActiveControllers,
  tokenUsageLiveUpdate,
  setLoopStopReason,
  enqueueUserInput,
  dequeueUserInput,
  clearPendingUserInputQueue,
} = dialogSlice.actions;

export default dialogSlice.reducer;

// --- Selectors Exports ---
export const {
  selectCurrentDialogKey,
  selectIsUpdatingMode,
  selectPendingFiles,
  selectActiveControllers,
  selectDialogRuntimeByKey,
  selectLoopStopReason,
  selectPendingRawData,
  selectDialogRuntimeTokens,
  selectDialogRuntimeGoal,
  selectPendingRawDataByPageKey,
  selectPendingUserInputQueue,
} = dialogSlice.selectors;

export const selectCurrentDialogConfig = createSelector(
  (state: RootState) => state,
  selectCurrentDialogKey,
  (state, currentDialogKey) =>
    currentDialogKey
      ? (selectById(state, currentDialogKey) as DialogConfig | null)
      : null
);

export const selectCurrentDialogAgentIds = createSelector(
  selectCurrentDialogConfig,
  (dialogConfig) => getDialogAgentIds(dialogConfig)
);

export const selectCurrentPrimaryAgentId = createSelector(
  selectCurrentDialogConfig,
  (dialogConfig) => getPrimaryDialogAgentId(dialogConfig)
);

export const selectDialogConfigByKey = createSelector(
  (state: RootState) => state,
  (_: RootState, dialogKey?: string | null) => dialogKey,
  (state, dialogKey) =>
    dialogKey ? (selectById(state, dialogKey) as DialogConfig | null) : null
);

export const selectCurrentDialogTokens = createSelector(
  (state: RootState) => state,
  selectCurrentDialogConfig,
  (state: RootState) => selectDialogRuntimeTokens(state),
  (_state: RootState, dialogKey?: string) => dialogKey,
  (state, currentDialog, currentRuntimeTokens, dialogKey) => {
    if (dialogKey) {
      const dialogConfig = selectById(state, dialogKey) as DialogConfig | null;
      const runtimeTokens = selectDialogRuntimeTokens(state, dialogKey);
      return mergeDialogTokenStats(dialogConfig, runtimeTokens);
    }

    return mergeDialogTokenStats(currentDialog, currentRuntimeTokens);
  }
);

export const selectTotalDialogTokens = selectCurrentDialogTokens;

export const selectCurrentDialogGoalReport = createSelector(
  (state: RootState) => state,
  selectCurrentDialogConfig,
  (state: RootState) => selectDialogRuntimeTokens(state),
  (state: RootState) => selectDialogRuntimeGoal(state),
  (_state: RootState, dialogKey?: string) => dialogKey,
  (state, currentDialog, currentRuntimeTokens, currentRuntimeGoal, dialogKey) => {
    if (dialogKey) {
      const dialogConfig = selectById(state, dialogKey) as DialogConfig | null;
      const runtimeTokens = selectDialogRuntimeTokens(state, dialogKey);
      const runtimeGoal = selectDialogRuntimeGoal(state, dialogKey);
      return getDialogGoalReport(dialogConfig, runtimeTokens, runtimeGoal);
    }

    return getDialogGoalReport(
      currentDialog,
      currentRuntimeTokens,
      currentRuntimeGoal
    );
  }
);
