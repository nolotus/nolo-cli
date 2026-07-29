
import { executeBrowserTool } from "./common";

export const browser_click_Schema = {
    name: "browser_click",
    description:
        "在当前浏览器会话中，点击匹配指定 CSS 选择器的元素。",
    parameters: {
        type: "object",
        properties: {
            sessionId: {
                type: "string",
                description: "由 browser_openSession 返回的活跃会话 ID。",
            },
            selector: {
                type: "string",
                description: "要点击元素的 CSS 选择器 (例如 '#submit-btn', '.nav-link').",
            },
        },
        required: ["sessionId", "selector"],
    },
};

export async function browser_click_Func(
    args: { sessionId: string; selector: string },
    thunkApi: any
) {
    const result = await executeBrowserTool("browser_click", args, thunkApi);
    return {
        rawData: result,
        displayData: `✅ 已点击元素: \`${args.selector}\``,
    };
}
