// 文件: ai/tools/table/createTableTool.ts

import { createTable } from "../../../render/table/tableSlice";
import { SEPARATOR } from "../../../database/keys";

type ColumnType =
    | "text"
    | "number"
    | "boolean"
    | "date"
    | "datetime"
    | "select"
    | "multi_select";

interface ToolTableColumnInput {
    name: string;
    label?: string;
    type?: ColumnType;
    description?: string;
    required?: boolean;
    options?: string[];
}

type PublicIntakeConfigInput = {
    enabled: boolean;
    slug?: string;
    appIds?: string[];
    allowedFields: string[];
    requiredFields?: string[];
    honeypotField?: string;
};

type CreateTableToolArgs = {
    spaceId?: string;
    title?: string;
    purpose?: string;
    description?: string;
    tags?: string[];
    publicIntake?: PublicIntakeConfigInput;
    categoryId?: string;
    columns: ToolTableColumnInput[];
    withDefaultRows?: boolean;
};

type CreateTableResult = {
    rawData: any;
    displayData: string;
};

/**
 * 解析 meta dbKey，得到 tenantId / tableId
 * 约定：meta-{tenantId}-{tableId}
 */
const parseMetaKey = (dbKey: string): { tenantId: string; tableId: string } => {
    const parts = dbKey.split(SEPARATOR);
    if (parts[0] !== "meta" || parts.length < 3) {
        return { tenantId: "", tableId: "" };
    }
    const tenantId = parts[1];
    const tableId = parts.slice(2).join(SEPARATOR);
    return { tenantId, tableId };
};

const toPreviewJson = (value: unknown, maxLength = 400): string => {
    try {
        const json = JSON.stringify(value, null, 2);
        if (json.length <= maxLength) return json;
        return `${json.slice(0, maxLength)}\n…(已截断)…`;
    } catch {
        return "[无法序列化为 JSON]";
    }
};

/**
 * [Schema] createTable：为当前用户创建一张新表
 */
