const SEPARATOR = "-";
const SPACE_PREFIX = "space";
const SPACE_PREFIX_WITH_SEPARATOR = `${SPACE_PREFIX}${SEPARATOR}`;

export const normalizeSpaceId = (spaceId: string) => {
  if (!spaceId) return spaceId;
  return spaceId.startsWith(SPACE_PREFIX_WITH_SEPARATOR)
    ? spaceId.slice(SPACE_PREFIX_WITH_SEPARATOR.length)
    : spaceId;
};

export const createSpaceKey = {
  // 空间基础信息的key
  space: (spaceId: string) => {
    return [SPACE_PREFIX, normalizeSpaceId(spaceId)].join(SEPARATOR);
  },

  // 空间成员的key
  member: (userId: string, spaceId: string) => {
    return [SPACE_PREFIX, "member", userId, normalizeSpaceId(spaceId)].join(
      SEPARATOR
    );
  },

  // 查询用户所在的所有空间的范围
  memberRange: (userId: string) => {
    return {
      start: [SPACE_PREFIX, "member", userId, ""].join(SEPARATOR),
      end: [SPACE_PREFIX, "member", userId, "\uffff"].join(SEPARATOR),
    };
  },

  /**
   * 预留：未来若出现“按用户、按空间、且必须跨设备同步”的空间级偏好，
   * 统一使用这个 key family。当前产品主链不要依赖它。
   */
  setting: (userId: string, spaceId: string) => {
    return [SPACE_PREFIX, "setting", userId, normalizeSpaceId(spaceId)].join(
      SEPARATOR
    );
  },

  /**
   * 预留：未来如确实需要批量读取空间级远端偏好，再使用这个范围。
   */
  settingRange: (userId: string) => {
    return {
      start: [SPACE_PREFIX, "setting", userId, ""].join(SEPARATOR),
      end: [SPACE_PREFIX, "setting", userId, "\uffff"].join(SEPARATOR),
    };
  },

  // 从成员key中提取空间key
  spaceFromMember: (memberKey: string) => {
    const parts = memberKey.split(SEPARATOR);
    const spaceId = parts[parts.length - 1];
    return [SPACE_PREFIX, spaceId].join(SEPARATOR);
  },

  // 从成员key中提取空间ID
  spaceIdFromMember: (memberKey: string) => {
    const parts = memberKey.split(SEPARATOR);
    return parts[parts.length - 1];
  },
};
