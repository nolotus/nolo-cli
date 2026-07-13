// 文件路径: app/spaces/fetchUserSpaceMembershipsAction.ts

import type { AppThunkApi } from "../../../app/store";
import { MemberRole, type SpaceMemberWithSpaceInfo } from "../../../app/types";
import { createSpaceKey, normalizeSpaceId } from "../../space/spaceKeys";
import {
  fetchRemoteSpace,
  fetchRemoteUserSpaceMemberships,
  membershipBelongsToUser,
  selectSpaceRemoteAuth,
  spaceListsUser,
} from "../../space/spaceAccess";
import { DataType } from "../../types";
import { API_ENDPOINTS } from "../../../database/config";
import { readAction } from "../../../database/actions/read";
import {
  DEVICE_LOCAL_OWNER_ID,
  isDeviceLocalOwnerId,
  isDeviceLocalSpaceMembership,
} from "../../../database/authority/deviceLocal";
import { isTombstoneRecord } from "../../../database/tombstones";

type MembershipWithSource = SpaceMemberWithSpaceInfo & {
  sourceServer?: string;
  requiresRemoteSpaceVerification?: boolean;
  /** True when this row is device-local authority (never remote-verified). */
  deviceLocal?: boolean;
};

const CONTENT_SPACE_RECOVERY_TYPES = [
  DataType.APP,
  DataType.DOC,
  DataType.DIALOG,
  DataType.IMAGE,
  DataType.FILE,
  DataType.TABLE,
  DataType.AGENT,
  DataType.CYBOT,
] as const;

const readLocalSpaceData = async (db: any, spaceId: string): Promise<any | null> => {
  const normalizedSpaceId = normalizeSpaceId(spaceId);
  const spaceKey = createSpaceKey.space(normalizedSpaceId);
  try {
    return (await db.get(spaceKey)) ?? null;
  } catch {
    return null;
  }
};

/**
 * Effective owner for membership/space listing checks.
 * Device-local rows always authenticate as `"local"`; account rows use active userId.
 */
const membershipCheckUserId = (
  membership: { userId?: string | null },
  activeUserId: string
): string =>
  isDeviceLocalSpaceMembership(membership)
    ? DEVICE_LOCAL_OWNER_ID
    : activeUserId;

const buildLocalMembershipPreview = async (
  userId: string,
  db: any,
  memberships: SpaceMemberWithSpaceInfo[]
): Promise<SpaceMemberWithSpaceInfo[]> => {
  const preview = await Promise.all(
    memberships.map(async (membership) => {
      if (isTombstoneRecord(membership)) return null;
      const checkUserId = membershipCheckUserId(membership, userId);
      if (!membershipBelongsToUser(membership, checkUserId)) return null;

      const normalizedSpaceId = normalizeSpaceId(membership.spaceId);
      const localSpaceData = await readLocalSpaceData(db, normalizedSpaceId);
      // Device-local membership is locally authoritative but requires a real
      // non-tombstoned Space body that lists `"local"`. Missing body is a
      // ghost membership — drop it (same as tombstoned). Never remote-verify.
      if (isDeviceLocalSpaceMembership(membership)) {
        if (!localSpaceData || isTombstoneRecord(localSpaceData)) return null;
        if (!spaceListsUser(localSpaceData, checkUserId)) return null;
      } else {
        if (localSpaceData && isTombstoneRecord(localSpaceData)) return null;
        if (localSpaceData && !spaceListsUser(localSpaceData, checkUserId)) {
          return null;
        }
      }

      return {
        ...membership,
        spaceId: normalizedSpaceId,
      };
    })
  );

  return preview.filter(
    (membership): membership is SpaceMemberWithSpaceInfo => !!membership
  );
};

/**
 * 从本地 IndexedDB 按 userId 前缀扫描 space-member-{userId}-*
 */
const fetchLocalForUser = async (
  userId: string,
  db: any
): Promise<SpaceMemberWithSpaceInfo[]> => {
  try {
    const memberships: SpaceMemberWithSpaceInfo[] = [];
    const prefix = `space-member-${userId}`;
    let iterator = db.iterator({
      gte: prefix,
      lte: prefix + "\xff",
    });

    if (iterator && typeof iterator.then === "function") {
      iterator = await iterator;
    }

    for await (const [_, memberData] of iterator) {
      if (
        memberData &&
        typeof memberData === "object" &&
        memberData.spaceId &&
        !isTombstoneRecord(memberData)
      ) {
        memberships.push(memberData);
      }
    }

    return memberships;
  } catch (error) {
    console.error("Error fetching local memberships:", error);
    return [];
  }
};