export const createTableFunctionSchema = {
    name: "createTable",
    description: [
        "在当前用户（租户）下创建一张新的结构化数据表。",
        "根据用户的描述，设计表的标题（title）、用途说明（description）以及字段列表（columns）。",
        "字段名建议使用简洁的英文或拼音（如 name, desc, status, dueDate），避免空格和特殊符号。",
    ].join("\n"),
    parameters: {
        type: "object",
        properties: {
            spaceId: {
                type: "string",
                description:
                    "可选：指定要创建到的 Space ID。不传则使用当前 Space。",
            },
            title: {
                type: "string",
                description:
                    "表的显示名称，可以使用中文，例如「任务清单」「客户管理」。",
            },
            purpose: {
                type: "string",
                description:
                    "可选：机器可读用途，用于之后在当前用户/Space 范围内查找这类表，例如 agent_eval_workbench。不要用它写自然语言说明。",
            },
            description: {
                type: "string",
                description:
                    "表用途说明（给人和 AI 看）：建议描述每一行代表什么，以及这张表大致用来干什么。",
            },
            tags: {
                type: "array",
                items: { type: "string" },
                description:
                    "可选：表示该表的关键词标签列表，例如 [\"记账\",\"交易\",\"预算\"]。主要供 AI 选表使用，用户无需手动维护。",
            },
            publicIntake: {
                type: "object",
                description:
                    "可选：开启公开匿名表单提交。只适合收集需求、报名、反馈等 append-only 数据；公开访客只能写入 allowedFields，不能读取/修改/删除表。",
                properties: {
                    enabled: {
                        type: "boolean",
                        description: "是否开启公开提交。",
                    },
                    slug: {
                        type: "string",
                        description:
                            "公开提交使用的短标识，例如 consult-leads。前端提交时传 table=slug。",
                    },
                    appIds: {
                        type: "array",
                        items: { type: "string" },
                        description:
                            "可选：允许提交到这张表的 appId 列表。配置后，公开提交必须携带匹配 appId。",
                    },
                    allowedFields: {
                        type: "array",
                        items: { type: "string" },
                        description:
                            "允许公开访客写入的字段 machine name 白名单，例如 [\"need\",\"email\",\"wechat\"]。",
                    },
                    requiredFields: {
                        type: "array",
                        items: { type: "string" },
                        description:
                            "公开提交时必填的字段 machine name，例如 [\"need\"]。",
                    },
                    honeypotField: {
                        type: "string",
                        description:
                            "可选：反垃圾隐藏字段名。访客填写了该字段时，服务端会忽略提交。",
                    },
                },
                required: ["enabled", "allowedFields"],
            },
            categoryId: {
                type: "string",
                description: "可选：Space 内分类 ID。",
            },
            columns: {
                type: "array",
                description: [
                    "要创建的字段列表，至少包含 1 个字段。",
                    "字段顺序会按数组顺序保存。",
                    "",
                    "每个字段对象支持：",
                    "- name: 字段 machine 名（英文/拼音，无空格），必填；",
                    "- label: 字段显示名，可中文；",
                    "- type: 字段类型，默认 text，可选：text/number/boolean/date/datetime/select/multi_select；",
                    "- description: 字段含义说明，给人和 AI 看；",
                    "- required: 是否必填；",
                    "- options: 对于 select/multi_select 的可选值列表。",
                ].join("\n"),
                minItems: 1,
                items: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string",
                            description:
                                "字段名（machine name），例如 name、desc、status、dueDate。必须是单个标识符，不要包含空格。",
                        },
                        label: {
                            type: "string",
                            description:
                                "字段显示名，可中文，例如「订单金额」「备注」。不填时前端会回退为 name。",
                        },
                        type: {
                            type: "string",
                            enum: [
                                "text",
                                "number",
                                "boolean",
                                "date",
                                "datetime",
                                "select",
                                "multi_select",
                            ],
                            description:
                                "字段类型，默认 text。选择类字段请使用 select 或 multi_select。",
                        },
                        description: {
                            type: "string",
                            description:
                                "字段含义说明，既给用户也给 AI 看，例如「订单金额（单位人民币）」。",
                        },
                        required: {
                            type: "boolean",
                            description: "是否为必填字段。",
                        },
                        options: {
                            type: "array",
                            items: { type: "string" },
                            description:
                                "当 type 为 select 或 multi_select 时可用，表示允许的取值列表，例如 [\"created\",\"paid\",\"done\"]。",
                        },
                    },
                    required: ["name"],
                },
            },
            withDefaultRows: {
                type: "boolean",
                description:
                    "是否自动创建两行示例数据。默认 false（AI 创建的表通常不需要示例行）。",
            },
        },
        required: ["columns"],
    },
};

/**
 * [Executor] 创建一张新表（调用 tableSlice.createTable thunk）
 */
