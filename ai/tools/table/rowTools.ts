import type { RootState } from "../../../app/store";
import { isRecord } from "../../../core/isRecord";
import { asOptionalTrimmedString } from "../../../core/optionalString";
import { asNonEmptyStringArray } from "../../../core/stringArray";
import { buildNoloTableQueryRequest } from "../../../agent-runtime/noloWorkspaceTools";
import {
  applyRowFilters,
  formatKnownColumns,
  normalizeRowValues,
  pickRowColumns,
  sortRows,
  type RowFilters,
} from "../../../render/table/toolValueUtils";
import { buildNewRow, ensureRowsLoaded, loadTableMetaOrThrow, patchRecord, resolveRowOrThrow, resolveTableIdentity, writeRow } from "./toolShared";

const toPreviewJson = (value: unknown, maxLength = 600): string => {
  try {
    const json = JSON.stringify(value, null, 2);
    if (json.length <= maxLength) return json;
    return `${json.slice(0, maxLength)}\n…(已截断)…`;
  } catch {
    return "[无法序列化为 JSON]";
  }
};

const selectCurrentUserId = (state: RootState) =>
  typeof state.auth?.currentUser?.userId === "string"
    ? state.auth.currentUser.userId
    : undefined;

const normalizeTableQueryArgs = (args: any, thunkApi: any) => {
  const state = thunkApi.getState() as RootState;
  return buildNoloTableQueryRequest(args ?? {}, selectCurrentUserId(state)) ?? args;
};

const requireTableIdentity = (args: { tenantId?: string; tableId?: string }, thunkApi: any) => {
  const state = thunkApi.getState() as RootState;
  const { tenantId, tableId } = resolveTableIdentity(args, state);
  if (!tenantId || !tableId) {
    throw new Error("需要显式提供 tenantId 和 tableId，或在已打开的表页面中调用。");
  }
  return { tenantId, tableId };
};

export const queryTableRowsFunctionSchema = {
  name: "queryTableRows",
  description: "查询指定表中的行，支持简单字段过滤、排序、分页和返回指定列。",
  parameters: {
    type: "object",
    properties: {
      tenantId: { type: "string", description: "租户 ID。聊天场景中必须显式传入。" },
      tableId: { type: "string", description: "表 ID。聊天场景中必须显式传入。" },
      table: { type: "string", description: "表 ID 或 meta-tenantId-tableId；兼容 Nolo CLI 参数。" },
      metaKey: { type: "string", description: "表 meta key；兼容 table。" },
      row: { type: "string", description: "可选 rowId 或 row-* dbKey，只查一行。" },
      filters: {
        type: "object",
        description: "按列名做精确匹配过滤，例如 {\"status\":\"todo\"}。",
      },
      columns: {
        type: "array",
        items: { type: "string" },
        description: "可选：只返回这些列。",
      },
      limit: { type: "number", description: "最多返回多少行，默认 20，最大 200。" },
      offset: { type: "number", description: "从第几行开始返回，默认 0。" },
      includeBaseFields: {
        type: "boolean",
        description: "配合 columns 使用。设为 false 时不额外返回 dbKey/rowId/tenantId/tableId/createdAt/updatedAt，适合任务表概览。",
      },
      sortBy: { type: "string", description: "排序字段，默认 updatedAt。" },
      sortOrder: {
        type: "string",
        enum: ["asc", "desc"],
        description: "排序方向，默认 desc。",
      },
    },
  },
};

export async function queryTableRowsFunc(args: any, thunkApi: any) {
  args = normalizeTableQueryArgs(args, thunkApi);
  const { tenantId, tableId } = requireTableIdentity(args, thunkApi);
  const tableMeta = await loadTableMetaOrThrow(thunkApi, tenantId, tableId);
  const rows = await ensureRowsLoaded(thunkApi, tenantId, tableId);
  const filters = (args?.filters ?? {}) as RowFilters;
  const limit = Math.min(Math.max(Number(args?.limit ?? 20), 1), 200);
  const offset = Math.max(Number(args?.offset ?? 0), 0);
  const sortBy = asOptionalTrimmedString(args?.sortBy) ?? "updatedAt";
  const sortOrder = args?.sortOrder === "asc" ? "asc" : "desc";
  const columns = Array.isArray(args?.columns)
    ? asNonEmptyStringArray(args.columns)
    : undefined;
  const includeBaseFields = args?.includeBaseFields !== false;

  const filtered = applyRowFilters(rows, filters);
  const sorted = sortRows(filtered, sortBy, sortOrder);
  const page = sorted.slice(offset, offset + limit);
  const items = columns ? page.map((row) => pickRowColumns(row, columns, { includeBaseFields })) : page;

  return {
    rawData: {
      tenantId,
      tableId,
      total: filtered.length,
      limit,
      offset,
      items,
    },
    displayData:
      `在表「${tableMeta.displayName || tableId}」中查询到 ${filtered.length} 行，当前返回 ${items.length} 行。\n` +
      `字段：${formatKnownColumns(tableMeta)}\n\n` +
      `${toPreviewJson(items)}`,
  };
}

