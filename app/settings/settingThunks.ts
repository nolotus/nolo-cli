// packages/app/settings/settingThunks.ts
//
// 单一职责:settings slice 的所有 async thunk(getSettings / setSettings /
// 各种细粒度 setXxx / toggleXxx / changeXxx)。
//
// thunk 必须放在 settingSlice 之外定义,避免 reducers 闭包内 thunk 自递归
// 触发的 TS 类型推断失败。

import { createAsyncThunk } from "@reduxjs/toolkit";
import type { RootState } from "../store";
import { selectUserId } from "../../auth/authSlice";
import { createUserKey, createUserPreferenceKey } from "../../database/keys";
import {
  USER_PREFERENCE_NAMES,
  readUserPreferenceRegisterValue,
} from "../../database/userPreferenceRegister";
import {
  resolveThemeModeIsDark,
  SYSTEM_DARK_MEDIA_QUERY,
} from "../theme/themeModeBootstrap";
import type { THEME_COLORS } from "../theme/theme.config";
import { normalizeFontPreset, type FontPreset } from "../theme/fontPreference";
import {
  DEFAULT_USER_PREFERENCE_PROFILE,
  type KnowledgeCaptureLevel,
  type SpaceContextLevel,
  type TonePreset,
} from "../../ai/policy/types";

import { updateSettingsState } from "./settingActions";
import { getSettingDbActionThunks } from "./dbActionThunks";
import {
  readDefaultSpaceIdPreference,
  persistDefaultSpacePreference,
  normalizeDefaultSpaceIdPreference,
} from "./defaultSpacePreference";
import {
  buildSettingsPersistencePlan,
  hydrateStoredSettings,
  isLocalFirstAppearanceChange,
  normalizeSettingChanges,
  persistDefaultAgentRegister,
} from "./settingPersistence";
import {
  hasOwn,
  normalizeDefaultAgentIdSetting,
  resolveDefaultAgentIdSetting,
} from "./settingNormalizers";
import { SYSTEM_DEFAULT_AGENT_ID, type SettingState } from "./settingTypes";

/**
 * Read the persisted settings record for the current user, normalize it, and
 * apply it to local state. Returns the hydrated record (or null when no user).
 */
export const getSettings = createAsyncThunk<
  Record<string, unknown> | null,
  void,
  { state: RootState }
>("settings/getSettings", async (_, { dispatch, getState }) => {
  const userId = selectUserId(getState() as RootState);
  if (!userId) return null;
  const settingsKey = createUserKey.settings(userId);
  const authorityHomeKey = createUserPreferenceKey.authorityHome(userId);
  const [settingsRecord, defaultSpaceId, authorityHomeRecord] =
    await Promise.all([
      dispatch(getSettingDbActionThunks().readAndWait(settingsKey))
        .unwrap()
        .catch(() => null),
      readDefaultSpaceIdPreference(dispatch, userId),
      dispatch(getSettingDbActionThunks().readAndWait(authorityHomeKey))
        .unwrap()
        .catch(() => null),
    ]);
  const authorityHomeServer =
    readUserPreferenceRegisterValue<string>(
      authorityHomeRecord,
      USER_PREFERENCE_NAMES.AUTHORITY_HOME,
    ) ?? null;

  const hydrated = hydrateStoredSettings({
    userId,
    settingsRecord,
    defaultSpaceId,
    authorityHomeServer,
  });
  if (hydrated) {
    const normalizedPayload = normalizeSettingChanges(
      hydrated as Partial<SettingState>,
    );
    const { currentServer: _ignored, ...settingsToApply } = normalizedPayload;
    dispatch(updateSettingsState(settingsToApply));
  }
  return hydrated;
});

/**
 * Apply settings changes. The thunk is responsible for:
 *  1. Normalizing the changes
 *  2. Persisting the settings record (via buildSettingsPersistencePlan)
 *  3. Persisting register-backed fields (defaultSpaceId, defaultAgentId)
 *  4. Updating local state via updateSettingsState
 *
 * When no user is logged in, only local-first appearance changes are
 * accepted (other settings require a user to persist against).
 */
export const setSettings = createAsyncThunk<
  Partial<SettingState>,
  Partial<SettingState>,
  { state: RootState }
