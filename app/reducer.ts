// Auth reducer: 通过 identity/authReducer edition 注入。
// - cloud edition（私有 checkout）：委托 auth/authSlice，SSR 和客户端用同一个 reducer。
// - local edition（公开集）：返回空对象 {} 的 noop reducer，SSR 注入 "auth":{} 而非 null，
//   客户端 hydrate 安全。
//
// ⚠️ 之前直接 import auth/authSlice 是因为 identity/authReducer 的 local edition
// 返回 null 导致 SSR hydration 崩溃。已修复 local edition 返回 {} 而非 null。
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