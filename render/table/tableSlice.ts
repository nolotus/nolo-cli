// 文件: render/table/tableSlice.ts

import { formatISO } from "date-fns";
import {
  asyncThunkCreator,
  buildCreateSlice,
  PayloadAction,
  createSelector,
} from "@reduxjs/toolkit";
import { ulid } from "ulid";
import { getRuntimeServerContext } from "../../database/runtimeServerContext";

import {
  write,
  readAndWait,
  patch,
  selectAll as selectAllDb,
  upsertSSREntity,
} from "../../database/dbSlice";
import { metaKey, rowKey } from "../../database/keys";
import { DataType } from "../../create/types";
import { resolveReplicationServers, scheduleWriteReplication } from "../../database/actions/replication";
import { fetchAndCacheTableRows } from "./fetchAndCacheTableRows";

import type { CreateTableArgs } from "./createTableAction";
import { createTableAction } from "./createTableAction";
import { deleteTableAction, type DeleteTableArgs } from "./deleteTableAction";
import type { TableMeta, TableColumn } from "./types";
import type { ContentIcon } from "../contentIcon/types";

/* --------------------------------------------------------------------------
 * Slice 状态
 * ------------------------------------------------------------------------*/

export interface TableSliceState {
  currentTable: TableMeta | null;
  isLoading: boolean;
  isInitialized: boolean;
  error: string | null;

  // 当前表的所有行（通过 loadTableRows 填充）
  rows: any[];
  focusContext: {
    rowDbKey: string;
    columnName: string;
    rowIndex: number | null;
    colIndex: number | null;
    rowTitle: string | null;
    cellPreview: string | null;
    isEditing: boolean;
  } | null;
}

/* --------------------------------------------------------------------------
 * 初始状态
 * ------------------------------------------------------------------------*/

const initialState: TableSliceState = {
  currentTable: null,
  isLoading: false,
  isInitialized: false,
  error: null,
  rows: [],
  focusContext: null,
};

/* --------------------------------------------------------------------------
 * 工具方法
 * ------------------------------------------------------------------------*/

const reorderList = <T,>(list: T[], from: number, to: number): T[] => {
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
};

/* --------------------------------------------------------------------------
 * thunk-capable createSlice
 * ------------------------------------------------------------------------*/

const createSliceWithThunks = buildCreateSlice({
  creators: { asyncThunk: asyncThunkCreator },
});

/* --------------------------------------------------------------------------
 * 其它 thunk 参数类型
 * ------------------------------------------------------------------------*/

interface InitTableArgs {
  tenantId: string;
  tableId: string;
}

interface AddRowArgs {
  tenantId: string;
  tableId: string;
  values: Record<string, any>;
}

interface AddColumnArgs {
  tenantId: string;
  tableId: string;
  columnName: string;
}

interface DeleteColumnArgs {
  tenantId: string;
  tableId: string;
  columnName: string;
}

interface RenameColumnArgs {
  tenantId: string;
  tableId: string;
  oldName: string;
  newName: string;
}

interface RenameColumnLabelArgs {
  tenantId: string;
  tableId: string;
  columnId: string;
  newLabel: string;
}

interface RenameTableArgs {
  tenantId: string;
  tableId: string; // 路由 / metaKey 中的 tableId，不做变更
  newName: string; // 新的显示名称 displayName
}

interface UpdateTableIconArgs {
  tenantId: string;
  tableId: string;
  icon: ContentIcon | null;
}

interface LoadTableRowsArgs {
  tenantId: string;
  tableId: string;
}

interface UpdateCellArgs {
  dbKey: string;
  columnName: string;
  value: any;
}

interface ReorderColumnArgs {
  tenantId: string;
  tableId: string;
  fromIndex: number;
  toIndex: number;
}

interface UpdateColumnWidthArgs {
  tenantId: string;
  tableId: string;
  columnId: string;
  width: number;
}

/* --------------------------------------------------------------------------
 * Slice 定义
 * ------------------------------------------------------------------------*/

