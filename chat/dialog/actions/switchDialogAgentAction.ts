import { patch, selectById } from "../../../database/dbSlice";
import { formatISO } from "date-fns";
import type { RootState } from "../../../app/store";
import type { DialogConfig } from "../../../app/types";
import { getActiveDialogKey } from "../dialogRuntimeStore";

export const switchDialogAgentAction = async (
  payload: { dialogKey?: string; agentKey: string },
  thunkApi: any,
) => {
  const { dispatch, getState } = thunkApi;
  const state = getState() as RootState;
  const targetDialogKey = payload?.dialogKey ?? getActiveDialogKey();

  if (!targetDialogKey) {
    throw new Error("No target dialog specified");
  }

  if (typeof payload?.agentKey !== "string" || !payload.agentKey.trim()) {
    throw new Error("No valid agent key provided");
  }

  const dialogConfig = selectById(state, targetDialogKey) as DialogConfig | undefined;
  if (!dialogConfig) {
    throw new Error("Dialog configuration not found");
  }

  const changes = {
    activeAgentKey: payload.agentKey.trim(),
    updatedAt: formatISO(new Date()),
  };

  return await dispatch(
    patch({
      dbKey: targetDialogKey,
      changes,
    }),
  ).unwrap();
};
