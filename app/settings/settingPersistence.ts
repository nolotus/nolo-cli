// packages/app/settings/settingPersistence.ts
//
// 单一职责:settings 的 hydrate 与持久化计划。
// 负责把远端存储的 settings record 转换成运行时 state(hydrate),以及把本地 state
// 变化转换成 settings record + register-backed write(persistence plan)。
//
// 不直接 dispatch settings slice action;只产出数据。调用方(如 setSettings thunk)
// 负责把 normalized changes 应用到 state。

import { createUserKey, createUserPreferenceKey } from "../../database/keys";
import {
  USER_PREFERENCE_NAMES,
  buildDefaultAgentPreferenceRegisterRecord,
  readUserPreferenceRegisterValue,
  type UserPreferenceRegisterRecord,
} from "../../database/userPreferenceRegister";
import { normalizeThemeName } from "../theme/themeModeBootstrap";
import { normalizeFontPreset } from "../theme/fontPreference";
import { DEFAULT_USER_PREFERENCE_PROFILE } from "../../ai/policy/types";
import { normalizeAgentUpdateFieldList } from "../../ai/policy/selfUpdateFields";
import { normalizeDefaultSpaceIdPreference } from "./defaultSpacePreference";
import { getSettingDbActionThunks } from "./dbActionThunks";
import { withSettingsRecordSchema } from "./settingsRecord";
import {
  hasOwn,
  normalizeAuthorityHomeServerSetting,
  normalizeDefaultAgentIdSetting,
  normalizePolicyLevelSetting,
  normalizeTonePresetSetting,
  omitKeys,
} from "./settingNormalizers";
import { SYSTEM_DEFAULT_AGENT_ID, type SettingState } from "./settingTypes";

/**
 * Run every field-level normalizer that may apply to a `setSettings` payload.
 * Returned object contains only keys that survived normalization.
 */
export const normalizeSettingChanges = (
  changes: Partial<SettingState>,
): Partial<SettingState> => {
  let normalizedChanges: Partial<SettingState> = changes;

  if (hasOwn(normalizedChanges, "defaultAgentId")) {
    normalizedChanges = {
      ...normalizedChanges,
      defaultAgentId: normalizeDefaultAgentIdSetting(
        normalizedChanges.defaultAgentId,
      ),
    };
  }

  if (hasOwn(normalizedChanges, "defaultSpaceId")) {
    normalizedChanges = {
      ...normalizedChanges,
      defaultSpaceId: normalizeDefaultSpaceIdPreference(
        normalizedChanges.defaultSpaceId,
      ),
    };
  }

  if (hasOwn(normalizedChanges, "themeName")) {
    const themeName = normalizeThemeName(normalizedChanges.themeName);
    normalizedChanges = themeName
      ? { ...normalizedChanges, themeName }
      : (omitKeys(normalizedChanges, ["themeName"]) as Partial<SettingState>);
  }

  if (hasOwn(normalizedChanges, "fontPreset")) {
    const fontPreset = normalizeFontPreset(normalizedChanges.fontPreset);
    normalizedChanges = fontPreset
      ? { ...normalizedChanges, fontPreset }
      : (omitKeys(normalizedChanges, ["fontPreset"]) as Partial<SettingState>);
  }

  if (hasOwn(normalizedChanges, "userTonePreset")) {
    normalizedChanges = {
      ...normalizedChanges,
      userTonePreset: normalizeTonePresetSetting(
        normalizedChanges.userTonePreset,
      ),
    };
  }

  if (hasOwn(normalizedChanges, "knowledgeCaptureLevel")) {
    normalizedChanges = {
      ...normalizedChanges,
      knowledgeCaptureLevel: normalizePolicyLevelSetting(
        normalizedChanges.knowledgeCaptureLevel,
        DEFAULT_USER_PREFERENCE_PROFILE.knowledgeCaptureLevel,
      ) as SettingState["knowledgeCaptureLevel"],
    };
  }

  if (hasOwn(normalizedChanges, "spaceContextLevel")) {
    normalizedChanges = {
      ...normalizedChanges,
      spaceContextLevel: normalizePolicyLevelSetting(
        normalizedChanges.spaceContextLevel,
        DEFAULT_USER_PREFERENCE_PROFILE.spaceContextLevel,
      ) as SettingState["spaceContextLevel"],
    };
  }

  if (hasOwn(normalizedChanges, "autoApproveSelfUpdateFields")) {
    normalizedChanges = {
      ...normalizedChanges,
      autoApproveSelfUpdateFields: normalizeAgentUpdateFieldList(
        normalizedChanges.autoApproveSelfUpdateFields,
      ),
    };
  }

  return normalizedChanges;
};