export const updateTableRowFunctionSchema = {
  name: "updateTableRow",
  description: "按 rowId 或 dbKey 更新指定表中的一行数据，只修改 changes 中提供的字段。",
  parameters: {
    type: "object",
    properties: {
      tenantId: { type: "string" },
      tableId: { type: "string" },
      rowId: { type: "string", description: "要更新的行 ID。" },
      dbKey: { type: "string", description: "要更新的行 dbKey。rowId 与 dbKey 二选一即可。" },
      changes: {
        type: "object",
        description: "要修改的字段集合，例如 {\"status\":\"done\"}。",
      },
    },
    required: ["changes"],
  },
};

export async function updateTableRowFunc(args: any, thunkApi: any) {
  const { tenantId, tableId } = requireTableIdentity(args, thunkApi);
  const tableMeta = await loadTableMetaOrThrow(thunkApi, tenantId, tableId);
  const targetRow = await resolveRowOrThrow(thunkApi, { tenantId, tableId, rowId: args?.rowId, dbKey: args?.dbKey });
  const changes = args?.changes;

  if (!isRecord(changes)) {
    throw new Error("updateTableRow.changes 必须是对象。");
  }

  const normalized = normalizeRowValues(tableMeta.columns, changes, { mode: "update" });
  if (normalized.errors.length > 0) {
    throw new Error(normalized.errors.join("\n"));
  }
  if (Object.keys(normalized.sanitizedValues).length === 0) {
    throw new Error(
      `updateTableRow 没有可更新的有效字段。已知字段：${formatKnownColumns(tableMeta)}`
    );
  }

  const updatedAt = new Date().toISOString();
  const updated = await patchRecord(thunkApi, targetRow.dbKey, {
    ...normalized.sanitizedValues,
    updatedAt,
  });

  const ignoredInfo =
    normalized.ignoredColumns.length > 0
      ? `\n\n注意：以下字段已忽略：${normalized.ignoredColumns.join(", ")}`
      : "";

  return {
    rawData: updated,
    displayData:
      `已更新表「${tableMeta.displayName || tableId}」中的行 ${targetRow.rowId}。${ignoredInfo}\n\n` +
      `${toPreviewJson(updated)}`,
  };
}

export const deleteTableRowFunctionSchema = {
  name: "deleteTableRow",
  description: "删除指定表中的一行数据（软删除）。",
  parameters: {
    type: "object",
    properties: {
      tenantId: { type: "string" },
      tableId: { type: "string" },
      rowId: { type: "string" },
      dbKey: { type: "string" },
    },
  },
};

export async function deleteTableRowFunc(args: any, thunkApi: any) {
  const { tenantId, tableId } = requireTableIdentity(args, thunkApi);
  const tableMeta = await loadTableMetaOrThrow(thunkApi, tenantId, tableId);
  const targetRow = await resolveRowOrThrow(thunkApi, { tenantId, tableId, rowId: args?.rowId, dbKey: args?.dbKey });
  const updatedAt = new Date().toISOString();
  const deleted = await patchRecord(thunkApi, targetRow.dbKey, {
    deletedAt: updatedAt,
    updatedAt,
  });

  return {
    rawData: deleted,
    displayData: `已从表「${tableMeta.displayName || tableId}」中删除行 ${targetRow.rowId}。`,
  };
}

export const addTableRowsFunctionSchema = {
  name: "addTableRows",
  description: "批量向指定表中新增多行数据。",
  parameters: {
    type: "object",
    properties: {
      tenantId: { type: "string" },
      tableId: { type: "string" },
      rows: {
        type: "array",
        items: { type: "object" },
        description: "每一项都是一行数据对象，key 必须是表中的列名。",
      },
    },
    required: ["rows"],
  },
};

export async function addTableRowsFunc(args: any, thunkApi: any) {
  const { tenantId, tableId } = requireTableIdentity(args, thunkApi);
  const tableMeta = await loadTableMetaOrThrow(thunkApi, tenantId, tableId);
  const rows = Array.isArray(args?.rows) ? args.rows : [];
  if (rows.length === 0) {
    throw new Error("addTableRows.rows 至少需要包含一行。");
  }

  const createdRows: any[] = [];
  const ignoredColumns = new Set<string>();
  // Validate + normalize all rows first so validation failure never leaves partial writes.
  for (const row of rows) {
    if (!isRecord(row)) {
      throw new Error("addTableRows.rows 中的每一项都必须是对象。");
    }
    const normalized = normalizeRowValues(tableMeta.columns, row, { mode: "create" });
    if (normalized.errors.length > 0) {
      throw new Error(normalized.errors.join("\n"));
    }
    if (Object.keys(normalized.sanitizedValues).length === 0) {
      throw new Error(`存在一行没有任何有效字段。已知字段：${formatKnownColumns(tableMeta)}`);
    }
    normalized.ignoredColumns.forEach((column) => ignoredColumns.add(column));
    createdRows.push(buildNewRow(tenantId, tableId, normalized.sanitizedValues));
  }
  await Promise.all(createdRows.map((row) => writeRow(thunkApi, row)));

  const ignoredInfo =
    ignoredColumns.size > 0 ? `\n\n注意：以下字段已忽略：${Array.from(ignoredColumns).join(", ")}` : "";

  return {
    rawData: {
      count: createdRows.length,
      items: createdRows,
    },
    displayData:
      `已向表「${tableMeta.displayName || tableId}」批量新增 ${createdRows.length} 行。${ignoredInfo}\n\n` +
      `${toPreviewJson(createdRows.slice(0, 10))}`,
  };
}

