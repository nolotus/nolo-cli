// 文件路径: render/table/deleteTableAction.ts

import type { RootState, AppDispatch } from "../../app/store";
import { getRuntimeServerContext } from "../../database/runtimeServerContext";
import { SEPARATOR, createKey } from "../../database/keys";
import { scheduleDeleteReplication } from "../../database/actions/replication";
import { buildTombstoneRecord } from "../../database/tombstones";

export interface DeleteTableArgs {
  dbKey: string; // 形如：meta-{tenantId}-{tableId}
}

/**
 * 从表的 meta dbKey 中解析 tenantId / tableId
 * 约定：meta-{tenantId}-{tableId}
 */
const parseMetaKey = (dbKey: string): { tenantId: string; tableId: string } => {
  const parts = dbKey.split(SEPARATOR);
  if (parts[0] !== "meta" || parts.length < 3) {
    throw new Error(`非法表 key：${dbKey}`);
  }
  const tenantId = parts[1];
  const tableId = parts.slice(2).join(SEPARATOR);
  return { tenantId, tableId };
};

const collectEntriesByPrefix = async (
  db: any,
  prefix: string
): Promise<Array<[string, unknown]>> => {
  const entries: Array<[string, unknown]> = [];

  for await (const [key, value] of db.iterator({
    gte: prefix,
    lte: prefix + "\uffff",
  })) {
    entries.push([key as string, value]);
  }

  return entries;
};

const belongsToTable = (
  value: unknown,
  tenantId: string,
  tableId: string
): value is Record<string, any> =>
  Boolean(
    value &&
      typeof value === "object" &&
      (value as any).tenantId === tenantId &&
      (value as any).tableId === tableId
  );

const indexValueReferencesRows = (
  value: unknown,
  rowDbKeys: Set<string>,
  rowIds: Set<string>
): boolean => {
  if (typeof value === "string") {
    return rowDbKeys.has(value) || rowIds.has(value);
  }
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, any>;
  return (
    (typeof candidate.dbKey === "string" && rowDbKeys.has(candidate.dbKey)) ||
    (typeof candidate.rowDbKey === "string" &&
      rowDbKeys.has(candidate.rowDbKey)) ||
    (typeof candidate.rowId === "string" && rowIds.has(candidate.rowId))
  );
};

/**
 * 删除整张表（本地 + 同步服务器）：
 *
 * 本地：
 *   1) 从 meta dbKey 中解析 tenantId / tableId
 *   2) 给该表的所有行写 tombstone：row-{tenantId}-{tableId}-{rowId}
 *   3) 删除该表的所有索引：idx-{tenantId}-{tableId}-...
 *   4) 删除该表的所有视图：view-{tenantId}-{tableId}-{viewId}
 *   6) 给表本身的 meta 写 tombstone：meta-{tenantId}-{tableId}
 *
 * 远端：
 *   - 使用 syncWithServers + noloDeleteRequest，
 *     调用后端统一 DELETE 接口：
 *       DELETE /db/{metaDbKey}?type=table
 *
 * 说明：
 *   - 当前实现假定：一张逻辑表严格属于单个 tenant：
 *       对于任意 meta-{tenantId}-{tableId}，
 *       所有行满足 row.tenantId === tenantId 且 row.tableId === tableId。
 *   - 不做历史兼容处理，如有旧数据可通过清库 / 迁移脚本处理。
 */
export const deleteTableAction = async (
  { dbKey }: DeleteTableArgs,
  {
    dispatch,
    getState,
    extra,
  }: {
    dispatch: AppDispatch;
    getState: () => RootState;
    extra: { db: any };
  }
): Promise<string> => {
  const { db } = extra;
  const state = getState();
  const { currentServer, syncServers } = getRuntimeServerContext(state);

  const { tenantId, tableId } = parseMetaKey(dbKey);

  const nowIso = new Date().toISOString();

  // 1) 本地收集所有行：row-{tenantId}-{tableId}-{rowId}
  const rowPrefix = createKey("row", tenantId, tableId, "");
  const rowEntries = (await collectEntriesByPrefix(db, rowPrefix)).filter(
    ([, value]) => belongsToTable(value, tenantId, tableId)
  );
  const rowDbKeys = new Set(rowEntries.map(([key]) => key));
  const rowIds = new Set(
    rowEntries
      .map(([, value]) => (value as any).rowId)
      .filter((rowId): rowId is string => typeof rowId === "string")
  );

  // 2) 本地收集所有索引 key：idx-{tenantId}-{tableId}-...
  const idxPrefix = createKey("idx", tenantId, tableId, "");
  const idxEntries = await collectEntriesByPrefix(db, idxPrefix);
  const idxKeys = idxEntries
    .filter(([, value]) =>
      belongsToTable(value, tenantId, tableId) ||
      indexValueReferencesRows(value, rowDbKeys, rowIds)
    )
    .map(([key]) => key);

  // 3) 本地收集所有视图 key：view-{tenantId}-{tableId}-{viewId}
  const viewPrefix = createKey("view", tenantId, tableId, "");
  const viewEntries = await collectEntriesByPrefix(db, viewPrefix);
  const viewKeys = viewEntries
    .filter(([, value]) => belongsToTable(value, tenantId, tableId))
    .map(([key]) => key);


  const metaRecord =
    typeof db.get === "function" ? await db.get(dbKey).catch(() => null) : null;

  // 5) 需要物理删除的 key：索引 + 视图；meta/row 写 tombstone 参与多服务器合并。
  const keysToDelete = Array.from(
    new Set<string>([
      ...idxKeys,
      ...viewKeys,
    ])
  );

  const putOps = [
    ...(metaRecord && typeof metaRecord === "object"
      ? [
          {
            type: "put" as const,
            key: dbKey,
            value: buildTombstoneRecord(metaRecord, nowIso),
          },
        ]
      : []),
    ...rowEntries.map(([key, value]) => ({
      type: "put" as const,
      key,
      value: buildTombstoneRecord(value as Record<string, unknown>, nowIso),
    })),
  ];

  if (keysToDelete.length > 0 || putOps.length > 0) {
    const ops = [
      ...putOps,
      ...keysToDelete.map((key) => ({
        type: "del" as const,
        key,
      })),
    ];
    await db.batch(ops);
  }

  // 6) local-first：本地先删除，远端整表删除在后台收敛。
  scheduleDeleteReplication({
    currentServer,
    syncServers,
    dbKey,
    deleteOptions: { type: "table" as const },
    state,
  });

  return dbKey;
};
