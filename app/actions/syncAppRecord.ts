// 文件路径: app/actions/syncAppRecord.ts
//
// 将 app record 同步到客户端本地 DB + 所有 syncServers。
// 适用场景：
//   - 应用部署成功后（currentServer 已写入，syncServers 还没有）
//   - 应用可见性/元数据更新后
//
// 不写 currentServer（它在 deploy/update 时已由服务端直接写入）。

import type { AppDispatch, RootState } from "../store";
import {
  selectCurrentServer,
  selectSyncServers,
} from "../settings/settingSlice";
import { DataType } from "../../create/types";
import { noloWriteRequest } from "../../database/requests";

interface SyncAppRecordOptions {
  includeCurrentServer?: boolean;
}

export const syncAppRecord =
  (
    appKey: string,
    appRecord: Record<string, any>,
    options: SyncAppRecordOptions = {}
  ) =>
  async (_dispatch: AppDispatch, getState: () => RootState, extra: any): Promise<void> => {
    if (!appKey || !appRecord) return;

    const state = getState();
    const currentServer = selectCurrentServer(state);
    const syncServers = selectSyncServers(state) ?? [];
    const { db: clientDb } = extra ?? {};

    // This path is intentionally still keyed off deployment settings instead of
    // the shared runtime helpers. App records are mixed local/remote state:
    // local cache for local-first reads, plus explicit fan-out to deploy peers.
    // Keep this separate from generic content CRUD until app local-dev/deploy
    // ownership is redesigned in the later app phase.

    const normalizedRecord = {
      ...appRecord,
      dbKey: appKey,
      type: DataType.APP,
    };

    // 1. 写本地 DB（供离线读 / local-first 查询）
    if (clientDb) {
      await clientDb.put(appKey, normalizedRecord).catch((err: unknown) => {
        console.warn("[syncAppRecord] local DB write failed:", appKey, err);
      });
    }

    // 2. 推送到目标服务器。
    // 默认跳过 currentServer（deploy/update 主写路径已在当前 server 完成），
    // 但在“远端回读后本地收敛”场景下可以显式要求把 currentServer 也补齐。
    const rawServers = options.includeCurrentServer
      ? [currentServer, ...syncServers]
      : syncServers.filter((s) => s !== currentServer);
    const serversToSync = [...new Set(rawServers.filter((s): s is string => !!s))];
    if (serversToSync.length === 0) return;

    await Promise.allSettled(
      serversToSync.map((server) =>
        noloWriteRequest(
          server,
          { data: normalizedRecord, customKey: appKey, userId: normalizedRecord.userId },
          state
        )
      )
    );
  };
