// 文件路径: database/actions/read.ts

import type { AppThunkApi } from "../../app/store";
import { getRuntimeServerContext } from "../runtimeServerContext";
import {
  fetchFromClientDb,
  fetchFromServer,
  isReadTimeoutError,
  logger,
} from "./common";
import { resolveAgentReadServers } from "./agentReadResolution";
import {
  partitionReadServers,
  planAuthorityReadServers,
  pickBestSettledRemoteRecord,
  shouldReplaceLocalWithRemoteRecord,
  shouldReplicateLocalRecord,
} from "./readResolution";
import { readRequestManager } from "./readRequestManager";
import { shouldReplaceWithNextRecord } from "../tombstones";
import { scheduleExistingRecordReplication } from "./replication";
import { resolveRecordAuthority } from "../authority/recordAuthority";

// --- 辅助函数 ---

const updateClientDbIfNewer = async (
  clientDb: any,
  dbKey: string,
  remoteData: any,
  localData: any,
): Promise<void> => {
  if (!clientDb) return;
  try {
    if (isRemoteDataNewer(remoteData, localData)) {
      await clientDb.put(
        dbKey,
        normalizeReadRecord(dbKey, remoteData, { forCache: true }),
      );
    }
  } catch (err) {
    throw err;
  }
};

const normalizeReadRecord = (
  dbKey: string,
  data: any,
  options: { forCache?: boolean } = {},
): any => {
  if (!data || typeof data !== "object") return data;
  const baseRecord = options.forCache ? data : { ...data, dbKey };
  return baseRecord;
};

const isRemoteDataNewer = (remoteData: any, localData: any): boolean => {
  if (!remoteData || typeof remoteData !== "object") return false;
  if (!localData || typeof localData !== "object") return true;
  return shouldReplaceWithNextRecord(remoteData, localData);
};

const syncLocalDataToServer = async (
  replicationContext: {
    currentServer: string | undefined;
    syncServers: string[] | undefined;
    state: unknown;
  },
  dbKey: string,
  localData: any,
): Promise<void> => {
  try {
    scheduleExistingRecordReplication({
      currentServer: replicationContext.currentServer,
      syncServers: replicationContext.syncServers,
      dbKey,
      localData,
      state: replicationContext.state,
    });
  } catch (err) {
    // Error ignored
  }
};

const saveRemoteDataToClientDb = async (
  clientDb: any,
  dbKey: string,
  remoteData: any,
  serverOrigin?: string | null,
): Promise<void> => {
  if (!clientDb) return;
  try {
    const normalizedRemoteData = normalizeReadRecord(dbKey, remoteData, {
      forCache: true,
    });
    await clientDb.put(
      dbKey,
      serverOrigin
        ? {
            ...normalizedRemoteData,
            serverOrigin,
          }
        : normalizedRemoteData,
    );
  } catch (err) {
    // Error ignored
  }
};

const processRemoteDataInBackground = async (
  clientDb: any,
  dbKey: string,
  remotePromises: Promise<any>[],
  remoteServers: string[],
  localData: any,
  replicationContext: {
    currentServer: string | undefined;
    syncServers: string[] | undefined;
    state: unknown;
  },
): Promise<void> => {
  if (!clientDb) return;
  try {
    const settledResults = await Promise.allSettled(remotePromises);
    const remoteResult = pickBestSettledRemoteRecord({
      settledResults,
      isBetterCandidate: (current, latest) =>
        shouldReplaceWithNextRecord(current, latest),
    });
    const validRemoteData = remoteResult ? remoteResult.data : null;
    const serverOrigin =
      remoteResult && remoteServers[remoteResult.index]
        ? remoteServers[remoteResult.index]
        : undefined;

    if (
      shouldReplaceLocalWithRemoteRecord({
        localData,
        remoteData: validRemoteData,
        isRemoteNewer: isRemoteDataNewer,
      })
    ) {
      await updateClientDbIfNewer(
        clientDb,
        dbKey,
        serverOrigin ? { ...validRemoteData, serverOrigin } : validRemoteData,
        localData,
      );
    }
    if (
      shouldReplicateLocalRecord({
        localData,
        remoteData: validRemoteData,
        remoteTargetCount: remotePromises.length,
      })
    ) {
      await syncLocalDataToServer(replicationContext, dbKey, localData);
    }
  } catch (err) {
    // Background sync errors ignored
  }
};

