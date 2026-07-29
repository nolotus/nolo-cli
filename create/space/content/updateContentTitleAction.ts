import type { SpaceContent, SpaceData, ULID } from "../../../app/types";
import { patch } from "../../../database/dbSlice";
import { renameTable } from "../../../render/table/tableSlice";
import { SEPARATOR } from "../../../database/keys";
import {
  loadSpaceContentOrThrow,
  patchIndividualContentRecord,
} from "./spaceContentPatch";

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

  if (title === undefined || title === null || typeof title !== "string") {
    throw new Error("Invalid title provided.");
  }
  if (title.trim() === "") {
    throw new Error("Title cannot be empty.");
  }

  const { spaceKey, spaceData, content } = await loadSpaceContentOrThrow(
    dispatch,
    spaceId,
    contentKey,
    sourceServerOrigin
  );

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

  await patchIndividualContentRecord(
    dispatch,
    contentKey,
    buildContentRecordTitleChanges(content, trimmedTitle, now),
    sourceServerOrigin,
    "标题已写入空间，但同步独立记录失败"
  );

  // If it's a table, also sync with TableMeta
  if (contentKey.startsWith("meta-")) {
    const parts = contentKey.split(SEPARATOR);
    if (parts.length >= 3) {
      const tableId = parts.slice(2).join(SEPARATOR);
      const tenantId = parts[1];

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
