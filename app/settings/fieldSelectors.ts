// packages/app/settings/fieldSelectors.ts
//
// 单一职责:settings state 的简单字段选择器(无业务派生)。
// 复合 selector(selectTheme / selectEditorConfig / selectEditorCodeTheme)放到
// themeSelectors / editorConfigSelectors。

import { createSelector } from "@reduxjs/toolkit";
import type { RootState } from "../store";
import type { THEME_COLORS } from "../theme/theme.config";
import {
  DEFAULT_FONT_PRESET,
  type FontPreset,
  normalizeFontPreset,
} from "../theme/fontPreference";
import { DEFAULT_USER_PREFERENCE_PROFILE } from "../../ai/policy/types";
import {
  DEFAULT_AUTO_APPROVED_SELF_UPDATE_FIELDS,
  normalizeAgentUpdateFieldList,
} from "../../ai/policy/selfUpdateFields";
import { DEFAULT_ANIMATION_SET_INDEX } from "../constants/animationSets";

import {
  normalizePolicyLevelSetting,
  normalizeTonePresetSetting,
  resolveDefaultAgentIdSetting,
  selectResolvedDefaultAgentId,
} from "./settingNormalizers";
import type { SettingState } from "./settingTypes";

// --- 通用 / 主题字段 ---

export const selectPreferredAnimationSet = (state: RootState): number =>
  state.settings.preferredAnimationSet ?? DEFAULT_ANIMATION_SET_INDEX;

export const selectShowThinking = (state: RootState): boolean =>
  state.settings.showThinking;

export const selectMaxCost = (state: RootState): number =>
  state.settings.maxCost;

export const selectMaxExecutionTime = (state: RootState): number =>
  state.settings.maxExecutionTime;

export const selectIsDark = (state: RootState): boolean =>
  state.settings.isDark;

export const selectThemeMode = (
  state: RootState,
): "system" | "light" | "dark" => state.settings.themeMode ?? "system";

export const selectHeaderHeight = (state: RootState): number =>
  state.settings.headerHeight;

export const selectThemeName = (
  state: RootState,
): keyof typeof THEME_COLORS => state.settings.themeName;

export const selectThemeFollowsSystem = (state: RootState): boolean =>
  (state.settings.themeMode ?? "system") === "system";

export const selectSidebarWidth = (state: RootState): number =>
  state.settings.sidebarWidth;

export const selectDensity = (
  state: RootState,
): "compact" | "spacious" => state.settings.density ?? "compact";

export const selectFontPreset = (state: RootState): FontPreset =>
  normalizeFontPreset(state.settings.fontPreset) ?? DEFAULT_FONT_PRESET;

// --- AI / 上下文策略 ---

export const selectEnableReadCurrentSpace = (state: RootState): boolean =>
  state.settings.enableReadCurrentSpace;

export const selectGlobalPrompt = (state: RootState): string =>
  state.settings.globalPrompt;

export const selectUserTonePreset = (state: RootState) =>
  normalizeTonePresetSetting(state.settings.userTonePreset);

export const selectKnowledgeCaptureLevel = (state: RootState) =>
  normalizePolicyLevelSetting(
    state.settings.knowledgeCaptureLevel,
    DEFAULT_USER_PREFERENCE_PROFILE.knowledgeCaptureLevel,
  ) as SettingState["knowledgeCaptureLevel"];

export const selectSpaceContextLevel = (state: RootState) =>
  state.settings.enableReadCurrentSpace === false
    ? 1
    : (normalizePolicyLevelSetting(
        state.settings.spaceContextLevel,
        DEFAULT_USER_PREFERENCE_PROFILE.spaceContextLevel,
      ) as SettingState["spaceContextLevel"]);

export const selectAutoApproveSelfUpdateFields = createSelector(
  [(state: RootState) => state.settings.autoApproveSelfUpdateFields],
  (fields) =>
    normalizeAgentUpdateFieldList(
      fields,
      DEFAULT_AUTO_APPROVED_SELF_UPDATE_FIELDS,
    ),
);

