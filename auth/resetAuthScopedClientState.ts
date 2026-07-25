import { clearWorkflow } from "../ai/workflow/workflowStore";
import { resetFavorites } from "../app/favorite/favoriteStore";
import { abortAllMessages, clearDialogState } from "../chat/dialog/dialogSlice";
import {
  clearPendingAttachments,
  clearPendingUserInputQueue,
} from "../chat/dialog/dialogRuntimeStore";
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
  // Runtime clears are module-store mutators; clearDialogState still clears
  // Redux currentDialogKey (and leaves runtime via applyClearDialogStateRuntime).
  clearPendingAttachments({ all: true });
  dispatch(clearDialogState());
  clearPendingUserInputQueue({ all: true });
  dispatch(resetMsgs({ all: true }));
  clearWorkflow();
  resetFavorites();
  dispatch(resetSpace());
};
