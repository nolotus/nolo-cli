import authReducer from "../auth/authSlice";
import databaseReducer from "../database/dbSlice";
import settingReducer from ".//settings/settingSlice";

import docReducer from "../render/page/docSlice";
import tableReducer from "../render/table/tableSlice";
import cybotReducer from "../ai/agent/agentSlice";
import spaceReducer from "../create/space/spaceSlice";

import dialogReducer from "../chat/dialog/dialogSlice";
import messageReducer from "../chat/messages/messageSlice";
import planSlice from "../ai/agent/planSlice";
import workflowReducer from "../ai/workflow/workflowSlice";
import favoriteReducer from ".//favorite/favoriteSlice";
import notificationReducer from ".//notifications/notificationSlice";
// 新增：工具调用 trace
import toolRunReducer from "../ai/tools/toolRunSlice";
import shareReducer from "../share/shareSlice";

export const reducer = {
  dialog: dialogReducer,
  plan: planSlice,
  workflow: workflowReducer,
  message: messageReducer,
  auth: authReducer,
  doc: docReducer,
  db: databaseReducer,
  settings: settingReducer,
  space: spaceReducer,
  notifications: notificationReducer,
  cybot: cybotReducer,
  table: tableReducer,
  toolRun: toolRunReducer,
  favorite: favoriteReducer,
  share: shareReducer,
};
