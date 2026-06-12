import { selectUserId } from "../../auth/authSlice";
import { createSpaceKey } from "../space/spaceKeys";
import { read, remove, patch } from "../../database/dbSlice";
import { deleteDbKey } from "../../app/hooks/deleteDbKey";
import {
  persistDefaultSpacePreference,
  readDefaultSpaceIdPreference,
} from "../../app/settings/defaultSpacePreference";
import {
  isAgentKey,
  isAppKey,
  isDialogKey,
  isFileKey,
  isPageKey,
  isTableMetaKey,
  splitKey,
} from "../../database/keys";
import { normalizeSpaceId } from "./spaceKeys";

// 定义ThunkAPI的通用类型（根据redux-thunk的用法）
interface ThunkAPI {
  dispatch: (action: any) => any;
  getState: () => any; // 如果有RootState类型，可替换为RootState
}

export type DeleteSpaceStrategy =
  | "delete-space-only"
  | "move-owned-to-all"
  | "delete-owned-content";

type DeleteSpaceArgs =
  | string
  | {
      spaceId: string;
      strategy?: DeleteSpaceStrategy;
    };

const getCurrentUserId = (state: any): string => selectUserId(state);

const fetchSpaceData = async (
  spaceId: string,
  dispatch: ThunkAPI["dispatch"]
) => {
  const spaceKey = createSpaceKey.space(spaceId);
  try {
    return await dispatch(read({
      dbKey: spaceKey
    })).unwrap();
  } catch (error) {
    console.warn(`Failed to read space ${spaceId}:`, error);
    return undefined;
  }
};

const checkOwnerPermission = (spaceData: any | undefined, userId: string) => {
  if (spaceData && spaceData.ownerId !== userId) {
    throw new Error("Only owner can delete space");
  }
};

const deleteSpaceData = async (
  spaceId: string,
  dispatch: ThunkAPI["dispatch"]
) => {
  const spaceKey = createSpaceKey.space(spaceId);
  try {
    await dispatch(remove(spaceKey)).unwrap();
  } catch (error) {
    console.warn(`Failed to delete space ${spaceId}:`, error);
  }
};

const deleteAllMembers = async (
  spaceData: any | undefined,
  spaceId: string,
  dispatch: ThunkAPI["dispatch"]
) => {
  if (spaceData?.members) {
    for (const memberId of spaceData.members) {
      const memberKey = createSpaceKey.member(memberId, spaceId);
      await dispatch(remove(memberKey))
        .unwrap()
        .catch((err) =>
          console.warn(
            `Failed to delete member ${memberId} for space ${spaceId}:`,
            err
          )
        );
    }
  }
};

const deleteCurrentUserMember = async (
  userId: string,
  spaceId: string,
  dispatch: ThunkAPI["dispatch"]
) => {
  const currentUserMemberKey = createSpaceKey.member(userId, spaceId);
  await dispatch(remove(currentUserMemberKey))
    .unwrap()
    .catch((err) =>
      console.warn(
        `Failed to delete member key for user ${userId} in space ${spaceId}:`,
        err
      )
    );
};

const clearDefaultSpacePreferenceIfNeeded = async (
  userId: string,
  spaceId: string,
  dispatch: ThunkAPI["dispatch"]
) => {
  const defaultSpaceId = await readDefaultSpaceIdPreference(dispatch, userId);
  if (defaultSpaceId && normalizeSpaceId(defaultSpaceId) === normalizeSpaceId(spaceId)) {
    await persistDefaultSpacePreference(dispatch, userId, null);
  }
};

const clearDeletedMemberDefaultSpacePreferences = async (
  userIds: string[],
  spaceId: string,
  dispatch: ThunkAPI["dispatch"]
) => {
  const uniqueUserIds = Array.from(new Set(userIds.filter(Boolean)));
  for (const userId of uniqueUserIds) {
    await clearDefaultSpacePreferenceIfNeeded(userId, spaceId, dispatch);
  }
};

const resolveDeleteArgs = (
  input: DeleteSpaceArgs
): { spaceId: string; strategy: DeleteSpaceStrategy } => {
  if (typeof input === "string") {
    return { spaceId: input, strategy: "delete-space-only" };
  }
  return {
    spaceId: input.spaceId,
    strategy: input.strategy ?? "delete-space-only",
  };
};

