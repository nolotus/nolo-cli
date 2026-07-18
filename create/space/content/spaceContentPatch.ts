import type { SpaceContent, SpaceData, ULID } from "../../../app/types";
import { createSpaceKey } from "../../space/spaceKeys";
import { read, patch } from "../../../database/dbSlice";

export const notifyUserDataUpdated = () => {
  if (
    typeof window !== "undefined" &&
    typeof window.dispatchEvent === "function" &&
    typeof window.Event === "function"
  ) {
    window.dispatchEvent(new window.Event("nolo-user-data-updated"));
  }
};

export interface SpaceContentResult {
  spaceKey: string;
  spaceData: SpaceData;
  content: SpaceContent;
}

export const loadSpaceContentOrThrow = async (
  dispatch: any,
  spaceId: ULID,
  contentKey: string,
  sourceServerOrigin?: string | null
): Promise<SpaceContentResult> => {
  if (!contentKey || typeof contentKey !== "string" || contentKey.trim() === "") {
    throw new Error("Invalid contentKey provided.");
  }

  const spaceKey = createSpaceKey.space(spaceId);
  let spaceData: SpaceData | null = null;
  try {
    spaceData = await dispatch(
      read({ dbKey: spaceKey, preferredServerOrigin: sourceServerOrigin })
    ).unwrap();
  } catch (readError) {
    throw new Error(`无法加载空间数据: ${spaceId}`);
  }

  if (!spaceData) {
    throw new Error("Space not found");
  }

  const content = spaceData.contents?.[contentKey];
  if (!content) {
    throw new Error("Content not found in space");
  }

  return { spaceKey, spaceData, content };
};

export const patchIndividualContentRecord = async (
  dispatch: any,
  contentKey: string,
  changes: Record<string, unknown>,
  sourceServerOrigin: string | null | undefined,
  failMessagePrefix: string
): Promise<void> => {
  let hasIndividualRecord = false;
  try {
    const existing = await dispatch(
      read({ dbKey: contentKey, preferredServerOrigin: sourceServerOrigin })
    ).unwrap();
    hasIndividualRecord = Boolean(existing);
  } catch {
    hasIndividualRecord = false;
  }

  if (hasIndividualRecord) {
    try {
      await dispatch(
        patch({
          dbKey: contentKey,
          changes,
          preferredServerOrigin: sourceServerOrigin,
        })
      ).unwrap();
      notifyUserDataUpdated();
    } catch (contentPatchError: any) {
      throw new Error(
        `${failMessagePrefix}: ${contentPatchError?.message || "未知错误"}`
      );
    }
  }
};
