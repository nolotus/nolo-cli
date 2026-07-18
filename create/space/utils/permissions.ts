// create/space/utils/permissions.ts

import type { SpaceData } from "../../../app/types";
import {
  DEVICE_LOCAL_OWNER_ID,
  isDeviceLocalSpaceBody,
} from "../../../database/authority/deviceLocal";

/**
 * Check whether the actor may mutate the given Space.
 *
 * Device-local Space body (`userId`/`ownerId` === `"local"`) is owned by the
 * synthetic local owner: guest and any logged-in account may operate it.
 * Account Spaces keep strict membership (logged-in + members includes userId).
 * Local cache of an account Space is never treated as device-local.
 */
export const checkSpaceMembership = (
  spaceData: SpaceData | null,
  userId: string | null | undefined
): void => {
  if (!spaceData) {
    console.error("[Permission Check] Space data is missing.");
    throw new Error("无法执行权限检查：空间数据缺失。");
  }

  // Real local body authority only — not arbitrary cached account Spaces.
  if (isDeviceLocalSpaceBody(spaceData)) {
    return;
  }

  if (!userId) {
    console.error("[Permission Check] User ID is missing.");
    throw new Error("无法执行权限检查：用户 ID 缺失。");
  }

  if (
    !spaceData.members ||
    !Array.isArray(spaceData.members) ||
    !spaceData.members.includes(userId)
  ) {
    console.warn(
      `[Permission Check] User ${userId} attempt to operate on space ${spaceData.id} without membership.`
    );
    throw new Error("当前用户不是空间成员");
  }
};

/**
 * Fields to merge into Space body patch/write changes so replication authority
 * sees `userId === "local"` and plans zero remote servers.
 * No-op for account Spaces (must not rewrite account ownership stamps).
 */
export const localSpaceAuthorityPatchStamp = (
  spaceData: { userId?: string | null; ownerId?: string | null } | null | undefined
): { userId: typeof DEVICE_LOCAL_OWNER_ID } | Record<string, never> =>
  isDeviceLocalSpaceBody(spaceData) ? { userId: DEVICE_LOCAL_OWNER_ID } : {};
