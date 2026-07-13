import type { RootState } from "../../app/store";
import {
  readDefaultSpaceIdPreference,
  resolveDefaultSpacePreferenceOwnerId,
} from "../../app/settings/defaultSpacePreference";
import { read, readAndWait } from "../../database/dbSlice";

import { createSpaceKey } from "./spaceKeys";

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException
    ? error.name === "AbortError"
    : typeof error === "object" &&
        error !== null &&
        "name" in error &&
        error.name === "AbortError";

const isSuppressedMissError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "message" in error &&
  typeof error.message === "string" &&
  (error.message.includes("temporarily suppressed") ||
    error.message.includes("miss suppressed"));

export const readSpaceIfExists = async (
  dispatch: any,
  spaceId?: string | null
): Promise<string | null> => {
  if (!spaceId) {
    return null;
  }

  try {
    const result = await dispatch(
      read({
        dbKey: createSpaceKey.space(spaceId),
      })
    ).unwrap();

    if (result) {
      return spaceId;
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    if (!isSuppressedMissError(error)) {
      console.info(
        `[resolvePreferredSpaceId] Optimistic read failed for ${spaceId}, retrying with readAndWait:`,
        error
      );
    }
  }

  try {
    const result = await dispatch(
      readAndWait(createSpaceKey.space(spaceId))
    ).unwrap();
    return result ? spaceId : null;
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    console.info(
      `[resolvePreferredSpaceId] Confirming space existence failed for ${spaceId}:`,
      error
    );
    return null;
  }
};

export const resolvePreferredSpaceId = async ({
  dispatch,
  getState,
  userId,
}: {
  dispatch: any;
  getState: () => RootState;
  userId?: string | null;
}): Promise<string | null> => {
  const state = getState();

  if (state.space.currentSpaceId) {
    return state.space.currentSpaceId;
  }

  const candidates: string[] = [];
  const pushCandidate = (spaceId?: string | null) => {
    if (!spaceId) return;
    if (candidates.includes(spaceId)) return;
    candidates.push(spaceId);
  };

  // Preference owner is effective Space actor (guest → local; account → that id).
  // Never cross-read local default into account or account default into guest.
  const preferenceOwnerId = resolveDefaultSpacePreferenceOwnerId(
    userId ?? state.auth?.currentUser?.userId ?? null
  );
  pushCandidate(
    await readDefaultSpaceIdPreference(dispatch, preferenceOwnerId)
  );

  for (const memberSpace of state.space.memberSpaces || []) {
    pushCandidate(memberSpace?.spaceId);
  }

  for (const candidate of candidates) {
    const readableSpaceId = await readSpaceIfExists(dispatch, candidate);
    if (readableSpaceId) {
      return readableSpaceId;
    }
  }

  return null;
};
