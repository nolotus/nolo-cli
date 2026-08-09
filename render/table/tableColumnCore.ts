// 文件: render/table/tableColumnCore.ts
//
// Pure column-operation core for tables — the cross-platform decision layer
// behind `tableSlice` 的列增删改序 thunk。
//
// Design goals (对齐 chatQueueMachine.ts / spaceEventCore.ts 的剥法):
//   1. Zero dependencies. 不 import React / Redux / RTK / date-fns / ulid /
//      database。Web / RN / 桌面 / server / CLI / TUI 共用同一份语义。
//   2. 纯函数：校验 + 变换一次算完，返回判别式 Result，绝不执行 IO。
//      写库（patch / replication）仍由调用方（thunk 或 CLI 命令）负责。
//   3. 非确定性输入（当前时间、新列 id）一律由调用方注入，便于确定性单测。
//   4. 输入不可变：所有返回的 columns / rows 均为新数组，不改动入参。
//
// 典型用法（Redux thunk 侧）：
//   const r = addColumnToMeta(meta, { columnName }, { id: ulid(), nowIso });
//   if (!r.ok) return rejectWithValue(r.error);
//   await dispatch(patch({ dbKey: meta.dbKey, changes: r.metaChanges })).unwrap();
//   return r.meta;
//
// 典型用法（CLI / TUI 侧）：同样调用，再换成本地 db 写入即可。

import type { TableColumn, TableMeta } from "./types";

/* --------------------------------------------------------------------------
 * 通用类型
 * ------------------------------------------------------------------------*/

/** 行数据在 core 层只当作普通字典处理，不绑定具体存储形态。 */
export type TableRowLike = Record<string, any>;

/** 判别式结果：ok 为 true 时取 value，否则取 error（可直接喂 rejectWithValue）。 */
export type ColumnCoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/** 只涉及 meta.columns 的操作结果。 */
export interface ColumnMetaChange {
  /** 变换后的完整 meta（供 reducer 直接落 state.currentTable）。 */
  meta: TableMeta;
  /** 需要写库的最小 changes 集合。 */
  metaChanges: { columns: TableColumn[]; updatedAt: string };
  /**
   * 该操作是否为空操作（例如 reorder 的 fromIndex === toIndex）。
   * 为 true 时调用方可跳过写库，直接复用原 meta。
   */
  noop: boolean;
}

/** 同时影响 meta 与行数据的操作结果。 */
export interface ColumnMetaAndRowsChange extends ColumnMetaChange {
  /** 变换后的内存态 rows。 */
  rows: TableRowLike[];
  /**
   * 需要逐行写库的 patch 描述（调用方决定用 dispatch(patch) 还是本地 db）。
   * 已过滤掉不含目标字段的行。
   */
  rowPatches: Array<{ dbKey: string; changes: Record<string, any> }>;
}

const ok = <T,>(value: T): ColumnCoreResult<T> => ({ ok: true, value });
const err = <T,>(error: string): ColumnCoreResult<T> => ({ ok: false, error });

const hasOwn = (obj: TableRowLike, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key);

const buildMeta = (
  meta: TableMeta,
  columns: TableColumn[],
  updatedAt: string
): ColumnMetaChange => ({
  meta: { ...meta, columns, updatedAt } as TableMeta,
  metaChanges: { columns, updatedAt },
  noop: false,
});

/* --------------------------------------------------------------------------
 * 通用工具
 * ------------------------------------------------------------------------*/

/**
 * 把 list[from] 移到下标 to（其余元素顺延）。剥自 tableSlice 的 reorderList。
 * 不校验越界——越界由 reorderColumnInMeta 负责。
 */
export const reorderList = <T,>(list: T[], from: number, to: number): T[] => {
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
};

/**
 * 校验 meta 是否为期望的那张表。所有列操作的公共前置。
 */
export function assertTableMeta(
  meta: TableMeta | null | undefined,
  tenantId: string,
  tableId: string
): ColumnCoreResult<TableMeta> {
  if (!meta || meta.tenantId !== tenantId || meta.tableId !== tableId) {
    return err("当前没有加载对应的表定义");
  }
  return ok(meta);
}

/* --------------------------------------------------------------------------
 * 1. 新增字段
 * ------------------------------------------------------------------------*/

export interface AddColumnInput {
  columnName: string;
}

export interface AddColumnDeps {
  /** 新列的稳定 id（Web 侧传 ulid()）。 */
  id: string;
  /** 本次操作的 ISO 时间戳。 */
  nowIso: string;
}

/**
 * 追加一列。新列的 label 默认与机器名一致，之后可单独改。
 */
export function addColumnToMeta(
  meta: TableMeta,
  input: AddColumnInput,
  deps: AddColumnDeps
): ColumnCoreResult<ColumnMetaChange> {
  const { columnName } = input;

  if (!columnName.trim()) {
    return err("字段名不能为空");
  }

  if (meta.columns.some((c) => c.name === columnName)) {
    return err(`字段 ${columnName} 已存在`);
  }

  const newColumn: TableColumn = {
    id: deps.id,
    name: columnName,
    label: columnName,
  };

  return ok(buildMeta(meta, [...meta.columns, newColumn], deps.nowIso));
}

/* --------------------------------------------------------------------------
 * 2. 删除字段
 * ------------------------------------------------------------------------*/

export interface DeleteColumnInput {
  columnName: string;
}

/**
 * 删除一列，并生成「把各行该字段置 null」的 patch 描述。
 * patch 的 null -> 删除语义由存储层负责，core 只描述意图。
 */