export const selectAiRecentContentLimit = (state: RootState): number =>
  state.settings.aiRecentContentLimit ?? 50;

export const selectContextRetention = (state: RootState): number =>
  state.settings.contextRetention ?? 50;

// --- 快速对话 agent id 偏好(每个档位一对:preference 是 raw stored,sentinel 留原值;
//     id 是运行时回退后的 nolo agent) ---

export const selectDefaultAgentPreference = (state: RootState): string =>
  resolveDefaultAgentIdSetting(state.settings.defaultAgentId);
export const selectDefaultAgentId = (state: RootState): string =>
  selectResolvedDefaultAgentId(state.settings.defaultAgentId);

export const selectFlashAgentPreference = (state: RootState): string =>
  resolveDefaultAgentIdSetting(state.settings.flashAgentId);
export const selectFlashAgentId = (state: RootState): string =>
  selectResolvedDefaultAgentId(state.settings.flashAgentId);

export const selectBalancedAgentPreference = (state: RootState): string =>
  resolveDefaultAgentIdSetting(state.settings.balancedAgentId);
export const selectBalancedAgentId = (state: RootState): string =>
  selectResolvedDefaultAgentId(state.settings.balancedAgentId);

export const selectQualityAgentPreference = (state: RootState): string =>
  resolveDefaultAgentIdSetting(state.settings.qualityAgentId);
export const selectQualityAgentId = (state: RootState): string =>
  selectResolvedDefaultAgentId(state.settings.qualityAgentId);

export const selectImageAgentPreference = (state: RootState): string =>
  resolveDefaultAgentIdSetting(state.settings.imageAgentId);
export const selectImageAgentId = (state: RootState): string =>
  selectResolvedDefaultAgentId(state.settings.imageAgentId);

// --- 杂项 UI 偏好 ---

export const selectOcrModel = (
  state: RootState,
): "none" | "google_document_ocr" | "olm_ocr" => {
  if (state.settings.ocrModel === "none") return "none";
  if (state.settings.ocrModel === "olm_ocr") return "olm_ocr";
  return "google_document_ocr";
};

export const selectShowScrollToTopButton = (state: RootState): boolean =>
  state.settings.showScrollToTopButton ?? false;

export const selectShowScrollToBottomButton = (state: RootState): boolean =>
  state.settings.showScrollToBottomButton ?? false;

export const selectCreateMenuOpenCount = (state: RootState): number => {
  const value = Number(state.settings.createMenuOpenCount);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
};

export const selectDesktopChromeConnectorEnabled = (
  state: RootState,
): boolean => state.settings.desktopChromeConnectorEnabled === true;

// --- 编辑器原始字段(不含 selectEditorConfig / selectEditorCodeTheme,见 editorConfigSelectors) ---

export const selectEditorDefaultMode = (
  state: RootState,
): "markdown" | "block" => state.settings.editorDefaultMode;

export const selectEditorLightCodeTheme = (state: RootState): string =>
  state.settings.editorLightCodeTheme;

export const selectEditorDarkCodeTheme = (state: RootState): string =>
  state.settings.editorDarkCodeTheme;

export const selectEditorWordCountEnabled = (state: RootState): boolean =>
  state.settings.editorWordCountEnabled;

export const selectEditorShortcuts = (state: RootState) =>
  state.settings.editorShortcuts;

const PLATFORM_MAC_REGEX = /Mac|iPod|iPhone|iPad/;

const isMacPlatform = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.navigator !== "undefined" &&
  PLATFORM_MAC_REGEX.test(window.navigator.platform);

export const selectDeleteShortcut = (state: RootState): string => {
  const shortcut = state.settings.deleteShortcut;
  if (shortcut === undefined || shortcut === null) {
    return isMacPlatform() ? "meta+backspace" : "ctrl+backspace";
  }
  return shortcut;
};

export const selectEditorFontSize = (state: RootState): number =>
  state.settings.editorFontSize;

export const selectEditorAutoSave = (state: RootState): boolean =>
  state.settings.editorAutoSave;

export const selectEditorAutoSaveInterval = (state: RootState): number =>
  state.settings.editorAutoSaveInterval;
