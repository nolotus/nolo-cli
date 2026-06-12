// 文件路径: database/actions/readAndWait.ts

import type { AppThunkApi } from "../../app/store";
import { buildBuiltinPlatformAgentRecord } from "../../core/builtinAgents";
import { fetchFromClientDb, fetchFromServer } from "./common";
import { readRequestManager } from "./readRequestManager";
import { scheduleExistingRecordReplication } from "./replication";
import { getRuntimeServerContext } from "../runtimeServerContext";
import { isBuiltinPlatformAgentKey, resolveAgentReadServers } from "./agentReadResolution";
import {
  compareRemoteRecordsByComparableTime,
  planAuthorityReadServers,
  pickBestSettledRemoteRecord,
  shouldReplaceLocalWithRemoteRecord,
  shouldReplicateLocalRecord,
} from "./readResolution";
import { resolveRecordAuthority } from "../authority/recordAuthority";

const hashTokenScope = (currentToken?: string | null): string => {
  const token = currentToken || "";
  if (!token) return "anonymous";
  let hash = 0;
  for (let index = 0; index < token.length; index += 1) {
    hash = ((hash << 5) - hash + token.charCodeAt(index)) | 0;
  }
  return `token:${Math.abs(hash).toString(36)}`;
};

const buildReadAndWaitRequestKey = (dbKey: string, currentToken?: string | null): string =>
  `${dbKey}\u0000auth:${hashTokenScope(currentToken)}`;

/**
 * 比较远程数据和本地数据的时间戳，判断远程数据是否更新。
 * @param remoteData - 从服务器获取的数据。
 * @param localData - 从本地数据库获取的数据。
 * @returns 如果远程数据更新，则返回 true。
 */
const isRemoteDataNewer = (remoteData: any, localData: any): boolean => {
  return compareRemoteRecordsByComparableTime(remoteData, localData) > 0;
};

/**
 * 触发一个“即发即忘”的异步任务，将本地数据上传（写入）到服务器。
 * 通常在发现本地存在数据而所有远程服务器上都不存在该数据时调用。
 */
const syncLocalDataToServer = async (
  replicationContext: {
    currentServer: string | undefined;
    syncServers: string[] | undefined;
    state: unknown;
  },
  dbKey: string,
  localData: any
): Promise<void> => {
  try {
    scheduleExistingRecordReplication({
      currentServer: replicationContext.currentServer,
      syncServers: replicationContext.syncServers,
      dbKey,
      localData,
      state: replicationContext.state,
    });
  } catch {
    // 后台同步失败不阻塞主流程，静默处理即可
  }
};

/**
 * 核心处理函数：协调本地和远程数据，决定最终返回哪个版本的数据，并处理同步逻辑。
 */
const processRemoteData = async (
  db: any,
  dbKey: string,
  remotePromises: Promise<any>[],
  localData: any,
  replicationContext: {
    currentServer: string | undefined;
    syncServers: string[] | undefined;
    state: unknown;
  }
): Promise<any> => {
  try {
    // 并行执行所有远程请求，并等待它们全部完成（无论成功或失败）。
    const settledResults = await Promise.allSettled(remotePromises);
    // 从所有结果中，找出最“权威”的远程版本（时间戳最新）。
    const remoteResult = pickBestSettledRemoteRecord({
      settledResults,
      isBetterCandidate: (current, latest) =>
        compareRemoteRecordsByComparableTime(current, latest) > 0,
    });
    const validRemoteData = remoteResult ? remoteResult.data : null;

    // --- 数据决策核心逻辑 ---

    // 场景 1: 至少一个远程服务器返回了有效数据。
    if (
      shouldReplaceLocalWithRemoteRecord({
        localData,
        remoteData: validRemoteData,
        isRemoteNewer: isRemoteDataNewer,
      })
    ) {
      // 如果本地没有数据，或者远程更新更新，则用远程覆盖本地缓存。
      await db.put(dbKey, validRemoteData);
      // 最终决策：返回权威的远程数据。
      return validRemoteData;
    }

    // 场景 2: 所有远程服务器都没有返回有效数据，但我们本地数据库中存在数据。
    if (localData) {
      // 仅当“确实有远程目标”时，才尝试上传本地数据到服务器。
      if (
        shouldReplicateLocalRecord({
          localData,
          remoteData: validRemoteData,
          remoteTargetCount: remotePromises.length,
        })
      ) {
        void syncLocalDataToServer(replicationContext, dbKey, localData);
      }
      // 最终决策：返回本地数据。
      return localData;
    }

    // 场景 3: 远程和本地都找不到任何数据。
    throw new Error("Failed to fetch data from all sources");
  } catch (err) {
    // 如果在上述过程中发生错误，且有本地数据，则优先返回本地数据，避免崩溃。
    if (localData) {
      return localData;
    }
    throw err;
  }
};

