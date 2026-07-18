import { patch } from "../../../database/dbSlice";
import type { RootState } from "../../../app/store";
import type { DialogConfig } from "../../../app/types";
import { closeCliChatSession } from "../../../ai/agent/cliChatClient";

export async function cleanupCliSessionForDialog(
  thunkApi: { dispatch: any; getState: () => RootState },
  dialogConfig: DialogConfig | null | undefined,
) {
  const cliSessionId = dialogConfig?.cliSessionId;
  const dialogKey = dialogConfig?.dbKey;
  if (!cliSessionId || !dialogKey) return;

  try {
    await closeCliChatSession(
      { getState: thunkApi.getState },
      { sessionId: cliSessionId },
    );
  } catch {
    // Best effort only. Session may already be gone server-side.
  }

  try {
    const patchResult = thunkApi.dispatch(
      patch({
        dbKey: dialogKey,
        changes: {
          cliSessionId: null,
        },
      }),
    ) as any;
    if (typeof patchResult?.unwrap === "function") {
      await patchResult.unwrap();
    } else {
      await patchResult;
    }
  } catch {
    // Also best effort. Dialog deletion/agent switching should not fail solely on cleanup.
  }
}