// --- 主函数 ---

export const readAction = async (
  payload: {
    dbKey: string;
    signal?: AbortSignal;
    preferredServerOrigin?: string | null;
  },
  thunkApi: AppThunkApi,
): Promise<any> => {
  const dbKey = payload.dbKey;
  const signal = payload.signal;
  const preferredServerOrigin = payload.preferredServerOrigin;

  if (!dbKey || typeof dbKey !== "string") {
    throw new Error("readAction requires a non-empty dbKey.");
  }

  // 2. 尽早检查中止信号，快速退出
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  const { db: clientDb } = thunkApi.extra;
  if (!clientDb) {
    throw new Error("Client database is not available.");
  }

  const executeRead = async (): Promise<any> => {
    const isDialogKey = dbKey.startsWith("dialog-") && !dbKey.includes("-msg-");
    const readStartedAt = isDialogKey ? Date.now() : 0;
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
    const now = Date.now();
    const localData = await fetchFromClientDb(clientDb, dbKey);
    if (isDialogKey) {
      console.info("[readAction-perf] dialog local-read", {
        dbKey,
        localHit: !!localData,
        localReadMs: Date.now() - readStartedAt,
        serverCount: allServers.length,
      });
    }
    const authority = resolveRecordAuthority({
      dbKey,
      record: localData,
      currentUserId,
      currentServer,
      userAuthorityRegistry,
    });
    const authorityPlannedServers = planAuthorityReadServers({
      allServers,
      authorityServer: preferredServerOrigin ?? authority.authorityServer,
      serverOrigin: authority.serverOrigin,
    });
    const { preferredServer, fallbackServers, orderedServersForLocalHit } =
      partitionReadServers({
        allServers: authorityPlannedServers,
        preferredServerOrigin:
          preferredServerOrigin ?? authority.authorityServer,
      });
    readRequestManager.cleanupMisses(now);
    readRequestManager.cleanupLocalHitRevalidations(now);

    if (localData) {
      readRequestManager.clearMiss(dbKey);
    } else {
      const retryInMs = readRequestManager.getRetryInMs(dbKey, now);
      if (typeof retryInMs === "number" && retryInMs > 0) {
        logger.debug(
          { dbKey, retryInMs },
          "[readAction] Suppressing repeated miss read",
        );
        throw new Error(
          `Read temporarily suppressed for missing key "${dbKey}".`,
        );
      }
    }

    // 离线 / 无可用远程服务器：只看本地
    if (authorityPlannedServers.length === 0) {
      if (localData) {
        if (isDialogKey) {
          console.info("[readAction-perf] dialog offline-local-hit", {
            dbKey,
            totalMs: Date.now() - readStartedAt,
          });
        }
        return normalizeReadRecord(dbKey, localData);
      }
      readRequestManager.markMiss(dbKey, now);
      throw new Error(
        `Failed to fetch data for key "${dbKey}" because network is offline and no local data is available.`,
      );
    }

    if (localData) {
      // Local-first: return durable local data immediately and only revalidate
      // against remote servers in the background. This avoids turning a
      // preferred-server timeout into a visible read failure for data we
      // already have locally (for example createDialog -> initDialog).
      const retryInMs = signal?.aborted
        ? undefined
        : readRequestManager.getLocalHitRevalidateInMs(dbKey, now);
      if (!signal?.aborted) {
        if (retryInMs === null) {
          readRequestManager.markLocalHitRevalidated(dbKey, now);
          const remotePromises = orderedServersForLocalHit.map((server) =>
            fetchFromServer(
              server,
              dbKey,
              isLoggedIn ? currentToken : undefined,
              signal,
            ),
          );
          void processRemoteDataInBackground(
            clientDb,
            dbKey,
            remotePromises,
            orderedServersForLocalHit,
            localData,
            { currentServer, syncServers, state },
          );
        } else {
          logger.debug(
            { dbKey, retryInMs },
            "[readAction] Skipping frequent local-hit revalidation",
          );
        }
      }
      if (isDialogKey) {
        console.info("[readAction-perf] dialog local-hit-return", {
          dbKey,
          totalMs: Date.now() - readStartedAt,
          revalidating: retryInMs === null,
        });
      }
      return normalizeReadRecord(dbKey, localData);
    }

    if (preferredServer) {
      try {
        const preferredRemoteData = await fetchFromServer(
          preferredServer,
          dbKey,
          isLoggedIn ? currentToken : undefined,
          signal,
        );

        if (preferredRemoteData) {
          await saveRemoteDataToClientDb(
            clientDb,
            dbKey,
            preferredRemoteData,
            preferredServer,
          );
          readRequestManager.clearMiss(dbKey);
          if (isDialogKey) {
            console.info("[readAction-perf] dialog preferred-remote-hit", {
              dbKey,
              totalMs: Date.now() - readStartedAt,
              server: preferredServer,
            });
          }
          return normalizeReadRecord(dbKey, {
            ...preferredRemoteData,
            serverOrigin: preferredServer,
          });
        }
      } catch (error) {
        if (
          signal?.aborted ||
          (error as { name?: string } | null)?.name === "AbortError"
        ) {
          throw error;
        }
        if (isReadTimeoutError(error)) {
          logger.warn(
            { dbKey, preferredServer, error: String((error as Error).message) },
            "[readAction] Preferred server timed out; falling back to remaining servers",
          );
        } else {
          logger.warn(
            { dbKey, preferredServer, error: String(error) },
            "[readAction] Preferred server read failed; falling back to remaining servers",
          );
        }
      }
    }

    // 3. 将 signal 传递给所有网络请求
    const remotePromises = fallbackServers.map((server) =>
      fetchFromServer(
        server,
        dbKey,
        isLoggedIn ? currentToken : undefined,
        signal,
      ),
    );

    // 如果本地没有数据，则等待网络请求结果
    const settledResults = await Promise.allSettled(remotePromises);

    // 4. 在处理网络结果前，再次检查中止信号
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const remoteResult = pickBestSettledRemoteRecord({
      settledResults,
      isBetterCandidate: (current, latest) =>
        shouldReplaceWithNextRecord(current, latest),
    });
    if (remoteResult) {
      const { data: validRemoteData } = remoteResult;
      const serverOrigin = fallbackServers[remoteResult.index];
      if (!signal?.aborted) {
        await saveRemoteDataToClientDb(
          clientDb,
          dbKey,
          validRemoteData,
          serverOrigin,
        );
      }
      readRequestManager.clearMiss(dbKey);
      const remoteData = serverOrigin
        ? { ...validRemoteData, dbKey, serverOrigin }
        : { ...validRemoteData, dbKey };
      return normalizeReadRecord(dbKey, remoteData);
    }

    readRequestManager.markMiss(dbKey, Date.now());
    throw new Error(
      `Failed to fetch data for key "${dbKey}" from all sources.`,
    );
  };

  const canDedup = !signal;
  if (canDedup) {
    const existing = readRequestManager.getInFlight(dbKey);
    if (existing) return existing;

    let inFlightPromise: Promise<any>;
    inFlightPromise = executeRead().finally(() => {
      readRequestManager.clearInFlight(dbKey, inFlightPromise);
    });
    readRequestManager.setInFlight(dbKey, inFlightPromise);
    return inFlightPromise;
  }

  return executeRead();
};
