import { isRecord } from "../../core/isRecord";
import { asOptionalFiniteNumber } from "../../core/optionalNumber";
import { asTrimmedLowercaseString } from "../../core/trimmedLowercaseString";

import type { TableColumn, TableMeta } from "./types";

const RESERVED_ROW_KEYS = new Set([
  "dbKey",
  "tenantId",
  "tableId",
  "rowId",
  "createdAt",
  "updatedAt",
  "deletedAt",
  "type",
]);

export type RowFilterValue =
  | string
  | number
  | boolean
  | null
  | string[]
  | number[]
  | boolean[];

export type RowFilters = Record<string, RowFilterValue>;

export type NormalizeRowOptions = {
  mode?: "create" | "update";
};

export type NormalizeRowResult = {
  sanitizedValues: Record<string, any>;
  ignoredColumns: string[];
  errors: string[];
};

const hasOwn = (value: unknown, key: string): boolean =>
  isRecord(value) && Object.prototype.hasOwnProperty.call(value, key);

export const getRowValueByPath = (row: any, key: string): { exists: boolean; value: any } => {
  if (!key) return { exists: false, value: undefined };
  if (hasOwn(row, key)) {
    return { exists: true, value: row[key] };
  }
  if (!key.includes(".")) {
    return { exists: false, value: undefined };
  }

  let current = row;
  for (const part of key.split(".")) {
    if (!part || !hasOwn(current, part)) {
      return { exists: false, value: undefined };
    }
    current = current[part];
  }
  return { exists: true, value: current };
};

const setValueByPath = (target: Record<string, any>, key: string, value: any) => {
  if (!key.includes(".")) {
    target[key] = value;
    return;
  }
  const parts = key.split(".").filter(Boolean);
  if (!parts.length) return;
  let current = target;
  for (const part of parts.slice(0, -1)) {
    if (!isRecord(current[part])) {
      current[part] = {};
    }
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
};

const isBlank = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (typeof value === "string" && value.trim() === "");

const normalizeBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === "string") {
    const normalized = asTrimmedLowercaseString(value);
    if (["true", "1", "yes", "y"].includes(normalized)) return true;
    if (["false", "0", "no", "n"].includes(normalized)) return false;
  }
  return undefined;
};

const normalizeDate = (value: unknown): string | undefined => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString().slice(0, 10);
};

const normalizeDateTime = (value: unknown): string | undefined => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
};

