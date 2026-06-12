// 文件路径: packages/ai/tools/readFileTool.ts

import { buildToolRequestHeaders, getToolBaseUrl } from "./toolApiClient";

// ---- Types ----

export type ReadFileArgs = {
    /**
     * 目标文件相对项目根目录（bun-nolo）的路径，例如：
     * - packages/chat/src/messages/web/ToolMessageContent.tsx
     * - packages/server/entry.ts
     */
    filePath: string;
    /**
     * 可选：从该行开始读取（1-based，包含）。
     */
    startLine?: number;
    /**
     * 可选：读取到该行结束（1-based，包含）。
     */
    endLine?: number;
};

// ---- 工具 Schema，供 LLM 调用 ----

export const readFileFunctionSchema = {
    name: "readFile",
    description: [
        "从后端服务器读取一个文本文件的完整内容，并辅助行级编辑工具获取精确的行号信息。",
        "",
        "适用场景：",
        "- 在修改文件之前，先获取当前文件的完整内容用于分析。",
        "- 在需要理解某个模块实现时，请求查看对应源文件。",
        "- 在使用 applyLineEdits 按行号修改文件前，先读取文件并基于返回的 lines / lineCount 计算行号。",
        "- 如果使用 startLine/endLine 只读取部分内容：",
        "  - lines[0] 对应的真实行号为 lineOffset；",
        "  - 全文件总行数为 totalLineCount；",
        "  - 计算绝对行号时，请用 lineOffset + index。",
        "- 为 applyLineEdits 提供 originalSnippet：",
        "  - 对 replaceRange/deleteRange：从 lines 中取出将要修改的那几行，用 \\n 拼接，作为 originalSnippet 传给 applyLineEdits；",
        "  - 对 insertBefore/insertAfter：从 lines 中取出插入点附近的一行原始代码，作为 originalSnippet 传给 applyLineEdits；",
        "",
        "行为约定：",
        "- 当目标文件存在：返回文件的完整文本内容。",
        "- 当目标文件不存在：返回错误信息。",
        "",
        "返回数据约定（rawData 中）：",
        "- content：文件完整内容，统一使用 \\n 作为换行符。",
        "- lines：按行拆分后的字符串数组；若使用 startLine/endLine，则 lines[0] 对应 lineOffset。",
        "- lineCount：全文件总行数（即最大可用行号）。",
        "- lineOffset：当使用 startLine/endLine 时，lines[0] 对应的真实行号。",
        "- totalLineCount：全文件总行数（与 lineCount 相同，便于兼容）。",
        "",
        "注意：",
        "- filePath 必须是相对项目根目录（bun-nolo）的相对路径，且不能越出项目根目录。",
        "- 仅适用于文本文件，二进制文件的内容会被当作 UTF-8 文本读取，可能出现乱码。",
    ].join("\n"),
    parameters: {
        type: "object",
        properties: {
            filePath: {
                type: "string",
                description:
                    "目标文件相对项目根目录（bun-nolo）的路径，例如: packages/chat/src/messages/web/ToolMessageContent.tsx",
            },
            startLine: {
                type: "number",
                description:
                    "可选：从该行开始读取（1-based，包含）。与 endLine 搭配可只读局部内容。",
            },
            endLine: {
                type: "number",
                description:
                    "可选：读取到该行结束（1-based，包含）。与 startLine 搭配可只读局部内容。",
            },
        },
        required: ["filePath"],
    },
};

// ---- 预览执行：不读文件，只展示信息 ----

export async function readFilePreviewFunc(
    args: ReadFileArgs,
    _thunkApi: any
): Promise<{ rawData: any; displayData?: string }> {
    const { filePath, startLine, endLine } = args;

    if (!filePath || typeof filePath !== "string") {
        throw new Error("readFile 预览失败：必须提供有效的 filePath 字符串。");
    }

    return {
        rawData: {
            previewOnly: true,
            filePath,
            startLine,
            endLine,
        },
        displayData: `⏸️ 文件读取预览: ${filePath}`,
    };
}

// ---- 真正执行：POST 到后端 /api/read-file ----

export async function readFileFunc(
    args: ReadFileArgs,
    thunkApi: any,
    context?: { parentMessageId?: string; signal?: AbortSignal; agentKey?: string }
): Promise<{ rawData: any; displayData?: string }> {
    const { filePath, startLine, endLine } = args;

    if (!filePath || typeof filePath !== "string") {
        throw new Error("读取文件失败：必须提供有效的 filePath 字符串。");
    }

    try {
        const baseUrl = getToolBaseUrl(thunkApi);

        if (!baseUrl) {
            throw new Error("读取文件失败：无法获取 readFile 服务器地址。");
        }

        const apiUrl = `${baseUrl.replace(/\/+$/, "")}/api/read-file`;

        const response = await fetch(apiUrl, {
            method: "POST",
            headers: buildToolRequestHeaders(thunkApi, {
                withAuth: true,
                agentKey: context?.agentKey,
            }),
            signal: context?.signal,
            body: JSON.stringify({ filePath, startLine, endLine }),
        });

        const textBody = await response.text();
        let data: any = {};
        try {
            data = textBody ? JSON.parse(textBody) : {};
        } catch {
            // 非 JSON 的情况忽略解析错误
        }

        if (!response.ok || data?.error) {
            const errMsg =
                data?.error ||
                `readFile API 请求失败，状态码: ${response.status}. 响应: ${textBody}`;
            console.error("readFile API Error:", errMsg);
            throw new Error(errMsg);
        }

        // 统一换行符为 \n，保证与行级编辑逻辑一致
        const serverContent: string =
            typeof data?.content === "string" ? data.content : "";
        const normalizedContent =
            serverContent.indexOf("\r\n") >= 0
                ? serverContent.replace(/\r\n/g, "\n")
                : serverContent;

        const lines =
            normalizedContent === "" ? [] : normalizedContent.split("\n");

        const lineOffset: number =
            typeof data?.lineOffset === "number" ? data.lineOffset : 1;

        const totalLineCount: number =
            typeof data?.totalLineCount === "number"
                ? data.totalLineCount
                : typeof data?.lineCount === "number"
                    ? data.lineCount
                    : lines.length;

        const rangeStart: number =
            typeof data?.rangeStart === "number"
                ? data.rangeStart
                : lines.length
                    ? lineOffset
                    : 1;
        const rangeEnd: number =
            typeof data?.rangeEnd === "number"
                ? data.rangeEnd
                : lines.length
                    ? lineOffset + lines.length - 1
                    : 0;

        const returnedLineCount = lines.length;

        const rangeInfo =
            totalLineCount === 0
                ? "0 行"
                : rangeStart === 1 && rangeEnd === totalLineCount
                    ? `${totalLineCount} 行`
                    : `${rangeStart}-${rangeEnd} 行 / 共 ${totalLineCount} 行`;

        return {
            rawData: {
                applied: true,
                filePath,
                lines,
                totalLineCount,
                lineOffset,
                rangeStart,
                rangeEnd,
                returnedLineCount,
            },
            displayData: `📖 已读取文件: ${filePath}（${rangeInfo}）`,
        };
    } catch (error: any) {
        console.error("执行 readFile 时发生错误:", error);
        throw new Error(
            `读取文件 (${filePath}) 失败：${error?.message || String(error)}`
        );
    }
}