/**
 * Appearance-only changes that should still update local state even when no
 * user is logged in (no server-side persistence).
 */
const LOCAL_APPEARANCE_KEY_NAMES = [
  "themeName",
  "themeMode",
  "isDark",
  "density",
  "fontPreset",
] as const satisfies ReadonlyArray<keyof SettingState>;

/**
 * Appearance-only changes that should still update local state even when no
 * user is logged in (no server-side persistence).
 */
export const LOCAL_FIRST_APPEARANCE_KEYS: Readonly<
  Record<(typeof LOCAL_APPEARANCE_KEY_NAMES)[number], true>
> = Object.freeze(
  Object.fromEntries(
    LOCAL_APPEARANCE_KEY_NAMES.map((key) => [key, true]),
  ) as Record<(typeof LOCAL_APPEARANCE_KEY_NAMES)[number], true>,
);

/**
 * Keys that must NEVER be written back to the server-side settings record,
 * because they're either register-backed elsewhere (defaultSpaceId,
 * userAuthorityRegistry) or pure local preference (appearance).
 */
export const LOCAL_ONLY_SETTINGS_KEYS: Readonly<
  Record<(typeof LOCAL_APPEARANCE_KEY_NAMES)[number], true>
> = LOCAL_FIRST_APPEARANCE_KEYS;

const isLocalAppearanceKey = (
  key: string,
): key is (typeof LOCAL_APPEARANCE_KEY_NAMES)[number] =>
  key in LOCAL_FIRST_APPEARANCE_KEYS;

export const isLocalFirstAppearanceChange = (
  changes: Partial<SettingState>,
): boolean => {
  const keys = Object.keys(changes);
  if (keys.length === 0) return false;
  return keys.every((key): key is (typeof LOCAL_APPEARANCE_KEY_NAMES)[number] =>
    isLocalAppearanceKey(key),
  );
};

export const stripRegisterBackedFieldsFromSettingsWrite = (
  changes: Partial<SettingState>,
): Partial<SettingState> => {
  return omitKeys(changes, [
    "defaultSpaceId",
    "userAuthorityRegistry",
    ...LOCAL_APPEARANCE_KEY_NAMES,
  ]) as Partial<SettingState>;
};

/**
 * Drop schema-managed keys and any key that isn't supposed to be persisted on
 * the server. Returns null if nothing remains.
 */
export const sanitizeStoredSettingsRecord = (
  settingsRecord: unknown,
): Record<string, unknown> | null => {
  if (!settingsRecord || typeof settingsRecord !== "object") {
    return null;
  }

  const record = settingsRecord as Record<string, unknown>;
  const sanitizedSettings = omitKeys(record, [
    "defaultSpaceId",
    "schemaVersion",
    ...LOCAL_APPEARANCE_KEY_NAMES,
  ]);
  return Object.keys(sanitizedSettings).length > 0 ? sanitizedSettings : null;
};

export const hydrateStoredSettings = ({
  userId,
  settingsRecord,
  defaultSpaceId,
  authorityHomeServer,
}: {
  userId?: string | null;
  settingsRecord: unknown;
  defaultSpaceId?: string | null;
  authorityHomeServer?: string | null;
}): Record<string, unknown> | null => {
  const record = (settingsRecord ?? {}) as Record<string, unknown>;
  const resolvedDefaultAgentId =
    normalizeDefaultAgentIdSetting(record.defaultAgentId) ??
    SYSTEM_DEFAULT_AGENT_ID;

  const baseSettings = sanitizeStoredSettingsRecord(settingsRecord) ?? {};
  const normalizedAuthorityHome =
    normalizeAuthorityHomeServerSetting(authorityHomeServer);
  const existingRegistry =
    baseSettings.userAuthorityRegistry &&
    typeof baseSettings.userAuthorityRegistry === "object"
      ? (baseSettings.userAuthorityRegistry as Record<string, string>)
      : {};
  const userAuthorityRegistry =
    userId && normalizedAuthorityHome
      ? { ...existingRegistry, [userId]: normalizedAuthorityHome }
      : existingRegistry;
  const userAuthorityRegistryIsEmpty = Object.keys(userAuthorityRegistry).length === 0;
  const hydratedSettings = {
    ...baseSettings,
    ...(userAuthorityRegistryIsEmpty ? {} : { userAuthorityRegistry }),
    defaultSpaceId: normalizeDefaultSpaceIdPreference(defaultSpaceId) ?? null,
    defaultAgentId: resolvedDefaultAgentId,
  };

  return Object.keys(hydratedSettings).length > 0 ? hydratedSettings : null;
};

