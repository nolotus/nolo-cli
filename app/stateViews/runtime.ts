import { createSelector } from "@reduxjs/toolkit";
import type { RootState } from "../store";
import {
  selectIdentityToken,
  selectIdentityUserId,
} from "identity/selectors";
import { getIsDesktopApp } from "../utils/env";
import { isLocalServerUrl } from "../../core/localOrigins";
import { getAllServers } from "../../database/actions/common";
import { SERVERS, normalizeKnownServerOrigin } from "../../database/config";

export type RuntimeSnapshot = {
  currentToken?: string;
  currentUserId?: string;
  currentServer?: string;
  syncServers: string[];
  localRuntimeOrigin?: string;
};

// 经 identity 读取，而不是自己读 state.auth 形状：identity 是 edition 注入点，
// 这里若另起一套直读，开源换 edition 时就有两个地方要改，必然漏一个。
// 外层的类型收窄（非 string 一律 undefined）是本模块 RuntimeSnapshot 的既有契约，
// 予以保留。
// RuntimeSnapshot 允许在 state.auth 尚未挂载时被调用（例如仅带 settings 的
// 局部 state），而 authSlice 侧的 selector 是 state.auth.x 直读、不容忍缺失。
// 因此这里先判存在再委托，保持本模块原有的容忍度。
const selectCurrentToken = (state: RootState) => {
  if (!state?.auth) return undefined;
  const token = selectIdentityToken(state as never);
  return typeof token === "string" ? token : undefined;
};

const selectCurrentUserId = (state: RootState) => {
  if (!state?.auth) return undefined;
  const userId = selectIdentityUserId(state as never);
  return typeof userId === "string" ? userId : undefined;
};

const EMPTY_SYNC_SERVERS: string[] = [];

const selectRuntimeRemoteServer = (state: RootState): string => {
  const configuredServer = normalizeKnownServerOrigin(state.settings?.currentServer) ?? undefined;
  if (!getIsDesktopApp()) return configuredServer || SERVERS.MAIN;
  return isLocalServerUrl(configuredServer) ? SERVERS.MAIN : configuredServer || SERVERS.MAIN;
};

const selectConfiguredSyncServers = (state: RootState) => state.settings?.syncServers;

const selectRuntimeRemoteSyncServers = createSelector(
  [selectConfiguredSyncServers],
  (syncServers): string[] => {
    if (!Array.isArray(syncServers) || syncServers.length === 0) {
      return EMPTY_SYNC_SERVERS;
    }
    const normalized = syncServers
      .map(normalizeKnownServerOrigin)
      .filter((server): server is string => !!server);
    if (!getIsDesktopApp()) return normalized;
    return normalized.filter((server) => !isLocalServerUrl(server));
  }
);

const selectLocalRuntimeOrigin = (): string | undefined => {
  if (
    typeof window !== "undefined" &&
    typeof window.location?.origin === "string" &&
    /^https?:\/\//.test(window.location.origin)
  ) {
    return window.location.origin.replace(/\/+$/, "");
  }
  return undefined;
};

export const selectRuntimeSnapshot = createSelector(
  [
    selectCurrentToken,
    selectCurrentUserId,
    selectRuntimeRemoteServer,
    selectRuntimeRemoteSyncServers,
    selectLocalRuntimeOrigin,
  ],
  (currentToken, currentUserId, currentServer, syncServers, localRuntimeOrigin): RuntimeSnapshot => ({
    currentToken,
    currentUserId,
    currentServer,
    syncServers,
    localRuntimeOrigin,
  })
);

export const selectRuntimeCurrentServer = createSelector(
  [selectRuntimeSnapshot],
  (runtime) => runtime.currentServer
);

export const selectRuntimeRemoteServers = createSelector(
  [selectRuntimeSnapshot],
  (runtime) => getAllServers(runtime.currentServer, runtime.syncServers)
);
