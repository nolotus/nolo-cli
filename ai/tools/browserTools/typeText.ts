
import { executeBrowserTool } from "./common";

export const browser_typeText_Schema = {
    name: "browser_typeText",
    description:
        "在当前浏览器会话中，向指定元素输入文本内容 (通常用于填写表单)。",
    parameters: {
        type: "object",
        properties: {
            sessionId: {
                type: "string",
                description: "由 browser_openSession 返回的活跃会话 ID。",
            },
            selector: {
                type: "string",
                description: "目标输入框的 CSS 选择器 (例如 'input[name=\"search\"]' ).",
            },
            text: {
                type: "string",
                description: "要输入的文本内容。",
            },
            pressEnter: {
                type: "boolean",
                description: "输入完成后是否模拟按下回车键 (默认 false)。",
            },
        },
        required: ["sessionId", "selector", "text"],
    },
};

export async function browser_typeText_Func(
    args: { sessionId: string; selector: string; text: string; pressEnter?: boolean },
    thunkApi: any
) {
    const result = await executeBrowserTool("browser_typeText", args, thunkApi);
    return {
        rawData: result,
        displayData: `✅ 已向 \`${args.selector}\` 输入文本: "${args.text}"${args.pressEnter ? " (并回车)" : ""
            }`,
    };
}
