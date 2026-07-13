/**
 * Device-local ownership helpers for Local-first M3+.
 *
 * Device-local dialogs/agents may chat without a Nolo login when they use
 * custom/cli (non-platform) providers. Account-private records stay gated.
 *
 * Device-local Space uses the same owner sentinel (`userId` / `ownerId`
 * `"local"`) and normal `space-{ULID}` body keys. Membership keys are the
 * existing family `space-member-local-{ULID}` (userId segment = `"local"`).
 * There is no `space-local-*` key family.
 *
 * Signals:
 * - `userId === "local"` / `ownerId === "local"`
 * - db keys: `dialog-local-*` / `agent-local-*` / `cybot-local-*`
 * - membership keys: `space-member-local-*` (via owner sentinel, not a new registry)
 */

import { parseOwnerUserIdFromDbKey } from "./ownerKey";

export const DEVICE_LOCAL_OWNER_ID = "local";

const DEVICE_LOCAL_DB_KEY_PREFIXES = [
  "dialog-local-",
  "agent-local-",
  "cybot-local-",
] as const;

const clean = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/** True when a record owner field is the device-local sentinel. */
export const isDeviceLocalOwnerId = (userId: unknown): boolean =>
  clean(userId) === DEVICE_LOCAL_OWNER_ID;

/**
 * Effective Space actor for create/list operations.
 * Logged-out (or blank) → synthetic device-local `"local"`.
 * Active non-local account → that account userId.
 * Does not mutate auth state; pure derivation only.
 */
export const resolveEffectiveSpaceActorId = (
  accountUserId: string | null | undefined
): string => {
  const cleaned = clean(accountUserId);
  if (!cleaned || isDeviceLocalOwnerId(cleaned)) {
    return DEVICE_LOCAL_OWNER_ID;
  }
  return cleaned;
};

/**
 * True when the Space actor is (or resolves to) the synthetic device-local owner.
 * Blank / null / `"local"` all mean guest/device-local Space authority.
 */
export const isDeviceLocalSpaceActor = (
  actorUserId: string | null | undefined
): boolean => isDeviceLocalOwnerId(resolveEffectiveSpaceActorId(actorUserId));

/**
 * True when a Space membership row is device-local authority
 * (`userId === "local"`). Membership key family remains `space-member-*`.
 */
export const isDeviceLocalSpaceMembership = (membership: {
  userId?: string | null;
} | null | undefined): boolean => isDeviceLocalOwnerId(membership?.userId);

/**
 * True when a Space body is device-local authority
 * (`userId === "local"` and/or `ownerId === "local"`).
 * Space body keys stay `space-{ULID}` — not `space-local-*`.
 */
export const isDeviceLocalSpaceBody = (space: {
  userId?: string | null;
  ownerId?: string | null;
} | null | undefined): boolean =>
  isDeviceLocalOwnerId(space?.userId) || isDeviceLocalOwnerId(space?.ownerId);

/**
 * True when a dbKey is owned by the device-local owner
 * (`dialog-local-*`, `agent-local-*`, `cybot-local-*`, or parsed owner `"local"`).
 */
export const isDeviceLocalDbKey = (dbKey: unknown): boolean => {
  const key = clean(dbKey);
  if (!key) return false;
  for (const prefix of DEVICE_LOCAL_DB_KEY_PREFIXES) {
    if (key.startsWith(prefix)) return true;
  }
  return (
    parseOwnerUserIdFromDbKey(key, {
      candidateOwnerUserIds: [DEVICE_LOCAL_OWNER_ID],
    }) === DEVICE_LOCAL_OWNER_ID
  );
};

/**
 * Classify content-record owner for first-Space migration.
 * Prefers explicit `userId`, then device-local key prefixes / parsed owner.
 */
export const resolveRecordOwnerUserId = (record: {
  userId?: string | null;
  dbKey?: string | null;
  id?: string | null;
} | null | undefined): string | null => {
  if (!record) return null;
  const explicit = clean(record.userId);
  if (explicit) return explicit;
  if (isDeviceLocalDbKey(record.dbKey) || isDeviceLocalDbKey(record.id)) {
    return DEVICE_LOCAL_OWNER_ID;
  }
  const fromKey =
    parseOwnerUserIdFromDbKey(clean(record.dbKey) ?? "", {
      candidateOwnerUserIds: [DEVICE_LOCAL_OWNER_ID],
    }) ??
    parseOwnerUserIdFromDbKey(clean(record.id) ?? "", {
      candidateOwnerUserIds: [DEVICE_LOCAL_OWNER_ID],
    });
  return fromKey;
};

/**
 * True when any of the provided identity signals indicate a device-local
 * dialog or agent (may chat without Nolo login for non-platform sources).
 */
export const isDeviceLocalDialogOrAgent = (input: {
  dbKey?: string | null;
  userId?: string | null;
  agentKey?: string | null;
  cybots?: readonly string[] | null;
  primaryAgentKey?: string | null;
}): boolean => {
  if (isDeviceLocalOwnerId(input.userId)) return true;
  if (input.dbKey && isDeviceLocalDbKey(input.dbKey)) return true;
  if (input.agentKey && isDeviceLocalDbKey(input.agentKey)) return true;
  if (input.primaryAgentKey && isDeviceLocalDbKey(input.primaryAgentKey)) {
    return true;
  }
  if (Array.isArray(input.cybots)) {
    for (const cybot of input.cybots) {
      if (typeof cybot === "string" && isDeviceLocalDbKey(cybot)) return true;
    }
  }
  return false;
};

/**
 * Whether a logged-out client may open/chat this dialog without forcing guest
 * guide / login. Account-private dialogs stay locked.
 */
export const canChatDeviceLocalWithoutLogin = (input: {
  dbKey?: string | null;
  userId?: string | null;
  agentKey?: string | null;
  cybots?: readonly string[] | null;
  primaryAgentKey?: string | null;
}): boolean => isDeviceLocalDialogOrAgent(input);
