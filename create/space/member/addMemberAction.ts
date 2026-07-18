import type { ULID } from "../../../app/types";
import { MemberRole } from "../../../app/types";
import type { SpaceData } from "../../../app/types";
import { selectUserId } from "../../../auth/authSlice";
import { createSpaceKey } from "../../space/spaceKeys";
import { DB_PREFIX } from "../../../database/keys";
import { read, write } from "../../../database/dbSlice";
import { SpaceMemberWithSpaceInfo } from "../../../app/types";
import { DataType } from "../../types";
import type { DbThunkApi } from "../../../database/thunkApiTypes";
import { dbThunkExtra, dbThunkState } from "../../../database/thunkApiTypes";
import type { AppExtra } from "../../../app/store";
import { logger } from "../../../database/actions/common";

/**
 * 添加成员到空间
 *
 * 说明：
 * 1. 当前用户必须为空间现有成员，才可以添加新成员；
 * 2. 如果成员已存在则直接报错；
 * 3. 更新 SpaceData.members 数组，同时为新成员创建 SpaceMemberWithSpaceInfo 数据。
 */
export const addMemberAction = async (
  input: { spaceId: ULID; memberId: string; role?: MemberRole },
  thunkAPI: DbThunkApi
): Promise<{ spaceId: ULID; updatedSpaceData: SpaceData }> => {
  const { spaceId, memberId, role = MemberRole.MEMBER } = input; // 默认角色为 MEMBER
  const { dispatch } = thunkAPI;
  const state = dbThunkState(thunkAPI);
  const currentUserId = selectUserId(state);

  const { db } = dbThunkExtra(thunkAPI);

  const resolvedMemberId = db
    ? await resolveMemberId(db, memberId)
    : memberId.trim();

  const spaceKey = createSpaceKey.space(spaceId);
  const spaceData: SpaceData | null = await dispatch(read({
    dbKey: spaceKey
  })).unwrap();

  if (!spaceData) {
    throw new Error("Space not found");
  }
  if (!currentUserId) {
    throw new Error("User is not logged in.");
  }
  // 检查当前用户是否为该空间的成员
  if (!spaceData.members.includes(currentUserId)) {
    throw new Error("当前用户不是空间成员，无法添加成员");
  }
  // 检查待添加的成员是否已存在
  if (spaceData.members.includes(resolvedMemberId)) {
    throw new Error("成员已存在");
  }

  // 更新 SpaceData
  const updatedSpaceData: SpaceData = {
    ...spaceData,
    members: [...spaceData.members, resolvedMemberId],
    updatedAt: Date.now(),
  };

  // 写入更新后的 SpaceData
  await dispatch(
    write({ data: updatedSpaceData, customKey: spaceKey })
  ).unwrap();

  // 创建并写入新成员的 SpaceMemberWithSpaceInfo 数据
  const now = Date.now();
  const spaceMemberData: SpaceMemberWithSpaceInfo = {
    userId: resolvedMemberId,
    role: role, // 使用传入的 role，默认为 MEMBER
    joinedAt: now,
    updatedAt: now, // 可选字段，初始化时设置为当前时间
    spaceId: spaceId,
    spaceName: spaceData.name,
    ownerId: spaceData.ownerId,
    visibility: spaceData.visibility,
    type: DataType.SPACE, // 添加 type 字段
  };

  const spaceMemberKey = createSpaceKey.member(resolvedMemberId, spaceId);
  await dispatch(
    write({
      data: spaceMemberData,
      customKey: spaceMemberKey,
    })
  ).unwrap();

  return { spaceId, updatedSpaceData };
};

async function resolveMemberId(
  db: NonNullable<AppExtra["db"]>,
  identifier: string
): Promise<string> {
  const trimmed = identifier.trim();
  let foundUserId: string | null = null;
  let matchCount = 0;

  try {
    for await (const [key, value] of db.iterator({
      gte: `${DB_PREFIX.USER}`,
      lte: `${DB_PREFIX.USER}\uFFFF`,
    })) {
      if (value.username === trimmed) {
        foundUserId = key.slice(DB_PREFIX.USER.length);
        matchCount++;
      }
    }
  } catch (err) {
    logger.warn({ err, identifier: trimmed }, "Failed to scan users by username");
  }

  if (matchCount > 1) {
    throw new Error(
      `找到多个用户名为 ${trimmed} 的用户，请使用用户 ID 邀请`
    );
  }
  if (matchCount === 1 && foundUserId) {
    return foundUserId;
  }
  return trimmed;
}
