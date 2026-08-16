import { authReducer } from "identity/authReducer";
import databaseReducer from "../database/dbSlice";
import settingReducer from ".//settings/settingSlice";

import tableReducer from "../render/table/tableSlice";
import spaceReducer from "../create/space/spaceSlice";

import messageReducer from "../chat/messages/messageSlice";

// Explicit Record type so composite/declaration checks do not require naming
// private slice state interfaces from other packages (TS4023).
export const reducer: Record<string, any> = {
  message: messageReducer,
  auth: authReducer,
  db: databaseReducer,
  settings: settingReducer,
  space: spaceReducer,
  table: tableReducer,
};
