// 文件路径: ai/tools/agent/callAgentTool.ts

import { runAgentBackground } from "../../agent/runAgentBackground";
import { toErrorMessage } from "../../../core/errorMessage";


/**
 * callAgent 工具 Schema
 *
 * 用于开展一个子对话（sub-dialog），只关心执行结果。由当前运行时根据父运行的
 * 有效 workspace 权威决定子 Agent 的实际执行位置；模型只选择目标 Agent、任务、
 * 可选输入，以及是否后台执行。
 *
 * 若需要用户立刻看到流式回复，请改用 runStreamingAgent。
 */
export const callAgentFunctionSchema = {
    name: "callAgent",
    description:
        "调用一个指定的 Agent 执行一次子任务并返回结果。" +
        "通常用于：将复杂子问题委托给其他 Agent，例如自动评测、多 Agent 对比、抓取结果的结构化处理等。",
    parameters: {
        type: "object",
        properties: {
            agentKey: {
                type: "string",
                description:
                    "要调用的 Agent 的唯一 ID。",
            },
            task: {
                type: "string",
                description:
                    "委托给该 Agent 的子任务描述（自然语言）。建议在此包含必要的上下文说明（例如当前表结构、题库说明等）。",
            },
            input: {
                description:
                    "可选。JSON 或字符串，将作为本次子任务的附加输入。通常用于传递抓取到的原始数据、题库、上下文片段等。",
            },
            background: {
                type: "boolean",
                description:
                    "可选。当为 true 时立即创建后台子对话并返回 childDialogId，由调用方稍后查询结果；" +
                    "适合可能超过 HTTP 网关等待窗口（约 100 秒）的长任务，避免 Cloudflare 524 导致结果丢失。" +
                    "默认 false，即继续等待子任务完成并返回 content。",
                default: false,
            },
        },
        required: ["agentKey", "task"],
    },
};

interface CallAgentArgs {
    agentKey: string;
    task: string;
    input?: any;
    background?: boolean;
}

/**
 * callAgent 工具执行函数
 * @param args - { agentKey, task, input, background }
 * @param thunkApi - Redux thunkApi
 * @param context - { parentMessageId }，用于关联父消息
 */
export async function callAgentFunc(
    args: CallAgentArgs,
    thunkApi: any,
    context?: { parentMessageId?: string; signal?: AbortSignal; toolRunId?: string; agentKey?: string; userInput?: string }
): Promise<{ rawData: any; displayData?: string }> {
    const { agentKey, task, input, background } = args;
    const { dispatch } = thunkApi;

    if (!agentKey) {
        throw new Error("callAgent: 缺少 agentKey 参数。");
    }
    if (!task || typeof task !== "string") {
        throw new Error("callAgent: 缺少有效的 task 文本描述。");
    }

    // 组装 content：统一用「指令 + 输入」的简单文本协议
    let content: string;
    if (input === undefined || input === null) {
        content = task;
    } else if (typeof input === "string") {
        content = `${task}\n\n--- INPUT (text) ---\n${input}`;
    } else {
        const jsonStr = JSON.stringify(input, null, 2);
        content = `${task}\n\n--- INPUT (json) ---\n${jsonStr}`;
    }

    try {
        const bgResult = await dispatch(
            runAgentBackground({
                agentKey,
                userInput: content,
                ...(background === true ? { waitForCompletion: false } : {}),
            })
        ).unwrap();

        if (background === true) {
            return {
                rawData: { dialogId: bgResult.dialogId, status: bgResult.status ?? "pending" },
                displayData: `⏳ callAgent 后台已启动，dialogId: ${bgResult.dialogId}，请稍后查询结果。`,
            };
        }

        return {
            rawData: bgResult.content ?? bgResult,
            displayData: `✅ callAgent 执行完成，dialogId: ${bgResult.dialogId}`,
        };
    } catch (e: any) {
        const msg = toErrorMessage(e);
        throw new Error(`callAgent 调用 Agent [${agentKey}] 时出错: ${msg}`);
    }
}
