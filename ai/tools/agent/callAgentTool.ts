// 文件路径: ai/tools/agent/callAgentTool.ts

import type { RootState } from "../../../app/store";
import { runAgent } from "../../agent/agentSlice";
import { runAgentBackground } from "../../agent/runAgentBackground";


/**
 * callAgent 工具 Schema
 *
 * 用于开展一个子对话（sub-dialog），只关心执行结果。支持两种执行模式：
 * - "server"（默认）：通过服务端 agent run 接口后台异步执行，结果写回 DB 并通过 SSE 回传，
 *   适合大多数子任务，也能复用服务端 runtime auto-routing。
 * - "client"：客户端同步执行，在当前 Redux 上下文中直接调用 runAgent，
 *   适合确认只需本地轻量执行的子任务。
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
            mode: {
                type: "string",
                enum: ["client", "server"],
                description:
                    "执行模式：'server'（默认）为服务端后台异步执行，能复用 runtime auto-routing；" +
                    "'client' 为客户端同步执行，适合明确只需本地轻量完成的任务。",
                default: "server",
            },
            serverBase: {
                type: "string",
                description:
                    "可选。目标 Agent 所在的 nolo server origin，例如 Windows 机器通过 Cloudflare 暴露的 https://win.example.com。" +
                    "仅 server 模式使用；跨域目标必须由服务端 AGENT_TOOL_ALLOWED_SERVER_BASES 明确放行。" +
                    "如果目标 Agent 记录声明了 delegation.serverBase / runtimeServerBase，服务端会在未显式传入时自动路由。",
            },
        },
        required: ["agentKey", "task"],
    },
};

interface CallAgentArgs {
    agentKey: string;
    task: string;
    input?: any;
    mode?: "client" | "server";
    serverBase?: string;
}

/**
 * callAgent 工具执行函数
 * @param args - { agentKey, task, input, mode }
 * @param thunkApi - Redux thunkApi
 * @param context - { parentMessageId }，用于关联父消息
 */
export async function callAgentFunc(
    args: CallAgentArgs,
    thunkApi: any,
    context?: { parentMessageId: string }
): Promise<{ rawData: any; displayData?: string }> {
    const { agentKey, task, input, mode = "server", serverBase } = args;
    const { dispatch, getState } = thunkApi;
    const state = getState() as RootState;

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

    const parentMessageId = context?.parentMessageId;

    try {
        if (mode === "server") {
            // 服务端后台执行：适合耗时/计算密集型任务
            // 通过 /api/agent/run?background=true 派发到服务端，SSE 监听结果
            const result = await dispatch(
                runAgentBackground({
                    agentKey,
                    userInput: content,
                    ...(serverBase ? { serverBase } : {}),
                })
            ).unwrap();

            return {
                rawData: result.content ?? result,
                displayData: `✅ callAgent(服务端) 执行完成，dialogId: ${result.dialogId}`,
            };
        }

        // client 模式（默认）：客户端同步执行，结果直接返回给调用方
        const result = await dispatch(
            runAgent({
                agentKey,
                content,
                parentMessageId,
            })
        ).unwrap();

        return {
            rawData: result,
            displayData: "✅ callAgent(客户端) 子任务执行完成。",
        };
    } catch (e: any) {
        const msg = e?.message || String(e);
        throw new Error(`callAgent 调用 Agent [${agentKey}] 时出错: ${msg}`);
    }
}
