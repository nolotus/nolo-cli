// 文件: render/table/createTableAction.ts

import { formatISO } from "date-fns";
import { ulid } from "ulid";
import i18n from "../../app/i18n/client";

import type { RootState, AppDispatch } from "../../app/store";
import { selectUserId } from "../../auth/authSlice";
import {
  addContentToSpace,
  selectCurrentSpaceId,
} from "../../create/space/spaceSlice";
import { write } from "../../database/dbSlice";
import { metaKey, rowKey } from "../../database/keys";
import { DataType } from "../../create/types";

import type {
  TableColumn,
  TableColumnType,
  CreateTableColumnInput,
  TableMeta,
  TablePublicIntakeConfig,
} from "./types";

/**
 * 创建表时的输入参数：
 * - spaceId        可选：不传则用当前 Space
 * - title          可选：不传用默认文案（表显示名）
 * - description    可选：表用途说明（包括每行代表什么，给人和 AI 看）
 * - tags           可选：关键词标签列表（由 Agent 自动填比较合理）
 * - categoryId     可选：Space 内分类
 * - columns        可选：表字段定义（对象数组）
 *   - 不传或为空时，自动使用默认两列：
 *     1) title / 标题（主字段）
 *     2) note  / 备注
 * - withDefaultRows 可选：是否创建两行示例数据
 */
export interface CreateTableArgs {
  spaceId?: string;
  title?: string;
  purpose?: string;
  description?: string;
  tags?: string[];
  publicIntake?: TablePublicIntakeConfig;
  categoryId?: string;
  columns?: CreateTableColumnInput[];
  withDefaultRows?: boolean;
}

// 默认列定义：标题 + 备注
const DEFAULT_COLUMNS: Omit<TableColumn, "id">[] = [
  {
    name: "title",
    label: "标题",
    type: "text",
    description: "这一行记录的主题或名称。",
    isPrimary: true,
    required: true,
  },
  {
    name: "note",
    label: "备注",
    type: "text",
    description: "对该条目的补充说明。",
    required: false,
  },
];

/**
 * 将 CreateTableColumnInput[] 归一化成 TableColumn[]
 * - 为每一列生成 id
 * - 清洗 name / label / type / description / isPrimary / required / options
 * - 如果结果为空，则使用 DEFAULT_COLUMNS
 */
const normalizeColumns = (
  inputColumns: CreateTableColumnInput[] | undefined
): TableColumn[] => {
  const base = Array.isArray(inputColumns) ? inputColumns : [];

  const normalized: TableColumn[] = base
    .map((c) => {
      if (!c || typeof c.name !== "string") return null;
      const name = c.name.trim();
      if (!name) return null;

      const col: TableColumn = {
        id: c.id && typeof c.id === "string" && c.id.trim() ? c.id.trim() : ulid(),
        name,
      };

      if (typeof c.label === "string" && c.label.trim()) {
        col.label = c.label.trim();
      }

      if (typeof c.type === "string") {
        col.type = c.type as TableColumnType;
      }

      if (typeof c.description === "string" && c.description.trim()) {
        col.description = c.description.trim();
      }

      if (typeof c.isPrimary === "boolean") {
        col.isPrimary = c.isPrimary;
      }

      if (typeof c.required === "boolean") {
        col.required = c.required;
      }

      if (Array.isArray(c.options)) {
        const opts = c.options
          .map((opt) => (typeof opt === "string" ? opt.trim() : ""))
          .filter(Boolean);
        if (opts.length) {
          col.options = opts;
        }
      }

      return col;
    })
    .filter(Boolean) as TableColumn[];

  if (normalized.length > 0) {
    // 确保有一个主字段：如果没有 isPrimary，就把第一列设为主字段
    if (!normalized.some((c) => c.isPrimary)) {
      normalized[0].isPrimary = true;
    }
    return normalized;
  }

  // 未提供列时，使用默认：标题 + 备注
  return DEFAULT_COLUMNS.map((c) => ({
    ...c,
    id: ulid(),
  }));
};

const normalizeStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
  return items.length ? Array.from(new Set(items)) : undefined;
};

