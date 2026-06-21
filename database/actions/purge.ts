// 文件路径: database/actions/purge.ts

import type { AppThunkApi } from "../../app/store";
import { getRuntimeServerContext } from "../runtimeServerContext";
import { isTombstoneRecord } from "../tombstones";
import {
  noloDeleteRequest,
} from "../requests";
import { resolveAuthorityReplicationServers } from "./replication";
import { fetchFromClientDb } from "./common";

/**
 * purgeAction: 从回收站永久删除一条记录。
 * - 仅对 tombstone（deletedAt 已存在）生效；活记录请走 removeAction。
 * - 先删本地 IndexedDB 记录（绕过 tombstone 写回），再通知所有同步服务器物理删除。
 * - 远端 delete 路由已经支持 ?force=true，会跳过 tombstone 短路并物理 del。
 */
export const purgeAction = async (
  payload: string | { dbKey: string; preferredServerOrigin?: string | null },
  thunkApi: AppThunkApi
): Promise<{ dbKey: string; servers: string[] }> => {
  const { db: clientDb } = thunkApi.extra;
  const dbKey = typeof payload === "string" ? payload : payload.dbKey;
  const preferredServerOrigin =
    typeof payload === "string" ? undefined : payload.preferredServerOrigin;

  if (!clientDb) {
    throw new Error("Client database is undefined in purgeAction");
  }

  const state = thunkApi.getState();
  const { currentServer, syncServers } = getRuntimeServerContext(state);

  // 1. 防御：仅 tombstone 可被 purge，活记录不要走这里。
  const localData = await fetchFromClientDb(clientDb, dbKey);
  if (localData && !isTombstoneRecord(localData)) {
    throw new Error(
      `purgeAction refused: record ${dbKey} is not tombstoned. Use removeAction instead.`
    );
  }

  // 2. 物理删除本地记录（不再写 tombstone）。
  await clientDb.del(dbKey);

  // 3. 通知所有相关服务器物理删除该记录。
  const servers = resolveAuthorityReplicationServers({
    currentServer,
    syncServers,
    preferredServerOrigin,
    dbKey,
    state,
  });

  await Promise.all(
    servers.map(async (server) => {
      const ok = await noloDeleteRequest(
        server,
        dbKey,
        { type: "single", force: true },
        state
      );
      if (!ok) {
        console.warn("[purgeAction] server force-delete failed", { dbKey, server });
      }
    })
  );

  return { dbKey, servers };
};