export const tableSlice = createSliceWithThunks({
  name: "table",
  initialState,
  reducers: (create) => ({
    /* --------------------------------------
     * 1. 创建表：createTable
     * ------------------------------------*/
    createTable: create.asyncThunk<string, CreateTableArgs | undefined>(
      createTableAction as any
    ),

    /* --------------------------------------
     * 2. 加载已有表定义：initTable
     * ------------------------------------*/
    initTable: create.asyncThunk(
      async (args: InitTableArgs, { dispatch, rejectWithValue }) => {
        const { tenantId, tableId } = args;
        const dbKey = metaKey(tenantId, tableId);

        try {
          const readAction = await dispatch(readAndWait(dbKey));

          if (readAndWait.fulfilled.match(readAction) && readAction.payload) {
            const meta = readAction.payload as TableMeta;
            return meta;
          }

          const msg =
            (readAction.payload as any)?.message || `无法加载表 ${tableId}`;
          return rejectWithValue(msg);
        } catch (e: any) {
          return rejectWithValue(e.message || `初始化表 ${tableId} 时出错`);
        }
      },
      {
        pending: (state) => {
          state.isLoading = true;
          state.error = null;
          state.isInitialized = false;
          state.currentTable = null;
          state.rows = []; // 切换/重载表时，行数据一起清空
        },
        fulfilled: (state, action: PayloadAction<TableMeta>) => {
          state.isLoading = false;
          state.isInitialized = true;
          state.currentTable = action.payload;
          state.error = null;
        },
        rejected: (state, action) => {
          state.isLoading = false;
          state.isInitialized = true;
          state.currentTable = null;
          state.error =
            (action.payload as string) ||
            action.error.message ||
            "初始化表时发生未知错误";
          state.rows = [];
        },
      }
    ),

    /* --------------------------------------
     * 2.1 加载某表的所有行：loadTableRows
     * ------------------------------------*/
    loadTableRows: create.asyncThunk(
      async (args: LoadTableRowsArgs, { getState, rejectWithValue, extra }) => {
        const { tenantId, tableId } = args;
        const { db } = extra as { db: any };

        try {
          const state = getState() as any;
          const { currentToken: token, remoteServers } =
            getRuntimeServerContext(state);
          return await fetchAndCacheTableRows({
            db,
            tenantId,
            tableId,
            token,
            remoteServers,
          });
        } catch (e: any) {
          return rejectWithValue(e.message || "加载表行失败");
        }
      },
      {
        pending: (state) => {
          state.error = null;
        },
        fulfilled: (state, action: PayloadAction<any[]>) => {
          state.rows = action.payload;
        },
        rejected: (state, action) => {
          state.error =
            (action.payload as string) ||
            action.error.message ||
            "加载表行时发生未知错误";
          state.rows = [];
        },
      }
    ),

    /* --------------------------------------
     * 3. 新增一行：addRow
     * ------------------------------------*/
    addRow: create.asyncThunk(
      async (args: AddRowArgs, { dispatch, rejectWithValue }) => {
        const { tenantId, tableId, values } = args;

        try {
          const { dbKey, rowId } = rowKey.create(tenantId, tableId);
          const nowIso = formatISO(new Date());

          const row = {
            dbKey,
            tenantId,
            tableId,
            rowId,
            createdAt: nowIso,
            updatedAt: nowIso,
            type: DataType.TABLE_ROW as const,
            ...values,
          };

          await dispatch(
            write({
              data: row,
              customKey: dbKey,
            })
          ).unwrap();

          return row;
        } catch (e: any) {
          return rejectWithValue(e.message || "新增表行失败");
        }
      },
      {
        pending: (state) => {
          state.error = null;
        },
        fulfilled: (state, action: PayloadAction<any>) => {
          const row = action.payload as any;
          const meta = state.currentTable;

          if (
            meta &&
            row?.tenantId === meta.tenantId &&
            row?.tableId === meta.tableId
          ) {
            state.rows.push(row);
          }
        },
        rejected: (state, action) => {
          state.error =
            (action.payload as string) ||
            action.error.message ||
            "新增表行时发生未知错误";
        },
      }
    ),

    /* --------------------------------------
     * 3.1 删除一行：deleteRow
     * ------------------------------------*/
    deleteRow: create.asyncThunk(
      async (dbKey: string, { dispatch, getState, rejectWithValue, extra }: any) => {
        try {
          const state = getState() as any;
          const row = (state.table.rows as any[]).find((item: any) => item?.dbKey === dbKey);

          if (!row) {
            return rejectWithValue(`当前表中找不到要删除的行：${dbKey}`);
          }

          const nowIso = formatISO(new Date());
          const tombstoneRow = {
            ...row,
            deletedAt: nowIso,
            updatedAt: nowIso,
            type: DataType.TABLE_ROW as const,
          };

          if (extra?.db && typeof extra.db.put === "function") {
            await extra.db.put(dbKey, tombstoneRow);
          }
          dispatch(upsertSSREntity(tombstoneRow));

          const { currentServer, syncServers } = getRuntimeServerContext(state);
          const servers = resolveReplicationServers(currentServer, syncServers);
          scheduleWriteReplication(
            servers,
            {
              data: tombstoneRow,
              customKey: dbKey,
            },
            state
          );

          return dbKey;
        } catch (e: any) {
          return rejectWithValue(e.message || "删除表行失败");
        }
      },
      {
        pending: (state) => {
          state.error = null;
        },
        fulfilled: (state, action: PayloadAction<string>) => {
          const dbKey = action.payload;
          state.rows = state.rows.filter((row: any) => row.dbKey !== dbKey);
        },
        rejected: (state, action) => {
          state.error =
            (action.payload as string) ||
            action.error.message ||
            "删除表行时发生未知错误";
        },
      }
    ),

    /* --------------------------------------
     * 3.2 删除整张表：deleteTable
     * ------------------------------------*/
    deleteTable: create.asyncThunk<string, DeleteTableArgs>(
      deleteTableAction as any,
      {
        pending: (state) => {
          state.error = null;
        },
        fulfilled: (state, action: PayloadAction<string>) => {
          const deletedKey = action.payload;

          if (state.currentTable?.dbKey === deletedKey) {
            state.currentTable = null;
            state.rows = [];
            state.isInitialized = false;
          }
        },
        rejected: (state, action) => {
          state.error =
            (action.payload as string) ||
            action.error.message ||
            "删除表时发生未知错误";
        },
      }
    ),

    /* --------------------------------------
     * 4. 新增字段：addColumn
     * ------------------------------------*/
    addColumn: create.asyncThunk(
      async (args: AddColumnArgs, { dispatch, getState, rejectWithValue }) => {
        const { tenantId, tableId, columnName } = args;

        if (!columnName.trim()) {
          return rejectWithValue("字段名不能为空");
        }

        const state = (getState() as any).table;
        const meta = state.currentTable;

        if (!meta || meta.tenantId !== tenantId || meta.tableId !== tableId) {
          return rejectWithValue("当前没有加载对应的表定义");
        }

        if (meta.columns.some((c: TableColumn) => c.name === columnName)) {
          return rejectWithValue(`字段 ${columnName} 已存在`);
        }

        try {
          const nowIso = formatISO(new Date());

          const newColumn: TableColumn = {
            id: ulid(),
            name: columnName,
            // 默认显示名与机器名一致；之后用户可以单独改 label
            label: columnName,
          };

          const newColumns: TableColumn[] = [...meta.columns, newColumn];

          await dispatch(
            patch({
              dbKey: meta.dbKey,
              changes: {
                columns: newColumns,
                updatedAt: nowIso,
              },
            })
          ).unwrap();

          const nextMeta: TableMeta = {
            ...meta,
            columns: newColumns,
            updatedAt: nowIso,
          };

          return nextMeta;
        } catch (e: any) {
          return rejectWithValue(e.message || "添加字段失败");
        }
      },
      {
        pending: (state) => {
          state.error = null;
        },
        fulfilled: (state, action: PayloadAction<TableMeta>) => {
          state.currentTable = action.payload;
          state.isInitialized = true;
        },
        rejected: (state, action) => {
          state.error =
            (action.payload as string) ||
            action.error.message ||
            "为表新增字段时发生未知错误";
        },
      }
    ),

    /* --------------------------------------
     * 4.1 删除字段：deleteColumn
     * ------------------------------------*/
    deleteColumn: create.asyncThunk(
      async (
        args: DeleteColumnArgs,
        { dispatch, getState, rejectWithValue }
      ) => {
        const { tenantId, tableId, columnName } = args;

        const state = (getState() as any).table;
        const meta = state.currentTable;

        if (!meta || meta.tenantId !== tenantId || meta.tableId !== tableId) {
          return rejectWithValue("当前没有加载对应的表定义");
        }

        if (!meta.columns.some((c: TableColumn) => c.name === columnName)) {
          return rejectWithValue(`字段 ${columnName} 不存在`);
        }

        const nowIso = formatISO(new Date());
        const newColumns: TableColumn[] = meta.columns.filter(
          (c: TableColumn) => c.name !== columnName
        );
        const rows = state.rows;

        try {
          // 1) 删除所有行上的该字段（利用 patch 的 null -> 删除语义）
          const rowsWithField = rows.filter((row: any) =>
            Object.prototype.hasOwnProperty.call(row, columnName)
          );

          await Promise.all(
            rowsWithField.map((row: any) =>
              dispatch(
                patch({
                  dbKey: row.dbKey,
                  changes: {
                    [columnName]: null,
                    updatedAt: nowIso,
                  },
                })
              ).unwrap()
            )
          );

          // 2) 更新 meta.columns
          await dispatch(
            patch({
              dbKey: meta.dbKey,
              changes: {
                columns: newColumns,
                updatedAt: nowIso,
              },
            })
          ).unwrap();

          // 3) 生成新的 rows（内存态）
          const newRows = rows.map((row: any) => {
            if (!Object.prototype.hasOwnProperty.call(row, columnName)) {
              return row;
            }
            const { [columnName]: _removed, ...rest } = row;
            return {
              ...rest,
              updatedAt: nowIso,
            };
          });

          return {
            meta: {
              ...meta,
              columns: newColumns,
              updatedAt: nowIso,
            } as TableMeta,
            rows: newRows,
          };
        } catch (e: any) {
          return rejectWithValue(e.message || "删除字段失败");
        }
      },
      {
        pending: (state) => {
          state.error = null;
        },
        fulfilled: (
          state,
          action: PayloadAction<{ meta: TableMeta; rows: any[] }>
        ) => {
          state.currentTable = action.payload.meta;
          state.rows = action.payload.rows;
          state.isInitialized = true;
        },
        rejected: (state, action) => {
          state.error =
            (action.payload as string) ||
            action.error.message ||
            "删除字段时发生未知错误";
        },
      }
    ),

    /* --------------------------------------
     * 4.1-bis 调整字段顺序：reorderColumn
     * ------------------------------------*/
    reorderColumn: create.asyncThunk(
      async (
        args: ReorderColumnArgs,
        { dispatch, getState, rejectWithValue }
      ) => {
        const { tenantId, tableId, fromIndex, toIndex } = args;
        const state = (getState() as any).table;
        const meta = state.currentTable;

        if (!meta || meta.tenantId !== tenantId || meta.tableId !== tableId) {
          return rejectWithValue("当前没有加载对应的表定义");
        }

        const columnCount = meta.columns.length;
        if (
          fromIndex < 0 ||
          fromIndex >= columnCount ||
          toIndex < 0 ||
          toIndex >= columnCount
        ) {
          return rejectWithValue("列索引超出范围");
        }

        if (fromIndex === toIndex) {
          // 不需要改动，直接返回原 meta，避免无意义写库
          return meta;
        }

        const nowIso = formatISO(new Date());
        const newColumns = reorderList(meta.columns, fromIndex, toIndex);

        try {
          await dispatch(
            patch({
              dbKey: meta.dbKey,
              changes: {
                columns: newColumns,
                updatedAt: nowIso,
              },
            })
          ).unwrap();

          const nextMeta: TableMeta = {
            ...meta,
            columns: newColumns,
            updatedAt: nowIso,
          };

          return nextMeta;
        } catch (e: any) {
          return rejectWithValue(e.message || "调整列顺序失败");
        }
      },
      {
        pending: (state) => {
          state.error = null;
        },
        fulfilled: (state, action: PayloadAction<TableMeta>) => {
          state.currentTable = action.payload;
          state.isInitialized = true;
        },
        rejected: (state, action) => {
          state.error =
            (action.payload as string) ||
            action.error.message ||
            "调整列顺序时发生未知错误";
        },
      }
    ),

    /* --------------------------------------
     * 4.2 重命名字段（机器名）：renameColumn
     * 说明：这是“改字段 key 并迁移所有行数据”的重操作，
     * 目前 UI 不直接调用，保留给将来高级设置用。
     * ------------------------------------*/
    renameColumn: create.asyncThunk(
      async (
        args: RenameColumnArgs,
        { dispatch, getState, rejectWithValue }
      ) => {
        const { tenantId, tableId, oldName, newName } = args;
        const trimmedNewName = newName.trim();

        if (!trimmedNewName) {
          return rejectWithValue("新的字段名不能为空");
        }

        const state = (getState() as any).table;
        const meta = state.currentTable;

        if (!meta || meta.tenantId !== tenantId || meta.tableId !== tableId) {
          return rejectWithValue("当前没有加载对应的表定义");
        }

        if (!meta.columns.some((c: TableColumn) => c.name === oldName)) {
          return rejectWithValue(`字段 ${oldName} 不存在`);
        }

        if (meta.columns.some((c: TableColumn) => c.name === trimmedNewName)) {
          return rejectWithValue(`字段 ${trimmedNewName} 已存在`);
        }

        const nowIso = formatISO(new Date());
        const rows = state.rows;

        const newColumns: TableColumn[] = meta.columns.map((c: TableColumn) =>
          c.name === oldName ? { ...c, name: trimmedNewName } : c
        );

        try {
          // 1) 遍历所有行，把 oldName -> newName，并删除 oldName
          const rowsWithOldField = rows.filter((row: any) =>
            Object.prototype.hasOwnProperty.call(row, oldName)
          );

          await Promise.all(
            rowsWithOldField.map((row: any) => {
              const changes: Record<string, any> = {
                [trimmedNewName]: row[oldName],
                [oldName]: null,
                updatedAt: nowIso,
              };

              return dispatch(
                patch({
                  dbKey: row.dbKey,
                  changes,
                })
              ).unwrap();
            })
          );

          // 2) 更新 meta.columns
          await dispatch(
            patch({
              dbKey: meta.dbKey,
              changes: {
                columns: newColumns,
                updatedAt: nowIso,
              },
            })
          ).unwrap();

          // 3) 内存态 rows 同步字段名
          const newRows = rows.map((row: any) => {
            if (!Object.prototype.hasOwnProperty.call(row, oldName)) {
              return row;
            }
            const { [oldName]: oldValue, ...rest } = row;
            return {
              ...rest,
              [trimmedNewName]: oldValue,
              updatedAt: nowIso,
            };
          });

          return {
            meta: {
              ...meta,
              columns: newColumns,
              updatedAt: nowIso,
            } as TableMeta,
            rows: newRows,
          };
        } catch (e: any) {
          return rejectWithValue(e.message || "重命名字段失败");
        }
      },
      {
        pending: (state) => {
          state.error = null;
        },
        fulfilled: (
          state,
          action: PayloadAction<{ meta: TableMeta; rows: any[] }>
        ) => {
          state.currentTable = action.payload.meta;
          state.rows = action.payload.rows;
          state.isInitialized = true;
        },
        rejected: (state, action) => {
          state.error =
            (action.payload as string) ||
            action.error.message ||
            "重命名字段时发生未知错误";
        },
      }
    ),

    /* --------------------------------------
     * 4.2-bis 重命名字段显示名：renameColumnLabel
     * 说明：只改 columns[].label，不动 name / 行数据
     * UI 表头双击使用这一条。
     * ------------------------------------*/
    renameColumnLabel: create.asyncThunk(
      async (
        args: RenameColumnLabelArgs,
        { dispatch, getState, rejectWithValue }
      ) => {
        const { tenantId, tableId, columnId, newLabel } = args;
        const trimmedLabel = newLabel.trim();

        if (!trimmedLabel) {
          return rejectWithValue("字段显示名不能为空");
        }

        const state = (getState() as any).table;
        const meta = state.currentTable;

        if (!meta || meta.tenantId !== tenantId || meta.tableId !== tableId) {
          return rejectWithValue("当前没有加载对应的表定义");
        }

        const column = meta.columns.find((c: TableColumn) => c.id === columnId);
        if (!column) {
          return rejectWithValue("要重命名的字段不存在");
        }

        const nowIso = formatISO(new Date());

        const newColumns: TableColumn[] = meta.columns.map((c: TableColumn) =>
          c.id === columnId ? { ...c, label: trimmedLabel } : c
        );

        try {
          await dispatch(
            patch({
              dbKey: meta.dbKey,
              changes: {
                columns: newColumns,
                updatedAt: nowIso,
              },
            })
          ).unwrap();

          const nextMeta: TableMeta = {
            ...meta,
            columns: newColumns,
            updatedAt: nowIso,
          };

          return nextMeta;
        } catch (e: any) {
          return rejectWithValue(e.message || "重命名字段显示名失败");
        }
      },
      {
        pending: (state) => {
          state.error = null;
        },
        fulfilled: (state, action: PayloadAction<TableMeta>) => {
          state.currentTable = action.payload;
          state.isInitialized = true;
        },
        rejected: (state, action) => {
          state.error =
            (action.payload as string) ||
            action.error.message ||
            "重命名字段显示名时发生未知错误";
        },
      }
    ),

    /* --------------------------------------
     * 4.2-ter 更新字段宽度：updateColumnWidth
     * 说明：只改 columns[].width，用于持久化列宽
     * ------------------------------------*/
    updateColumnWidth: create.asyncThunk(
      async (
        args: UpdateColumnWidthArgs,
        { dispatch, getState, rejectWithValue }
      ) => {
        const { tenantId, tableId, columnId, width } = args;

        const state = (getState() as any).table;
        const meta = state.currentTable;

        if (!meta || meta.tenantId !== tenantId || meta.tableId !== tableId) {
          return rejectWithValue("当前没有加载对应的表定义");
        }

        const column = meta.columns.find((c: TableColumn) => c.id === columnId);
        if (!column) {
          return rejectWithValue("要调整宽度的字段不存在");
        }

        const normalizedWidth =
          typeof width === "number" && width > 0 ? Math.round(width) : undefined;

        const nowIso = formatISO(new Date());

        const newColumns: TableColumn[] = meta.columns.map((c: TableColumn) =>
          c.id === columnId ? { ...c, width: normalizedWidth } : c
        );

        try {
          await dispatch(
            patch({
              dbKey: meta.dbKey,
              changes: {
                columns: newColumns,
                updatedAt: nowIso,
              },
            })
          ).unwrap();

          const nextMeta: TableMeta = {
            ...meta,
            columns: newColumns,
            updatedAt: nowIso,
          };

          return nextMeta;
        } catch (e: any) {
          return rejectWithValue(e.message || "更新字段宽度失败");
        }
      },
      {
        pending: (state) => {
          state.error = null;
        },
        fulfilled: (state, action: PayloadAction<TableMeta>) => {
          state.currentTable = action.payload;
          state.isInitialized = true;
        },
        rejected: (state, action) => {
          state.error =
            (action.payload as string) ||
            action.error.message ||
            "更新字段宽度时发生未知错误";
        },
      }
    ),

    /* --------------------------------------
     * 4.3 重命名表：renameTable（仅修改显示名称）
     * ------------------------------------*/
    renameTable: create.asyncThunk(
      async (
        args: RenameTableArgs,
        { dispatch, getState, rejectWithValue }
      ) => {
        const { tenantId, tableId, newName } = args;
        const trimmedName = newName.trim();

        if (!trimmedName) {
          return rejectWithValue("表名不能为空");
        }

        const state = (getState() as any).table;
        const meta = state.currentTable;

        if (!meta || meta.tenantId !== tenantId || meta.tableId !== tableId) {
          return rejectWithValue("当前没有加载对应的表定义");
        }

        const nowIso = formatISO(new Date());

        try {
          await dispatch(
            patch({
              dbKey: meta.dbKey,
              changes: {
                displayName: trimmedName,
                updatedAt: nowIso,
              },
            })
          ).unwrap();

          const nextMeta: TableMeta = {
            ...meta,
            displayName: trimmedName,
            updatedAt: nowIso,
          };

          return nextMeta;
        } catch (e: any) {
          return rejectWithValue(e.message || "重命名表失败");
        }
      },
      {
        pending: (state) => {
          state.error = null;
        },
        fulfilled: (state, action: PayloadAction<TableMeta>) => {
          state.currentTable = action.payload;
        },
        rejected: (state, action) => {
          state.error =
            (action.payload as string) ||
            action.error.message ||
            "重命名表时发生未知错误";
        },
      }
    ),

    updateTableIcon: create.asyncThunk(
      async (
        args: UpdateTableIconArgs,
        { dispatch, getState, rejectWithValue }
      ) => {
        const { tenantId, tableId, icon } = args;
        const state = (getState() as any).table;
        const meta = state.currentTable;

        if (!meta || meta.tenantId !== tenantId || meta.tableId !== tableId) {
          return rejectWithValue("当前没有加载对应的表定义");
        }

        const nowIso = formatISO(new Date());

        try {
          await dispatch(
            patch({
              dbKey: meta.dbKey,
              changes: {
                icon: icon ?? null,
                updatedAt: nowIso,
              },
            })
          ).unwrap();

          const nextMeta: TableMeta = {
            ...meta,
            icon: icon ?? null,
            updatedAt: nowIso,
          };

          return nextMeta;
        } catch (e: any) {
          return rejectWithValue(e.message || "更新表格图标失败");
        }
      },
      {
        pending: (state) => {
          state.error = null;
        },
        fulfilled: (state, action: PayloadAction<TableMeta>) => {
          state.currentTable = action.payload;
        },
        rejected: (state, action) => {
          state.error =
            (action.payload as string) ||
            action.error.message ||
            "更新表格图标时发生未知错误";
        },
      }
    ),

    /* --------------------------------------
     * 4.4 更新单元格：updateCell
     * ------------------------------------*/
    updateCell: create.asyncThunk(
      async (args: UpdateCellArgs, { dispatch, rejectWithValue }) => {
        const { dbKey, columnName, value } = args;

        try {
          const nowIso = formatISO(new Date());

          await dispatch(
            patch({
              dbKey,
              changes: {
                [columnName]: value,
                updatedAt: nowIso,
              },
            })
          ).unwrap();

          return { dbKey, columnName, value, updatedAt: nowIso };
        } catch (e: any) {
          return rejectWithValue(e.message || "更新单元格失败");
        }
      },
      {
        pending: (state) => {
          state.error = null;
        },
        fulfilled: (
          state,
          action: PayloadAction<{
            dbKey: string;
            columnName: string;
            value: any;
            updatedAt: string;
          }>
        ) => {
          const { dbKey, columnName, value, updatedAt } = action.payload;
          const row = state.rows.find((r) => r.dbKey === dbKey);
          if (row) {
            row[columnName] = value;
            row.updatedAt = updatedAt;
          }
        },
        rejected: (state, action) => {
          state.error =
            (action.payload as string) ||
            action.error.message ||
            "更新单元格时发生未知错误";
        },
      }
    ),

    /* --------------------------------------
     * 5. 重置当前表状态
     * ------------------------------------*/
    setTableFocusContext: create.reducer(
      (state, action: PayloadAction<TableSliceState["focusContext"]>) => {
        state.focusContext = action.payload;
      }
    ),

    resetTable: create.reducer((state) => {
      Object.assign(state, initialState);
    }),
  }),

  selectors: {
    selectCurrentTable: (s: TableSliceState) => s.currentTable,
    selectTableIsLoading: (s: TableSliceState) => s.isLoading,
    selectTableIsInitialized: (s: TableSliceState) => s.isInitialized,
    selectTableError: (s: TableSliceState) => s.error,
    selectTableColumns: (s: TableSliceState) =>
      s.currentTable ? s.currentTable.columns : [],
    selectTableRows: (s: TableSliceState) => s.rows,
    selectTableFocusContext: (s: TableSliceState) => s.focusContext,
  },
});

/* --------------------------------------------------------------------------
 * 老接口：按表取所有行（基于 dbSlice），目前页面用不到了
 * ------------------------------------------------------------------------*/

export const makeSelectRowsByTable = (tenantId: string, tableId: string) =>
  createSelector(
    (state: any) => selectAllDb(state),
    (entities) =>
      entities.filter((e) => e.tableId === tableId && e.tenantId === tenantId)
  );

/* --------------------------------------------------------------------------
 * 导出
 * ------------------------------------------------------------------------*/

// cast: buildCreateSlice async thunks 会推断成 void|AsyncThunk|ActionCreator 联合
export const {
  createTable,
  initTable,
  addRow,
  deleteRow,
  deleteTable,
  addColumn,
  deleteColumn,
  renameColumn,
  renameColumnLabel,
  renameTable,
  updateTableIcon,
  resetTable,
  loadTableRows,
  updateCell,
  reorderColumn,
  updateColumnWidth,
  setTableFocusContext,
} = tableSlice.actions as any;

export const {
  selectCurrentTable,
  selectTableIsLoading,
  selectTableIsInitialized,
  selectTableError,
  selectTableColumns,
  selectTableRows,
  selectTableFocusContext,
} = tableSlice.selectors;

export default tableSlice.reducer;
