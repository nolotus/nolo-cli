// 文件路径: create/space/actions/addContentAction.ts

import type { SpaceId } from "../../space/types";
import type { SpaceData, SpaceContent, ContentType, FileCategory } from "../../../app/types";
import { selectUserId } from "../../../auth/authSlice";
import { createSpaceKey } from "../../space/spaceKeys";
import { read, patch } from "../../../database/dbSlice";
import { checkSpaceMembership } from "../utils/permissions";
import { UNCATEGORIZED_ID } from "../../space/constants";

export interface AddContentRequest {
  title: string;
  type: ContentType;
  contentKey: string;
  fileCategory?: FileCategory;
  mimeType?: string;
  fileSize?: number;
  originalName?: string;
  categoryId?: string;
  pinned?: boolean;
  order?: number;
  triggerType?: string;
  skillSummary?: SpaceContent["skillSummary"];
}

export const addContentAction = async (
  input: AddContentRequest & { spaceId: SpaceId },
  thunkAPI: { dispatch: any; getState: () => any }
): Promise<{ spaceId: SpaceId; updatedSpaceData: SpaceData }> => {
  const {
    spaceId,
    title,
    type,
    contentKey,
    fileCategory,
    mimeType,
    fileSize,
    originalName,
    categoryId: rawCategoryId,
    pinned = false,
    order,
    triggerType,
    skillSummary,
  } = input;

  const { dispatch, getState } = thunkAPI;
  const userId = selectUserId(getState());

  // 基本输入验证
  if (!userId) throw new Error("User is not logged in.");
  if (!contentKey || typeof contentKey !== "string" || contentKey.trim() === "")
    throw new Error("Invalid contentKey provided.");
  if (!title || typeof title !== "string" || title.trim() === "")
    throw new Error("Invalid or empty title provided.");
  if (!type || typeof type !== "string")
    throw new Error("Invalid content type provided.");

  // 读取 Space 数据
  const spaceKey = createSpaceKey.space(spaceId);
  const spaceData = await dispatch(read({
    dbKey: spaceKey
  })).unwrap();

  // 权限检查
  checkSpaceMembership(spaceData, userId);

  // 检查 Content Key 是否已存在
  if (spaceData.contents && spaceData.contents[contentKey]) {
    throw new Error(`内容键 "${contentKey}" 已存在。`);
  }

  // 确定最终用于存储的 categoryId
  let categoryIdForStorage: string | undefined;
  if (
    rawCategoryId &&
    rawCategoryId !== "" &&
    rawCategoryId !== UNCATEGORIZED_ID
  ) {
    if (spaceData.categories?.[rawCategoryId]) {
      categoryIdForStorage = rawCategoryId;
    }
  }

  // 构造新内容对象
  const now = Date.now();
  const newSpaceContent: SpaceContent = {
    title: title.trim(),
    type,
    contentKey,
    ...(fileCategory !== undefined ? { fileCategory } : {}),
    ...(mimeType !== undefined ? { mimeType } : {}),
    ...(fileSize !== undefined ? { fileSize } : {}),
    ...(originalName !== undefined ? { originalName } : {}),
    ...(categoryIdForStorage !== undefined && {
      categoryId: categoryIdForStorage,
    }),
    pinned,
    createdAt: now,
    updatedAt: now,
    ...(order !== undefined && typeof order === "number" && { order }),
    ...(triggerType !== undefined && { triggerType }),
    ...(skillSummary !== undefined ? { skillSummary } : {}),
  };

  // 准备并执行 Patch 更新
  const changes = {
    contents: { [contentKey]: newSpaceContent },
    updatedAt: now,
  };

  const updatedSpaceData = await dispatch(
    patch({ dbKey: spaceKey, changes })
  ).unwrap();

  return { spaceId, updatedSpaceData };
};