const normalizeMultiSelectInput = (value: unknown): string[] | undefined => {
  if (Array.isArray(value)) {
    const list = value
      .map((item) =>
        typeof item === "string" || typeof item === "number" || typeof item === "boolean"
          ? String(item).trim()
          : ""
      )
      .filter(Boolean);
    return list;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    return trimmed
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return undefined;
};

const normalizeSingleValue = (
  column: TableColumn,
  rawValue: unknown
): { value?: any; error?: string } => {
  if (rawValue === undefined) {
    return { value: undefined };
  }

  if (rawValue === null) {
    if (column.required) {
      return { error: `字段 ${column.name} 是必填项，不能设为 null。` };
    }
    return { value: null };
  }

  switch (column.type ?? "text") {
    case "number": {
      const finiteNumber = asOptionalFiniteNumber(rawValue);
      if (finiteNumber !== undefined) {
        return { value: finiteNumber };
      }
      if (typeof rawValue === "string" && rawValue.trim()) {
        const parsed = Number(rawValue);
        if (Number.isFinite(parsed)) {
          return { value: parsed };
        }
      }
      return { error: `字段 ${column.name} 需要 number 值。` };
    }
    case "boolean": {
      const normalized = normalizeBoolean(rawValue);
      if (normalized === undefined) {
        return { error: `字段 ${column.name} 需要 boolean 值。` };
      }
      return { value: normalized };
    }
    case "date": {
      const normalized = normalizeDate(rawValue);
      if (!normalized) {
        return { error: `字段 ${column.name} 需要日期字符串（YYYY-MM-DD）。` };
      }
      return { value: normalized };
    }
    case "datetime": {
      const normalized = normalizeDateTime(rawValue);
      if (!normalized) {
        return { error: `字段 ${column.name} 需要可解析的日期时间字符串。` };
      }
      return { value: normalized };
    }
    case "select": {
      const normalized =
        typeof rawValue === "string" || typeof rawValue === "number" || typeof rawValue === "boolean"
          ? String(rawValue).trim()
          : "";
      if (!normalized) {
        return { error: `字段 ${column.name} 需要非空字符串。` };
      }
      if (Array.isArray(column.options) && column.options.length > 0 && !column.options.includes(normalized)) {
        return {
          error: `字段 ${column.name} 只能是以下值之一：${column.options.join(", ")}。`,
        };
      }
      return { value: normalized };
    }
    case "multi_select": {
      const normalized = normalizeMultiSelectInput(rawValue);
      if (!normalized) {
        return { error: `字段 ${column.name} 需要字符串数组，或逗号分隔字符串。` };
      }
      if (Array.isArray(column.options) && column.options.length > 0) {
        const invalid = normalized.filter((item) => !column.options?.includes(item));
        if (invalid.length > 0) {
          return {
            error: `字段 ${column.name} 包含非法选项：${invalid.join(", ")}。允许值：${column.options.join(", ")}。`,
          };
        }
      }
      return { value: normalized };
    }
    case "text":
    default: {
      if (typeof rawValue === "string") return { value: rawValue };
      if (
        typeof rawValue === "number" ||
        typeof rawValue === "boolean"
      ) {
        return { value: String(rawValue) };
      }
      return { value: rawValue };
    }
  }
};

export const normalizeRowValues = (
  columns: TableColumn[],
  values: Record<string, any>,
  options: NormalizeRowOptions = {}
): NormalizeRowResult => {
  const mode = options.mode ?? "create";
  const allowedColumns = new Map(columns.map((column) => [column.name, column]));
  const sanitizedValues: Record<string, any> = {};
  const ignoredColumns: string[] = [];
  const errors: string[] = [];

  for (const [key, value] of Object.entries(values || {})) {
    if (RESERVED_ROW_KEYS.has(key)) {
      ignoredColumns.push(key);
      continue;
    }

    const column = allowedColumns.get(key);
    if (!column) {
      ignoredColumns.push(key);
      continue;
    }

    const normalized = normalizeSingleValue(column, value);
    if (normalized.error) {
      errors.push(normalized.error);
      continue;
    }

    if (normalized.value !== undefined) {
      sanitizedValues[key] = normalized.value;
    }
  }

  if (mode === "create") {
    const missingRequired = columns
      .filter((column) => column.required)
      .filter((column) => isBlank(sanitizedValues[column.name]))
      .map((column) => column.name);

    if (missingRequired.length > 0) {
      errors.push(`缺少必填字段：${missingRequired.join(", ")}。`);
    }
  }

  return {
    sanitizedValues,
    ignoredColumns,
    errors,
  };
};

export const applyRowFilters = (rows: any[], filters?: RowFilters): any[] => {
  if (!filters || Object.keys(filters).length === 0) return rows;

  return rows.filter((row) =>
    Object.entries(filters).every(([key, expected]) => {
      const { exists, value: actual } = getRowValueByPath(row, key);
      if (!exists) return false;
      if (Array.isArray(expected)) {
        if (Array.isArray(actual)) {
          return expected.every((item) => actual.includes(item));
        }
        return (expected as unknown as string).includes(actual as string);
      }
      if (Array.isArray(actual)) {
        return actual.includes(expected);
      }
      return actual === expected;
    })
  );
};

export const sortRows = (
  rows: any[],
  sortBy = "updatedAt",
  sortOrder: "asc" | "desc" = "desc"
): any[] => {
  const factor = sortOrder === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = getRowValueByPath(a, sortBy).value;
    const right = getRowValueByPath(b, sortBy).value;

    if (left == null && right == null) return 0;
    if (left == null) return 1;
    if (right == null) return -1;

    if (typeof left === "number" && typeof right === "number") {
      return (left - right) * factor;
    }

    const leftTs = Date.parse(String(left));
    const rightTs = Date.parse(String(right));
    if (Number.isFinite(leftTs) && Number.isFinite(rightTs)) {
      return (leftTs - rightTs) * factor;
    }

    return String(left).localeCompare(String(right)) * factor;
  });
};

export const pickRowColumns = (
  row: any,
  columns?: string[],
  options: { includeBaseFields?: boolean } = {}
): any => {
  if (!Array.isArray(columns) || columns.length === 0) return row;

  const picked: Record<string, any> = {};
  for (const key of columns) {
    const { exists, value } = getRowValueByPath(row, key);
    if (exists) {
      setValueByPath(picked, key, value);
    }
  }

  if (options.includeBaseFields !== false) {
    for (const baseKey of ["dbKey", "rowId", "tenantId", "tableId", "createdAt", "updatedAt"]) {
      if (baseKey in row) {
        picked[baseKey] = row[baseKey];
      }
    }
  }

  return picked;
};

export const formatKnownColumns = (tableMeta: TableMeta): string =>
  tableMeta.columns.map((column) => column.name).join(", ") || "(无列定义)";
