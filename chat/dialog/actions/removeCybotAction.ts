import { removeDialogAgentAction } from "./removeDialogAgentAction";

export const removeCybotAction = async (
  cybotId: string,
  thunkApi: any // 使用 any 或具体类型
) => removeDialogAgentAction(cybotId, thunkApi);
