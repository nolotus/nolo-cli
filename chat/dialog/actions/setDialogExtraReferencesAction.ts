import { patch, selectById } from "../../../database/dbSlice";
import { formatISO } from "date-fns";
import type { RootState } from "../../../app/store";
import type { DialogConfig, ReferenceItem } from "../../../app/types";

export const setDialogExtraReferencesAction = async (
  extraReferences: ReferenceItem[],
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

  return await dispatch(
    patch({
      dbKey: currentDialogKey,
      changes: {
        extraReferences: extraReferences ?? [],
        updatedAt: formatISO(new Date()),
      },
    }),
  ).unwrap();
};