/**
 * 主函数：读取数据，并等待远程和本地操作都完成后才返回最合适的数据。
 * - 本地优先：有本地数据时，远程只用于更新缓存或回填云端。
 * - 远程优先：若拿到了有效远程数据，以其为准。
 */
export const readAndWaitAction = async (
  payload:
    | string
    | {
        dbKey: string;
        preferredServerOrigin?: string | null;
      },
  thunkApi: AppThunkApi
): Promise<any> => {
  const dbKey = typeof payload === "string" ? payload : payload.dbKey;
  const preferredServerOrigin =
    typeof payload === "string" ? undefined : payload.preferredServerOrigin;
  const { db } = thunkApi.extra;

  if (!db) {
    throw new Error(
      "Database instance is not available in thunk extra argument."
    );
  }

  const state = thunkApi.getState();
  const {
    currentToken,
    remoteServers: configuredServers,
    currentServer,
    currentUserId,
    syncServers,
    userAuthorityRegistry,
  } = getRuntimeServerContext(state, preferredServerOrigin);
  const allServers = resolveAgentReadServers({ dbKey, configuredServers });
  const isLoggedIn = !!currentToken;

  const executeReadAndWait = async (): Promise<any> => {
    if (isBuiltinPlatformAgentKey(dbKey)) {
      const builtinRecord = buildBuiltinPlatformAgentRecord(dbKey);
      if (builtinRecord) {
        await db.put(dbKey, builtinRecord);
        return { ...builtinRecord, dbKey };
      }
    }

    // 1. 准备所有需要访问的远程服务器（带去重 + 离线检测）
    // 2. 首先，尝试从本地数据库获取数据（可能为 null）
    const localData = await fetchFromClientDb(db, dbKey);
    const authority = resolveRecordAuthority({
      dbKey,
      record: localData,
      currentUserId,
      currentServer,
      userAuthorityRegistry,
    });
    const readServers = planAuthorityReadServers({
      allServers,
      authorityServer: preferredServerOrigin ?? authority.authorityServer,
      serverOrigin: authority.serverOrigin,
    });
    const hasPreferredAuthorityServer =
      !!preferredServerOrigin || !!authority.authorityServer;
    const preferredAuthorityServer = hasPreferredAuthorityServer
      ? readServers[0]
      : null;

    // 如果离线或没有任何可用远程服务器：
    if (readServers.length === 0) {
      if (localData) {
        return { ...localData, dbKey };
      }
      throw new Error(
        `Failed to fetch data for key "${dbKey}" because network is offline and no local data is available.`
      );
    }

    if (preferredAuthorityServer) {
      try {
        const preferredRemoteData = await fetchFromServer(
          preferredAuthorityServer,
          dbKey,
          isLoggedIn ? currentToken : undefined
        );
        if (preferredRemoteData) {
          await db.put(dbKey, preferredRemoteData);
          return { ...preferredRemoteData, dbKey };
        }
      } catch {
        // Fall back to remaining servers below; local data is still handled by processRemoteData.
      }
    }

    // 3. 创建所有到远程服务器的并行请求
    const remainingReadServers = preferredAuthorityServer
      ? readServers.filter((server) => server !== preferredAuthorityServer)
      : readServers;
    const remotePromises = remainingReadServers.map((server) =>
      fetchFromServer(server, dbKey, isLoggedIn ? currentToken : undefined)
    );

    // 4. 将所有信息交给核心处理函数去做最终决策
    const chosenData = await processRemoteData(
      db,
      dbKey,
      remotePromises,
      localData,
      { currentServer, syncServers, state }
    );

    // ⭐ 统一：不论返回的是本地还是远程，最终都附加 dbKey 字段
    return { ...chosenData, dbKey };
  };

  const inFlightKey = buildReadAndWaitRequestKey(dbKey, currentToken);
  const existing = readRequestManager.getInFlight(inFlightKey);
  if (existing) return existing;

  let inFlightPromise: Promise<any>;
  inFlightPromise = executeReadAndWait().finally(() => {
    readRequestManager.clearInFlight(inFlightKey, inFlightPromise);
  });
  readRequestManager.setInFlight(inFlightKey, inFlightPromise);
  return inFlightPromise;
};
