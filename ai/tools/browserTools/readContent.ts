
import { executeBrowserTool } from "./common";

export const browser_readContent_Schema = {
    name: "browser_readContent",
    description:
        "获取当前浏览器页面的文本内容 (innerText) 或特定元素的内容。",
    parameters: {
        type: "object",
        properties: {
            sessionId: {
                type: "string",
                description: "由 browser_openSession 返回的活跃会话 ID。",
            },
            selector: {
                type: "string",
                description:
                    "可选。若指定，则仅提取该元素内的文本 (例如 '.article-body')。若留空，则提取全页文本。",
            },
        },
        required: ["sessionId"],
    },
};

export async function browser_readContent_Func(
    args: { sessionId: string; selector?: string },
    thunkApi: any
) {
    const result: any = await executeBrowserTool("browser_readContent", args, thunkApi);

    const content = typeof result === "string" ? result : result.content || "";
    const preview = content.substring(0, 300) + (content.length > 300 ? "..." : "");

    return {
        rawData: content,
        displayData: `✅ 已成功读取页面内容 (${content.length} 字符)。\n**预览:**\n${preview}`,
    };
}
