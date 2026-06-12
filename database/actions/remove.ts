// 文件路径: src/database/actions/delete.ts

import type { AppThunkApi } from "../../app/store";
import { getRuntimeServerContext } from "../runtimeServerContext";

import { fetchFromClientDb } from "./common";
import { deleteFileFromIndexedDb } from "../fileStorage";
import {
  scheduleDeleteReplication,
} from "./replication";
import { buildTombstoneRecord } from "../tombstones";

/**
 * removeAction:
 * 1. 先删除本地 IndexedDB 中的记录（如果存在）
 * 2. 再异步并行通知所有远程服务器删除该记录
 *
 * - 服务器列表来源：
 *   - 当前服务器：settings.currentServer
 *   - 备份服务器：settings.syncServers
 *   - getAllServers 负责去重 + 离线检测（offline 时返回 []）
 */
export const removeAction = async (
  payload: string | { dbKey: string; preferredServerOrigin?: string | null },
  thunkApi: AppThunkApi
): Promise<{ dbKey: string }> => {
  const { db: clientDb } = thunkApi.extra;
  const dbKey = typeof payload === "string" ? payload : payload.dbKey;
  const preferredServerOrigin =
    typeof payload === "string" ? undefined : payload.preferredServerOrigin;

  if (!clientDb) {
    throw new Error("Client database is undefined in removeAction");
  }

  const state = thunkApi.getState();
  const { currentServer, syncServers } = getRuntimeServerContext(state);

  console.log("[removeAction] START", {
    dbKey,
    preferredServerOrigin,
    currentServer,
    syncServers,
    hasToken: Boolean(state?.auth?.currentToken),
  });

  // 1) 先查本地是否有这条数据
  const localData = await fetchFromClientDb(clientDb, dbKey);
  const hadLocalData = Boolean(localData);

  // 2) local mutation 只依赖本地真相；远端删除由 replication helper 负责后台收敛。
  console.log("[removeAction] replication inputs", {
    currentServer,
    syncServers,
    preferredServerOrigin,
    hadLocalData,
  });

  // 3) 如果本地存在，则先写 tombstone 到本地。
  // Recent / My Content 是多源 merge，直接物理删除本地会丢失“删除胜出”证据，
  // 老版本远端返回的活记录会在下一轮 merge 时再次回流。
  const nowIso = new Date().toISOString();
  if (localData) {
    if (localData.id && typeof localData.id === "string") {
      void deleteFileFromIndexedDb(localData.id).catch((err) => {
        console.warn("[removeAction] Failed to delete associated file:", localData.id, err);
      });
    }
    await clientDb.put(dbKey, buildTombstoneRecord(localData, nowIso));
  } else {
    // 本地无数据（仅存于远端），写最小 tombstone 防止远端记录在 merge 时回流
    await clientDb.put(dbKey, buildTombstoneRecord({ dbKey }, nowIso));
  }

  // 4) local-first 产品语义：本地 tombstone 立即成功，远端删除异步收敛。
  // 这样离线/弱网时删除也能成立，UI 可立刻移除内容；远端复制后续自行收敛。
  scheduleDeleteReplication({
    currentServer,
    syncServers,
    preferredServerOrigin,
    dbKey,
    state,
    onResult: (result) => {
      if (result.failed.length > 0) {
        console.warn("[removeAction] Server delete failures after local tombstone:", result.failed);
      }
    },
    onError: (err) => {
      console.warn("[removeAction] Background server delete error:", err);
    },
  });

  return { dbKey };
};