export const updateTableRowsFunctionSchema = {
  name: "updateTableRows",
  description: "批量更新多行数据。每项都需要 rowId 或 dbKey，以及 changes。",
  parameters: {
    type: "object",
    properties: {
      tenantId: { type: "string" },
      tableId: { type: "string" },
      updates: {
        type: "array",
        items: {
          type: "object",
          properties: {
            rowId: { type: "string" },
            dbKey: { type: "string" },
            changes: { type: "object" },
          },
        },
      },
    },
    required: ["updates"],
  },
};

export async function updateTableRowsFunc(args: any, thunkApi: any) {
  const { tenantId, tableId } = requireTableIdentity(args, thunkApi);
  const tableMeta = await loadTableMetaOrThrow(thunkApi, tenantId, tableId);
  const updates = Array.isArray(args?.updates) ? args.updates : [];
  if (updates.length === 0) {
    throw new Error("updateTableRows.updates 至少需要包含一项。");
  }

  const results: any[] = [];
  const ignoredColumns = new Set<string>();
  for (const item of updates) {
    if (!isRecord(item)) {
      throw new Error("updateTableRows.updates 中的每一项都必须是对象。");
    }
    const targetRow = await resolveRowOrThrow(thunkApi, {
      tenantId,
      tableId,
      rowId: item.rowId as string | undefined,
      dbKey: item.dbKey as string | undefined,
    });
    const normalized = normalizeRowValues(tableMeta.columns, item.changes ?? {}, { mode: "update" });
    if (normalized.errors.length > 0) {
      throw new Error(normalized.errors.join("\n"));
    }
    if (Object.keys(normalized.sanitizedValues).length === 0) {
      throw new Error(`行 ${targetRow.rowId} 没有可更新的有效字段。`);
    }
    normalized.ignoredColumns.forEach((column) => ignoredColumns.add(column));
    const updated = await patchRecord(thunkApi, targetRow.dbKey, {
      ...normalized.sanitizedValues,
      updatedAt: new Date().toISOString(),
    });
    results.push(updated);
  }

  const ignoredInfo =
    ignoredColumns.size > 0 ? `\n\n注意：以下字段已忽略：${Array.from(ignoredColumns).join(", ")}` : "";

  return {
    rawData: {
      count: results.length,
      items: results,
    },
    displayData:
      `已批量更新表「${tableMeta.displayName || tableId}」中的 ${results.length} 行。${ignoredInfo}`,
  };
}

export const deleteTableRowsFunctionSchema = {
  name: "deleteTableRows",
  description: "批量删除多行数据（软删除）。",
  parameters: {
    type: "object",
    properties: {
      tenantId: { type: "string" },
      tableId: { type: "string" },
      rowIds: {
        type: "array",
        items: { type: "string" },
        description: "要删除的 rowId 列表。",
      },
      dbKeys: {
        type: "array",
        items: { type: "string" },
        description: "要删除的 dbKey 列表。",
      },
    },
  },
};

export async function deleteTableRowsFunc(args: any, thunkApi: any) {
  const { tenantId, tableId } = requireTableIdentity(args, thunkApi);
  const tableMeta = await loadTableMetaOrThrow(thunkApi, tenantId, tableId);
  const rowIds = Array.isArray(args?.rowIds) ? args.rowIds : [];
  const dbKeys = Array.isArray(args?.dbKeys) ? args.dbKeys : [];
  const targets = [
    ...rowIds.map((rowId: string) => ({ rowId })),
    ...dbKeys.map((dbKey: string) => ({ dbKey })),
  ];

  if (targets.length === 0) {
    throw new Error("deleteTableRows 需要至少提供一个 rowId 或 dbKey。");
  }

  const results = await Promise.all(
    targets.map(async (target) => {
      const row = await resolveRowOrThrow(thunkApi, {
        tenantId,
        tableId,
        rowId: target.rowId,
        dbKey: target.dbKey,
      });
      return patchRecord(thunkApi, row.dbKey, {
        deletedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    })
  );

  return {
    rawData: {
      count: results.length,
      items: results,
    },
    displayData: `已从表「${tableMeta.displayName || tableId}」中批量删除 ${results.length} 行。`,
  };
}
