import type { SpaceData, ULID } from "../../../app/types";
import { patch } from "../../../database/dbSlice";
import {
  loadSpaceContentOrThrow,
  patchIndividualContentRecord,
} from "./spaceContentPatch";

export const updateContentPinnedAction = async (
  input: {
    // Items without a space membership (e.g. standalone table records in the
    // all-view) are pinned via their individual record only.
    spaceId?: ULID | null;
    contentKey: string;
    pinned: boolean;
    sourceServerOrigin?: string | null;
  },
  thunkAPI: any
): Promise<{ spaceId: ULID | null; updatedSpaceData: SpaceData | null }> => {
  const { spaceId, contentKey, pinned, sourceServerOrigin } = input;
  const { dispatch } = thunkAPI;

  if (typeof pinned !== "boolean") {
    throw new Error("Invalid pinned value provided.");
  }

  if (!spaceId) {
    if (!contentKey || typeof contentKey !== "string" || contentKey.trim() === "") {
      throw new Error("Invalid contentKey provided.");
    }
    await patchIndividualContentRecord(
      dispatch,
      contentKey,
      { pinned },
      sourceServerOrigin,
      "更新置顶状态失败"
    );
    return { spaceId: null, updatedSpaceData: null };
  }

  const { spaceKey, spaceData } = await loadSpaceContentOrThrow(
    dispatch,
    spaceId,
    contentKey,
    sourceServerOrigin
  );

  const changes = {
    contents: {
      [contentKey]: { ...spaceData.contents[contentKey], pinned },
    },
    updatedAt: new Date().toISOString(),
  };

  let updatedSpaceData: SpaceData;
  try {
    updatedSpaceData = await dispatch(
      patch({ dbKey: spaceKey, changes, preferredServerOrigin: sourceServerOrigin })
    ).unwrap();
  } catch (patchError: any) {
    throw new Error(`更新内容置顶状态失败: ${patchError.message || "未知错误"}`);
  }

  await patchIndividualContentRecord(
    dispatch,
    contentKey,
    { pinned },
    sourceServerOrigin,
    "置顶状态已写入空间，但同步独立记录失败"
  );

  return { spaceId, updatedSpaceData };
};
