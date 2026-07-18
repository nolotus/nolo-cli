import { toErrorMessage } from "../../core/errorMessage";
import { buildToolRequestHeaders, getToolBaseUrl } from "./toolApiClient";

type EditMatchOptions = {
    occurrence?: number;
    expectedMatches?: number;
    replaceAll?: boolean;
};

export type ApplyEdit =
    | (EditMatchOptions & {
        type: "replace";
        oldText: string;
        newText: string;
    })
    | (EditMatchOptions & {
        type: "insertBefore";
        anchor: string;
        content: string;
    })
    | (EditMatchOptions & {
        type: "insertAfter";
        anchor: string;
        content: string;
    })
    | (EditMatchOptions & {
        type: "delete";
        oldText: string;
    });

export type ApplyEditArgs = {
    filePath: string;
    edits: ApplyEdit[];
};

export const applyEditFunctionSchema = {
    name: "applyEdit",
    description: [
        "推荐默认使用的代码编辑工具：基于“精确文本片段”而不是行号进行局部修改。",
        "",
        "适用场景：",
        "- 替换一个已知的唯一代码片段。",
        "- 在某个唯一锚点片段之前或之后插入代码。",
        "- 删除一个精确可定位的片段。",
        "",
        "推荐工作流：",
        "- 先用 codeSearch 找文件或搜索代码；",
        "- 再用 readFile 读取最新内容；",
        "- 如果这次修改依赖用户给的 URL / 文档页，先用 fetchWebpage 或其它网页工具抓取真值，再编辑；",
        "- 直接把 readFile 中复制出的精确片段作为 oldText / anchor 传入。",
        "- 对从网页提取出的价格、上下文窗口、能力字段，按抓到的原值写入，不要凭记忆改写。",
        "",
        "准确率约定：",
        "- 默认要求片段在文件中只匹配 1 次；",
        "- 若匹配多次，会直接报错，要求你补更多上下文、设置 occurrence，或显式 replaceAll；",
        "- replaceAll 只会在你显式传 replaceAll=true 时执行；",
        "- 可用 expectedMatches 断言匹配数量，进一步防止误改。",
        "",
        "返回数据约定（rawData.response 中）：",
        "- newContent：编辑后的完整文件内容（统一使用 \\n）。",
        "- diff：基于原始内容与 newContent 的行级 diff。",
        "- appliedEdits：每个 edit 的匹配次数与实际应用次数。",
        "",
        "注意：",
        "- filePath 必须是相对项目根目录（bun-nolo）的路径。",
        "- 优先用 applyEdit 做最小局部修改；只有确实无法用精确片段表达时，再考虑 applyLineEdits 或整文件覆盖。",
    ].join("\n"),
    parameters: {
        type: "object",
        properties: {
            filePath: {
                type: "string",
                description:
                    "要修改的文件相对项目根目录（bun-nolo）的路径，例如: packages/server/routes.ts",
            },
            edits: {
                type: "array",
                description:
                    "要按顺序应用的一组精确片段编辑。后一个 edit 会基于前一个 edit 应用后的最新文本继续执行。",
                items: {
                    type: "object",
                    oneOf: [
                        {
                            properties: {
                                type: { const: "replace" },
                                oldText: {
                                    type: "string",
                                    description: "要被替换的精确原始片段。",
                                },
                                newText: {
                                    type: "string",
                                    description: "替换后的新片段。",
                                },
                                occurrence: {
                                    type: "number",
                                    description: "可选：当 oldText 匹配多次时，替换第几次匹配（1-based）。",
                                },
                                expectedMatches: {
                                    type: "number",
                                    description: "可选：断言 oldText 总共应匹配多少次。",
                                },
                                replaceAll: {
                                    type: "boolean",
                                    description: "可选：为 true 时替换所有匹配项。",
                                },
                            },
                            required: ["type", "oldText", "newText"],
                        },
                        {
                            properties: {
                                type: { const: "insertBefore" },
                                anchor: {
                                    type: "string",
                                    description: "作为插入锚点的精确原始片段。",
                                },
                                content: {
                                    type: "string",
                                    description: "要插入到锚点之前的文本。",
                                },
                                occurrence: {
                                    type: "number",
                                    description: "可选：当 anchor 匹配多次时，插入到第几次匹配之前（1-based）。",
                                },
                                expectedMatches: {
                                    type: "number",
                                    description: "可选：断言 anchor 总共应匹配多少次。",
                                },
                                replaceAll: {
                                    type: "boolean",
                                    description: "可选：为 true 时，对所有匹配锚点都执行插入。",
                                },
                            },
                            required: ["type", "anchor", "content"],
                        },
                        {
                            properties: {
                                type: { const: "insertAfter" },
                                anchor: {
                                    type: "string",
                                    description: "作为插入锚点的精确原始片段。",
                                },
                                content: {
                                    type: "string",
                                    description: "要插入到锚点之后的文本。",
                                },
                                occurrence: {
                                    type: "number",
                                    description: "可选：当 anchor 匹配多次时，插入到第几次匹配之后（1-based）。",
                                },
                                expectedMatches: {
                                    type: "number",
                                    description: "可选：断言 anchor 总共应匹配多少次。",
                                },
                                replaceAll: {
                                    type: "boolean",
                                    description: "可选：为 true 时，对所有匹配锚点都执行插入。",
                                },
                            },
                            required: ["type", "anchor", "content"],
                        },
                        {
                            properties: {
                                type: { const: "delete" },
                                oldText: {
                                    type: "string",
                                    description: "要删除的精确原始片段。",
                                },
                                occurrence: {
                                    type: "number",
                                    description: "可选：当 oldText 匹配多次时，删除第几次匹配（1-based）。",
                                },
                                expectedMatches: {
                                    type: "number",
                                    description: "可选：断言 oldText 总共应匹配多少次。",
                                },
                                replaceAll: {
                                    type: "boolean",
                                    description: "可选：为 true 时删除所有匹配项。",
                                },
                            },
                            required: ["type", "oldText"],
                        },
                    ],
                },
            },
        },
        required: ["filePath", "edits"],
    },
};

