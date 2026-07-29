import { normalizeSpaceId } from "./spaceKeys";
import { readStoredCollapsedCategories } from "./spaceCollapsedState";

interface FetchSpaceSidebarStateResponse {
  collapsedCategories: Record<string, boolean>;
}

export const fetchSpaceSidebarStateAction = async (
  spaceId: string,
  thunkAPI: any,
): Promise<FetchSpaceSidebarStateResponse> => {
  const { dispatch, getState } = thunkAPI;
  const normalizedSpaceId = normalizeSpaceId(spaceId);
  void dispatch;
  void getState;

  return {
    collapsedCategories:
      typeof window === "undefined"
        ? {}
        : readStoredCollapsedCategories(
            normalizedSpaceId,
            window.localStorage,
          ),
  };
};
