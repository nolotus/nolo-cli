import type { SpaceContent, SpaceData, ULID } from "../../../app/types";
import { createSpaceKey } from "../../space/spaceKeys";
import { read, patch } from "../../../database/dbSlice";
import { renameTable } from "../../../render/table/tableSlice";
import { SEPARATOR } from "../../../database/keys";

const notifyUserDataUpdated = () => {
  if (
    typeof window !== "undefined" &&
    typeof window.dispatchEvent === "function" &&
    typeof window.Event === "function"
  ) {
    window.dispatchEvent(new window.Event("nolo-user-data-updated"));
  }
};

const buildContentRecordTitleChanges = (
  content: SpaceContent,
  title: string,
  updatedAt: string
) => {
  const changes: Record<string, unknown> = { title, updatedAt };
  if (content.type === "app") {
    changes.name = title;
  }
  return changes;
};

export const updateContentTitleAction = async (
  input: {
    spaceId: ULID;
    contentKey: string;
    title: string;
    skillSummary?: SpaceContent["skillSummary"];
    sourceServerOrigin?: string | null;
  },
  thunkAPI: any
): Promise<{ spaceId: ULID; updatedSpaceData: SpaceData }> => {
  const { spaceId, contentKey, title, skillSummary, sourceServerOrigin } = input;
  const { dispatch } = thunkAPI;

  if (
    !contentKey ||
    typeof contentKey !== "string" ||
    contentKey.trim() === ""
  ) {
    throw new Error("Invalid contentKey provided.");
  }
  if (title === undefined || title === null || typeof title !== "string") {
    throw new Error("Invalid title provided.");
  }
  if (title.trim() === "") {
    throw new Error("Title cannot be empty.");
  }

  const spaceKey = createSpaceKey.space(spaceId);
  let spaceData: SpaceData | null = null;
  try {
    spaceData = await dispatch(read({
      dbKey: spaceKey,
      preferredServerOrigin: sourceServerOrigin,
    })).unwrap();
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

  const trimmedTitle = title.trim();
  const now = new Date().toISOString();

  const changes = {
    contents: {
      [contentKey]: {
        ...spaceData.contents[contentKey],
        title: trimmedTitle,
        updatedAt: now,
        ...(skillSummary !== undefined ? { skillSummary } : {}),
      },
    },
    updatedAt: now,
  };

  let updatedSpaceData: SpaceData;
  try {
    updatedSpaceData = await dispatch(
      patch({
        dbKey: spaceKey,
        changes,
        preferredServerOrigin: sourceServerOrigin,
      })
    ).unwrap();
  } catch (patchError: any) {
    throw new Error(`更新内容标题失败: ${patchError.message || "未知错误"}`);
  }

  // Also patch the individual content record so that sidebar "recent" items
  // (loaded via useUserData from individual records) pick up the new title
  // after a page refresh.  Without this, only the space's contents map is
  // updated while the standalone record retains the stale title.
  try {
    await dispatch(
      patch({
        dbKey: contentKey,
        changes: buildContentRecordTitleChanges(content, trimmedTitle, now),
        preferredServerOrigin: sourceServerOrigin,
      })
    ).unwrap();
    notifyUserDataUpdated();
  } catch (contentPatchError) {
    // Non-fatal: the space data is already updated; the individual record
    // may not exist for some content types or the patch may fail due to
    // permission issues. Log but don't block the title update.
    console.warn(
      "[updateContentTitle] Failed to sync title to individual content record:",
      contentPatchError
    );
  }

  // If it's a table, also sync with TableMeta
  if (contentKey.startsWith("meta-")) {
    const parts = contentKey.split(SEPARATOR);
    if (parts.length >= 3) {
      const tableId = parts[parts.length - 1];
      const tenantId = parts.slice(1, parts.length - 1).join(SEPARATOR);

      try {
        await dispatch(
          renameTable({
            tenantId,
            tableId,
            newName: trimmedTitle,
          })
        ).unwrap();
      } catch (tableError) {
        console.error("Failed to sync title to TableMeta:", tableError);
        // We don't throw here to avoid failing the whole space update
      }
    }
  }

  return { spaceId, updatedSpaceData };

};
