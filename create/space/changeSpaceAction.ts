import { toTimestampMs } from "../../core/timestamp";
import { SpaceData } from "../../app/types";
import { normalizeSpaceId } from "./spaceKeys";
import { fetchSpaceSidebarStateAction } from "./fetchSpaceSidebarStateAction";
import { fetchSpaceAction } from "./fetchSpaceAction";

interface ChangeSpaceResponse {
  spaceId: string;
  spaceData: SpaceData;
  sidebarState: { collapsedCategories: Record<string, boolean> };
}

const getSpaceUpdatedAt = (space: SpaceData | null | undefined): number => {
  if (!space) return 0;
  return toTimestampMs((space as any).updatedAt);
};

/**
 * Open a space for the sidebar as fast as possible:
 * 1) read local body (no remote wait)
 * 2) if missing, fall back to fresh (may hit remote)
 * 3) when local hit, soft-revalidate in the background and patch if still current
 */
export const changeSpaceAction = async (
  spaceId: string,
  thunkAPI: any,
): Promise<ChangeSpaceResponse> => {
  const normalizedSpaceId = normalizeSpaceId(spaceId);

  const sidebarPromise = fetchSpaceSidebarStateAction(
    normalizedSpaceId,
    thunkAPI,
  ).catch(() => ({ collapsedCategories: {} as Record<string, boolean> }));

  let spaceData: SpaceData | null = null;
  let usedLocal = false;

  try {
    const local = await fetchSpaceAction(
      { spaceId: normalizedSpaceId, fresh: false },
      thunkAPI,
    );
    if (local?.spaceData) {
      spaceData = local.spaceData as SpaceData;
      usedLocal = true;
    }
  } catch {
    // fall through to fresh path
  }

  if (!spaceData) {
    const fresh = await fetchSpaceAction(
      { spaceId: normalizedSpaceId, fresh: true },
      thunkAPI,
    );
    if (!fresh?.spaceData) {
      throw new Error("空间不存在或加载失败");
    }
    spaceData = fresh.spaceData as SpaceData;
  } else if (usedLocal) {
    // Soft revalidate: do not block first paint. Apply only if still on this space
    // and remote body is at least as new as the local snapshot.
    void fetchSpaceAction({ spaceId: normalizedSpaceId, fresh: true }, thunkAPI)
      .then((result) => {
        if (!result?.spaceData) return;
        const state = thunkAPI.getState()?.space;
        if (!state) return;
        if (normalizeSpaceId(state.currentSpaceId || "") !== normalizedSpaceId) {
          return;
        }
        if (
          getSpaceUpdatedAt(result.spaceData) <
          getSpaceUpdatedAt(state.currentSpace)
        ) {
          return;
        }
        thunkAPI.dispatch({
          type: "space/fetchSpace/fulfilled",
          payload: {
            spaceId: normalizedSpaceId,
            spaceData: result.spaceData,
          },
          meta: {
            arg: { spaceId: normalizedSpaceId, fresh: true },
            requestId: `changeSpace-revalidate-${normalizedSpaceId}`,
            requestStatus: "fulfilled",
          },
        });
      })
      .catch(() => {
        /* ignore background refresh failures */
      });
  }

  const sidebarState = await sidebarPromise;

  return {
    spaceId: normalizedSpaceId,
    spaceData,
    sidebarState,
  };
};
