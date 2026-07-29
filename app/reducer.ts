import authReducer from "../auth/authSlice";
import databaseReducer from "../database/dbSlice";
import settingReducer from ".//settings/settingSlice";

import tableReducer from "../render/table/tableSlice";
import spaceReducer from "../create/space/spaceSlice";

import messageReducer from "../chat/messages/messageSlice";
// doc 已剥叶为 module store（render/page/docStore.ts，Wave doc migration），不再挂 reducer。
// favorite 已剥叶为 module store（app/favorite/favoriteStore.ts，Wave8），不再挂 reducer。
// toolRun 已剥叶为 module store（ai/tools/toolRunStore.ts，Wave7），不再挂 reducer。
// dialog 已卸空壳 reducer（Wave14）；CRUD/send 仍为 createAsyncThunk，session flash 在
// dialogRuntimeStore。

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
