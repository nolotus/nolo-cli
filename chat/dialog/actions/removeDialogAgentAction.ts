import { patch, selectById } from "../../../database/dbSlice";
import { formatISO } from "date-fns";
import type { RootState } from "../../../app/store";
import type { DialogConfig } from "../../../app/types";
import {
  getPrimaryDialogAgentId,
  removeDialogAgentId,
} from "../dialogAgents";
import { cleanupCliSessionForDialog } from "./cleanupCliSession";

export const removeDialogAgentAction = async (
  agentId: string,
  thunkApi: any,
) => {
  const { dispatch, getState } = thunkApi;
  const state = getState() as RootState;
  const currentDialogKey = state.dialog?.currentDialogKey;

  if (!currentDialogKey) {
    throw new Error("No current dialog selected");
  }

  const dialogConfig = selectById(
    state,
    currentDialogKey,
  ) as DialogConfig | undefined;
  if (!dialogConfig) {
    throw new Error("Dialog configuration not found");
  }

  if (getPrimaryDialogAgentId(dialogConfig) === agentId) {
    await cleanupCliSessionForDialog({ dispatch, getState }, dialogConfig);
  }

  return await dispatch(
    patch({
      dbKey: currentDialogKey,
      changes: {
        cybots: removeDialogAgentId(dialogConfig.cybots || [], agentId),
        updatedAt: formatISO(new Date()),
      },
    }),
  ).unwrap();
};
