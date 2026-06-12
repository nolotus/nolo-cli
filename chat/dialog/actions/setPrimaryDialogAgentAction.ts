import { patch, selectById } from "../../../database/dbSlice";
import { formatISO } from "date-fns";
import type { RootState } from "../../../app/store";
import type { DialogConfig } from "../../../app/types";
import {
  getPrimaryDialogAgentId,
  replacePrimaryDialogAgentId,
} from "../dialogAgents";
import { cleanupCliSessionForDialog } from "./cleanupCliSession";

export const setPrimaryDialogAgentAction = async (
  agentId: string,
  thunkApi: any,
) => {
  const { dispatch, getState } = thunkApi;
  const state = getState() as RootState;
  const currentDialogKey = state.dialog?.currentDialogKey;

  if (!currentDialogKey) {
    throw new Error("No current dialog selected");
  }

  if (!agentId || typeof agentId !== "string") {
    throw new Error("No valid agent ID provided");
  }

  const dialogConfig = selectById(
    state,
    currentDialogKey,
  ) as DialogConfig | undefined;
  if (!dialogConfig) {
    throw new Error("Dialog configuration not found");
  }

  const currentPrimaryAgentId = getPrimaryDialogAgentId(dialogConfig);
  if (currentPrimaryAgentId && currentPrimaryAgentId !== agentId) {
    await cleanupCliSessionForDialog({ dispatch, getState }, dialogConfig);
  }

  return await dispatch(
    patch({
      dbKey: currentDialogKey,
      changes: {
        cybots: replacePrimaryDialogAgentId(
          dialogConfig.cybots || [],
          agentId,
        ),
        updatedAt: formatISO(new Date()),
      },
    }),
  ).unwrap();
};
