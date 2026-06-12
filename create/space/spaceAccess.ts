import type { SpaceData, SpaceMemberWithSpaceInfo } from "../../app/types";
import { getIsDesktopApp } from "../../app/utils/env";
import { createSpaceKey, normalizeSpaceId } from "../space/spaceKeys";
import { fetchFromServer } from "../../database/actions/common";
import { NOLO_CLUSTER_SERVERS, normalizeKnownServerOrigin } from "../../database/config";
import { isTombstoneRecord } from "../../database/tombstones";

export interface SpaceRemoteAuth {
  token: string | null;
  userId: string | null;
  servers: string[];
}

export interface RemoteMembershipFetchResult {
  ok: boolean;
  server?: string;
  memberships: SpaceMemberWithSpaceInfo[];
}

const normalizeServerOrigin = (server: unknown): string | null => {
  return normalizeKnownServerOrigin(server);
};

const isLocalServerOrigin = (server: string): boolean =>
  /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|nolotus\.local)(?::\d+)?$/i.test(server);

const resolveSpaceRemoteServers = (state: any): string[] => {
  const currentServer = normalizeServerOrigin(state?.settings?.currentServer);
  const normalized = [
    currentServer,
    ...(Array.isArray(state?.settings?.syncServers)
      ? state.settings.syncServers
      : []),
  ]
    .map(normalizeServerOrigin)
    .filter((server): server is string => !!server);

  if (!getIsDesktopApp()) {
    return Array.from(new Set(normalized));
  }

  const remoteServers = normalized.filter((server) => !isLocalServerOrigin(server));
  if (currentServer && isLocalServerOrigin(currentServer)) {
    return Array.from(new Set([...NOLO_CLUSTER_SERVERS, ...remoteServers]));
  }
  if (remoteServers.length === 0) {
    remoteServers.push(...NOLO_CLUSTER_SERVERS);
  }

  return Array.from(new Set(remoteServers));
};

export const selectSpaceRemoteAuth = (state: any): SpaceRemoteAuth => ({
  token: state?.auth?.currentToken ?? null,
  userId: state?.auth?.currentUser?.userId ?? null,
  servers: resolveSpaceRemoteServers(state),
});

export const spaceListsUser = (spaceData: any, userId: string): boolean => {
  if (!spaceData || isTombstoneRecord(spaceData)) return false;
  if (spaceData.ownerId === userId) return true;
  return Array.isArray(spaceData.members) && spaceData.members.includes(userId);
};

export const membershipBelongsToUser = (
  membership: SpaceMemberWithSpaceInfo,
  userId: string
): boolean => !membership.userId || membership.userId === userId;

export const fetchRemoteUserSpaceMemberships = async (
  server: string,
  token: string | null,
  userId: string,
  timeoutMs = 5000
): Promise<RemoteMembershipFetchResult> => {
  if (!token) return { ok: false, memberships: [] };
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${server}/rpc/getUserSpaceMemberships`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userId }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      console.error(
        `Failed to fetch memberships from ${server}: ${response.statusText}`
      );
      return { ok: false, memberships: [] };
    }
    const data = await response.json();
    return {
      ok: true,
      server,
      memberships: Array.isArray(data) ? data : [],
    };
  } catch (error) {
    clearTimeout(timeoutId);
    console.error(`Error fetching memberships from ${server}:`, error);
    return { ok: false, memberships: [] };
  }
};

export const fetchRemoteSpace = async (
  server: string,
  token: string | null,
  spaceId: string
): Promise<SpaceData | null> => {
  try {
    const space = await fetchFromServer(
      server,
      createSpaceKey.space(normalizeSpaceId(spaceId)),
      token ?? undefined
    );
    return space && typeof space === "object" ? (space as SpaceData) : null;
  } catch {
    return null;
  }
};

export const hasActiveRemoteMembership = async (
  server: string,
  token: string,
  userId: string,
  spaceId: string
): Promise<boolean> => {
  const result = await fetchRemoteUserSpaceMemberships(server, token, userId);
  if (!result.ok) return false;
  const normalizedSpaceId = normalizeSpaceId(spaceId);
  return result.memberships.some((membership) => {
    const membershipSpaceId =
      typeof membership?.spaceId === "string"
        ? normalizeSpaceId(membership.spaceId)
        : "";
    return (
      membershipSpaceId === normalizedSpaceId &&
      membershipBelongsToUser(membership, userId) &&
      !isTombstoneRecord(membership)
    );
  });
};

export const fetchAuthoritativeRemoteSpace = async ({
  servers,
  token,
  userId,
  spaceId,
}: {
  servers: string[];
  token: string;
  userId: string;
  spaceId: string;
}): Promise<SpaceData | null> => {
  const normalizedSpaceId = normalizeSpaceId(spaceId);
  for (const server of servers) {
    const space = await fetchRemoteSpace(server, token, normalizedSpaceId);
    if (!space) continue;
    if (!spaceListsUser(space, userId)) {
      throw new Error(`Current user is not a member of space: ${normalizedSpaceId}`);
    }
    if (space.ownerId !== userId) {
      const hasMembership = await hasActiveRemoteMembership(
        server,
        token,
        userId,
        normalizedSpaceId
      );
      if (!hasMembership) {
        throw new Error(
          `Current user has no active membership for space: ${normalizedSpaceId}`
        );
      }
    }
    return space;
  }
  return null;
};