export function deleteColumnFromMeta(
  meta: TableMeta,
  rows: TableRowLike[],
  input: DeleteColumnInput,
  deps: { nowIso: string }
): ColumnCoreResult<ColumnMetaAndRowsChange> {
  const { columnName } = input;
  const { nowIso } = deps;

  if (!meta.columns.some((c) => c.name === columnName)) {
    return err(`字段 ${columnName} 不存在`);
  }

  const newColumns = meta.columns.filter((c) => c.name !== columnName);

  const rowPatches = rows
    .filter((row) => hasOwn(row, columnName))
    .map((row) => ({
      dbKey: row.dbKey,
      changes: { [columnName]: null, updatedAt: nowIso },
    }));

  const newRows = rows.map((row) => {
    if (!hasOwn(row, columnName)) {
      return row;
    }
    const { [columnName]: _removed, ...rest } = row;
    return { ...rest, updatedAt: nowIso };
  });

  return ok({
    ...buildMeta(meta, newColumns, nowIso),
    rows: newRows,
    rowPatches,
  });
}

/* --------------------------------------------------------------------------
 * 3. 调整字段顺序
 * ------------------------------------------------------------------------*/

export interface ReorderColumnInput {
  fromIndex: number;
  toIndex: number;
}

/**
 * 调整列顺序。fromIndex === toIndex 时返回 noop: true，调用方应跳过写库。
 */
export function reorderColumnInMeta(
  meta: TableMeta,
  input: ReorderColumnInput,
  deps: { nowIso: string }
): ColumnCoreResult<ColumnMetaChange> {
  const { fromIndex, toIndex } = input;
  const columnCount = meta.columns.length;

  if (
    fromIndex < 0 ||
    fromIndex >= columnCount ||
    toIndex < 0 ||
    toIndex >= columnCount
  ) {
    return err("列索引超出范围");
  }

  if (fromIndex === toIndex) {
    // 不需要改动，避免无意义写库。
    return ok({
      meta,
      metaChanges: { columns: meta.columns, updatedAt: meta.updatedAt as string },
      noop: true,
    });
  }

  return ok(
    buildMeta(meta, reorderList(meta.columns, fromIndex, toIndex), deps.nowIso)
  );
}

/* --------------------------------------------------------------------------
 * 4. 重命名字段（机器名，需迁移行数据）
 * ------------------------------------------------------------------------*/

export interface RenameColumnInput {
  oldName: string;
  newName: string;
}

/**
 * 改字段 key 并迁移所有行数据：新 key 写入原值，旧 key 置 null。
 */
export function renameColumnInMeta(
  meta: TableMeta,
  rows: TableRowLike[],
  input: RenameColumnInput,
  deps: { nowIso: string }
): ColumnCoreResult<ColumnMetaAndRowsChange> {
  const { oldName } = input;
  const { nowIso } = deps;
  const newName = input.newName.trim();

  if (!newName) {
    return err("新的字段名不能为空");
  }

  if (!meta.columns.some((c) => c.name === oldName)) {
    return err(`字段 ${oldName} 不存在`);
  }

  if (meta.columns.some((c) => c.name === newName)) {
    return err(`字段 ${newName} 已存在`);
  }

  const newColumns = meta.columns.map((c) =>
    c.name === oldName ? { ...c, name: newName } : c
  );

  const rowPatches = rows
    .filter((row) => hasOwn(row, oldName))
    .map((row) => ({
      dbKey: row.dbKey,
      changes: {
        [newName]: row[oldName],
        [oldName]: null,
        updatedAt: nowIso,
      },
    }));

  const newRows = rows.map((row) => {
    if (!hasOwn(row, oldName)) {
      return row;
    }
    const { [oldName]: oldValue, ...rest } = row;
    return { ...rest, [newName]: oldValue, updatedAt: nowIso };
  });

  return ok({
    ...buildMeta(meta, newColumns, nowIso),
    rows: newRows,
    rowPatches,
  });
}

/* --------------------------------------------------------------------------
 * 5. 重命名字段显示名（只动 label）
 * ------------------------------------------------------------------------*/

export interface RenameColumnLabelInput {
  columnId: string;
  label: string;
}

/**
 * 只改 columns[].label，不动 name / 行数据。
 */
export function renameColumnLabelInMeta(
  meta: TableMeta,
  input: RenameColumnLabelInput,
  deps: { nowIso: string }
): ColumnCoreResult<ColumnMetaChange> {
  const { columnId } = input;
  const label = input.label.trim();

  if (!label) {
    return err("字段显示名不能为空");
  }

  if (!meta.columns.some((c) => c.id === columnId)) {
    return err("要重命名的字段不存在");
  }

  const newColumns = meta.columns.map((c) =>
    c.id === columnId ? { ...c, label } : c
  );

  return ok(buildMeta(meta, newColumns, deps.nowIso));
}

/* --------------------------------------------------------------------------
 * 6. 更新字段宽度
 * ------------------------------------------------------------------------*/

export interface UpdateColumnWidthInput {
  columnId: string;
  /** 传入非正数或非 number 时表示「清除自定义列宽」（width -> undefined）。 */
  width: number;
}

/**
 * 更新列宽（像素，取整）。宽度非正或非 number 时置为 undefined，即回退默认列宽。
 * 注意：与原 thunk 语义一致，core 不做 min/max 夹取。
 */
export function updateColumnWidthInMeta(
  meta: TableMeta,
  input: UpdateColumnWidthInput,
  deps: { nowIso: string }
): ColumnCoreResult<ColumnMetaChange> {
  const { columnId, width } = input;

  if (!meta.columns.some((c) => c.id === columnId)) {
    return err("要调整宽度的字段不存在");
  }

  const normalizedWidth =
    typeof width === "number" && width > 0 ? Math.round(width) : undefined;

  const newColumns = meta.columns.map((c) =>
    c.id === columnId ? { ...c, width: normalizedWidth } : c
  );

  return ok(buildMeta(meta, newColumns, deps.nowIso));
}
