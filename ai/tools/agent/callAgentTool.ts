// 文件路径: ai/tools/agent/callAgentTool.ts

import { runAgentBackground } from "../../agent/runAgentBackground";
import { toErrorMessage } from "../../../core/errorMessage";
import { getActiveDialogKey } from "../../../chat/dialog/dialogRuntimeStore";
import { extractCustomId } from "../../../core/prefix";

/**
 * 组装委托任务的 content：统一用「指令 + 输入」的简单文本协议
 */
export function buildDelegatedTaskContent(task: string, input?: any): string {
    if (input === undefined || input === null) {
        return task;
    }
    if (typeof input === "string") {
        return `${task}\n\n--- INPUT (text) ---\n${input}`;
    }
    const jsonStr = JSON.stringify(input, null, 2);
    return `${task}\n\n--- INPUT (json) ---\n${jsonStr}`;
}


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
                    "要调用的 Agent 的可运行 dbKey，必须是 listAgents 返回的 agentKey 字段（owned: agent-<userId>-<id>；public: agent-pub-<id>）或 readAgent 返回的 agentKey。只接受精确 dbKey，不接受 name/handle/bare id。",
            },
            task: {
                type: "string",
                description:
                    "委托给该 Agent 的子任务描述（自然语言）。建议在此包含必要的上下文说明（例如当前表结构、题库说明等）。" +
                    "在 task 里要求子 agent '最后用 1-3 句话总结结论 + 列出关键产出'，父 agent 用 resultMode:summary 时就只需读这段总结，不必消化完整输出。",
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
            resultMode: {
                type: "string",
                enum: ["summary", "full"],
                description:
                    "可选。控制返回给父 agent 的内容量，减少父 agent 上下文成本。" +
                    "summary（默认）：只返回子 agent 输出的前 2000 字 + 末尾总结段，适合父 agent 只需结论而非完整过程。" +
                    "full：返回子 agent 完整输出，适合需要完整 diff/日志做后续处理。" +
                    "父 agent 每多一个 turn 处理子输出 = 全前缀重新计价，所以非必要时用 summary。" +
                    "仅在 foreground 模式（background 未设或 false）生效；background 模式无 content 可截，此参数被忽略。",
                default: "summary",
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
    resultMode?: "summary" | "full";
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
    const { agentKey, task, input, background, resultMode } = args;
    const { dispatch } = thunkApi;

    if (!agentKey) {
        throw new Error("callAgent: 缺少 agentKey 参数。");
    }
    if (!task || typeof task !== "string") {
        throw new Error("callAgent: 缺少有效的 task 文本描述。");
    }

    const content = buildDelegatedTaskContent(task, input);

    // 从模块级单例取当前对话 key，提取 id 作为 parentDialogId 透传，
    // 让子对话记录父子关系，供侧边栏折叠。无当前对话时不传。
    const activeDialogKey = getActiveDialogKey();
    const parentDialogId = activeDialogKey ? extractCustomId(activeDialogKey) : undefined;

    try {
        const bgResult = await dispatch(
            runAgentBackground({
                agentKey,
                userInput: content,
                ...(background === true ? { waitForCompletion: false } : {}),
                ...(parentDialogId ? { parentDialogId } : {}),
            })
        ).unwrap();

        if (background === true) {
            return {
                rawData: { dialogId: bgResult.dialogId, status: bgResult.status ?? "pending" },
                displayData: `⏳ callAgent 后台已启动，dialogId: ${bgResult.dialogId}，请稍后查询结果。`,
            };
        }

        const fullContent = bgResult.content ?? bgResult;
        const wantSummary = resultMode !== "full";
        const returnedContent = wantSummary
            ? summarizeChildContent(typeof fullContent === "string" ? fullContent : JSON.stringify(fullContent))
            : fullContent;

        return {
            rawData: returnedContent,
            displayData: `✅ callAgent 执行完成，dialogId: ${bgResult.dialogId}${wantSummary ? "（summary）" : ""}`,
        };
    } catch (e: any) {
        const msg = toErrorMessage(e);
        throw new Error(`callAgent 调用 Agent [${agentKey}] 时出错: ${msg}`);
    }
}

/** Summary truncation thresholds for callAgent resultMode=summary. */
const SUMMARY_HEAD_CHARS = 1500;
const SUMMARY_TAIL_CHARS = 500;
/** Minimum content length to trigger truncation (avoid cutting very short outputs). */
const SUMMARY_MIN_LENGTH_THRESHOLD = SUMMARY_HEAD_CHARS + SUMMARY_TAIL_CHARS + 50;

/**
 * Trim a child agent's full output to a summary for the parent context:
 * first {@link SUMMARY_HEAD_CHARS} chars + last {@link SUMMARY_TAIL_CHARS} chars,
 * with a marker in between. Keeps the beginning (task framing) and the
 * conclusion, eliding the verbose middle.
 */
function summarizeChildContent(text: string): string {
    if (text.length <= SUMMARY_MIN_LENGTH_THRESHOLD) return text;
    return `${text.slice(0, SUMMARY_HEAD_CHARS)}\n\n…（中间部分已省略，resultMode=full 可看完整输出）…\n\n${text.slice(-SUMMARY_TAIL_CHARS)}`;
}
