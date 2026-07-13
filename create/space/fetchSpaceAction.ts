import type { SpaceId } from "../space/types";
import type { SpaceData } from "../../app/types";
import { createSpaceKey, normalizeSpaceId } from "../space/spaceKeys";
import {
  fetchAuthoritativeRemoteSpace,
  selectSpaceRemoteAuth,
} from "../space/spaceAccess";
import { isDeviceLocalSpaceBody } from "../../database/authority/deviceLocal";
import { isTombstoneRecord } from "../../database/tombstones";

type FetchSpaceInput = SpaceId | { spaceId: SpaceId; fresh?: boolean };

export const fetchSpaceAction = async (
  input: FetchSpaceInput,
  thunkAPI: any
): Promise<{ spaceId: SpaceId; spaceData: SpaceData }> => {
  const rawSpaceId = typeof input === "string" ? input : input?.spaceId;
  const fresh = typeof input === "object" && input !== null ? !!input.fresh : false;
  const { dispatch } = thunkAPI;

  if (!rawSpaceId) {
    throw new Error("spaceId is required");
  }

  // Normalize ID for fetching
  const spaceId = normalizeSpaceId(rawSpaceId);
  const spaceKey = createSpaceKey.space(spaceId);

  const readSpace = async (dbKey: string): Promise<SpaceData | null> => {
    try {
      const { read, readAndWait } = await import("../../database/dbSlice");
      if (fresh) {
        return await dispatch(readAndWait(dbKey)).unwrap();
      }
      return await dispatch(
        read({
          dbKey,
        })
      ).unwrap();
    } catch {
      return null;
    }
  };

  const readLocalSpaceBody = async (): Promise<SpaceData | null> => {
    let spaceData: SpaceData | null = await readSpace(spaceKey);
    // If not found, try the raw ID as a fallback (maybe stored with the prefix)
    if (!spaceData && rawSpaceId !== spaceKey) {
      spaceData = await readSpace(rawSpaceId);
    }
    if (!spaceData || isTombstoneRecord(spaceData)) {
      return null;
    }
    return spaceData;
  };

  // Device-local Space body authority (slice B1):
  // While logged in with token, still open/fresh-fetch local Spaces from local
  // body only. Never treat a remote miss of a device-local Space as not-found.
  // Account Spaces keep remote fresh authority when credentials exist.
  if (fresh) {
    const localBody = await readLocalSpaceBody();
    if (localBody && isDeviceLocalSpaceBody(localBody)) {
      return { spaceId, spaceData: localBody };
    }

    const { token, userId, servers } = selectSpaceRemoteAuth(thunkAPI.getState());
    // Guest / no token: never hit remote for Space body.
    if (token && userId && servers.length > 0) {
      const remoteSpace = await fetchAuthoritativeRemoteSpace({
        servers,
        token,
        userId,
        spaceId,
      });
      if (remoteSpace) return { spaceId, spaceData: remoteSpace };
      throw new Error(`Space not found: ${spaceId}`);
    }

    if (localBody) {
      return { spaceId, spaceData: localBody };
    }
    throw new Error(`Space not found: ${spaceId}`);
  }

  const spaceData = await readLocalSpaceBody();
  if (!spaceData) {
    throw new Error(`Space not found: ${spaceId}`);
  }

  // Ensure returned ID is normalized
  return { spaceId, spaceData };
};
