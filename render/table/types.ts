// 文件: render/table/types.ts

import { DataType } from "../../create/types";
import type { ContentIcon } from "../contentIcon/types";

/* --------------------------------------------------------------------------
 * 1. 列类型（TableColumn）
 * ------------------------------------------------------------------------*/

export type TableColumnType =
    | "text"
    | "number"
    | "boolean"
    | "date"
    | "datetime"
    | "select"
    | "multi_select";
// 将来可以扩展: "relation" | "json" | "file" 等

/**
 * 表字段定义（列）
 *
 * 说明：
 * - id：列自身的稳定 ID，供公式 / 视图 / 触发器 / Agent 配置引用
 * - name：行数据中的 key（machine name）
 * - label：展示名，可中文；不填时 UI 回退为 name
 * - type + required + options：构成字段的“域约束”
 * - description：给人和 AI 的语义说明
 * - isPrimary：标记“这一行是谁”的主字段（行标题）
 */
export interface TableColumn {
    /** 列内部 ID（稳定，不随 name 改动） */
    id: string;

    /** 行中的字段名（机器名），建议英文/拼音，无空格 */
    name: string;

    /** 字段显示名，可中文；不填时 UI 用 name */
    label?: string;

    /** 字段类型（默认 text） */
    type?: TableColumnType;

    /** 字段说明：给人和 AI 看的描述 */
    description?: string;

    /** 是否为主字段（行标题），类似 Notion 的 Name 列 */
    isPrimary?: boolean;

    /** 是否必填 */
    required?: boolean;

    /**
     * 离散取值集合，仅在 type 为 select / multi_select 时有意义。
     * 先用 string[] 简化，将来可以扩展为对象数组（带颜色/顺序等）。
     */
    options?: string[];

    /**
     * 自定义列宽（像素），仅影响 UI 展示。
     * - 不设置时由浏览器根据内容自适应宽度；
     * - 设置后在所有视图中保持一致宽度（后续可以细化到 view 级别）。
     */
    width?: number;
}

/**
 * 创建表时，传入的列配置：
 * - id 由系统生成，外部一般不传
 */
export type CreateTableColumnInput = Omit<TableColumn, "id"> & { id?: string };

/* --------------------------------------------------------------------------
 * 2. 视图（TableView）
 * ------------------------------------------------------------------------*/

export type TableViewType = "grid" | "kanban" | "calendar";

export type SortDirection = "asc" | "desc";

/**
 * 简化版排序规则
 */
export interface TableViewSortRule {
    columnId: string; // 引用 TableColumn.id
    direction: SortDirection;
}

/**
 * 过滤规则：
 * - 这里先保留占位，后续可以演进为一套 DSL / JSON Schema
 */
export interface TableViewFilter {
    // 将来可以改成 { op: "and" | "or"; conditions: Condition[] } 等
    [key: string]: any;
}

/**
 * 分组配置（例如看板分组）
 */
export interface TableViewGroup {
    columnId: string; // 按哪个列分组
}

/**
 * 视图定义：
 * - 用来描述“这一张表在某个视角下如何展示/筛选/排序”
 * - 未来 UI 和 Agent 都可以基于 View 工作
 */
export interface TableView {
    id: string;
    name: string;
    type: TableViewType;

    /** 是否为默认视图 */
    isDefault?: boolean;

    /** 当前视图中可见的列（按列 id 排序） */
    visibleColumnIds: string[];

    /** 排序规则（可选） */
    sort?: TableViewSortRule[];

    /** 过滤规则（可选） */
    filter?: TableViewFilter;

    /** 分组（看板/分组表格） */
    group?: TableViewGroup | null;

    /**
     * 给 AI 的附加说明：
     * - 例如「本视图只展示未完成任务」「按项目分组」等
     */
    aiHint?: string;
}

/* --------------------------------------------------------------------------
 * 3. 触发器（TableTrigger）：行变更 → Agent / Webhook 等
 * ------------------------------------------------------------------------*/

