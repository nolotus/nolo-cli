// packages/app/settings/settingSlice.tsx
//
// 公共 entry point for the settings slice.
//
// 单一职责:声明 settings slice(reducer + 3 reducers) 并把按职责拆出去的
// 内部模块(类型 / 初始 state / 归一化 / 持久化 / 选择器 / thunks)重新导出。
// 调用方统一 `import { ... } from "../settings/settingSlice"`,API 表面零变动。
//
// 各模块职责见各自文件顶部注释。

import {
  asyncThunkCreator,
  buildCreateSlice,
  type PayloadAction,
} from "@reduxjs/toolkit";

import { initialState } from "./settingInitialState";
import { normalizeSettingChanges } from "./settingPersistence";
import type { SettingState } from "./settingTypes";

// ---------------------------------------------------------------------------
// Slice 创建
// ---------------------------------------------------------------------------

const createSliceWithThunks = buildCreateSlice({
  creators: { asyncThunk: asyncThunkCreator },
});

const settingSlice = createSliceWithThunks({
  name: "settings",
  initialState,
  reducers: {
    _updateSettingsState: (
      state,
      action: PayloadAction<Partial<SettingState>>,
    ) => {
      Object.assign(state, normalizeSettingChanges(action.payload));
    },
    clearDefaultSpaceId: (state) => {
      state.defaultSpaceId = initialState.defaultSpaceId;
    },
    addHostToCurrentServer: (state, action: PayloadAction<string>) => {
      const rawValue = action.payload;
      if (typeof rawValue !== "string" || rawValue.trim() === "") return;

      const trimmed = rawValue.trim();
      if (/^https?:\/\//i.test(trimmed)) {
        try {
          state.currentServer = new URL(trimmed).origin;
          return;
        } catch {
          return;
        }
      }

      const host = trimmed.replace(/^\/+|\/+$/g, "");
      const [hostname] = host.split(":");
      if (!hostname) return;
      const isIpAddress = /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname);
      const isLocal =
        ["nolotus.local", "localhost"].includes(hostname) || isIpAddress;
      const protocol = isLocal ? "http" : "https";
      state.currentServer = `${protocol}://${host}`;
    },
  },
});

export const { clearDefaultSpaceId, addHostToCurrentServer } =
  settingSlice.actions;

// ---------------------------------------------------------------------------
// Re-export 公共 API 表面(保持调用方 import 路径不变)
// ---------------------------------------------------------------------------

// 常量 + 类型
export { SYSTEM_DEFAULT_AGENT_ID, type SettingState } from "./settingTypes";

// server selectors
export {
  selectSettings,
  selectCurrentServer,
  selectSyncServers,
  selectRemoteServer,
  selectRemoteSyncServers,
  selectRemoteServers,
  selectDefaultSpaceId,
} from "./serverSelectors";

// 简单字段 selectors
export {
  selectPreferredAnimationSet,
  selectShowThinking,
  selectMaxCost,
  selectMaxExecutionTime,
  selectIsDark,
  selectThemeMode,
  selectHeaderHeight,
  selectThemeName,
  selectThemeFollowsSystem,
  selectSidebarWidth,
  selectDensity,
  selectFontPreset,
  selectEnableReadCurrentSpace,
  selectGlobalPrompt,
  selectUserTonePreset,
  selectKnowledgeCaptureLevel,
  selectSpaceContextLevel,
  selectAutoApproveSelfUpdateFields,
  selectAiRecentContentLimit,
  selectDefaultAgentPreference,
  selectDefaultAgentId,
  selectOcrModel,
  selectShowScrollToTopButton,
  selectShowScrollToBottomButton,
  selectCreateMenuOpenCount,
  selectDesktopChromeConnectorEnabled,
  selectEditorDefaultMode,
  selectEditorLightCodeTheme,
  selectEditorDarkCodeTheme,
  selectEditorWordCountEnabled,
  selectEditorShortcuts,
  selectDeleteShortcut,
  selectEditorFontSize,
  selectEditorAutoSave,
  selectEditorAutoSaveInterval,
} from "./fieldSelectors";

// 复合 selectors
export {
  selectEditorCodeTheme,
  selectEditorConfig,
} from "./editorConfigSelectors";
export { selectTheme } from "./themeSelectors";

// 持久化 / hydrate 工具
export {
  normalizeSettingChanges,
  hydrateStoredSettings,
  buildSettingsPersistencePlan,
  persistDefaultAgentRegister,
  getCachedDefaultAgentRegisterRecord,
  LOCAL_FIRST_APPEARANCE_KEYS,
  LOCAL_ONLY_SETTINGS_KEYS,
  isLocalFirstAppearanceChange,
  stripRegisterBackedFieldsFromSettingsWrite,
  sanitizeStoredSettingsRecord,
} from "./settingPersistence";

// thunks
export {
  getSettings,
  setSettings,
  changeTheme,
  changeDensity,
  changeFontPreset,
  changeDarkMode,
  toggleShowThinking,
  setThemeFollowsSystem,
  setSidebarWidth,
  toggleEnableReadCurrentSpace,
  setEditorDefaultMode,
  setEditorLightCodeTheme,
  setEditorDarkCodeTheme,
  setEditorCodeTheme,
  toggleEditorWordCount,
  toggleEditorShortcut,
  setEditorFontSize,
  toggleEditorAutoSave,
  setEditorAutoSaveInterval,
  setGlobalPrompt,
  setUserTonePreset,
  setKnowledgeCaptureLevel,
  setSpaceContextLevel,
  setAiRecentContentLimit,
  setMaxExecutionTime,
  setDefaultAgentId,
  setPreferredAnimationSet,
  setThemeMode,
} from "./settingThunks";

export default settingSlice.reducer;
