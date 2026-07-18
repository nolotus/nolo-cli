import { patchRecord, loadTableMetaOrThrow, ensureRowsLoaded, resolveTableIdentity } from "./toolShared";
import type { RootState } from "../../../app/store";
import { asOptionalTrimmedString } from "../../../core/optionalString";
import { asTrimmedNonEmptyStringArray } from "../../../core/stringArray";
import type { TableColumn } from "../../../render/table/types";
import { ulid } from "../../../database/utils/ulid";

const requireTableIdentity = (args: { tenantId?: string; tableId?: string }, thunkApi: any) => {
  const state = thunkApi.getState() as RootState;
  const { tenantId, tableId } = resolveTableIdentity(args, state);
  if (!tenantId || !tableId) {
    throw new Error("需要显式提供 tenantId 和 tableId，或在已打开的表页面中调用。");
  }
  return { tenantId, tableId };
};

const ensureColumnName = (name: unknown): string => {
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("列名不能为空。");
  }
  return name.trim();
};

const normalizeOptions = (options: unknown): string[] | undefined => {
  if (!Array.isArray(options)) return undefined;
  const normalized = asTrimmedNonEmptyStringArray(options);
  return normalized.length > 0 ? normalized : undefined;
};

export const addTableColumnFunctionSchema = {
  name: "addTableColumn",
  description: "向指定表中新增一列。",
  parameters: {
    type: "object",
    properties: {
      tenantId: { type: "string" },
      tableId: { type: "string" },
      name: { type: "string" },
      label: { type: "string" },
      type: {
        type: "string",
        enum: ["text", "number", "boolean", "date", "datetime", "select", "multi_select"],
      },
      description: { type: "string" },
      required: { type: "boolean" },
      options: { type: "array", items: { type: "string" } },
    },
    required: ["name"],
  },
};

export async function addTableColumnFunc(args: any, thunkApi: any) {
  const { tenantId, tableId } = requireTableIdentity(args, thunkApi);
  const tableMeta = await loadTableMetaOrThrow(thunkApi, tenantId, tableId);
  const name = ensureColumnName(args?.name);
  if (tableMeta.columns.some((column) => column.name === name)) {
    throw new Error(`字段 ${name} 已存在。`);
  }

  const column: TableColumn = {
    id: ulid(),
    name,
    label: asOptionalTrimmedString(args?.label) ?? name,
    type: typeof args?.type === "string" ? args.type : "text",
    description: asOptionalTrimmedString(args?.description),
    required: typeof args?.required === "boolean" ? args.required : undefined,
    options: normalizeOptions(args?.options),
  };

  const updatedAt = new Date().toISOString();
  const updated = await patchRecord(thunkApi, tableMeta.dbKey, {
    columns: [...tableMeta.columns, column],
    updatedAt,
  });

  return {
    rawData: updated,
    displayData: `已向表「${tableMeta.displayName || tableId}」新增字段 ${name}。`,
  };
}

export const deleteTableColumnFunctionSchema = {
  name: "deleteTableColumn",
  description: "删除指定表中的某一列，并同步从已有行中移除该字段。",
  parameters: {
    type: "object",
    properties: {
      tenantId: { type: "string" },
      tableId: { type: "string" },
      columnName: { type: "string" },
    },
    required: ["columnName"],
  },
};

export async function deleteTableColumnFunc(args: any, thunkApi: any) {
  const { tenantId, tableId } = requireTableIdentity(args, thunkApi);
  const tableMeta = await loadTableMetaOrThrow(thunkApi, tenantId, tableId);
  const columnName = ensureColumnName(args?.columnName);
  if (!tableMeta.columns.some((column) => column.name === columnName)) {
    throw new Error(`字段 ${columnName} 不存在。`);
  }

  const rows = await ensureRowsLoaded(thunkApi, tenantId, tableId);
  const updatedAt = new Date().toISOString();
  await Promise.all(
    rows
      .filter((row) => Object.prototype.hasOwnProperty.call(row, columnName))
      .map((row) =>
        patchRecord(thunkApi, row.dbKey, {
          [columnName]: null,
          updatedAt,
        })
      )
  );

  const updated = await patchRecord(thunkApi, tableMeta.dbKey, {
    columns: tableMeta.columns.filter((column) => column.name !== columnName),
    updatedAt,
  });

  return {
    rawData: updated,
    displayData: `已从表「${tableMeta.displayName || tableId}」删除字段 ${columnName}。`,
  };
}

