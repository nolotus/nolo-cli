// 文件: ai/tools/table/addTableRowTool.ts

import type { RootState } from "../../../app/store";
import { isRecord } from "../../../core/isRecord";
import { asRecordOrEmpty } from "../../../core/recordOrEmpty";
import { addRow } from "../../../render/table/tableSlice";

/**
 * [Schema] addTableRow：在当前已打开的表中新增一行数据
 *
 * 设计要点：
 * - 默认情况下，从当前 Redux 状态里的 tableSlice.currentTable 推断 tenantId / tableId
 * - LLM 主要只需要关心 values（列名 -> 值）
 * - 如果没有当前表，又没显式传 tenantId / tableId，则报错
 */
export const addTableRowFunctionSchema = {
    name: "addTableRow",
    description:
        [
            "在指定表中新增一行数据。",
            "【重要】如果你是在对话（chat）中调用此函数（而非在表格页面的「页面助手」中），",
            "则必须显式传入 tenantId 和 tableId。这两个值可从 createTable 的返回结果中获取。",
            "如果你刚刚调用了 createTable，请务必将其返回的 tenantId 和 tableId 传入此函数。",
            "只有在表格页面打开「页面助手」时，tenantId 和 tableId 才可以省略（会自动推断）。",
            "【重要】表格字段必须放在 values 对象里，不要把 content、status 这类列名直接放在顶层。",
            '完整示例：{"tenantId":"u1","tableId":"t1","values":{"content":"希望支持支付宝支付","status":"待处理"}}。',
        ].join("\n"),
    parameters: {
        type: "object",
        properties: {
            values: {
                type: "object",
                description:
                    [
                        "要写入新行的数据。key 必须是目标表已有的列名，多余字段会被忽略。",
                        '请根据用户的自然语言描述，为每个相关字段填上合理的值，而不是传入空对象 {}。',
                        '字段必须包在 values 中。示例：{"values": {"name": "张三", "desc": "测试任务", "date": "2025-01-01"}}。',
                    ].join("\n"),
                additionalProperties: {
                    description:
                        "单个字段的值；可以是字符串、数字、布尔值、null、对象或数组。",
                },
            },
            tenantId: {
                type: "string",
                description:
                    "租户 ID。在对话（chat）中调用时必须显式传入，从 createTable 的返回结果获取。",
            },
            tableId: {
                type: "string",
                description:
                    "表 ID。在对话（chat）中调用时必须显式传入，从 createTable 的返回结果获取。",
            },
        },
        required: ["values"],
    },
};

type AddTableRowArgs = {
    values?: Record<string, any>;
    tenantId?: string;
    tableId?: string;
} & Record<string, any>;

type AddTableRowResult = {
    rawData: any;
    displayData: string;
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

const RESERVED_ARG_KEYS = new Set(["tenantId", "tableId", "values"]);

const extractLegacyValues = (args: AddTableRowArgs | undefined): Record<string, any> => {
    return Object.fromEntries(
        Object.entries(asRecordOrEmpty(args)).filter(
            ([key, value]) => !RESERVED_ARG_KEYS.has(key) && value !== undefined
        )
    );
};

/**
 * [Executor] 在当前表中新增一行
 *
 * - 优先从 args.tenantId / args.tableId 取值
 * - 否则使用 state.table.currentTable 的 tenantId / tableId
 * - 如果当前表元数据可用，会自动过滤掉不存在的列名，并在 displayData 提示
 */
export async function addTableRowFunc(
    args: AddTableRowArgs,
    thunkApi: any
): Promise<AddTableRowResult> {
    const state = thunkApi.getState() as RootState;
    const tableState = state.table as RootState["table"];

    const currentTable = tableState.currentTable;

    const tenantId = args?.tenantId ?? currentTable?.tenantId;
    const tableId = args?.tableId ?? currentTable?.tableId;
    const normalizedValues =
        args?.values !== undefined ? args.values : extractLegacyValues(args);
    const values = (normalizedValues ?? {}) as Record<string, any>;

    if (!tenantId || !tableId) {
        throw new Error(
            "addTableRow 只能在已打开某张表的页面中调用，或显式提供 tenantId 和 tableId。"
        );
    }

    if (!isRecord(values)) {
        throw new Error(
            'addTableRow.values 必须是一个对象（列名到值的映射，例如 { "name": "张三", "desc": "测试任务" }）。'
        );
    }

    // 兜底：禁止传空对象 {}，要求至少提供一个字段
    if (Object.keys(values).length === 0) {
        const knownCols = currentTable
            ? currentTable.columns.map((c: any) => c.name).join(", ") || "(无列定义)"
            : "(当前表字段未知)";

        throw new Error(
            `addTableRow.values 不能为空：你需要至少为一个字段提供值。\n` +
            `请根据用户的输入，从以下字段中选择并填充值：${knownCols}`
        );
    }

    let sanitizedValues: Record<string, any> = values;
    let ignoredColumns: string[] = [];

    if (
        currentTable &&
        currentTable.tenantId === tenantId &&
        currentTable.tableId === tableId
    ) {
        const allowedColumns = new Set(currentTable.columns.map((c: any) => c.name));

        sanitizedValues = {};
        ignoredColumns = [];

        for (const [key, val] of Object.entries(values)) {
            if (allowedColumns.has(key)) {
                sanitizedValues[key] = val;
            } else {
                ignoredColumns.push(key);
            }
        }

        if (
            Object.keys(sanitizedValues).length === 0 &&
            Object.keys(values).length > 0
        ) {
            const knownCols =
                currentTable.columns.map((c: any) => c.name).join(", ") || "(无列定义)";

            throw new Error(
                `addTableRow 失败：提供的字段名都不在当前表中。\n` +
                `已知字段: ${knownCols}\n` +
                `请仅使用这些字段名作为 key。`
            );
        }
    }

    try {
        const actionResult = await thunkApi.dispatch(
            addRow({ tenantId, tableId, values: sanitizedValues })
        );

        if (!addRow.fulfilled.match(actionResult)) {
            const msg =
                (actionResult.payload as string) ||
                actionResult.error?.message ||
                "新增表行失败";
            throw new Error(msg);
        }

        const createdRow = actionResult.payload as any;

        const tableLabel =
            currentTable?.displayName ||
            currentTable?.tableId ||
            tableId ||
            "当前表";

        const ignoredInfo =
            ignoredColumns.length > 0
                ? `\n\n注意：以下字段在当前表中不存在，已被忽略：${ignoredColumns.join(
                    ", "
                )}`
                : "";

        return {
            rawData: {
                ...createdRow,
                values: sanitizedValues,
            },
            displayData:
                `已在表「${tableLabel}」中新增一行数据。\n` +
                `rowId: ${createdRow.rowId ?? "（无 rowId 字段）"}\n\n` +
                `数据预览：\n${toPreviewJson(createdRow)}${ignoredInfo}`,
        };
    } catch (error: any) {
        throw new Error(
            `addTableRow 调用失败：${error?.message ?? "未知错误"}`
        );
    }
}