const normalizePublicIntake = (
  input: TablePublicIntakeConfig | undefined
): TablePublicIntakeConfig | undefined => {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;

  const allowedFields = normalizeStringArray(input.allowedFields) ?? [];
  if (input.enabled !== true) {
    return { enabled: false, allowedFields };
  }
  if (allowedFields.length === 0) {
    throw new Error("publicIntake.allowedFields 至少需要一个字段。");
  }

  const slug =
    typeof input.slug === "string" && input.slug.trim() ? input.slug.trim() : undefined;
  const honeypotField =
    typeof input.honeypotField === "string" && input.honeypotField.trim()
      ? input.honeypotField.trim()
      : undefined;
  return {
    enabled: true,
    ...(slug ? { slug } : {}),
    ...(normalizeStringArray(input.appIds) ? { appIds: normalizeStringArray(input.appIds) } : {}),
    allowedFields,
    ...(normalizeStringArray(input.requiredFields)
      ? { requiredFields: normalizeStringArray(input.requiredFields) }
      : {}),
    ...(honeypotField ? { honeypotField } : {}),
  };
};

/**
 * 类似 createPageAction：
 * 1) 基于当前 userId 生成 tableId + metaKey
 * 2) 写入 TABLE meta
 * 3) 可选：写入两行 TABLE_ROW 默认数据
 * 4) 如果有 spaceId（或当前 Space），自动 addContentToSpace
 * 5) 返回 dbKey（路由用）
 */
export const createTableAction = async (
  {
    spaceId: customSpaceId,
    title: customTitle,
    purpose: customPurpose,
    description: customDescription,
    tags: customTags,
    publicIntake,
    categoryId,
    columns,
    withDefaultRows = true,
  }: CreateTableArgs = {},
  { dispatch, getState }: { dispatch: AppDispatch; getState: () => RootState }
): Promise<string> => {
  const state = getState();
  const userId = selectUserId(state);
  if (!userId) throw new Error("User ID not found.");

  // Important:
  // View-mode-based scoping belongs to the UI entry layer (currently the sidebar-top
  // create button), not to this action.
  // This action preserves explicit caller intent:
  // - prefer `spaceId` when a caller passes it;
  // - otherwise fall back to the current selected space only.
  const spaceId = customSpaceId ?? selectCurrentSpaceId(state);

  const tableId = ulid();

  const now = new Date();
  const nowIso = formatISO(now);

  const dbKey = metaKey(userId, tableId);

  const defaultTitle = i18n.t("table:defaultTitle", {
    defaultValue: "新建表格",
  });
  const title = customTitle?.trim() || defaultTitle;

  const purpose = customPurpose?.trim() || undefined;
  const description = customDescription?.trim() || undefined;
  const tags =
    Array.isArray(customTags) && customTags.length
      ? customTags
        .map((t) => (typeof t === "string" ? t.trim() : ""))
        .filter(Boolean)
      : undefined;
  const finalPublicIntake = normalizePublicIntake(publicIntake);

  // 1) 归一化列定义
  const finalColumns: TableColumn[] = normalizeColumns(columns);

  // 2) 写入表 meta（TABLE）
  const tableMeta: TableMeta = {
    dbKey,
    tenantId: userId,
    tableId,
    spaceId: spaceId ?? null,
    displayName: title,
    purpose,
    description,
    tags,
    schemaVersion: 1,
    columns: finalColumns,
    views: [], // 后续可以在 UI 中新增视图
    triggers: [], // 后续可以在 UI/配置中新增触发器
    aiConfig: undefined,
    ...(finalPublicIntake ? { publicIntake: finalPublicIntake } : {}),
    createdAt: nowIso,
    updatedAt: nowIso,
    type: DataType.TABLE,
  };

  await dispatch(
    write({
      data: tableMeta,
      customKey: dbKey,
    })
  ).unwrap();

  // 3) 可选：写入两行默认数据（TABLE_ROW）
  if (withDefaultRows) {
    const defaultRows = [
      {
        title: "示例一",
        note: "你可以在这里记录任何内容，例如任务、想法或配置项。",
      },
      {
        title: "示例二",
        note: '双击单元格开始编辑，右上角可以添加字段和行。',
      },
    ];

    await Promise.all(
      defaultRows.map(async (values) => {
        const { dbKey: rowKeyStr, rowId } = rowKey.create(userId, tableId);

        const row = {
          dbKey: rowKeyStr,
          tenantId: userId,
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
            customKey: rowKeyStr,
          })
        ).unwrap();
      })
    );
  }

  // 4) 如果在某个 Space 中，把表挂到 Space.contents（关键点）
  if (spaceId) {
    await dispatch(
      (addContentToSpace as any)({
        spaceId,
        contentKey: dbKey,
        type: DataType.TABLE, // ContentType 里要有 "table"
        title,
        categoryId,
      })
    ).unwrap();
  }

  // 5) 返回 dbKey，用于路由跳转 /meta-{tenantId}-{tableId}
  return dbKey;
};
