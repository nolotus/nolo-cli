import { clearWorkflow } from "../ai/workflow/workflowSlice";
import { resetFavorites } from "../app/favorite/favoriteSlice";
import {
  abortAllMessages,
  clearDialogState,
  clearPendingAttachments,
  clearPendingUserInputQueue,
} from "../chat/dialog/dialogSlice";
import { resetMsgs } from "../chat/messages/messageSlice";
import { resetSpace } from "../create/space/spaceSlice";
import { cancelAllSyncJobs } from "../database/sync/syncJobRegistry";
import { clearSyncMappings } from "../database/sync/syncMapping";

export const resetAuthScopedClientState = async (dispatch: any) => {
  // Detach account-scoped in-flight sync before clearing client caches so
  // logout / switch cannot leave orphaned network work against the prior user.
  cancelAllSyncJobs();
  // Drop process-local mapping index so account B cannot observe A mappings
  // from stale memory. Durable on-device rows remain and rehydrate when the
  // original account is active again (ensureSyncMappingsHydrated).
  clearSyncMappings();
  await dispatch(abortAllMessages({ all: true })).unwrap();
  // The remaining clears are synchronous slice reducers, so inline dispatch
  // order is sufficient and intentionally not modeled as async work.
  dispatch(clearPendingAttachments({ all: true }));
  dispatch(clearDialogState());
  dispatch(clearPendingUserInputQueue({ all: true }));
  dispatch(resetMsgs({ all: true }));
  dispatch(clearWorkflow());
  dispatch(resetFavorites());
  dispatch(resetSpace());
};
