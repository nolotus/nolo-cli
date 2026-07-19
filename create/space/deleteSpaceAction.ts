import { selectIdentityUserId } from "../../app/identity/selectors";
import { createSpaceKey } from "../space/spaceKeys";
import { asOptionalTrimmedString } from "../../core/optionalString";
import { asTrimmedNonEmptyStringArray } from "../../core/stringArray";
import { read, remove, patch, write } from "../../database/dbSlice";
import { deleteDbKey } from "../../app/hooks/deleteDbKey";
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
import {
  DEVICE_LOCAL_OWNER_ID,
  isDeviceLocalSpaceBody,
} from "../../database/authority/deviceLocal";
import { buildTombstoneRecord } from "../../database/tombstones";
import { DataType } from "../types";

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

const getCurrentUserId = (state: any): string | null =>
  asOptionalTrimmedString(selectIdentityUserId(state) as string | null | undefined) ??
  null;

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

/**
 * Owner gate for Space delete.
 * - Device-local body (`ownerId`/`userId` === `"local"`): guest or any account
 *   may delete (synthetic local owner). Cached account Spaces are never local.
 * - Account Space: require logged-in actor matching ownerId (unchanged).
 */
const checkOwnerPermission = (
  spaceData: any | undefined,
  accountUserId: string | null | undefined
) => {
  if (!spaceData) return;
  if (isDeviceLocalSpaceBody(spaceData)) return;
  if (!accountUserId) {
    throw new Error("User is not logged in.");
  }
  if (spaceData.ownerId !== accountUserId) {
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

/**
 * Device-local Space delete: write tombstones with explicit userId=local so
 * replication plans [] (removeAction does not pass record.userId to planner).
 * Body first, then membership — body tombstone alone drops the Space from
 * restart listing even if a membership row is briefly left behind.
 */
const tombstoneLocalAuthorityRecord = async (
  dbKey: string,
  existing: Record<string, unknown> | null | undefined,
  dispatch: ThunkAPI["dispatch"]
) => {
  const nowIso = new Date().toISOString();
  const base =
    existing && typeof existing === "object"
      ? { ...existing }
      : ({ dbKey } as Record<string, unknown>);
  const tombstone = buildTombstoneRecord(
    {
      ...base,
      dbKey,
      userId: DEVICE_LOCAL_OWNER_ID,
    },
    nowIso
  );
  await dispatch(
    write({
      data: tombstone,
      customKey: dbKey,
      userId: DEVICE_LOCAL_OWNER_ID,
    })
  ).unwrap();
};

const deleteLocalSpaceAuthority = async (
  spaceId: string,
  spaceData: any | undefined,
  dispatch: ThunkAPI["dispatch"]
) => {
  const spaceKey = createSpaceKey.space(spaceId);
  try {
    await tombstoneLocalAuthorityRecord(
      spaceKey,
      spaceData && typeof spaceData === "object" ? spaceData : { dbKey: spaceKey },
      dispatch
    );
  } catch (error) {
    console.warn(`Failed to tombstone local space ${spaceId}:`, error);
    throw error;
  }

  const memberIds = new Set<string>([
    DEVICE_LOCAL_OWNER_ID,
    ...asTrimmedNonEmptyStringArray(spaceData?.members),
  ]);

  for (const memberId of memberIds) {
    const memberKey = createSpaceKey.member(memberId, spaceId);
    let existingMember: Record<string, unknown> | null = null;
    try {
      existingMember = await dispatch(read({ dbKey: memberKey })).unwrap();
    } catch {
      existingMember = null;
    }
    try {
      await tombstoneLocalAuthorityRecord(
        memberKey,
        existingMember ?? {
          dbKey: memberKey,
          type: DataType.SPACE,
          userId: memberId,
          spaceId: normalizeSpaceId(spaceId),
        },
        dispatch
      );
    } catch (err) {
      console.warn(
        `Failed to tombstone local membership ${memberId} for space ${spaceId}:`,
        err
      );
    }
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
        .catch((err: unknown) =>
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
    .catch((err: unknown) =>
      console.warn(
        `Failed to delete member key for user ${userId} in space ${spaceId}:`,
        err
      )
    );
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
  const accountUserId = getCurrentUserId(getState());
  const spaceData = await fetchSpaceData(spaceId, dispatch);
  const isLocalSpace = isDeviceLocalSpaceBody(spaceData);

  if (!isLocalSpace) {
    if (!accountUserId) {
      throw new Error("User is not logged in.");
    }
    checkOwnerPermission(spaceData, accountUserId);
  }
  // Device-local Space: guest or logged-in may delete; body owner is "local".
  // Do not require account membership / account ownerId match.

  // Content strategy ownership: local Space uses synthetic local owner.
  const ownershipUserId = isLocalSpace
    ? DEVICE_LOCAL_OWNER_ID
    : (accountUserId as string);

  if (spaceData && strategy !== "delete-space-only") {
    const allEntities = await listSpaceEntities(spaceData, dispatch);
    const ownedEntities = allEntities.filter(({ entityKey, entity }) =>
      isOwnedByUser(entityKey, entity, ownershipUserId)
    );
    const unownedEntities = allEntities.filter(
      ({ entityKey, entity }) => !isOwnedByUser(entityKey, entity, ownershipUserId)
    );

    if (strategy === "move-owned-to-all") {
      await clearEntitySpaceIds(allEntities, dispatch);
    } else if (strategy === "delete-owned-content") {
      await deleteOwnedEntities(ownedEntities, dispatch);
      await clearEntitySpaceIds(unownedEntities, dispatch);
    }
  }

  if (isLocalSpace) {
    await deleteLocalSpaceAuthority(spaceId, spaceData, dispatch);
  } else {
    await deleteSpaceData(spaceId, dispatch);
    await deleteAllMembers(spaceData, spaceId, dispatch);
    await deleteCurrentUserMember(accountUserId as string, spaceId, dispatch);
  }

  return { spaceId, strategy };
};
