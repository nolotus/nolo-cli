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
import { isTombstoneRecord } from "../../../database/tombstones";

type MembershipWithSource = SpaceMemberWithSpaceInfo & {
  sourceServer?: string;
  requiresRemoteSpaceVerification?: boolean;
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

const buildLocalMembershipPreview = async (
  userId: string,
  db: any,
  memberships: SpaceMemberWithSpaceInfo[]
): Promise<SpaceMemberWithSpaceInfo[]> => {
  const preview = await Promise.all(
    memberships.map(async (membership) => {
      if (isTombstoneRecord(membership)) return null;
      if (!membershipBelongsToUser(membership, userId)) return null;

      const normalizedSpaceId = normalizeSpaceId(membership.spaceId);
      const localSpaceData = await readLocalSpaceData(db, normalizedSpaceId);
      if (localSpaceData && isTombstoneRecord(localSpaceData)) return null;
      if (localSpaceData && !spaceListsUser(localSpaceData, userId)) return null;

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
 * 从本地 IndexedDB 获取数据
 */
const fetchLocal = async (
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

    if (iterator && typeof iterator.then === 'function') {
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
 */
export const fetchUserSpaceMembershipsAction = async (
  userId: string,
  thunkAPI: AppThunkApi
): Promise<SpaceMemberWithSpaceInfo[]> => {
  const state = thunkAPI.getState();
  const db = thunkAPI.extra.db;
  const { token, servers } = selectSpaceRemoteAuth(state);

  const localMembershipsPromise = fetchLocal(userId, db);
  const remoteResultsPromise = Promise.all(
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
  const hasRemoteAuthority = !!token && servers.length > 0;

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
    if (!membershipBelongsToUser(membership, userId)) return null;

    const normalizedSpaceId = normalizeSpaceId(membership.spaceId);
    const localSpaceData = await readLocalSpaceData(db, normalizedSpaceId);
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
        const { requiresRemoteSpaceVerification, ...verifiedMembership } = membership;
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
  const recoveredMemberships =
    hasRemoteAuthority && hasSuccessfulRemoteFetch
      ? await recoverMembershipsFromContentSpaces({
        servers,
        token,
        userId,
        knownSpaceIds,
      })
      : [];

  const membershipMap = new Map<string, SpaceMemberWithSpaceInfo>();
  [...activeMemberships, ...recoveredMemberships].forEach((membership) => {
    const normalizedSpaceId = normalizeSpaceId(membership.spaceId);
    const { sourceServer, ...visibleMembership } = membership as MembershipWithSource;
    membershipMap.set(normalizedSpaceId, {
      ...visibleMembership,
      spaceId: normalizedSpaceId,
    });
  });

  const finalMemberships = Array.from(membershipMap.values()).sort(
    (a, b) => (b.joinedAt || 0) - (a.joinedAt || 0)
  );
  return finalMemberships;
};
