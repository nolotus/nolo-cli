// packages/app/settings/settingActions.ts
//
// 单一职责:跨 settingSlice 与 settingThunks 共享的 action creator 工厂。
// 抽出来以避免 settingThunks → settingSlice 的循环依赖。

import { createAction } from "@reduxjs/toolkit";

import type { SettingState } from "./settingTypes";

/**
 * Apply a normalized settings change payload to the local state. Dispatched by
 * thunks (e.g. setSettings / getSettings) after the payload has been normalized
 * and the persistence plan built.
 */
export const updateSettingsState = createAction<Partial<SettingState>>(
  "settings/_updateSettingsState",
);
