import { normalizeSpaceId } from "./spaceKeys";
import { SpaceData } from "../../app/types";
import { fetchSpaceSidebarStateAction } from "./fetchSpaceSidebarStateAction";
import { fetchSpaceAction } from "./fetchSpaceAction";

interface ChangeSpaceResponse {
  spaceId: string;
  spaceData: SpaceData;
  sidebarState: { collapsedCategories: Record<string, boolean> };
}

export const changeSpaceAction = async (
  spaceId: string,
  thunkAPI: any,
): Promise<ChangeSpaceResponse> => {
  const normalizedSpaceId = normalizeSpaceId(spaceId);

  const results = await Promise.allSettled([
    fetchSpaceAction({ spaceId: normalizedSpaceId, fresh: true }, thunkAPI),
    fetchSpaceSidebarStateAction(normalizedSpaceId, thunkAPI),
  ]);

  const spaceResult = results[0];
  if (spaceResult.status === "rejected" || !spaceResult.value?.spaceData) {
    throw new Error("空间不存在或加载失败");
  }
  const spaceData = spaceResult.value.spaceData as SpaceData;

  let sidebarState = { collapsedCategories: {} };
  const sidebarStateResult = results[1];
  if (sidebarStateResult.status === "fulfilled") {
    sidebarState = sidebarStateResult.value;
  }

  return { spaceId: normalizedSpaceId, spaceData, sidebarState };
};