const isOwnedByUser = (entityKey: string, entity: any, userId: string): boolean => {
  if (!entityKey || !userId) return false;

  const keyParts = splitKey(entityKey);
  const keyedOwner = keyParts[1];

  if (
    (isDialogKey(entityKey) ||
      isPageKey(entityKey) ||
      isFileKey(entityKey) ||
      isTableMetaKey(entityKey)) &&
    keyedOwner === userId
  ) {
    return true;
  }

  if ((isAgentKey(entityKey) || isAppKey(entityKey)) && entity?.userId === userId) {
    return true;
  }

  if (entity?.tenantId === userId || entity?.userId === userId || entity?.ownerId === userId) {
    return true;
  }

  return false;
};

const nextUpdatedAt = (entity: any): string => {
  const source =
    entity?.updatedAt ??
    entity?.updated_at ??
    entity?.createdAt ??
    entity?.created ??
    Date.now();
  const timestamp =
    typeof source === "number" ? source : Date.parse(String(source)) || Date.now();
  return new Date(Math.max(Date.now(), timestamp + 1)).toISOString();
};

const listSpaceEntities = async (
  spaceData: any | undefined,
  dispatch: ThunkAPI["dispatch"]
) => {
  const results: Array<{ entityKey: string; entity: any }> = [];
  const contents = Object.values(spaceData?.contents ?? {}).filter(Boolean) as Array<{
    contentKey?: string;
  }>;

  for (const item of contents) {
    const entityKey = typeof item.contentKey === "string" ? item.contentKey : "";
    if (!entityKey) continue;

    let entity: any = null;
    try {
      entity = await dispatch(read({ dbKey: entityKey })).unwrap();
    } catch {
      entity = null;
    }

    results.push({ entityKey, entity });
  }

  return results;
};

const clearEntitySpaceIds = async (
  entities: Array<{ entityKey: string; entity: any }>,
  dispatch: ThunkAPI["dispatch"]
) => {
  await Promise.all(
    entities
      .filter(({ entity }) => entity && typeof entity === "object")
      .map(({ entityKey, entity }) =>
      dispatch(
        patch({
          dbKey: entityKey,
          changes: {
            spaceId: null,
            updatedAt: nextUpdatedAt(entity),
          },
        })
      ).unwrap()
      )
  );
};

const deleteOwnedEntities = async (
  ownedEntities: Array<{ entityKey: string; entity: any }>,
  dispatch: ThunkAPI["dispatch"]
) => {
  for (const { entityKey } of ownedEntities) {
    await dispatch(deleteDbKey(entityKey));
  }
};

export const deleteSpaceAction = async (
  input: DeleteSpaceArgs,
  thunkAPI: ThunkAPI
) => {
  const { dispatch, getState } = thunkAPI;
  const { spaceId, strategy } = resolveDeleteArgs(input);
  const userId = getCurrentUserId(getState());
  const spaceData = await fetchSpaceData(spaceId, dispatch);

  checkOwnerPermission(spaceData, userId);

  if (spaceData && strategy !== "delete-space-only") {
    const allEntities = await listSpaceEntities(spaceData, dispatch);
    const ownedEntities = allEntities.filter(({ entityKey, entity }) =>
      isOwnedByUser(entityKey, entity, userId)
    );
    const unownedEntities = allEntities.filter(
      ({ entityKey, entity }) => !isOwnedByUser(entityKey, entity, userId)
    );

    if (strategy === "move-owned-to-all") {
      await clearEntitySpaceIds(allEntities, dispatch);
    } else if (strategy === "delete-owned-content") {
      await deleteOwnedEntities(ownedEntities, dispatch);
      await clearEntitySpaceIds(unownedEntities, dispatch);
    }
  }

  await deleteSpaceData(spaceId, dispatch);
  await deleteAllMembers(spaceData, spaceId, dispatch);
  await deleteCurrentUserMember(userId, spaceId, dispatch);
  await clearDeletedMemberDefaultSpacePreferences(
    [userId, ...(Array.isArray(spaceData?.members) ? spaceData.members : [])],
    spaceId,
    dispatch
  );

  return { spaceId, strategy };
};
