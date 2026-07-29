// 文件路径: chat/dialog/dialogSlice.ts
// Wave9: dialogRuntimeByKey → dialogRuntimeStore.
// Wave13: currentDialogKey / configError → dialogRuntimeStore.
// Wave14: empty dialog reducer unmounted; thunks are createAsyncThunk;
//   side effects run inside thunk bodies; clearDialogState is a store mutator.

import { createAsyncThunk, createSelector } from "@reduxjs/toolkit";
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
  deleteDialogRuntime,
  getActiveDialogKey,
  getDialogRuntimeTokens,
  resetDialogRuntimeSessionState,
  setActiveDialogKey,
  setDialogConfigError,
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

const runCreateDialogAction = async (args: any, thunkApi: any) => {
  const { createDialogAction } = await import("./actions/createDialogAction");
  return createDialogAction(args, thunkApi);
};

const runCreateAgentAutomationAction = async (args: any, thunkApi: any) => {
  const { createAgentAutomationAction } = await import(
    "./actions/createAgentAutomationAction"
  );
  return createAgentAutomationAction(args, thunkApi);
};

const runUpdateDialogTitleAction = async (args: any, thunkApi: any) => {
  const { updateDialogTitleAction } = await import(
    "./actions/updateDialogTitleAction"
  );
  return updateDialogTitleAction(args, thunkApi);
};

const runAddDialogAgentAction = async (args: any, thunkApi: any) => {
  const { addDialogAgentAction } = await import("./actions/addDialogAgentAction");
  return addDialogAgentAction(args, thunkApi);
};

const runRemoveDialogAgentAction = async (args: any, thunkApi: any) => {
  const { removeDialogAgentAction } = await import(
    "./actions/removeDialogAgentAction"
  );
  return removeDialogAgentAction(args, thunkApi);
};

const runSetPrimaryDialogAgentAction = async (args: any, thunkApi: any) => {
  const { setPrimaryDialogAgentAction } = await import(
    "./actions/setPrimaryDialogAgentAction"
  );
  return setPrimaryDialogAgentAction(args, thunkApi);
};

const runSetDialogExtraReferencesAction = async (args: any, thunkApi: any) => {
  const { setDialogExtraReferencesAction } = await import(
    "./actions/setDialogExtraReferencesAction"
  );
  return setDialogExtraReferencesAction(args, thunkApi);
};

const runHandleSendMessageAction = async (args: any, thunkApi: any) => {
  const { handleSendMessageAction } = await import(
    "./actions/handleSendMessageAction"
  );
  return handleSendMessageAction(args, thunkApi);
};

/** Clears active dialog key + session flash; runtime leave semantics in the store. */
export function clearDialogState(): { type: "dialog/clearDialogState" } {
  applyClearDialogStateRuntime();
  return { type: "dialog/clearDialogState" };
}
(clearDialogState as typeof clearDialogState & { type: string }).type =
  "dialog/clearDialogState";

export const createPageAndAddReference = createAsyncThunk(
  "dialog/createPageAndAddReference",
  async (payload: CreatePagePayload, { dispatch, getState, rejectWithValue }) => {
    const { slateData, jsonData, title, type, fileId, groupId, dialogKey } =
      payload;
    try {
      const { createDocState } = await import("../../render/page/docStore");
      const pageKey = await createDocState(
        { slateData, title },
        { dispatch, getState }
      );

      const newReference: PendingFile = {
        id: fileId,
        name: title,
        pageKey,
        dialogKey,
        type,
        groupId,
      };
      const newRawData = jsonData ? { pageKey, jsonData } : null;

      addPageReferenceToRuntime({
        reference: newReference,
        rawData: newRawData,
        dialogKey: dialogKey,
      });

      return { reference: newReference, rawData: newRawData, dialogKey };
    } catch (error) {
      console.error("创建页面或引用失败:", error);
      return rejectWithValue((error as Error).message);
    }
  }
);