export const buildSettingsPersistencePlan = ({
  userId,
  currentSettings,
  changes,
  previousDefaultAgentRecord,
}: {
  userId: string;
  currentSettings: Partial<SettingState>;
  changes: Partial<SettingState>;
  previousDefaultAgentRecord: Partial<UserPreferenceRegisterRecord<string>> | null | undefined;
}) => {
  const normalizedChanges = normalizeSettingChanges(changes);
  const persistedChanges =
    stripRegisterBackedFieldsFromSettingsWrite(normalizedChanges);
  const previousDefaultAgentId =
    normalizeDefaultAgentIdSetting(currentSettings.defaultAgentId) ??
    SYSTEM_DEFAULT_AGENT_ID;
  const nextDefaultAgentId =
    normalizeDefaultAgentIdSetting(normalizedChanges.defaultAgentId) ?? null;

  const previousDefaultAgentValue =
    readUserPreferenceRegisterValue<string>(
      previousDefaultAgentRecord,
      USER_PREFERENCE_NAMES.DEFAULT_AGENT,
    ) ?? null;

  const defaultAgentRegisterWrite =
    hasOwn(normalizedChanges, "defaultAgentId") &&
    previousDefaultAgentId !==
      (nextDefaultAgentId ?? SYSTEM_DEFAULT_AGENT_ID) &&
    (!previousDefaultAgentRecord ||
      previousDefaultAgentValue !== nextDefaultAgentId)
      ? {
          customKey: createUserPreferenceKey.defaultAgent(userId),
          data: buildDefaultAgentPreferenceRegisterRecord({
            userId,
            defaultAgentId: nextDefaultAgentId,
            previousRecord: previousDefaultAgentRecord,
          }),
        }
      : null;

  const settingsPatch =
    Object.keys(persistedChanges).length > 0
      ? {
          dbKey: createUserKey.settings(userId),
          changes: withSettingsRecordSchema(
            persistedChanges as Record<string, unknown>,
          ),
        }
      : null;

  return {
    normalizedChanges,
    defaultAgentRegisterWrite,
    settingsPatch,
  };
};

/**
 * Read the cached default-agent preference record from the in-memory db entities.
 * Returns null if the record is missing or not an object.
 */
export const getCachedDefaultAgentRegisterRecord = (
  getState: () => { db: { entities: Record<string, unknown> } },
  registerKey: string,
): Partial<UserPreferenceRegisterRecord<string>> | null => {
  const record = getState().db.entities[registerKey];
  if (!record || typeof record !== "object") return null;
  return record as Partial<UserPreferenceRegisterRecord<string>>;
};

/**
 * Persist the user's default-agent id to the dedicated register, skipping the
 * write when the value already matches the previous one. The dispatcher is
 * typed loosely because the readAndWait / write thunks come from a swappable
 * layer (see `./dbActionThunks`) and full thunk type inference here would
 * require importing the full ThunkApi.
 */
export const persistDefaultAgentRegister = async (
  dispatch: (action: unknown) => { unwrap: () => Promise<unknown> },
  getState: () => { db: { entities: Record<string, unknown> } },
  userId: string,
  value: string | null,
): Promise<void> => {
  const registerKey = createUserPreferenceKey.defaultAgent(userId);
  let previousRecord: Partial<UserPreferenceRegisterRecord<string>> | null =
    getCachedDefaultAgentRegisterRecord(getState, registerKey);
  if (!previousRecord) {
    previousRecord = (await dispatch(
      getSettingDbActionThunks().readAndWait(registerKey),
    )
      .unwrap()
      .catch(() => null)) as Partial<UserPreferenceRegisterRecord<string>> | null;
  }

  const previousValue =
    readUserPreferenceRegisterValue<string>(
      previousRecord,
      USER_PREFERENCE_NAMES.DEFAULT_AGENT,
    ) ?? null;
  if (previousRecord && previousValue === value) {
    return;
  }

  await dispatch(
    getSettingDbActionThunks().write({
      customKey: registerKey,
      data: buildDefaultAgentPreferenceRegisterRecord({
        userId,
        defaultAgentId: value,
        previousRecord,
      }),
    }),
  ).unwrap();
};
