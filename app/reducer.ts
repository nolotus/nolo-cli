import authReducer from "../auth/authSlice";
import databaseReducer from "../database/dbSlice";
import settingReducer from ".//settings/settingSlice";

import docReducer from "../render/page/docSlice";
import tableReducer from "../render/table/tableSlice";
import agentReducer from "../ai/agent/agentSlice";
import spaceReducer from "../create/space/spaceSlice";

import dialogReducer from "../chat/dialog/dialogSlice";
import messageReducer from "../chat/messages/messageSlice";
import workflowReducer from "../ai/workflow/workflowSlice";
import favoriteReducer from ".//favorite/favoriteSlice";
import notificationReducer from ".//notifications/notificationSlice";
// 新增：工具调用 trace
import toolRunReducer from "../ai/tools/toolRunSlice";
import shareReducer from "../share/shareSlice";
import appInspectorReducer from ".//appInspector/appInspectorSlice";

// Explicit Record type so composite/declaration checks do not require naming
// private slice state interfaces from other packages (TS4023).
export const reducer: Record<string, any> = {
  dialog: dialogReducer,
  workflow: workflowReducer,
  message: messageReducer,
  auth: authReducer,
  doc: docReducer,
  db: databaseReducer,
  settings: settingReducer,
  space: spaceReducer,
  notifications: notificationReducer,
  agent: agentReducer,
  table: tableReducer,
  toolRun: toolRunReducer,
  favorite: favoriteReducer,
  share: shareReducer,
  appInspector: appInspectorReducer,
};
