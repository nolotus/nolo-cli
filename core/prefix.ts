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
