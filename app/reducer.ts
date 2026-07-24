import authReducer from "../auth/authSlice";
import databaseReducer from "../database/dbSlice";
import settingReducer from ".//settings/settingSlice";

import docReducer from "../render/page/docSlice";
import tableReducer from "../render/table/tableSlice";
import spaceReducer from "../create/space/spaceSlice";

import dialogReducer from "../chat/dialog/dialogSlice";
import messageReducer from "../chat/messages/messageSlice";
// favorite 已剥叶为 module store（app/favorite/favoriteStore.ts，Wave8），不再挂 reducer。
// toolRun 已剥叶为 module store（ai/tools/toolRunStore.ts，Wave7），不再挂 reducer。

// Explicit Record type so composite/declaration checks do not require naming
// private slice state interfaces from other packages (TS4023).
export const reducer: Record<string, any> = {
  dialog: dialogReducer,
  message: messageReducer,
  auth: authReducer,
  doc: docReducer,
  db: databaseReducer,
  settings: settingReducer,
  space: spaceReducer,
  table: tableReducer,
};
