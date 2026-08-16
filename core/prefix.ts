const extractKeyPart = (key: string, index: number): string => {
  const parts = key.split("-");
  if (index < 2) {
    return parts[index];
  }
  return parts.slice(index).join("-");
};

export const extractUserId = (key: string): string => {
  const parts = key.split("-");

  if (parts.length === 2) {
    return parts[0];
  }

  if (parts[0] === "user" && parts[1] === "pref" && parts.length >= 3) {
    return parts[2];
  }

  return extractKeyPart(key, 1);
};

/**
 * Extract the custom id segment from a dbKey.
 *
 * Dialog **record** keys are `dialog-{userId}-{dialogId}` where userId may
 * contain hyphens. dialogId is always the final dash segment (see
 * packages/database/keys.ts resolveDialogIdForIndex / isDialogRecordKey).
 * Message keys (`…-msg-…`) and all non-dialog keys keep the legacy
 * extractKeyPart(key, 2) behavior (parts from index 2 joined by "-").
 */
export const extractCustomId = (key: string): string => {
  if (key.startsWith("dialog-") && !key.includes("-msg-")) {
    const lastDash = key.lastIndexOf("-");
    return lastDash >= 0 ? key.slice(lastDash + 1) : key;
  }
  return extractKeyPart(key, 2);
};

/* ── agent key 前缀工具（唯一真相源，避免各层手拼 "agent-pub-"）── */

export const PUBLIC_AGENT_KEY_PREFIX = "agent-pub-";
export const SYSTEM_AGENT_KEY_PREFIX = "agent-system-";

/** 构造公开 agent key：`agent-pub-{id}` */
export const publicAgentKey = (id: string): string =>
  `${PUBLIC_AGENT_KEY_PREFIX}${id}`;

/** 构造平台 system agent key：`agent-system-{id}` */
export const systemAgentKey = (id: string): string =>
  `${SYSTEM_AGENT_KEY_PREFIX}${id}`;

/** 从公开 agent key 解析出 id；非 agent-pub-* 返回 null */
export const parsePublicAgentId = (key: string): string | null =>
  key.startsWith(PUBLIC_AGENT_KEY_PREFIX)
    ? key.slice(PUBLIC_AGENT_KEY_PREFIX.length)
    : null;

/**
 * 某用户自建 agent 的 key 前缀：`agent-{userId}-`。
 *
 * 必须整体比较该前缀，不能按 "-" 分段解析——userId 本身可能含连字符
 * （如 `user-1`），分段会截成 `user` 从而漏判自建 agent。
 *
 * 注意 "-" 分隔符本身有歧义：`agent-user-1-x` 同时匹配 userId `user-1`
 * 与 `user`。调用方必须传该 key 所归属的 userId（登录用户，或记录自带的
 * owner/属主 id），不能拿任意用户 id 来试探归属。
 */
export const ownedAgentKeyPrefix = (userId: string): string =>
  `agent-${userId}-`;

/** 构造自建 agent key：`agent-{userId}-{id}`；id 已含前缀时原样返回。 */
export const ownedAgentKey = (userId: string, id: string): string =>
  id.startsWith(ownedAgentKeyPrefix(userId))
    ? id
    : `${ownedAgentKeyPrefix(userId)}${id}`;

/** key 是否为该用户的自建 agent key。 */
export const isOwnedAgentKey = (key: unknown, userId: string): key is string =>
  typeof key === "string" && key.startsWith(ownedAgentKeyPrefix(userId));

/** 从自建 agent key 解析出 id；非该用户的 key 返回 null。 */
export const parseOwnedAgentId = (key: string, userId: string): string | null =>
  isOwnedAgentKey(key, userId)
    ? key.slice(ownedAgentKeyPrefix(userId).length) || null
    : null;
