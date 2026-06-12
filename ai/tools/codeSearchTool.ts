import { buildToolRequestHeaders, getToolBaseUrl } from "./toolApiClient";

export type CodeSearchArgs = {
    query?: string;
    path?: string;
    pathScope?: string;
    glob?: string;
    mode?: "content" | "files";
    maxResults?: number;
    maxFiles?: number;
    caseSensitive?: boolean;
};

export const codeSearchFunctionSchema = {
    name: "codeSearch",
    description: [
        "使用 ripgrep (rg) 在项目代码中搜索文本，或按 glob 列出文件。",
        "",
        "推荐场景：",
        "- mode=content：按关键词搜索代码内容，替代旧的 searchRepo。",
        "- mode=files：按路径范围和 glob 列出文件，替代旧的 listFiles。",
        "",
        "参数说明：",
        "- query：搜索文本；mode=content 时必填，mode=files 时可省略。",
        "- path/pathScope：限制搜索目录，例如 'packages/server'。",
        "- glob：可选文件匹配模式，例如 '**/*.ts'。",
        "- maxResults：最大返回数量；兼容旧参数 maxFiles。",
        "- caseSensitive：是否区分大小写，默认 false。",
    ].join("\n"),
    parameters: {
        type: "object",
        properties: {
            query: {
                type: "string",
                description: "可选：要搜索的文本。mode=content 时必须提供。",
            },
            path: {
                type: "string",
                description: "可选：限制搜索目录，例如 'packages/ai'。",
            },
            pathScope: {
                type: "string",
                description: "兼容旧参数：限制搜索目录，例如 'packages/ai'。",
            },
            glob: {
                type: "string",
                description: "可选：文件 glob，例如 '**/*.ts'。",
            },
            mode: {
                type: "string",
                enum: ["content", "files"],
                description: "搜索模式：content=搜内容，files=列文件。",
            },
            maxResults: {
                type: "number",
                description: "最大返回数量。兼容旧参数 maxFiles。",
            },
            maxFiles: {
                type: "number",
                description: "兼容旧参数：等价于 maxResults。",
            },
            caseSensitive: {
                type: "boolean",
                description: "是否区分大小写，默认 false。",
            },
        },
    },
};

export async function codeSearchFunc(
    args: CodeSearchArgs,
    thunkApi: any,
    context?: { signal?: AbortSignal; agentKey?: string },
): Promise<{ rawData: any; displayData?: string }> {
    const baseUrl = getToolBaseUrl(thunkApi);
    const apiUrl = `${baseUrl}/api/code-search`;
    const mode = args.mode ?? "content";

    const response = await fetch(apiUrl, {
        method: "POST",
        headers: buildToolRequestHeaders(thunkApi, {
            withAuth: true,
            agentKey: context?.agentKey,
        }),
        signal: context?.signal,
        body: JSON.stringify({
            query: args.query,
            path: args.path ?? args.pathScope,
            glob: args.glob,
            mode,
            maxResults: args.maxResults ?? args.maxFiles,
            caseSensitive: args.caseSensitive,
        }),
    });

    const responseText = await response.text();
    let data: any = null;
    try {
        data = responseText ? JSON.parse(responseText) : {};
    } catch {
        data = null;
    }
    if (!response.ok || data?.error) {
        throw new Error(
            data?.error ||
            `codeSearch 请求失败: ${response.status}${responseText ? `. 响应: ${responseText}` : ""}`
        );
    }

    if (mode === "files") {
        const files = Array.isArray(data.files) ? data.files : [];
        return {
            rawData: data,
            displayData: `📁 codeSearch 列出 ${files.length} 个文件${data.truncated ? "（已截断）" : ""}`,
        };
    }

    const hits = Array.isArray(data.hits) ? data.hits : [];
    return {
        rawData: data,
        displayData: `🔍 codeSearch 找到 ${hits.length} 条匹配${data.truncated ? "（已截断）" : ""}`,
    };
}
