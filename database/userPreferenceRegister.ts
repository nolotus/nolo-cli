import { DataType } from "../create/types";
import { normalizeServerOrigin } from "../core/serverOrigin";
import { toTimestampMs } from "../core/timestamp";
import { ulid } from ".//utils/ulid";

export const USER_PREFERENCE_NAMES = {
  AUTHORITY_HOME: "authority_home",

  DEFAULT_AGENT: "agent_default",
} as const;

export type UserPreferenceName =
  (typeof USER_PREFERENCE_NAMES)[keyof typeof USER_PREFERENCE_NAMES];

export interface UserPreferenceRegisterRecord<T = unknown> {
  type: DataType.SETTING;
  registerType: "user_preference";
  preferenceName: UserPreferenceName;
  schemaVersion: 1;
  userId: string;
  value: T | null;
  opId: string;
  createdAt: number;
  updatedAt: number;
}

const normalizeAuthorityServer = (value: unknown): string | null => {
  const normalized = normalizeServerOrigin(value);
  return /^https?:\/\//i.test(normalized) ? normalized : null;
};

const nextRegisterUpdatedAt = (previousRecord?: Partial<UserPreferenceRegisterRecord>) => {
  const previousTimestamp = Math.max(
    toTimestampMs(previousRecord?.updatedAt),
    toTimestampMs(previousRecord?.createdAt)
  );
  return Math.max(Date.now(), previousTimestamp + 1);
};

export const buildUserPreferenceRegisterRecord = <T>({
  userId,
  preferenceName,
  value,
  previousRecord,
}: {
  userId: string;
  preferenceName: UserPreferenceName;
  value: T | null;
  previousRecord?: Partial<UserPreferenceRegisterRecord<T>> | null;
}): UserPreferenceRegisterRecord<T> => {
  const updatedAt = nextRegisterUpdatedAt(previousRecord ?? undefined);

  return {
    type: DataType.SETTING,
    registerType: "user_preference",
    preferenceName,
    schemaVersion: 1,
    userId,
    value,
    opId: ulid(),
    createdAt: toTimestampMs(previousRecord?.createdAt) || updatedAt,
    updatedAt,
  };
};

export const readUserPreferenceRegisterValue = <T>(
  record: any,
  preferenceName: UserPreferenceName
): T | null | undefined => {
  if (!record || typeof record !== "object") return undefined;
  if (record.registerType !== "user_preference") return undefined;
  if (record.preferenceName !== preferenceName) return undefined;
  if (!("value" in record)) return undefined;
  return record.value as T | null;
};

export const buildDefaultAgentPreferenceRegisterRecord = ({
  userId,
  defaultAgentId,
  previousRecord,
}: {
  userId: string;
  defaultAgentId: string | null;
  previousRecord?: Partial<UserPreferenceRegisterRecord<string>> | null;
}) =>
  buildUserPreferenceRegisterRecord<string>({
    userId,
    preferenceName: USER_PREFERENCE_NAMES.DEFAULT_AGENT,
    value: defaultAgentId,
    previousRecord,
  });

export const buildAuthorityHomePreferenceRegisterRecord = ({
  userId,
  authorityServer,
  previousRecord,
}: {
  userId: string;
  authorityServer: string | null;
  previousRecord?: Partial<UserPreferenceRegisterRecord<string>> | null;
}) =>
  buildUserPreferenceRegisterRecord<string>({
    userId,
    preferenceName: USER_PREFERENCE_NAMES.AUTHORITY_HOME,
    value: normalizeAuthorityServer(authorityServer),
    previousRecord,
  });