>("settings/setSettings", async (changes, { dispatch, getState }) => {
  const currentSettings = (getState() as RootState).settings;
  const normalizedChanges = normalizeSettingChanges(changes);
  const nextDefaultSpaceId =
    normalizeDefaultSpaceIdPreference(normalizedChanges.defaultSpaceId) ?? null;
  const previousDefaultAgentId =
    normalizeDefaultAgentIdSetting(currentSettings.defaultAgentId) ??
    SYSTEM_DEFAULT_AGENT_ID;
  const userId = selectUserId(getState() as RootState);
  if (!userId) {
    if (!isLocalFirstAppearanceChange(normalizedChanges)) {
      throw new Error("User not found for persisting settings.");
    }
    dispatch(updateSettingsState(normalizedChanges));
    return normalizedChanges;
  }
  const persistencePlan = buildSettingsPersistencePlan({
    userId,
    currentSettings,
    changes: normalizedChanges,
    previousDefaultAgentRecord: null,
  });
  dispatch(updateSettingsState(persistencePlan.normalizedChanges));
  if (hasOwn(changes, "defaultSpaceId")) {
    await persistDefaultSpacePreference(dispatch, userId, nextDefaultSpaceId);
  }
  const nextDefaultAgentId =
    normalizeDefaultAgentIdSetting(
      persistencePlan.normalizedChanges.defaultAgentId,
    ) ?? null;
  if (
    hasOwn(changes, "defaultAgentId") &&
    previousDefaultAgentId !== (nextDefaultAgentId ?? SYSTEM_DEFAULT_AGENT_ID)
  ) {
    await persistDefaultAgentRegister(
      dispatch as unknown as (action: unknown) => {
        unwrap: () => Promise<unknown>;
      },
      getState as unknown as () => {
        db: { entities: Record<string, unknown> };
      },
      userId,
      nextDefaultAgentId,
    );
  }
  if (persistencePlan.settingsPatch) {
    await dispatch(
      getSettingDbActionThunks().upsert({
        dbKey: persistencePlan.settingsPatch.dbKey,
        data: persistencePlan.settingsPatch.changes,
      }),
    ).unwrap();
  }
  return persistencePlan.normalizedChanges;
});

// --- 细粒度 setter thunk(几乎都是 setSettings 的薄包装) ---

export const changeTheme = createAsyncThunk(
  "settings/changeTheme",
  async (themeName: keyof typeof THEME_COLORS, { dispatch }) =>
    dispatch(setSettings({ themeName })).unwrap(),
);

export const changeDensity = createAsyncThunk(
  "settings/changeDensity",
  async (density: "compact" | "spacious", { dispatch }) =>
    dispatch(setSettings({ density })).unwrap(),
);

export const changeFontPreset = createAsyncThunk(
  "settings/changeFontPreset",
  async (fontPreset: FontPreset, { dispatch }) => {
    const normalized = normalizeFontPreset(fontPreset) ?? fontPreset;
    return dispatch(setSettings({ fontPreset: normalized })).unwrap();
  },
);

export const changeDarkMode = createAsyncThunk(
  "settings/changeDarkMode",
  async (isDark: boolean, { dispatch }) =>
    dispatch(
      setSettings({ isDark, themeMode: isDark ? "dark" : "light" }),
    ).unwrap(),
);

export const toggleShowThinking = createAsyncThunk(
  "settings/toggleShowThinking",
  async (_: void, { dispatch, getState }) => {
    const currentShowThinking = (getState() as RootState).settings.showThinking;
    return dispatch(
      setSettings({ showThinking: !currentShowThinking }),
    ).unwrap();
  },
);

export const setThemeFollowsSystem = createAsyncThunk(
  "settings/setThemeFollowsSystem",
  async (follows: boolean, { dispatch }) =>
    dispatch(setSettings({ themeMode: follows ? "system" : "light" })).unwrap(),
);

export const setSidebarWidth = createAsyncThunk(
  "settings/setSidebarWidth",
  async (sidebarWidth: number, { dispatch }) =>
    dispatch(setSettings({ sidebarWidth })).unwrap(),
);

export const toggleEnableReadCurrentSpace = createAsyncThunk(
  "settings/toggleEnableReadCurrentSpace",
  async (_: void, { dispatch, getState }) => {
    const current = (getState() as RootState).settings.enableReadCurrentSpace;
    return dispatch(
      setSettings({
        enableReadCurrentSpace: !current,
        spaceContextLevel: current
          ? 1
          : DEFAULT_USER_PREFERENCE_PROFILE.spaceContextLevel,
      }),
    ).unwrap();
  },
);

export const setEditorDefaultMode = createAsyncThunk(
  "settings/setEditorDefaultMode",
  async (mode: "markdown" | "block", { dispatch }) =>
    dispatch(setSettings({ editorDefaultMode: mode })).unwrap(),
);

export const setEditorLightCodeTheme = createAsyncThunk(
  "settings/setEditorLightCodeTheme",
  async (theme: string, { dispatch }) =>
    dispatch(setSettings({ editorLightCodeTheme: theme })).unwrap(),
);

export const setEditorDarkCodeTheme = createAsyncThunk(
  "settings/setEditorDarkCodeTheme",
  async (theme: string, { dispatch }) =>
    dispatch(setSettings({ editorDarkCodeTheme: theme })).unwrap(),
);

export const setEditorCodeTheme = createAsyncThunk(
  "settings/setEditorCodeTheme",
  async (theme: string, { dispatch }) =>
    dispatch(
      setSettings({
        editorLightCodeTheme: theme,
        editorDarkCodeTheme: theme,
      }),
    ).unwrap(),
);

export const toggleEditorWordCount = createAsyncThunk(
  "settings/toggleEditorWordCount",
  async (_: void, { dispatch, getState }) => {
    const current = (getState() as RootState).settings.editorWordCountEnabled;
    return dispatch(setSettings({ editorWordCountEnabled: !current })).unwrap();
  },
);

