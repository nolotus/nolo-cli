// 文件路径: chat/dialog/dialogSlice.ts
// Wave9: dialogRuntimeByKey 已剥到 dialogRuntimeStore.ts。
// 本 slice 只保留 currentDialogKey / configError / isUpdatingMode 与 CRUD/send thunks。

import {
  asyncThunkCreator,
  buildCreateSlice,
  createSelector,
} from "@reduxjs/toolkit";
import type { DialogConfig } from "../../app/types";
import { isAbortError } from "../../core/abortError";
import { getRuntimeServerContext } from "../../database/runtimeServerContext";
import { clearAllStreaming } from "../messages/messageSlice";
import { read, selectById } from "../../database/dbSlice";

import { clearWorkflow } from "../../ai/workflow/workflowStore";

import { updateTokensAction } from "./actions/updateTokensAction";

import { mergeDialogTokenStats } from "./dialogTokenStats";
import { getDialogAgentIds, getPrimaryDialogAgentId } from "./dialogAgents";
import { deleteDialogThunk } from "./deleteDialogOrchestration";
import type { CreatePagePayload, PendingFile } from "./dialogRuntimeTypes";
import {
  abortActiveControllers,
  addPageReferenceToRuntime,
  applyClearDialogStateRuntime,
  applyUpdateTokensFulfilled,
  clearActiveControllers,
  clearPendingAttachments,
  deleteDialogRuntime,
  getDialogRuntimeTokens,
  resetDialogRuntimeSessionState,
  setActiveDialogKey,
} from "./dialogRuntimeStore";

// Re-export runtime mutators/selectors/types so existing import paths keep working.
export type {
  CreatePagePayload,
  LoopStopReason,
  PendingFile,
  PendingRawData,
  TokenStats,
} from "./dialogRuntimeTypes";
export { GLOBAL_DIALOG_RUNTIME_KEY } from "./dialogRuntimeTypes";
export {
  addPendingFile,
  removePendingFile,
  clearPendingAttachments,
  clearDialogRuntimeState,
  addActiveController,
  removeActiveController,
  clearActiveControllers,
  tokenUsageLiveUpdate,
  setLoopStopReason,
  enqueueUserInput,
  dequeueUserInput,
  clearPendingUserInputQueue,
  selectDialogRuntimeByKey,
  selectPendingFiles,
  selectActiveControllers,
  selectPendingRawData,
  selectDialogRuntimeTokens,
  selectPendingRawDataByPageKey,
  selectPendingUserInputQueue,
  selectLoopStopReason,
  usePendingFiles,
  useActiveControllers,
  usePendingUserInputQueue,
  useLoopStopReason,
  useDialogRuntimeTokens,
} from "./dialogRuntimeStore";

const createSliceWithThunks = buildCreateSlice({
  creators: { asyncThunk: asyncThunkCreator },
});

const runCreateDialogAction = async (args: any, thunkApi: any) => {
  const { createDialogAction } = await import("./actions/createDialogAction");
  return createDialogAction(args, thunkApi);
};

const runCreateAgentAutomationAction = async (args: any, thunkApi: any) => {
  const { createAgentAutomationAction } = await import("./actions/createAgentAutomationAction");
  return createAgentAutomationAction(args, thunkApi);
};

const runUpdateDialogTitleAction = async (args: any, thunkApi: any) => {
  const { updateDialogTitleAction } = await import("./actions/updateDialogTitleAction");
  return updateDialogTitleAction(args, thunkApi);
};

const runAddDialogAgentAction = async (args: any, thunkApi: any) => {
  const { addDialogAgentAction } = await import("./actions/addDialogAgentAction");
  return addDialogAgentAction(args, thunkApi);
};

const runRemoveDialogAgentAction = async (args: any, thunkApi: any) => {
  const { removeDialogAgentAction } = await import("./actions/removeDialogAgentAction");
  return removeDialogAgentAction(args, thunkApi);
};

const runSetPrimaryDialogAgentAction = async (args: any, thunkApi: any) => {
  const { setPrimaryDialogAgentAction } = await import("./actions/setPrimaryDialogAgentAction");
  return setPrimaryDialogAgentAction(args, thunkApi);
};

const runSetDialogExtraReferencesAction = async (args: any, thunkApi: any) => {
  const { setDialogExtraReferencesAction } = await import("./actions/setDialogExtraReferencesAction");
  return setDialogExtraReferencesAction(args, thunkApi);
};

const runHandleSendMessageAction = async (args: any, thunkApi: any) => {
  const { handleSendMessageAction } = await import("./actions/handleSendMessageAction");
  return handleSendMessageAction(args, thunkApi);
};

interface DialogState {
  currentDialogKey: string | null;
  configError: string | null;
  isUpdatingMode: boolean;
}

const initialState: DialogState = {
  currentDialogKey: null,
  configError: null,
  isUpdatingMode: false,
};

