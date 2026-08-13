import type { SpaceData, SpaceMemberWithSpaceInfo } from "../../app/types";
import { createSpaceKey, normalizeSpaceId } from "../space/spaceKeys";
import { fetchFromServer, getAllServers } from "../../database/actions/common";
import { normalizeKnownServerOrigin } from "../../database/config";
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

const resolveSpaceRemoteServers = (state: any): string[] => {
  const currentServer =
    typeof state?.settings?.currentServer === "string"
      ? state.settings.currentServer
      : undefined;
  const syncServers = Array.isArray(state?.settings?.syncServers)
    ? state.settings.syncServers
    : undefined;
  return getAllServers(currentServer, syncServers);
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

// in-flight 去重 + 短期缓存：页面加载时多个空间权限检查组件会并发调用本函数
// （实测 getUserSpaceMemberships ×3），同一 server+userId 只发一次请求。
// 只读数据 + 30s TTL，副作用低。
const membershipFetchCache = new Map<string, Promise<RemoteMembershipFetchResult>>();
const MEMBERSHIP_FETCH_CACHE_TTL_MS = 30_000;

async function fetchMembershipsFromServer(
  server: string,
  token: string | null,
  userId: string,
  timeoutMs: number
): Promise<RemoteMembershipFetchResult> {
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
}

export const fetchRemoteUserSpaceMemberships = (
  server: string,
  token: string | null,
  userId: string,
  timeoutMs = 5000
): Promise<RemoteMembershipFetchResult> => {
  const cacheKey = `${server}|${userId}`;
  const cached = membershipFetchCache.get(cacheKey);
  if (cached) return cached;
  const promise = fetchMembershipsFromServer(server, token, userId, timeoutMs);
  membershipFetchCache.set(cacheKey, promise);
  promise
    .catch(() => {})
    .finally(() => {
      setTimeout(() => {
        if (membershipFetchCache.get(cacheKey) === promise) {
          membershipFetchCache.delete(cacheKey);
        }
      }, MEMBERSHIP_FETCH_CACHE_TTL_MS);
    });
  return promise;
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
