import type { RootState, AppThunkApi } from "../../app/store";
import {
  readDefaultSpaceIdPreference,
  resolveDefaultSpacePreferenceOwnerId,
} from "../../app/settings/defaultSpacePreference";

import { changeSpace } from "./spaceSlice";
import { readSpaceIfExists } from "./resolvePreferredSpaceId";

export const loadDefaultSpaceAction = async (
  userId: string | undefined,
  thunkAPI: AppThunkApi
): Promise<string | null> => {
  const dispatch = thunkAPI.dispatch;
  const state = thunkAPI.getState() as RootState;

  if (state.space.currentSpaceId) {
    return null;
  }

  if (state.space.viewMode === "all") {
    return null;
  }

  // Actor-scoped default: guest → "local"; account A/B → that account only.
  // Does not read another actor's register (no local↔account leak).
  const preferenceOwnerId = resolveDefaultSpacePreferenceOwnerId(
    userId ?? state.auth?.currentUser?.userId ?? null
  );
  const memberSpaces = state.space.memberSpaces;

  try {
    const defaultSpaceId = await readDefaultSpaceIdPreference(
      dispatch,
      preferenceOwnerId
    );
    const spaceIdToLoad = await readSpaceIfExists(dispatch, defaultSpaceId);

    if (spaceIdToLoad) {
      await dispatch((changeSpace as any)(spaceIdToLoad)).unwrap();
      return spaceIdToLoad;
    }

    if (memberSpaces === null) {
      console.warn(
        `[Space] Skipped default-space selection for ${preferenceOwnerId}: memberships are still loading and no readable default-space register exists.`
      );
      return null;
    }

    // Fall back to first readable member space when no register exists (e.g. accounts
    // created before the register migration)
    for (const memberSpace of memberSpaces) {
      const fallbackId = memberSpace?.spaceId;
      const readableId = await readSpaceIfExists(dispatch, fallbackId);
      if (readableId) {
        console.info(
          `[Space] No register for ${preferenceOwnerId}, falling back to member space: ${readableId}`
        );
        await dispatch((changeSpace as any)(readableId)).unwrap();
        return readableId;
      }
    }

    console.warn(
      `[Space] Skipped default-space selection for ${preferenceOwnerId}: no readable default-space register exists.`
    );
    return null;
  } catch (error) {
    throw error;
  }
};