const dialogSlice = createSliceWithThunks({
  name: "dialog",
  initialState,
  reducers: (create) => ({
    createPageAndAddReference: create.asyncThunk(
      async (payload: CreatePagePayload, { dispatch, rejectWithValue }) => {
        const { slateData, jsonData, title, type, fileId, groupId, dialogKey } = payload;
        try {
          const { createDoc } = await import("../../render/page/docSlice");
          const pageKey = await (dispatch as any)(
            (createDoc as any)({ slateData, title })
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
        fulfilled: (_state, action) => {
          addPageReferenceToRuntime({
            reference: action.payload.reference,
            rawData: action.payload.rawData,
            dialogKey: action.payload.dialogKey ?? action.meta.arg.dialogKey,
          });
        },
      }
    ),

    deleteDialog: create.asyncThunk(deleteDialogThunk, {
      fulfilled: (state, action) => {
        deleteDialogRuntime(action.payload.dialogKey);
        if (action.payload.isCurrentDialog) {
          state.currentDialogKey = null;
          setActiveDialogKey(null);
        }
      },
    }),

    initDialog: create.asyncThunk(
      async (id: string, { dispatch, signal, getState }) => {
        clearPendingAttachments();
        clearWorkflow();
        const { currentServer: preferredServerOrigin } = getRuntimeServerContext(
          getState() as any
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
          state.configError = null;
          setActiveDialogKey(action.meta.arg);
          resetDialogRuntimeSessionState(action.meta.arg);
        },
        fulfilled: (state, action) => {
          if (state.currentDialogKey === action.meta.arg) {
            // No-op
          }
        },
        rejected: (state, action) => {
          const isAborted =
            isAbortError(action.error) ||
            action.error.message === "Aborted";
          const isCurrentDialog = state.currentDialogKey === action.meta.arg;

          if (!isAborted && isCurrentDialog) {
            state.configError = action.error.message || "Failed to load dialog";
            console.info("Failed to load dialog config:", action.error.message);
          }
        },
      }
    ),

    handleSendMessage: create.asyncThunk(runHandleSendMessageAction),

    abortAllMessages: create.asyncThunk(
      async (
        args: { dialogKey?: string; all?: boolean } | undefined,
        { dispatch }
      ) => {
        /**
         * 产品约束说明：
         * - 当前网页端 stop 默认只停“当前对话”，避免切换对话时把后台任务一起杀掉
         * - `all: true` 仅用于 logout / 全局 reset 这类明确的系统级清理
         * - 未来桌面端若要支持“从任务中心停任意 dialog”，应在 UI 层显式传 dialogKey
         */
        abortActiveControllers(args);
        dispatch(clearAllStreaming(args));
        clearActiveControllers(args);
      }
    ),

    updateTokens: create.asyncThunk(updateTokensAction, {
      fulfilled: (_state, action) => {
        const dialogKey = action.meta.arg.dialogKey;
        if (!dialogKey) return;
        applyUpdateTokensFulfilled({
          dialogKey,
          input_tokens: action.payload.input_tokens,
          output_tokens: action.payload.output_tokens,
          cost: action.payload.cost,
        });
      },
    }),

    createDialog: create.asyncThunk(runCreateDialogAction),
    createAgentAutomation: create.asyncThunk(runCreateAgentAutomationAction),
    updateDialogTitle: create.asyncThunk(runUpdateDialogTitleAction),
    addDialogAgent: create.asyncThunk(runAddDialogAgentAction),
    removeDialogAgent: create.asyncThunk(runRemoveDialogAgentAction),
    setPrimaryDialogAgent: create.asyncThunk(runSetPrimaryDialogAgentAction),
    setDialogExtraReferences: create.asyncThunk(runSetDialogExtraReferencesAction),

    /** Clears currentDialogKey; runtime leave semantics live in the store. */
    clearDialogState: create.reducer((state) => {
      applyClearDialogStateRuntime();
      state.currentDialogKey = null;
    }),
  }),
  selectors: {
    selectCurrentDialogKey: (state) => state.currentDialogKey,
    selectConfigError: (state) => state.configError,
  },
});

export const {
  createPageAndAddReference,
  initDialog,
  deleteDialog,
  updateTokens,
  clearDialogState,
  createDialog,
  createAgentAutomation,
  updateDialogTitle,
  addDialogAgent,
  removeDialogAgent,
  setPrimaryDialogAgent,
  setDialogExtraReferences,
  handleSendMessage,
  abortAllMessages,
} = dialogSlice.actions as any;

export default dialogSlice.reducer;

export const { selectCurrentDialogKey, selectConfigError } =
  dialogSlice.selectors;

export const selectCurrentDialogConfig = createSelector(
  (state: any) => state,
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
  (state: any) => state,
  (_: any, dialogKey?: string | null) => dialogKey,
  (state, dialogKey) =>
    dialogKey ? (selectById(state, dialogKey) as DialogConfig | null) : null
);

export const selectCurrentDialogTokens = createSelector(
  (state: any) => state,
  selectCurrentDialogConfig,
  (_state: any, dialogKey?: string) => dialogKey,
  (state, currentDialog, dialogKey) => {
    if (dialogKey) {
      const dialogConfig = selectById(state, dialogKey) as DialogConfig | null;
      return mergeDialogTokenStats(
        dialogConfig,
        getDialogRuntimeTokens(dialogKey)
      );
    }

    return mergeDialogTokenStats(
      currentDialog,
      getDialogRuntimeTokens()
    );
  }
);

export const selectTotalDialogTokens = selectCurrentDialogTokens;