// 目前 Trigger 还没有真正落库和实现逻辑，可以仅保留类型占位，
// 后续如做通用 Trigger 中心建议迁移到 core/events/types.ts。

export type TableTriggerEvent = "row_created" | "row_updated" | "row_deleted";

export type TableTriggerActionType = "agent" | "webhook" | "custom";

export interface TableTriggerCondition {
    kind: "match_column_value";
    columnId: string; // TableColumn.id
    operator: "eq" | "ne" | "in" | "not_in" | "contains";
    value: any;
}

export interface TableTriggerActionConfig {
    agentKey?: string;
    url?: string;
    method?: "GET" | "POST" | "PUT" | "DELETE";
    [key: string]: any;
}

export interface TableTrigger {
    id: string;
    name: string;
    description?: string;
    enabled: boolean;

    event: TableTriggerEvent;
    viewId?: string;
    condition?: TableTriggerCondition;

    actionType: TableTriggerActionType;
    actionConfig?: TableTriggerActionConfig;
}

/* --------------------------------------------------------------------------
 * 4. 表 AI 配置（TableAiConfig）
 * ------------------------------------------------------------------------*/

export interface TableAiConfig {
    enabled: boolean;
    purpose?: string;
    allowedOperations?: {
        createRow?: boolean;
        updateRow?: boolean;
        deleteRow?: boolean;
        modifySchema?: boolean;
    };
    privacy?: {
        maskColumnIds?: string[];
    };
}

export interface TablePublicIntakeConfig {
    enabled: boolean;
    slug?: string;
    appIds?: string[];
    allowedFields: string[];
    requiredFields?: string[];
    honeypotField?: string;
}

/* --------------------------------------------------------------------------
 * 5. 表 Meta（TableMeta）
 * ------------------------------------------------------------------------*/

/**
 * 表的元信息：
 * - 跟具体存储键（meta-{tenantId}-{tableId}）一一对应
 * - 是 schema + 视图 + 触发器 + AI 配置的集中描述
 *
 * Invariant:
 * - 对任意 TableMeta(dbKey = meta-{tenantId}-{tableId})，
 *   所有行必须满足 row.tenantId === tenantId 且 row.tableId === tableId。
 */
export interface TableMeta {
    /** meta dbKey: meta-{tenantId}-{tableId} */
    dbKey: string;

    tenantId: string;
    tableId: string;
    spaceId?: string | null;

    /** 表显示名（可中文） */
    displayName?: string;

    /** 表格自定义图标；未设置时 UI 使用默认表格图标。 */
    icon?: ContentIcon | null;

    /**
     * 机器可读用途，用于在当前用户/space 范围内查找某类表。
     * 例如 agent_eval_workbench。
     */
    purpose?: string;

    /**
     * 表用途说明，给人和 AI 都看的版本：
     * 建议包括：
     * - 每一行代表什么
     * - 这张表大致用来干什么
     */
    description?: string;

    /**
     * 任意关键词标签，仅供 AI / 系统使用：
     * 例如 ["记账","交易","财务"] / ["衣服","穿搭","旅行"]。
     * 用户不必手动维护，可由 Agent 在创建表时自动填入。
     */
    tags?: string[];

    /** schema 版本号，用于将来迁移，起步可以固定为 1 */
    schemaVersion?: number;

    /** 列定义 */
    columns: TableColumn[];

    /** 视图列表（可选） */
    views?: TableView[];

    /** 表级触发器列表（可选） */
    triggers?: TableTrigger[];

    /** AI 配置（可选） */
    aiConfig?: TableAiConfig;

    /**
     * 公开匿名写入配置。
     * 只用于 append-only intake 场景；公开提交端点必须按 allowedFields 白名单写入。
     */
    publicIntake?: TablePublicIntakeConfig;

    createdAt: string;
    updatedAt: string;

    /** 类型标记：table */
    type: DataType.TABLE;
}