export const deleteDialog = createAsyncThunk(
  "dialog/deleteDialog",
  async (payload: any, thunkApi) => {
    const result = await deleteDialogThunk(payload, thunkApi);
    deleteDialogRuntime(result.dialogKey);
    if (result.isCurrentDialog) {
      setActiveDialogKey(null);
    }
    return result;
  }
);

export const initDialog = createAsyncThunk(
  "dialog/initDialog",
  async (id: string, { dispatch, signal, getState }) => {
    // Wave14: former pending reducer side effects — must run before await.
    setActiveDialogKey(id);
    resetDialogRuntimeSessionState(id);
    // Do not clearPendingAttachments here: drafts are per-dialogKey and must
    // survive leave/re-enter (resetDialogRuntimeSessionState already preserves
    // pendingFiles). Send / auth-reset / delete paths clear when appropriate.
    clearWorkflow();
    try {
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
    } catch (error) {
      const err = error as Error;
      const isAborted =
        isAbortError(err) || err?.message === "Aborted";
      const isCurrentDialog = getActiveDialogKey() === id;

      if (!isAborted && isCurrentDialog) {
        setDialogConfigError(err?.message || "Failed to load dialog");
        console.info("Failed to load dialog config:", err?.message);
      }
      throw error;
    }
  }
);

export const handleSendMessage = createAsyncThunk(
  "dialog/handleSendMessage",
  runHandleSendMessageAction
);

export const abortAllMessages = createAsyncThunk(
  "dialog/abortAllMessages",
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
);

export const updateTokens = createAsyncThunk(
  "dialog/updateTokens",
  async (args: any, thunkApi) => {
    const payload = await updateTokensAction(args, thunkApi);
    const dialogKey = args?.dialogKey;
    if (dialogKey && payload) {
      applyUpdateTokensFulfilled({
        dialogKey,
        input_tokens: payload.input_tokens,
        output_tokens: payload.output_tokens,
        cost: payload.cost,
      });
    }
    return payload;
  }
);

export const createDialog = createAsyncThunk(
  "dialog/createDialog",
  runCreateDialogAction
);
export const createAgentAutomation = createAsyncThunk(
  "dialog/createAgentAutomation",
  runCreateAgentAutomationAction
);
export const updateDialogTitle = createAsyncThunk(
  "dialog/updateDialogTitle",
  runUpdateDialogTitleAction
);
export const addDialogAgent = createAsyncThunk(
  "dialog/addDialogAgent",
  runAddDialogAgentAction
);
export const removeDialogAgent = createAsyncThunk(
  "dialog/removeDialogAgent",
  runRemoveDialogAgentAction
);
export const setPrimaryDialogAgent = createAsyncThunk(
  "dialog/setPrimaryDialogAgent",
  runSetPrimaryDialogAgentAction
);
export const setDialogExtraReferences = createAsyncThunk(
  "dialog/setDialogExtraReferences",
  runSetDialogExtraReferencesAction
);

// Wave13/14: dialog key/error selectors & hooks from dialogRuntimeStore.
export {
  selectCurrentDialogKey,
  selectConfigError,
  useCurrentDialogKey,
  useDialogConfigError,
} from "./dialogRuntimeStore";

export function selectCurrentDialogConfig(state: any): DialogConfig | null {
  const key = getActiveDialogKey();
  return key ? (selectById(state, key) as DialogConfig | null) : null;
}

export const selectCurrentDialogAgentIds = createSelector(
  (state: any) => selectCurrentDialogConfig(state),
  (dialogConfig) => getDialogAgentIds(dialogConfig)
);

export const selectCurrentPrimaryAgentId = createSelector(
  (state: any) => selectCurrentDialogConfig(state),
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

    return mergeDialogTokenStats(currentDialog, getDialogRuntimeTokens());
  }
);

export const selectTotalDialogTokens = selectCurrentDialogTokens;
