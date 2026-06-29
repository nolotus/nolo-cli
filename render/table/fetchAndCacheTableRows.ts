import { DataType } from "../../create/types";
import { rowKey } from "../../database/keys";

const getRowTimestamp = (row: any): number => {
  if (!row || typeof row !== "object") return 0;
  const updatedAt = Date.parse(row.updatedAt ?? "");
  if (Number.isFinite(updatedAt) && updatedAt > 0) return updatedAt;
  const createdAt = Date.parse(row.createdAt ?? "");
  return Number.isFinite(createdAt) && createdAt > 0 ? createdAt : 0;
};

const shouldReplaceMergedRow = (nextRow: any, currentRow: any): boolean => {
  const nextTs = getRowTimestamp(nextRow);
  const currentTs = getRowTimestamp(currentRow);
  if (nextTs !== currentTs) return nextTs > currentTs;
  return Boolean(nextRow?.deletedAt) && !currentRow?.deletedAt;
};

const mergeTableRows = (...rowLists: any[][]): any[] => {
  const merged = new Map<string, any>();

  for (const rowList of rowLists) {
    for (const row of rowList) {
      const dbKey = row?.dbKey;
      if (!dbKey) continue;
      const existing = merged.get(dbKey);
      if (!existing || shouldReplaceMergedRow(row, existing)) {
        merged.set(dbKey, row);
      }
    }
  }

  return Array.from(merged.values());
};

const TABLE_SYNC_ENVELOPE = "table-sync-v1";

interface TableRowsSnapshot {
  rows: any[];
  deletedRows: any[];
  tableMeta: any | null;
  complete: boolean;
}

const getLatestTableMeta = (snapshots: TableRowsSnapshot[]): any | null => {
  let latestMeta: any | null = null;
  for (const snapshot of snapshots) {
    const tableMeta = snapshot.tableMeta;
    if (!tableMeta || typeof tableMeta !== "object") continue;
    if (!latestMeta || shouldReplaceMergedRow(tableMeta, latestMeta)) {
      latestMeta = tableMeta;
    }
  }
  return latestMeta;
};

const loadLocalTableRows = async (
  db: any,
  tenantId: string,
  tableId: string
): Promise<any[]> => {
  if (!db || typeof db.iterator !== "function") {
    return [];
  }

  const rows: any[] = [];
  const { gte, lte } = rowKey.range(tenantId, tableId);

  try {
    for await (const [, value] of db.iterator({ gte, lte })) {
      if (value?.type === DataType.TABLE_ROW) {
        rows.push(value);
      }
    }
  } catch {
    return [];
  }

  return rows;
};

const fetchTableRowsFromServer = async (
  server: string,
  tenantId: string,
  tableId: string,
  headers: Record<string, string>
): Promise<TableRowsSnapshot> => {
  const res = await fetch(`${server}/rpc/listTableRows`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      tenantId,
      tableId,
      includeDeleted: true,
      envelope: TABLE_SYNC_ENVELOPE,
    }),
  });

  if (!res.ok) {
    let msg = `加载表 ${tableId} 行失败（${res.status}）`;
    try {
      const err = await res.json();
      if (err && typeof err.message === "string") {
        msg = err.message;
      }
    } catch {
      // ignore
    }
    throw new Error(msg);
  }

  const data = await res.json();
  if (Array.isArray(data)) {
    return {
      rows: data,
      deletedRows: [],
      tableMeta: null,
      complete: false,
    };
  }
  if (!data || typeof data !== "object" || !Array.isArray(data.rows)) {
    throw new Error("服务器返回格式错误：预期为数组");
  }
  return {
    rows: data.rows,
    deletedRows: Array.isArray(data.deletedRows) ? data.deletedRows : [],
    tableMeta: data.tableMeta ?? null,
    complete: data.complete === true,
  };
};

export const cacheMergedTableRows = async (db: any, mergedRows: any[]) => {
  if (!db) return;

  await Promise.all(
    mergedRows.map(async (mergedRow: any) => {
      if (!mergedRow?.dbKey) return;
      try {
        const localRow = await db.get(mergedRow.dbKey).catch(() => null);
        if (!localRow) {
          await db.put(mergedRow.dbKey, mergedRow);
          return;
        }

        const serverTs = new Date(
          mergedRow.updatedAt ?? mergedRow.createdAt ?? 0
        ).getTime();
        const localTs = new Date(
          localRow.updatedAt ?? localRow.createdAt ?? 0
        ).getTime();
        const shouldOverwrite =
          serverTs > localTs ||
          (serverTs === localTs &&
            Boolean(mergedRow.deletedAt) &&
            !Boolean(localRow.deletedAt));

        if (shouldOverwrite) {
          await db.put(mergedRow.dbKey, mergedRow);
        }
      } catch {
        // Ignore local cache errors.
      }
    })
  );
};

