import { createSelector } from "@reduxjs/toolkit";
import type { RootState } from "../store";
import { SERVERS, normalizeKnownServerOrigin } from "../../database/config";
import { getAllServers } from "../../database/actions/common";
import { getIsDesktopApp } from "../utils/env";

export type RuntimeSnapshot = {
  currentToken?: string;
  currentUserId?: string;
  currentServer?: string;
  syncServers: string[];
  localRuntimeOrigin?: string;
};

const selectCurrentToken = (state: RootState) =>
  typeof state.auth?.currentToken === "string" ? state.auth.currentToken : undefined;

const selectCurrentUserId = (state: RootState) =>
  typeof state.auth?.currentUser?.userId === "string"
    ? state.auth.currentUser.userId
    : undefined;

const EMPTY_SYNC_SERVERS: string[] = [];

const isLocalServerUrl = (value: string | undefined): boolean => {
  if (typeof value !== "string") return false;
  return /^https?:\/\/(?:(?:\d{1,3}\.){3}\d{1,3}|localhost|nolotus\.local)(?::\d+)?$/i.test(
    value.trim()
  );
};

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
