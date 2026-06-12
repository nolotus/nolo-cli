import { patch, selectById } from "../../../database/dbSlice";
import { formatISO } from "date-fns";
import type { RootState } from "../../../app/store";
import type { DialogConfig } from "../../../app/types";
import { addDialogAgentIds } from "../dialogAgents";

export const addCybotAction = async (
  cybotIds: string | string[],
  thunkApi: any // 使用 any 或者具体的 ThunkAPI 类型
) => {
  const { dispatch, getState } = thunkApi;
  const state = getState() as RootState;
  const currentDialogKey = state.dialog?.currentDialogKey;

  if (!currentDialogKey) {
    throw new Error("No current dialog selected");
  }

  const dialogConfig = selectById(state, currentDialogKey) as DialogConfig | undefined;
  if (!dialogConfig) {
    throw new Error("Dialog configuration not found");
  }

  // 统一处理为数组格式
  const idsToAdd = Array.isArray(cybotIds) ? cybotIds : [cybotIds];

  // 验证输入
  if (idsToAdd.length === 0) {
    throw new Error("No cybot IDs provided");
  }

  // 过滤掉空值和重复值
  const validIds = idsToAdd.filter((id) => id && typeof id === "string");

  if (validIds.length === 0) {
    throw new Error("No valid cybot IDs provided");
  }

  // 合并新的 ID 并去重
  const updatedCybots = addDialogAgentIds(dialogConfig.cybots || [], validIds);

  const changes = {
    cybots: updatedCybots,
    updatedAt: formatISO(new Date()),
  };

  const updatedConfig = await dispatch(
    patch({ dbKey: currentDialogKey, changes })
  ).unwrap();

  return updatedConfig;
};
