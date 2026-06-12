// ai/tools/updateDocTool.ts

import { readAction } from "../../database/actions/read";
import { write } from "../../database/dbSlice";
import { markdownToSlate } from "../../create/editor/transforms/markdownToSlate";
import { slateToRenderMarkdown } from "../../create/editor/transforms/slateToRenderMarkdown";
import { extractMentionsFromSlate } from "../../create/editor/utils/slateUtils";
import type { PageData } from "../../render/page/types";
import { parseSkillDocProtocol } from "../skills/skillDocProtocol";

export const updateDocFunctionSchema = {
    name: "updateDoc",
    description: "更新指定页面/文档的内容。支持全量覆盖或在末尾追加内容。",
    parameters: {
        type: "object",
        properties: {
            id: {
                type: "string",
                description: "页面/文档的 dbKey，通常以 page- 开头，例如 page-user-01ABC...",
            },
            content: {
                type: "string",
                description: "要更新或追加的 Markdown 格式内容。",
            },
            mode: {
                type: "string",
                enum: ["replace", "append"],
                description: "更新模式：'replace' 表示全量覆盖（默认），'append' 表示在页面末尾追加。",
                default: "replace",
            },
        },
        required: ["id", "content"],
    },
};

/**
 * [Executor] 'updateDoc' 工具的执行函数。
 */
export async function updateDocFunc(
    args: { id: string; content: string; mode?: "replace" | "append" },
    thunkApi: any
): Promise<{ rawData: any; displayData: string }> {
    const { id, content, mode = "replace" } = args;
    const { dispatch } = thunkApi;

    if (!id.toLowerCase().startsWith("page-")) {
        throw new Error("updateDoc 工具仅支持更新页面 (page-xxx)。");
    }
    try {
        // 1. 读取原页面数据
        const originalData = (await readAction({ dbKey: id }, thunkApi)) as PageData;
        if (!originalData) {
            throw new Error(`未找到 ID 为 ${id} 的页面。`);
        }

        const currentMarkdown =
            typeof originalData.content === "string" && originalData.content.trim()
                ? originalData.content
                : slateToRenderMarkdown(
                    Array.isArray(originalData.slateData) ? originalData.slateData : [],
                );

        const mergedMarkdown = mode === "append"
            ? [currentMarkdown, content].filter(Boolean).join("\n\n")
            : content;
        const parsedProtocol = parseSkillDocProtocol(
            mergedMarkdown,
            originalData.meta,
            originalData.tools,
        );
        const finalSlateData = markdownToSlate(parsedProtocol.content);
        const tools = extractMentionsFromSlate(finalSlateData as any);

        // 3. 构造更新后的数据
        const updatedPageData: PageData = {
            ...originalData,
            slateData: finalSlateData,
            content: parsedProtocol.content,
            tools,
            ...(parsedProtocol.meta ? { meta: parsedProtocol.meta } : {}),
            updated_at: new Date().toISOString(),
        };

        // 4. 写入数据库
        // 4. 写入数据库
        await (dispatch as any)(write({ data: updatedPageData, customKey: id })).unwrap();

        const displayData = mode === "append"
            ? `已成功在页面《${originalData.title}》末尾追加了内容。`
            : `页面《${originalData.title}》的内容已成功更新。`;

        return {
            rawData: { success: true, id, title: originalData.title },
            displayData,
        };
    } catch (error: any) {
        console.error("执行 updateDoc 工具时出错:", error);
        throw new Error(`更新页面失败：${error?.message || String(error)}`);
    }
}
// ── 向后兼容别名（旧名 updatePage / update_page）────────────────────────────
/** @deprecated 使用 updateDocFunctionSchema */
export const updatePageFunctionSchema = updateDocFunctionSchema;
/** @deprecated 使用 updateDocFunc */
export const updatePageFunc = updateDocFunc;
