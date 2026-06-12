import { setPrimaryDialogAgentAction } from "./setPrimaryDialogAgentAction";

export const replacePrimaryCybotAction = async (
  cybotId: string,
  thunkApi: any
) => setPrimaryDialogAgentAction(cybotId, thunkApi);
