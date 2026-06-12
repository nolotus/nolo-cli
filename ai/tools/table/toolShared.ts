import type { RootState } from "../../../app/store";
import { readAndWait, patch, write } from "../../../database/dbSlice";
import { metaKey, rowKey } from "../../../database/keys";
import { DataType } from "../../../create/types";
import { loadTableRows } from "../../../render/table/tableSlice";
import type { TableMeta } from "../../../render/table/types";

export const resolveTableIdentity = (
  args: { tenantId?: string; tableId?: string },
  state: RootState
) => {
  const currentTable = state.table.currentTable;
  const tenantId = args.tenantId ?? currentTable?.tenantId;
  const tableId = args.tableId ?? currentTable?.tableId;
  return { tenantId, tableId, currentTable };
};

export async function loadTableMetaOrThrow(
  thunkApi: any,
  tenantId: string,
  tableId: string
): Promise<TableMeta> {
  const result = await thunkApi.dispatch(readAndWait(metaKey(tenantId, tableId)));
  if (!readAndWait.fulfilled.match(result) || !result.payload) {
    const message =
      (result.payload as any)?.message ||
      result.error?.message ||
      `找不到表 ${tableId} 的定义。`;
    throw new Error(message);
  }
  return result.payload as TableMeta;
}

export async function ensureRowsLoaded(
  thunkApi: any,
  tenantId: string,
  tableId: string
): Promise<any[]> {
  const result = await thunkApi.dispatch(loadTableRows({ tenantId, tableId }));
  if (!loadTableRows.fulfilled.match(result)) {
    const message =
      (result.payload as any) ||
      result.error?.message ||
      "加载表行失败";
    throw new Error(message);
  }

  const state = thunkApi.getState() as RootState;
  return state.table.rows.filter(
    (row: any) => row?.tenantId === tenantId && row?.tableId === tableId && !row?.deletedAt
  );
}

export async function resolveRowOrThrow(
  thunkApi: any,
  args: { tenantId: string; tableId: string; rowId?: string; dbKey?: string }
) {
  const { tenantId, tableId, rowId, dbKey } = args;

  if (!rowId && !dbKey) {
    throw new Error("需要提供 rowId 或 dbKey 才能定位表行。");
  }

  const finalDbKey = dbKey || rowKey.single(tenantId, tableId, String(rowId));
  const readResult = await thunkApi.dispatch(readAndWait(finalDbKey));
  if (readAndWait.fulfilled.match(readResult) && readResult.payload && !readResult.payload.deletedAt) {
    return readResult.payload;
  }

  const rows = await ensureRowsLoaded(thunkApi, tenantId, tableId);
  const found = rows.find((row) => row?.dbKey === finalDbKey || row?.rowId === rowId);
  if (!found) {
    throw new Error(`找不到要操作的行：${rowId || finalDbKey}`);
  }
  return found;
}

export async function writeRow(thunkApi: any, row: any) {
  const result = await thunkApi.dispatch(
    write({
      data: row,
      customKey: row.dbKey,
    })
  );
  if (!write.fulfilled.match(result)) {
    const message =
      (result.payload as any)?.message ||
      result.error?.message ||
      "写入表行失败";
    throw new Error(message);
  }
  return result.payload;
}

export async function patchRecord(thunkApi: any, dbKey: string, changes: Record<string, any>) {
  const result = await thunkApi.dispatch(
    patch({
      dbKey,
      changes,
    })
  );
  if (!patch.fulfilled.match(result)) {
    const message =
      (result.payload as any)?.message ||
      result.error?.message ||
      `更新记录失败：${dbKey}`;
    throw new Error(message);
  }
  return result.payload;
}

export function buildNewRow(
  tenantId: string,
  tableId: string,
  values: Record<string, any>
) {
  const { dbKey, rowId } = rowKey.create(tenantId, tableId);
  const now = new Date().toISOString();
  return {
    dbKey,
    tenantId,
    tableId,
    rowId,
    createdAt: now,
    updatedAt: now,
    type: DataType.TABLE_ROW as const,
    ...values,
  };
}