export const toggleEditorShortcut = createAsyncThunk(
  "settings/toggleEditorShortcut",
  async (key: string, { dispatch, getState }) => {
    const currentShortcuts = (getState() as RootState).settings.editorShortcuts;
    const newShortcuts = {
      ...currentShortcuts,
      [key]: !currentShortcuts[key],
    };
    return dispatch(setSettings({ editorShortcuts: newShortcuts })).unwrap();
  },
);

export const setEditorFontSize = createAsyncThunk(
  "settings/setEditorFontSize",
  async (fontSize: number, { dispatch }) =>
    dispatch(setSettings({ editorFontSize: fontSize })).unwrap(),
);

export const toggleEditorAutoSave = createAsyncThunk(
  "settings/toggleEditorAutoSave",
  async (_: void, { dispatch, getState }) => {
    const current = (getState() as RootState).settings.editorAutoSave;
    return dispatch(setSettings({ editorAutoSave: !current })).unwrap();
  },
);

export const setEditorAutoSaveInterval = createAsyncThunk(
  "settings/setEditorAutoSaveInterval",
  async (interval: number, { dispatch }) =>
    dispatch(setSettings({ editorAutoSaveInterval: interval })).unwrap(),
);

export const setGlobalPrompt = createAsyncThunk(
  "settings/setGlobalPrompt",
  async (prompt: string, { dispatch }) =>
    dispatch(setSettings({ globalPrompt: prompt })).unwrap(),
);

export const setUserTonePreset = createAsyncThunk(
  "settings/setUserTonePreset",
  async (tone: TonePreset, { dispatch }) =>
    dispatch(setSettings({ userTonePreset: tone })).unwrap(),
);

export const setKnowledgeCaptureLevel = createAsyncThunk(
  "settings/setKnowledgeCaptureLevel",
  async (level: KnowledgeCaptureLevel, { dispatch }) =>
    dispatch(setSettings({ knowledgeCaptureLevel: level })).unwrap(),
);

export const setSpaceContextLevel = createAsyncThunk(
  "settings/setSpaceContextLevel",
  async (level: SpaceContextLevel, { dispatch }) =>
    dispatch(
      setSettings({
        spaceContextLevel: level,
        enableReadCurrentSpace: level > 1,
      }),
    ).unwrap(),
);

export const setAiRecentContentLimit = createAsyncThunk(
  "settings/setAiRecentContentLimit",
  async (limit: number, { dispatch }) =>
    dispatch(setSettings({ aiRecentContentLimit: limit })).unwrap(),
);

export const setMaxExecutionTime = createAsyncThunk(
  "settings/setMaxExecutionTime",
  async (time: number, { dispatch }) =>
    dispatch(setSettings({ maxExecutionTime: time })).unwrap(),
);

export const setDefaultAgentId = createAsyncThunk(
  "settings/setDefaultAgentId",
  async (agentId: string, { dispatch }) =>
    dispatch(
      setSettings({
        defaultAgentId: resolveDefaultAgentIdSetting(agentId),
      }),
    ).unwrap(),
);

export const setFlashAgentId = createAsyncThunk(
  "settings/setFlashAgentId",
  async (agentId: string, { dispatch }) =>
    dispatch(
      setSettings({
        flashAgentId: resolveDefaultAgentIdSetting(agentId),
      }),
    ).unwrap(),
);

export const setBalancedAgentId = createAsyncThunk(
  "settings/setBalancedAgentId",
  async (agentId: string, { dispatch }) =>
    dispatch(
      setSettings({
        balancedAgentId: resolveDefaultAgentIdSetting(agentId),
      }),
    ).unwrap(),
);

export const setQualityAgentId = createAsyncThunk(
  "settings/setQualityAgentId",
  async (agentId: string, { dispatch }) =>
    dispatch(
      setSettings({
        qualityAgentId: resolveDefaultAgentIdSetting(agentId),
      }),
    ).unwrap(),
);

export const setImageAgentId = createAsyncThunk(
  "settings/setImageAgentId",
  async (agentId: string, { dispatch }) =>
    dispatch(
      setSettings({
        imageAgentId: resolveDefaultAgentIdSetting(agentId),
      }),
    ).unwrap(),
);

export const setPreferredAnimationSet = createAsyncThunk(
  "settings/setPreferredAnimationSet",
  async (index: number, { dispatch }) =>
    dispatch(setSettings({ preferredAnimationSet: index })).unwrap(),
);

export const setThemeMode = createAsyncThunk(
  "settings/setThemeMode",
  async (mode: "system" | "light" | "dark", { dispatch }) => {
    const changes: Partial<SettingState> = { themeMode: mode };
    const systemPrefersDark =
      typeof window !== "undefined" &&
      window.matchMedia(SYSTEM_DARK_MEDIA_QUERY).matches;
    changes.isDark = resolveThemeModeIsDark(mode, systemPrefersDark);
    return dispatch(setSettings(changes)).unwrap();
  },
);
