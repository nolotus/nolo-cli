// app/space/addSpaceAction.ts

import {
  MemberRole,
  SpaceVisibility,
  SpaceData,
  SpaceContent,
  ContentType,
  type SpaceMemberWithSpaceInfo,
} from "../../app/types";
import { selectIdentityUserId } from "../../app/identity/selectors";
import { DataType } from "../types";
import { fetchUserData } from "../../database/client/fetchUserData";
import {
  isDeviceLocalOwnerId,
  isDeviceLocalSpaceMembership,
  resolveEffectiveSpaceActorId,
  resolveRecordOwnerUserId,
} from "../../database/authority/deviceLocal";
import { ulid } from "ulid";
import { patch, write } from "../../database/dbSlice";
import { createSpaceKey } from "../space/spaceKeys";
import { selectAllMemberSpaces } from "./spaceSlice";
import type { CreateSpaceRequest } from "./types";
import type { AppDispatch, RootState } from "../../app/store";

//
// Helper: 一次性读取本地用户数据
//
interface BaseItem {
  id: string;
  type: DataType;
  userId: string;
  createdAt?: string | number;
  updatedAt?: string | number;
  [key: string]: any;
}

interface GetUserDataOptions {
  types: DataType | DataType[];
  userId: string;
  limit: number;
  isLoggedIn?: boolean;
  currentUserId?: string;
  db: any;
}

async function getUserDataOnce({
  types,
  userId,
  limit,
  isLoggedIn = false,
  currentUserId,
  db,
}: GetUserDataOptions): Promise<{
  data: BaseItem[];
  error?: Error;
}> {
  try {
    const typeArray = Array.isArray(types) ? types : [types];
    const effectiveUserId =
      userId === "local" && isLoggedIn && currentUserId
        ? currentUserId
        : userId;
    const localResults = await fetchUserData(db, typeArray, effectiveUserId);
    const localData = Object.values(localResults).flat();
    return { data: localData };
  } catch (err) {
    const error =
      err instanceof Error ? err : new Error("Unknown error occurred");
    return { data: [], error };
  }
}

const targetTypes: DataType[] = [DataType.DIALOG, DataType.DOC];

const getCurrentPathForLog = () =>
  typeof window !== "undefined" &&
  typeof window.location?.pathname === "string"
    ? window.location.pathname
    : undefined;

/**
 * 新增 Space，包括首次迁移旧侧边栏数据到 Space.contents
 *
 * Device-local foundation:
 * - Logged-out → synthetic actor `"local"` (Space body + membership stamped local).
 * - Logged-in account → account-owned Space (unchanged).
 * - Write config always passes explicit actor userId so local stamps even if a
 *   session exists later; replication uses record.userId === "local" → [].
 */
export const addSpaceAction = async (
  input: CreateSpaceRequest,
  thunkAPI: { dispatch: AppDispatch; getState: () => RootState; extra: { db: any } }
): Promise<SpaceMemberWithSpaceInfo> => {
  const {
    name,
    description = "",
    boundFolder,
  } = input;
  const visibility = (input.visibility ?? SpaceVisibility.PRIVATE) as SpaceVisibility;
  const { dispatch, getState, extra } = thunkAPI;
  const state = getState();
  const accountUserId = selectIdentityUserId(state);
  // Guest / blank → "local"; active non-local account → that account id.
  // Does not mutate auth state.
  const userId = resolveEffectiveSpaceActorId(accountUserId);

  const spaceId = ulid();
  const now = Date.now();
  const nowISO = new Date(now).toISOString();

  // 基本 Space 数据 — body keys remain space-{ULID}; authority is owner/userId.
  const spaceData: SpaceData & { userId: string } = {
    id: spaceId,
    name,
    description,
    boundFolder,
    ownerId: userId,
    userId,
    visibility,
    members: [userId],
    categories: {},
    contents: {},
    createdAt: now,
    updatedAt: now,
    type: DataType.SPACE,
  };
  const spaces = selectAllMemberSpaces(state);
  // After local+account membership union, first-Space migration must be
  // actor-scoped: a device-local membership must not block account first-Space
  // migration, and an account membership must not block guest first-Space.
  const hasSpaceForActor = spaces.some(
    (membership: SpaceMemberWithSpaceInfo) => {
      if (isDeviceLocalOwnerId(userId)) {
        return isDeviceLocalSpaceMembership(membership);
      }
      if (isDeviceLocalSpaceMembership(membership)) return false;
      return (
        membership.userId === userId || membership.ownerId === userId
      );
    }
  );

  console.info("[space/create] addSpaceAction", {
    userId,
    name,
    visibility,
    boundFolder,
    memberSpaceCount: spaces.length,
    hasSpaceForActor,
    currentPath: getCurrentPathForLog(),
  });

  if (!hasSpaceForActor) {
    // 首次创建 Space 时尝试迁移旧侧边栏数据（仅同 owner，避免 local↔account 串迁）
    const { data: oldItems = [] } = await getUserDataOnce({
      types: targetTypes,
      userId,
      limit: 100,
      db: extra.db,
    });

    const hasOldSideData = oldItems.length > 0;
    if (hasOldSideData) {
      const contents: Record<string, SpaceContent> = {};
      const updatePromises: Promise<any>[] = [];

      for (const item of oldItems) {
        if (!item.id || !item.type) continue;
        // Classify source owner explicitly — never migrate account content into
        // a local Space or local content into an account Space.
        const recordOwner = resolveRecordOwnerUserId(item);
        if (recordOwner !== userId) continue;

        const stableContentKey =
          typeof item.dbKey === "string" && item.dbKey.trim()
            ? item.dbKey
            : item.id;
        contents[stableContentKey] = {
          title: item.title || "",
          type: item.type as unknown as ContentType,
          contentKey: stableContentKey,
          categoryId: "",
          pinned: false,
          createdAt: (item.createdAt ?? now) as unknown as number,
          updatedAt: (item.updatedAt ?? now) as unknown as number,
          order: item.order,
        };
        if (item.dbKey) {
          updatePromises.push(
            dispatch(
              patch({
                dbKey: item.dbKey,
                changes: { spaceId, updatedAt: now },
              })
            )
          );
        }
      }
      spaceData.contents = contents;
      await Promise.all(updatePromises);
    }
  }

  // 写入 Space — explicit userId so local authority stamps even under account session
  const spaceKey = createSpaceKey.space(spaceId);
  await dispatch(
    write({ data: spaceData, customKey: spaceKey, userId })
  ).unwrap();

  // 写入 SpaceMember — key family space-member-{userId}-{spaceId}
  // Local path → space-member-local-{ULID}; never a second registry.
  const spaceMemberKey = createSpaceKey.member(userId, spaceId);
  const spaceMemberData: SpaceMemberWithSpaceInfo = {
    dbKey: spaceMemberKey,
    type: DataType.SPACE,
    userId,
    role: MemberRole.OWNER,
    joinedAt: now,
    spaceId,
    spaceName: name,
    ownerId: userId,
    visibility,
    createdAt: nowISO,
    updatedAt: nowISO,
  };

  await dispatch(
    write({ data: spaceMemberData, customKey: spaceMemberKey, userId })
  ).unwrap();

  return spaceMemberData;
};
