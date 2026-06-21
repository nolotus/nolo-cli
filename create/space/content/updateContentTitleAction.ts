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
  //
  // Some content types (e.g. table meta records, ephemeral rows) may not have
  // a standalone record. Detect that with a read first and skip the patch
  // cleanly; for any other failure we throw so the caller (and the user, via
  // the rejected toast in contentThunks) sees that the two data paths
  // diverged instead of silently keeping a stale individual record.
  let hasIndividualRecord = false;
  try {
    const existing = await dispatch(
      read({
        dbKey: contentKey,
        preferredServerOrigin: sourceServerOrigin,
      })
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
          changes: buildContentRecordTitleChanges(content, trimmedTitle, now),
          preferredServerOrigin: sourceServerOrigin,
        })
      ).unwrap();
      notifyUserDataUpdated();
    } catch (contentPatchError: any) {
      throw new Error(
        `标题已写入空间，但同步独立记录失败: ${
          contentPatchError?.message || "未知错误"
        }`
      );
    }
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
