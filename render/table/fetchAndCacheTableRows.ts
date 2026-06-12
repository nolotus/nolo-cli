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
): Promise<any[]> => {
  const res = await fetch(`${server}/rpc/listTableRows`, {
    method: "POST",
    headers,
    body: JSON.stringify({ tenantId, tableId }),
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
  if (!Array.isArray(data)) {
    throw new Error("服务器返回格式错误：预期为数组");
  }
  return data;
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

  const fulfilledRemoteRows = remoteResults
    .filter(
      (result): result is PromiseFulfilledResult<any[]> =>
        result.status === "fulfilled"
    )
    .map((result) => result.value);

  if (fulfilledRemoteRows.length === 0 && localRows.length === 0) {
    const firstFailure = remoteResults.find(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected"
    );
    throw new Error(firstFailure?.reason?.message || "加载表行失败");
  }

  const mergedRows = mergeTableRows(localRows, ...fulfilledRemoteRows);
  await cacheMergedTableRows(db, mergedRows);

  return mergedRows.filter((row) => !row?.deletedAt);
};
