// packages/app/settings/editorConfigSelectors.ts
//
// 单一职责:编辑器复合选择器(selectEditorCodeTheme / selectEditorConfig),
// 聚合 fieldSelectors 的原始字段 + isDark。

import { createSelector } from "@reduxjs/toolkit";

import {
  selectEditorAutoSave,
  selectEditorAutoSaveInterval,
  selectEditorDarkCodeTheme,
  selectEditorDefaultMode,
  selectEditorFontSize,
  selectEditorLightCodeTheme,
  selectEditorShortcuts,
  selectEditorWordCountEnabled,
} from "./fieldSelectors";
import { selectIsDark } from "./fieldSelectors";

export const selectEditorCodeTheme = createSelector(
  [selectEditorLightCodeTheme, selectEditorDarkCodeTheme, selectIsDark],
  (lightTheme, darkTheme, isDark) => (isDark ? darkTheme : lightTheme),
);

export const selectEditorConfig = createSelector(
  [
    selectEditorDefaultMode,
    selectEditorLightCodeTheme,
    selectEditorDarkCodeTheme,
    selectEditorWordCountEnabled,
    selectEditorShortcuts,
    selectEditorFontSize,
    selectEditorAutoSave,
    selectEditorAutoSaveInterval,
    selectIsDark,
  ],
  (
    defaultMode,
    lightCodeTheme,
    darkCodeTheme,
    wordCountEnabled,
    shortcuts,
    fontSize,
    autoSave,
    autoSaveInterval,
    isDark,
  ) => {
    const codeTheme = isDark ? darkCodeTheme : lightCodeTheme;
    return {
      defaultMode,
      codeTheme,
      lightCodeTheme,
      darkCodeTheme,
      wordCountEnabled,
      shortcuts,
      fontSize,
      autoSave,
      autoSaveInterval,
    };
  },
);