export async function createTableFunc(
    args: CreateTableToolArgs,
    thunkApi: any
): Promise<CreateTableResult> {
    const spaceId =
        typeof args?.spaceId === "string" && args.spaceId.trim()
            ? args.spaceId.trim()
            : undefined;
    const title =
        typeof args?.title === "string" && args.title.trim()
            ? args.title.trim()
            : undefined;
    const purpose =
        typeof args?.purpose === "string" && args.purpose.trim()
            ? args.purpose.trim()
            : undefined;
    const description =
        typeof args?.description === "string" && args.description.trim()
            ? args.description.trim()
            : undefined;
    const tags =
        Array.isArray(args?.tags) && args.tags.length
            ? args.tags
                .map((t) => (typeof t === "string" ? t.trim() : ""))
                .filter(Boolean)
            : undefined;
    const publicIntake =
        args?.publicIntake &&
            typeof args.publicIntake === "object" &&
            !Array.isArray(args.publicIntake)
            ? args.publicIntake
            : undefined;
    const categoryId =
        typeof args?.categoryId === "string" && args.categoryId.trim()
            ? args.categoryId.trim()
            : undefined;
    const withDefaultRows =
        typeof args?.withDefaultRows === "boolean" ? args.withDefaultRows : false;

    const columnsInput = Array.isArray(args?.columns) ? args.columns : [];

    if (columnsInput.length === 0) {
        throw new Error(
            "createTable.columns 至少需要包含一个字段，请根据用户需求设计字段。"
        );
    }

    // 1. 清洗字段：去空白、去重
    const seen = new Set<string>();
    const sanitizedColumns: ToolTableColumnInput[] = [];

    for (const col of columnsInput) {
        if (!col || typeof col.name !== "string") continue;
        const name = col.name.trim();
        if (!name) continue;
        if (seen.has(name)) continue;
        seen.add(name);

        const sanitized: ToolTableColumnInput = { name };

        if (typeof col.label === "string" && col.label.trim()) {
            sanitized.label = col.label.trim();
        }
        if (typeof col.type === "string") {
            sanitized.type = col.type as ColumnType;
        }
        if (typeof col.description === "string" && col.description.trim()) {
            sanitized.description = col.description.trim();
        }
        if (typeof col.required === "boolean") {
            sanitized.required = col.required;
        }
        if (Array.isArray(col.options)) {
            const opts = col.options
                .map((opt) => (typeof opt === "string" ? opt.trim() : ""))
                .filter(Boolean);
            if (opts.length) sanitized.options = opts;
        }

        sanitizedColumns.push(sanitized);
    }

    if (sanitizedColumns.length === 0) {
        throw new Error(
            "createTable.columns 中没有任何有效的字段名，请为至少一个字段提供非空的 name。"
        );
    }

    // 2. 构造 CreateTableArgs（与 render/table/createTableAction.ts 对齐）
    const createArgs: any = {
        spaceId,
        title,
        purpose,
        description,
        tags,
        publicIntake,
        categoryId,
        columns: sanitizedColumns,
        withDefaultRows,
    };

    try {
        const actionResult = await thunkApi.dispatch(createTable(createArgs));

        if (!createTable.fulfilled.match(actionResult)) {
            const msg =
                (actionResult.payload as string) ||
                actionResult.error?.message ||
                "创建表失败";
            throw new Error(msg);
        }

        // createTableAction 返回的是 dbKey（string）
        const dbKey = actionResult.payload as string;

        // 解析出 tenantId / tableId
        const { tenantId, tableId } = parseMetaKey(dbKey);

        const finalTitle = title || "新建表格";
        const colNamesForDisplay = sanitizedColumns.map((c) => c.name).join(", ");

        // 给聊天前端的结构化数据，供 Tool 卡片渲染
        const tableMetaForUi = {
            dbKey, // meta-{tenantId}-{tableId}
            tenantId,
            tableId,
            displayName: finalTitle,
            description,
            tags,
            publicIntake,
            columns: sanitizedColumns, // [{ name, label?, type?, description?, required?, options? }]
        };

        return {
            rawData: tableMetaForUi,
            displayData:
                `已创建新表「${finalTitle}」（tableId: ${tableId}）。\n` +
                `字段列表：${colNamesForDisplay}\n\n` +
                `接下来调用 addTableRow 时，请传入完整结构：\n` +
                `{\n` +
                `  "tenantId": "${tenantId}",\n` +
                `  "tableId": "${tableId}",\n` +
                `  "values": {\n` +
                `    "列名": "字段值"\n` +
                `  }\n` +
                `}\n\n` +
                `服务器返回 dbKey：\n${toPreviewJson(dbKey)}`,
        };
    } catch (error: any) {
        throw new Error(
            `createTable 调用失败：${error?.message ?? "未知错误"}`
        );
    }
}