const clearStaleLocalRows = async (
  db: any,
  localRows: any[],
  authoritativeRows: any[]
) => {
  if (!db || typeof db.del !== "function") return;

  const authoritativeKeys = new Set(
    authoritativeRows
      .map((row) => row?.dbKey)
      .filter((dbKey): dbKey is string => typeof dbKey === "string" && dbKey.length > 0)
  );

  await Promise.all(
    localRows.map(async (row) => {
      const dbKey = row?.dbKey;
      if (typeof dbKey !== "string" || authoritativeKeys.has(dbKey)) return;
      try {
        await db.del(dbKey);
      } catch {
        // Ignore local cache cleanup errors.
      }
    })
  );
};

const keepRemoteRowForPartialMerge = (
  row: any,
  localRowsByKey: Map<string, any>
): boolean => {
  const dbKey = row?.dbKey;
  if (typeof dbKey !== "string" || !dbKey) return false;
  const localRow = localRowsByKey.get(dbKey);
  if (!localRow) return true;

  const remoteDeleted = Boolean(row?.deletedAt);
  const localDeleted = Boolean(localRow?.deletedAt);
  return remoteDeleted === localDeleted;
};

export const fetchAndCacheTableRows = async ({
  db,
  tenantId,
  tableId,
  token,
  remoteServers = [],
}: {
  db: any;
  tenantId: string;
  tableId: string;
  token?: string | null;
  remoteServers?: string[];
}): Promise<any[]> => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const localRows = await loadLocalTableRows(db, tenantId, tableId);
  const remoteResults = await Promise.allSettled(
    remoteServers.map((server) =>
      fetchTableRowsFromServer(server, tenantId, tableId, headers)
    )
  );

  const fulfilledRemoteSnapshots = remoteResults
    .filter(
      (result): result is PromiseFulfilledResult<TableRowsSnapshot> =>
        result.status === "fulfilled"
    )
    .map((result) => result.value);

  if (fulfilledRemoteSnapshots.length === 0 && localRows.length === 0) {
    const firstFailure = remoteResults.find(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected"
    );
    throw new Error(firstFailure?.reason?.message || "加载表行失败");
  }

  const allRemoteSnapshotsComplete =
    remoteServers.length > 0 &&
    remoteResults.length === remoteServers.length &&
    fulfilledRemoteSnapshots.length === remoteServers.length &&
    fulfilledRemoteSnapshots.every((snapshot) => snapshot.complete);
  const localRowsByKey = new Map(
    localRows
      .filter((row) => typeof row?.dbKey === "string" && row.dbKey.length > 0)
      .map((row) => [row.dbKey, row])
  );
  const remoteRowLists = fulfilledRemoteSnapshots.map((snapshot) => {
    const snapshotRows = [...snapshot.rows, ...snapshot.deletedRows];
    return allRemoteSnapshotsComplete
      ? snapshotRows
      : snapshotRows.filter((row) => keepRemoteRowForPartialMerge(row, localRowsByKey));
  });
  const authoritativeRemoteRows = remoteRowLists.flat();
  const tableDeleted =
    allRemoteSnapshotsComplete &&
    Boolean(getLatestTableMeta(fulfilledRemoteSnapshots)?.deletedAt);

  if (allRemoteSnapshotsComplete) {
    await clearStaleLocalRows(db, localRows, authoritativeRemoteRows);
  }

  const localRowsForMerge = allRemoteSnapshotsComplete
    ? localRows.filter((row) =>
        authoritativeRemoteRows.some((remoteRow) => remoteRow?.dbKey === row?.dbKey)
      )
    : localRows;
  const mergedRows = mergeTableRows(localRowsForMerge, ...remoteRowLists);
  await cacheMergedTableRows(db, mergedRows);

  return tableDeleted ? [] : mergedRows.filter((row) => !row?.deletedAt);
};