/**
 * Device-local + active-account union (single list, no second registry).
 * Guest / userId "local" → local only.
 * Account A → space-member-local-* ∪ space-member-A-*.
 */
const fetchLocalUnion = async (
  userId: string,
  db: any
): Promise<MembershipWithSource[]> => {
  const deviceLocalRows = await fetchLocalForUser(DEVICE_LOCAL_OWNER_ID, db);
  const taggedLocal: MembershipWithSource[] = deviceLocalRows.map(
    (membership) => ({
      ...membership,
      spaceId: normalizeSpaceId(membership.spaceId),
      deviceLocal: true,
      userId: membership.userId || DEVICE_LOCAL_OWNER_ID,
    })
  );

  if (isDeviceLocalOwnerId(userId)) {
    return taggedLocal;
  }

  const accountRows = await fetchLocalForUser(userId, db);
  const taggedAccount: MembershipWithSource[] = accountRows.map(
    (membership) => ({
      ...membership,
      spaceId: normalizeSpaceId(membership.spaceId),
      deviceLocal: false,
    })
  );

  // Prefer account row when the same spaceId collides (account processed last
  // in the merge map). Here we just concatenate; map merge applies preference.
  return [...taggedLocal, ...taggedAccount];
};

const fetchRemoteContentSpaceIds = async (
  server: string,
  userId: string
): Promise<string[]> => {
  try {
    const queryParams = new URLSearchParams({ limit: "200" });
    const response = await fetch(
      `${server}${API_ENDPOINTS.DATABASE}/query/${encodeURIComponent(userId)}?${queryParams}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: [...CONTENT_SPACE_RECOVERY_TYPES],
          includeDeleted: true,
          summary: true,
        }),
      }
    );
    if (!response.ok) return [];
    const data = await response.json();
    const records = Array.isArray(data?.data?.data) ? data.data.data : [];
    return records
      .filter((record: any) => !isTombstoneRecord(record))
      .map((record: any) =>
        typeof record?.spaceId === "string" ? normalizeSpaceId(record.spaceId) : ""
      )
      .filter((spaceId: string) => spaceId.length > 0);
  } catch {
    return [];
  }
};

const recoverMembershipsFromContentSpaces = async ({
  servers,
  token,
  userId,
  knownSpaceIds,
}: {
  servers: string[];
  token: string | null;
  userId: string;
  knownSpaceIds: Set<string>;
}): Promise<MembershipWithSource[]> => {
  const candidateSpaceIds = new Set<string>();
  await Promise.all(
    servers.map(async (server) => {
      const spaceIds = await fetchRemoteContentSpaceIds(server, userId);
      spaceIds.forEach((spaceId) => {
        if (!knownSpaceIds.has(spaceId)) {
          candidateSpaceIds.add(spaceId);
        }
      });
    })
  );

  const recovered: MembershipWithSource[] = [];
  for (const spaceId of candidateSpaceIds) {
    for (const server of servers) {
      const remoteSpace = await fetchRemoteSpace(server, token, spaceId);
      if (!spaceListsUser(remoteSpace, userId)) continue;
      recovered.push({
        userId,
        spaceId,
        spaceName:
          typeof remoteSpace?.name === "string" && remoteSpace.name.trim()
            ? remoteSpace.name
            : spaceId,
        role:
          remoteSpace?.ownerId === userId
            ? MemberRole.OWNER
            : MemberRole.MEMBER,
        joinedAt:
          remoteSpace?.updatedAt ??
          remoteSpace?.createdAt ??
          Date.now(),
        sourceServer: server,
      } as unknown as MembershipWithSource);
      break;
    }
  }
  return recovered;
};

/**
 * 获取用户的所有空间成员资格。
 *
 * Device-local foundation:
 * - Always unions `space-member-local-*` with the active account prefix.
 * - Guest (`userId === "local"`) needs no token/server.
 * - Device-local rows never remote-verify and never recover remotely.
 * - Same spaceId collision: active-account membership wins over local.
 */
export const fetchUserSpaceMembershipsAction = async (
  userId: string,
  thunkAPI: AppThunkApi
): Promise<SpaceMemberWithSpaceInfo[]> => {
  const state = thunkAPI.getState();
  const db = thunkAPI.extra.db;
  const { token, servers } = selectSpaceRemoteAuth(state);
  const isLocalActor = isDeviceLocalOwnerId(userId);

  const localMembershipsPromise = fetchLocalUnion(userId, db);
  // Guest / local actor: never hit remote membership RPC (no token required).
  const remoteResultsPromise = isLocalActor
    ? Promise.resolve([] as Awaited<
        ReturnType<typeof fetchRemoteUserSpaceMemberships>
      >[])
    : Promise.all(
        servers.map((server) =>
          fetchRemoteUserSpaceMemberships(server, token, userId)
        )
      );

  const localMemberships = await localMembershipsPromise;
  if (state.space?.memberSpaces === null && localMemberships.length > 0) {
    const localPreview = await buildLocalMembershipPreview(
      userId,
      db,
      localMemberships
    );
    thunkAPI.dispatch?.({
      type: "space/hydrateMemberSpacesFromLocal",
      payload: localPreview,
    });
  }

  const remoteResults = await remoteResultsPromise;

  const successfulRemoteResults = remoteResults.filter((result) => result.ok);
  const successfulRemoteMemberships = successfulRemoteResults.flatMap(
    (result) =>
      result.memberships.map((membership) => ({
        ...membership,
        sourceServer: result.server,
      }))
  );
  const hasSuccessfulRemoteFetch = successfulRemoteResults.length > 0;
  // Guest never has remote authority requirements even if servers are listed.
  const hasRemoteAuthority = !isLocalActor && !!token && servers.length > 0;

  if (hasRemoteAuthority && !hasSuccessfulRemoteFetch) {
    throw new Error(
      `space_membership_remote_unavailable: unable to refresh memberships from ${servers.join(", ")}`
    );
  }

  const remoteSpaceIds = new Set(
    successfulRemoteMemberships.map((membership) =>
      normalizeSpaceId(membership.spaceId)
    )
  );

  const filteredLocalMemberships: MembershipWithSource[] = hasSuccessfulRemoteFetch
    ? (
      await Promise.all(
        localMemberships.map(async (membership) => {
          const normalizedSpaceId = normalizeSpaceId(membership.spaceId);

          // Device-local rows are device-authoritative: never flag for remote verify.
          if (
            membership.deviceLocal ||
            isDeviceLocalSpaceMembership(membership)
          ) {
            return {
              ...membership,
              spaceId: normalizedSpaceId,
              deviceLocal: true,
            };
          }

          if (remoteSpaceIds.has(normalizedSpaceId)) {
            return {
              ...membership,
              spaceId: normalizedSpaceId,
            };
          }

          console.warn(
            `[SpaceMembership] Membership missing from remote index, verifying space record: user=${userId}, spaceId=${normalizedSpaceId}`
          );
          return {
            ...membership,
            spaceId: normalizedSpaceId,
            requiresRemoteSpaceVerification: true,
          };
        })
      )
    ).filter((membership): membership is MembershipWithSource => !!membership)
    : localMemberships.map((membership) => ({
      ...membership,
      spaceId: normalizeSpaceId(membership.spaceId),
    }));

  const verifyActiveSpaceMembership = async (
    membership: MembershipWithSource
  ): Promise<SpaceMemberWithSpaceInfo | null> => {
    if (isTombstoneRecord(membership)) return null;

    const checkUserId = membershipCheckUserId(membership, userId);
    if (!membershipBelongsToUser(membership, checkUserId)) return null;

    const normalizedSpaceId = normalizeSpaceId(membership.spaceId);
    const localSpaceData = await readLocalSpaceData(db, normalizedSpaceId);
    const isDeviceLocal =
      membership.deviceLocal || isDeviceLocalSpaceMembership(membership);

    // Device-local memberships never remote-verify. Body must exist, be
    // non-tombstoned, and list `"local"` — missing body is ghost membership.
    if (isDeviceLocal) {
      if (!localSpaceData || isTombstoneRecord(localSpaceData)) return null;
      if (!spaceListsUser(localSpaceData, checkUserId)) {
        return null;
      }
      const {
        sourceServer: _s,
        requiresRemoteSpaceVerification: _r,
        deviceLocal: _d,
        ...visible
      } = membership;
      return {
        ...visible,
        spaceId: normalizedSpaceId,
        userId: DEVICE_LOCAL_OWNER_ID,
      };
    }

    if (membership.sourceServer || membership.requiresRemoteSpaceVerification) {
      if (localSpaceData && isTombstoneRecord(localSpaceData)) return null;
      try {
        const remoteSpaceServers = Array.from(
          new Set(
            [membership.sourceServer, ...servers].filter(
              (server): server is string =>
                typeof server === "string" && server.length > 0
            )
          )
        );
        let remoteSpace: any | null = null;
        for (const server of remoteSpaceServers) {
          remoteSpace = await fetchRemoteSpace(
            server,
            token,
            normalizedSpaceId
          );
          if (remoteSpace) break;
        }
        if (!spaceListsUser(remoteSpace, userId)) return null;
        const {
          requiresRemoteSpaceVerification,
          deviceLocal: _dl,
          ...verifiedMembership
        } = membership;
        return {
          ...verifiedMembership,
          spaceId: normalizedSpaceId,
        };
      } catch {
        return null;
      }
    }

    if (localSpaceData) {
      return !spaceListsUser(localSpaceData, userId)
        ? null
        : {
            ...membership,
            spaceId: normalizedSpaceId,
          };
    }
    if (!membership.sourceServer && servers.length === 0) {
      return {
        ...membership,
        spaceId: normalizedSpaceId,
      };
    }

    try {
      const remoteSpace = await readAction(
        {
          dbKey: createSpaceKey.space(normalizedSpaceId),
          preferredServerOrigin: membership.sourceServer,
        },
        thunkAPI
      );
      if (!spaceListsUser(remoteSpace, userId)) return null;
      return {
        ...membership,
        spaceId: normalizedSpaceId,
      };
    } catch {
      return null;
    }
  };

  const activeMemberships = (
    await Promise.all(
      [...filteredLocalMemberships, ...successfulRemoteMemberships].map(
        verifyActiveSpaceMembership
      )
    )
  ).filter((membership): membership is SpaceMemberWithSpaceInfo => !!membership);

  const knownSpaceIds = new Set(
    [
      ...filteredLocalMemberships,
      ...successfulRemoteMemberships,
      ...activeMemberships,
    ].map((membership) => normalizeSpaceId(membership.spaceId))
  );
  // Content recovery is account-only; never for guest/local actor.
  const recoveredMemberships =
    hasRemoteAuthority && hasSuccessfulRemoteFetch && !isLocalActor
      ? await recoverMembershipsFromContentSpaces({
        servers,
        token,
        userId,
        knownSpaceIds,
      })
      : [];

  // Merge into one list. On spaceId collision prefer active-account membership
  // over device-local: process device-local first, then account/recovered last.
  const membershipMap = new Map<string, SpaceMemberWithSpaceInfo>();
  const preferAccountOnCollision = (
    existing: SpaceMemberWithSpaceInfo | undefined,
    next: SpaceMemberWithSpaceInfo
  ): SpaceMemberWithSpaceInfo => {
    if (!existing) return next;
    const existingLocal = isDeviceLocalSpaceMembership(existing);
    const nextLocal = isDeviceLocalSpaceMembership(next);
    // Prefer non-local (active account) over local when ids collide.
    if (existingLocal && !nextLocal) return next;
    if (!existingLocal && nextLocal) return existing;
    return next;
  };

  [...activeMemberships, ...recoveredMemberships].forEach((membership) => {
    const normalizedSpaceId = normalizeSpaceId(membership.spaceId);
    const {
      sourceServer: _sourceServer,
      requiresRemoteSpaceVerification: _req,
      deviceLocal: _deviceLocal,
      ...visibleMembership
    } = membership as MembershipWithSource;
    const cleaned: SpaceMemberWithSpaceInfo = {
      ...visibleMembership,
      spaceId: normalizedSpaceId,
    };
    const existing = membershipMap.get(normalizedSpaceId);
    membershipMap.set(
      normalizedSpaceId,
      preferAccountOnCollision(existing, cleaned)
    );
  });

  const finalMemberships = Array.from(membershipMap.values()).sort(
    (a, b) => (b.joinedAt || 0) - (a.joinedAt || 0)
  );
  return finalMemberships;
};
