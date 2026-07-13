// create/space/deleteContentFromSpaceAction.ts
import { createSpaceKey, normalizeSpaceId } from "../../space/spaceKeys";
import { patch, read, remove } from "../../../database/dbSlice";
import { SpaceData, SpaceContent, Agent } from "../../../app/types";
import { selectUserId } from "../../../auth/authSlice";
import { isAgentKey, isPageKey, splitKey } from "../../../database/keys";
import { extractUserId } from "../../../core/prefix";
import { isSystemAdmin } from "../../../core/init";
import { deleteDialog } from "../../../chat/dialog/dialogSlice";
import { deleteTable } from "../../../render/table/tableSlice";
import {
  DEVICE_LOCAL_OWNER_ID,
  isDeviceLocalSpaceBody,
} from "../../../database/authority/deviceLocal";
import {
  checkSpaceMembership,
  localSpaceAuthorityPatchStamp,
} from "../utils/permissions";

const nextSpaceUpdatedAt = (value: unknown): number | string => {
  const previousTimestamp =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Date.parse(value) || 0
        : 0;
  const nextTimestamp = Math.max(Date.now(), previousTimestamp + 1);
  return typeof value === "string"
    ? new Date(nextTimestamp).toISOString()
    : nextTimestamp;
};

const findContentReference = (
  spaceData: SpaceData,
  requestedContentKey: string
): { entryKey: string; contentInfo: SpaceContent } | null => {
  const contents = spaceData.contents ?? {};
  const directMatch = contents[requestedContentKey];
  if (directMatch) {
    return { entryKey: requestedContentKey, contentInfo: directMatch };
  }

  for (const [entryKey, item] of Object.entries(contents)) {
    if (!item) continue;
    if (item.contentKey === requestedContentKey) {
      return { entryKey, contentInfo: item };
    }
  }

  return null;
};

/**
 * 策略模式处理不同类型内容的实体物理删除逻辑
 */
const ENTITY_DELETE_STRATEGIES: Record<
  string,
  (key: string, ctx: {
    dispatch: any;
    userId: string;
    thunkAPI: any;
    sourceServerOrigin?: string | null;
  }) => Promise<void>
> = {
  dialog: async (key, { dispatch }) => {
    await (dispatch as any)(deleteDialog(key)).unwrap();
  },
  page: async (key, { dispatch, userId, sourceServerOrigin }) => {
    const isOwnerByKey = extractUserId(key) === userId;
    if (isOwnerByKey || isSystemAdmin(userId)) {
      await dispatch(remove({ dbKey: key, preferredServerOrigin: sourceServerOrigin }));
    }
  },
  table: async (key, { dispatch }) => {
    await (dispatch as any)(deleteTable({ dbKey: key })).unwrap();
  },
  file: async (key, { thunkAPI }) => {
    const { deleteFileAction } = await import("../../../database/actions/deleteFile");
    await deleteFileAction(key, thunkAPI);
  },
  image: async (key, { thunkAPI }) => {
    const { deleteFileAction } = await import("../../../database/actions/deleteFile");
    await deleteFileAction(key, thunkAPI);
  },
  agent: async (key, { dispatch, userId, sourceServerOrigin }) => {
    const parts = splitKey(key);
    const isPublic = parts[1] === "pub";
    const isOwnerByKey = parts[1] === userId;

    if (!isPublic) {
      // 1. 私有副本：只有所有者或管理员可以物理删除实体
      if (isOwnerByKey || isSystemAdmin(userId)) {
        await dispatch(remove({ dbKey: key, preferredServerOrigin: sourceServerOrigin }));
      }
    } else {
      // 2. 公共副本：只有创建者或管理员可以删除实体
      const agentData = (await (dispatch as any)(read({
        dbKey: key,
        preferredServerOrigin: sourceServerOrigin,
      })).unwrap()) as Agent | null;
      if (agentData) {
        const isCreator = agentData.userId === userId;
        const isAdmin = isSystemAdmin(userId);
        if (isCreator || isAdmin) {
          await dispatch(remove({ dbKey: key, preferredServerOrigin: sourceServerOrigin }));
        }
      }
    }
  },
  cybot: async (key, ctx) => ENTITY_DELETE_STRATEGIES.agent(key, ctx),
};

/**
 * 从指定的 Space 中删除内容的引用，并随后根据类型执行实体的物理删除。
 */
export const deleteContentFromSpaceAction = async (
  input: { contentKey: string; spaceId: string; sourceServerOrigin?: string | null },
  thunkAPI: any
) => {
  const { contentKey, sourceServerOrigin } = input;
  const spaceId = normalizeSpaceId(input.spaceId);
  const { dispatch, getState } = thunkAPI;
  const accountUserId = selectUserId(getState()) as string | null | undefined;

  // 1. 获取并验证 Space 数据
  const spaceKey = createSpaceKey.space(spaceId);
  const spaceData = (await (dispatch as any)(read({
    dbKey: spaceKey,
    preferredServerOrigin: sourceServerOrigin,
  })).unwrap()) as SpaceData | null;

  if (!spaceData) throw new Error("空间不存在");
  // Local body → local owner (guest or logged-in); account Space keeps membership.
  checkSpaceMembership(spaceData, accountUserId);

  const contentReference = findContentReference(spaceData, contentKey);
  if (!contentReference) {
    return { contentKey, spaceId, updatedSpaceData: spaceData };
  }

  const { entryKey, contentInfo } = contentReference;
  const entityKey = String(contentInfo.contentKey || contentKey || entryKey);
  const contentDeletes: Record<string, null> = {
    [entryKey]: null,
  };
  if (entityKey !== entryKey) {
    contentDeletes[entityKey] = null;
  }

  // 2. 从 Space 的 contents 中移除引用；本地 Space 显式 stamp userId=local
  const updatedSpaceData = await (dispatch as any)(
    patch({
      dbKey: spaceKey,
      preferredServerOrigin: sourceServerOrigin,
      changes: {
        contents: contentDeletes,
        updatedAt: nextSpaceUpdatedAt(spaceData.updatedAt),
        ...localSpaceAuthorityPatchStamp(spaceData),
      },
    })
  ).unwrap();

  // 3. 根据内容类型执行实体的物理删除 (Functional Refactor)
  // Local Space body → entity owner checks use synthetic "local" (not the
  // active account id). Account Spaces keep account userId.
  const userId = isDeviceLocalSpaceBody(spaceData)
    ? DEVICE_LOCAL_OWNER_ID
    : String(accountUserId ?? "");
  let entityRemoveError: string | null = null;
  const contentType = String(contentInfo.type || "").toLowerCase();

  try {
    const strategy = ENTITY_DELETE_STRATEGIES[contentType];
    if (strategy) {
      await strategy(entityKey, { dispatch, userId, thunkAPI, sourceServerOrigin });
    } else if (isPageKey(entityKey)) {
      await ENTITY_DELETE_STRATEGIES.page(entityKey, {
        dispatch,
        userId,
        thunkAPI,
        sourceServerOrigin,
      });
    } else if (isAgentKey(entityKey)) {
      await ENTITY_DELETE_STRATEGIES.agent(entityKey, {
        dispatch,
        userId,
        thunkAPI,
        sourceServerOrigin,
      });
    }
  } catch (err: any) {
    console.error(`[deleteContent] Failed to delete entity ${entityKey}:`, err);
    entityRemoveError = err.message || "Unknown error";
  }

  return {
    contentKey,
    spaceId,
    updatedSpaceData,
    entityRemoveError,
  };
};
