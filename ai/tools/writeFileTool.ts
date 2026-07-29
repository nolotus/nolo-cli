// 文件路径: packages/ai/tools/writeFileTool.ts

import { toErrorMessage } from "../../core/errorMessage";
import { buildToolRequestHeaders, getToolBaseUrl } from "./toolApiClient";

// ---- Types ----

export type WriteFileArgs = {
    /**
     * 目标文件相对项目根目录（bun-nolo）的路径，例如：
     * - packages/chat/src/messages/web/NewComponent.tsx
     * - packages/server/some-script.ts
     */
    filePath: string;
    /**
     * 要写入文件的完整内容。
     * - 如果文件不存在：将创建新文件，并写入该内容；
     * - 如果文件已存在：
     *   - overwrite = true：覆盖原有内容；
     *   - overwrite 未设置或为 false：请求会失败。
     */
    content: string;
    overwrite?: boolean;
};

// ---- 工具 Schema，供 LLM 调用 ----

export const writeFileFunctionSchema = {
    name: "writeFile",
    description: [
        "在后端服务器上写入一个完整文件的内容，可用于新建文件或覆盖已有文件。",
        "",
        "适用场景：",
        "- 新建一个全新的代码文件（例如新组件、新工具函数、配置文件等）",
        "- 覆盖一个文件的全部内容（当你需要重写整个文件时）",
        "",
        "行为约定：",
        "- 当目标文件不存在：直接创建新文件并写入 content。",
        "- 当目标文件已存在：",
        "  - 如果 overwrite=true，则覆盖原文件内容；",
        "  - 否则请求会失败，以避免意外覆盖。",
        "",
        "返回数据约定（rawData.response 中）：",
        "- created / overwritten：指示本次操作是新建还是覆盖。",
        "- newContent：写入后的完整文件内容（统一使用 \\n 作为换行符），用于 UI 中的代码预览。",
        "- diff：如果文件原本存在，则返回基于旧内容与 newContent 的行级 diff（diffLines 结果），用于 UI 中的 Diff 视图。",
        "",
        "注意：",
        "- filePath 必须是相对项目根目录（bun-nolo）的相对路径，且不能越出项目根目录。",
        "- 建议只在“新建文件/全量重写”时使用本工具；修改部分内容时优先使用 applyEdit。",
        "- 如果用户给了 URL 或网页资料来驱动本次改动，先抓取网页并核对字段，再决定是否需要整文件覆盖。",
    ].join("\n"),
    parameters: {
        type: "object",
        properties: {
            filePath: {
                type: "string",
                description:
                    "目标文件相对项目根目录（bun-nolo）的路径，例如: packages/chat/src/messages/web/NewComponent.tsx",
            },
            content: {
                type: "string",
                description:
                    "要写入文件的完整内容。对于新建文件，就是文件的全部内容；对于覆盖已有文件，会用该内容替换原内容。",
            },
            overwrite: {
                type: "boolean",
                description:
                    "是否允许覆盖已存在的文件。缺省或为 false 时，如果文件已存在将报错；true 时允许覆盖。",
            },
        },
        required: ["filePath", "content"],
    },
};

// ---- 预览执行：不写文件，只展示信息 ----

export async function writeFilePreviewFunc(
    args: WriteFileArgs,
    _thunkApi: any
): Promise<{ rawData: any; displayData?: string }> {
    const { filePath, content, overwrite } = args;

    if (!filePath || typeof filePath !== "string") {
        throw new Error("writeFile 预览失败：必须提供有效的 filePath 字符串。");
    }
    if (typeof content !== "string") {
        throw new Error("writeFile 预览失败：content 必须是字符串。");
    }

    const mode = overwrite ? "允许覆盖（已存在则覆盖）" : "仅新建（已存在则报错）";
    const lengthInfo = `内容长度: ${content.length} 个字符`;

    return {
        rawData: {
            previewOnly: true,
            filePath,
            overwrite: !!overwrite,
            content,
        },
        displayData: `⏸️ 文件写入预览: ${filePath}（模式: ${mode}，${lengthInfo}）`,
    };
}

// ---- 真正执行：POST 到后端 /api/write-file ----

export async function writeFileFunc(
    args: WriteFileArgs,
    thunkApi: any,
    context?: { parentMessageId?: string; signal?: AbortSignal; toolRunId?: string; agentKey?: string; userInput?: string }
): Promise<{ rawData: any; displayData?: string }> {
    const { filePath, content, overwrite } = args;

    if (!filePath || typeof filePath !== "string") {
        throw new Error("写入文件失败：必须提供有效的 filePath 字符串。");
    }
    if (typeof content !== "string") {
        throw new Error("写入文件失败：content 必须是字符串。");
    }

    try {
        const baseUrl = getToolBaseUrl(thunkApi);

        if (!baseUrl) {
            throw new Error("写入文件失败：无法获取 writeFile 服务器地址。");
        }

        const apiUrl = `${baseUrl.replace(/\/+$/, "")}/api/write-file`;

        

        const response = await fetch(apiUrl, {
            method: "POST",
            headers: buildToolRequestHeaders(thunkApi, {
                withAuth: true,
                agentKey: context?.agentKey,
            }),
            signal: context?.signal,
            body: JSON.stringify({ filePath, content, overwrite }),
        });

        const status = response.status;
        const textBody = await response.text();
        let data: any = {};
        try {
            data = textBody ? JSON.parse(textBody) : {};
        } catch {
            // 非 JSON 的情况忽略解析错误
        }

        // 409：文件已存在但未允许覆盖 → 视为“写入冲突”，不抛异常
        if (status === 409) {
            const serverMsg =
                data?.error ||
                "写入文件失败：目标文件已存在，且 overwrite 未设置为 true。";

            return {
                rawData: {
                    applied: false,
                    conflict: true,
                    fileExists: true,
                    filePath,
                    overwrite: !!overwrite,
                    serverMessage: serverMsg,
                },
                displayData: [
                    "⏸️ 检测到目标文件已存在，暂未写入。",
                    `- filePath: ${filePath}`,
                    `- 服务器消息: ${serverMsg}`,
                    "",
                    "如需覆盖，请在下一次调用 writeFile 时显式设置 overwrite: true。",
                ].join("\n"),
            };
        }

        if (!response.ok || data?.error) {
            const errMsg =
                data?.error ||
                `writeFile API 请求失败，状态码: ${status}. 响应: ${textBody}`;
            console.error("writeFile API Error:", errMsg);
            throw new Error(errMsg);
        }

        const created: boolean | undefined = data?.created;
        const overwrittenFlag: boolean | undefined = data?.overwritten;

        let actionDesc = "写入";
        if (created === true) {
            actionDesc = "新建";
        } else if (overwrittenFlag === true) {
            actionDesc = "覆盖";
        }

        return {
            rawData: {
                applied: true,
                filePath,
                overwrite: !!overwrite,
                // 把这次写入的原始内容也附带上，方便调试
                content,
                // 服务端返回的详细结果（包括 newContent / diff 等）
                response: data,
            },
            displayData: `✅ 已成功${actionDesc}文件: ${filePath}`,
        };
    } catch (error: any) {
        console.error("执行 writeFile 时发生错误:", error);
        throw new Error(
            `写入文件 (${filePath}) 失败：${toErrorMessage(error)}`
        );
    }
}
