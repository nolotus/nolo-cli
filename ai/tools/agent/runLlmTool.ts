// 文件路径: ai/tools/agent/runLlmTool.ts

/**
 * runLlm 工具
 *
 * 单轮 LLM 调用，不加载 Agent 的 references（知识库），不触发多轮 tool loop。
 * 工具列表和系统提示均可在调用时覆盖 Agent 的默认配置。
 *
 * 与 callAgent 的区别：
 * - runLlm：1 轮回复，不加载知识库；可携带工具但不会循环调用，更快且可预期
 * - callAgent：可能多轮（agent 内部有 tool loop），带完整 agent 上下文
 */

import { runLlm } from "../../agent/agentSlice";

export const runLlmFunctionSchema = {
    name: "runLlm",
    description:
        "对指定模型发起一次单轮 LLM 调用并返回结果。" +
        "不加载 Agent 知识库（references），适合摘要、分类、格式化、翻译等纯文本处理任务。" +
        "可选择注入临时系统提示或覆盖工具列表。",
    parameters: {
        type: "object",
        properties: {
            agentKey: {
                type: "string",
                description:
                    "要使用的模型配置 ID。若不填，使用当前对话绑定的默认模型。",
            },
            userInput: {
                type: "string",
                description: "发送给模型的提示词或问题。",
            },
            systemPrompt: {
                type: "string",
                description:
                    "可选。临时系统提示，会覆盖 Agent 原有配置中的 prompt。适合临时调整模型行为或角色。",
            },
            tools: {
                type: "array",
                items: { type: "string" },
                description:
                    "可选。工具 ID 列表，覆盖 Agent 默认配置的工具集。传空数组则禁用所有工具。",
            },
        },
        required: ["userInput"],
    },
};

interface RunLlmToolArgs {
    agentKey?: string;
    userInput: string;
    systemPrompt?: string;
    tools?: string[];
}

export async function runLlmToolFunc(
    args: RunLlmToolArgs,
    thunkApi: any,
    _context?: { parentMessageId?: string; signal?: AbortSignal; toolRunId?: string; agentKey?: string; userInput?: string }
): Promise<{ rawData: any; displayData?: string }> {
    const { agentKey, userInput, systemPrompt, tools } = args;

    if (!userInput?.trim()) {
        throw new Error("runLlm: 缺少 userInput 参数。");
    }

    const { dispatch } = thunkApi;

    try {
        const result = await dispatch(
            runLlm({
                agentKey,
                content: userInput,
                isStreaming: false,
                ...(systemPrompt !== undefined && { systemPromptOverride: systemPrompt }),
                ...(tools !== undefined && { toolsOverride: tools }),
            })
        ).unwrap();

        // 取前 60 字作为 header 摘要
        const preview = typeof result === "string"
            ? result.slice(0, 60) + (result.length > 60 ? "…" : "")
            : "";

        return {
            rawData: { result, userInput },
            displayData: preview || "✅ runLlm 完成",
        };
    } catch (e: any) {
        const msg = e?.message || String(e);
        throw new Error(`runLlm 调用失败: ${msg}`);
    }
}