function assertValidArgs(args: ApplyEditArgs): void {
    if (!args.filePath || typeof args.filePath !== "string") {
        throw new Error("应用代码编辑失败：必须提供有效的 filePath 字符串。");
    }
    if (!Array.isArray(args.edits) || args.edits.length === 0) {
        throw new Error("应用代码编辑失败：edits 必须是非空数组。");
    }
}

export async function applyEditFunc(
    args: ApplyEditArgs,
    thunkApi: any,
    context?: { parentMessageId?: string; signal?: AbortSignal; toolRunId?: string; agentKey?: string; userInput?: string }
): Promise<{ rawData: any; displayData?: string }> {
    assertValidArgs(args);

    const { filePath, edits } = args;
    

    try {
        const baseUrl = getToolBaseUrl(thunkApi);

        if (!baseUrl) {
            throw new Error("应用代码编辑失败：无法获取 applyEdit 服务器地址。");
        }

        const apiUrl = `${baseUrl.replace(/\/+$/, "")}/api/apply-edit`;
        const response = await fetch(apiUrl, {
            method: "POST",
            headers: buildToolRequestHeaders(thunkApi, {
                withAuth: true,
                agentKey: context?.agentKey,
            }),
            signal: context?.signal,
            body: JSON.stringify({ filePath, edits }),
        });

        const textBody = await response.text();
        let data: any = {};
        try {
            data = textBody ? JSON.parse(textBody) : {};
        } catch {
            // ignore JSON parse error
        }

        if (!response.ok || data?.error) {
            const errMsg =
                data?.error ||
                `applyEdit API 请求失败，状态码: ${response.status}. 响应: ${textBody}`;
            console.error("applyEdit API Error:", errMsg);
            throw new Error(errMsg);
        }

        return {
            rawData: {
                applied: true,
                filePath,
                editCount: edits.length,
                response: data,
            },
            displayData: `✅ 已成功对文件应用 ${edits.length} 个精确片段编辑: ${filePath}`,
        };
    } catch (error: any) {
        console.error("执行 applyEdit 时发生错误:", error);
        throw new Error(
            `应用代码编辑到文件 (${filePath}) 失败：${toErrorMessage(error)}`
        );
    }
}
