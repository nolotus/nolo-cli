// packages/app/settings/serverSelectors.ts
//
// 单一职责:服务端地址相关选择器(current server / sync servers / remote cluster),
// 以及 desktop-safe 解析。这些是 settings 模块对外最常被引用的 selector。

import { createSelector } from "@reduxjs/toolkit";
import type { RootState } from "../store";
import { getIsDesktopApp } from "../utils/env";
import { isLocalServerUrl } from "../../core/localOrigins";
import { getAllServers } from "../../database/actions/common";
import { SERVERS } from "../../database/config";

import type { SettingState } from "./settingTypes";

/**
 * In desktop builds, local-only URLs (localhost / 192.168.x.x / nolotus.local)
 * are not routable from the desktop shell, so we fall back to SERVERS.MAIN
 * instead. Everywhere else, just normalize to SERVERS.MAIN when the value is
 * empty.
 */
const resolveDesktopSafeServer = (value: string | undefined): string => {
  if (!getIsDesktopApp()) return value || SERVERS.MAIN;
  return isLocalServerUrl(value) ? SERVERS.MAIN : value || SERVERS.MAIN;
};

export const selectSettings = (state: RootState): SettingState =>
  state.settings;

export const selectCurrentServer = createSelector(
  [selectSettings],
  (settings) => resolveDesktopSafeServer(settings.currentServer),
);

export const selectSyncServers = createSelector(
  [selectSettings],
  (settings): string[] =>
    (settings.syncServers || []).filter(
      (server: string) => !getIsDesktopApp() || !isLocalServerUrl(server),
    ),
);

export const selectRemoteServer = selectCurrentServer;
export const selectRemoteSyncServers = selectSyncServers;

export const selectRemoteServers = createSelector(
  [selectRemoteServer, selectRemoteSyncServers],
  (currentServer, syncServers) => getAllServers(currentServer, syncServers),
);