export const renameTableColumnFunctionSchema = {
  name: "renameTableColumn",
  description: "修改表字段的 machine name，并同步迁移所有已有行的数据 key。",
  parameters: {
    type: "object",
    properties: {
      tenantId: { type: "string" },
      tableId: { type: "string" },
      oldName: { type: "string" },
      newName: { type: "string" },
    },
    required: ["oldName", "newName"],
  },
};

export async function renameTableColumnFunc(args: any, thunkApi: any) {
  const { tenantId, tableId } = requireTableIdentity(args, thunkApi);
  const tableMeta = await loadTableMetaOrThrow(thunkApi, tenantId, tableId);
  const oldName = ensureColumnName(args?.oldName);
  const newName = ensureColumnName(args?.newName);

  if (!tableMeta.columns.some((column) => column.name === oldName)) {
    throw new Error(`字段 ${oldName} 不存在。`);
  }
  if (tableMeta.columns.some((column) => column.name === newName)) {
    throw new Error(`字段 ${newName} 已存在。`);
  }

  const rows = await ensureRowsLoaded(thunkApi, tenantId, tableId);
  const updatedAt = new Date().toISOString();
  await Promise.all(
    rows
      .filter((row) => Object.prototype.hasOwnProperty.call(row, oldName))
      .map((row) =>
        patchRecord(thunkApi, row.dbKey, {
          [newName]: row[oldName],
          [oldName]: null,
          updatedAt,
        })
      )
  );

  const updated = await patchRecord(thunkApi, tableMeta.dbKey, {
    columns: tableMeta.columns.map((column) =>
      column.name === oldName ? { ...column, name: newName } : column
    ),
    updatedAt,
  });

  return {
    rawData: updated,
    displayData: `已将表「${tableMeta.displayName || tableId}」中的字段 ${oldName} 重命名为 ${newName}。`,
  };
}

export const renameTableColumnLabelFunctionSchema = {
  name: "renameTableColumnLabel",
  description: "修改表字段的显示名，不改变行数据里的 key。",
  parameters: {
    type: "object",
    properties: {
      tenantId: { type: "string" },
      tableId: { type: "string" },
      columnName: { type: "string" },
      newLabel: { type: "string" },
    },
    required: ["columnName", "newLabel"],
  },
};

export async function renameTableColumnLabelFunc(args: any, thunkApi: any) {
  const { tenantId, tableId } = requireTableIdentity(args, thunkApi);
  const tableMeta = await loadTableMetaOrThrow(thunkApi, tenantId, tableId);
  const columnName = ensureColumnName(args?.columnName);
  const newLabel = ensureColumnName(args?.newLabel);

  if (!tableMeta.columns.some((column) => column.name === columnName)) {
    throw new Error(`字段 ${columnName} 不存在。`);
  }

  const updated = await patchRecord(thunkApi, tableMeta.dbKey, {
    columns: tableMeta.columns.map((column) =>
      column.name === columnName ? { ...column, label: newLabel } : column
    ),
    updatedAt: new Date().toISOString(),
  });

  return {
    rawData: updated,
    displayData: `已将字段 ${columnName} 的显示名更新为 ${newLabel}。`,
  };
}

export const renameTableFunctionSchema = {
  name: "renameTable",
  description: "更新表的显示名称。",
  parameters: {
    type: "object",
    properties: {
      tenantId: { type: "string" },
      tableId: { type: "string" },
      newName: { type: "string" },
    },
    required: ["newName"],
  },
};

export async function renameTableFunc(args: any, thunkApi: any) {
  const { tenantId, tableId } = requireTableIdentity(args, thunkApi);
  const tableMeta = await loadTableMetaOrThrow(thunkApi, tenantId, tableId);
  const newName = ensureColumnName(args?.newName);
  const updated = await patchRecord(thunkApi, tableMeta.dbKey, {
    displayName: newName,
    updatedAt: new Date().toISOString(),
  });

  return {
    rawData: updated,
    displayData: `已将表名更新为「${newName}」。`,
  };
}
