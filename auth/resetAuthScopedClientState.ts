import { clearPlan } from "../ai/agent/planSlice";
import { clearWorkflow } from "../ai/workflow/workflowSlice";
import { resetFavorites } from "../app/favorite/favoriteSlice";
import { clearDefaultSpaceId } from "../app/settings/settingSlice";
import {
  abortAllMessages,
  clearDialogState,
  clearPendingAttachments,
  clearPendingUserInputQueue,
} from "../chat/dialog/dialogSlice";
import { resetMsgs } from "../chat/messages/messageSlice";
import { resetSpace } from "../create/space/spaceSlice";

export const resetAuthScopedClientState = async (dispatch: any) => {
  await dispatch(abortAllMessages({ all: true })).unwrap();
  // The remaining clears are synchronous slice reducers, so inline dispatch
  // order is sufficient and intentionally not modeled as async work.
  dispatch(clearPendingAttachments({ all: true }));
  dispatch(clearDialogState());
  dispatch(clearPendingUserInputQueue({ all: true }));
  dispatch(resetMsgs({ all: true }));
  dispatch(clearPlan());
  dispatch(clearWorkflow());
  dispatch(resetFavorites());
  dispatch(resetSpace());
  dispatch(clearDefaultSpaceId());
};
