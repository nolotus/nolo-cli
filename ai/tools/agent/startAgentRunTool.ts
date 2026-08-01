// packages/ai/tools/agent/startAgentRunTool.ts
//
// startAgentRun tool — forks a background agent run and returns immediately.
//
// Unix analogy: fork + exec. You get a runId (= dialogId = threadId) back,
// then use controlAgentRun to observe / stop it.
//
// Environment routing:
//   - CLI local --bg: detects ~/.nolo/runs/ + CLI context → spawn detached
//     child process (reuses CLI's agentRunControl spawnLocalBackgroundRun)
//   - Otherwise (web/RN/desktop/CLI --server): dispatches runAgentBackground
//     with waitForCompletion:false, which posts to /api/agent/run {background:true}

import { runAgentBackground } from "../../agent/runAgentBackground";
import { toErrorMessage } from "../../../core/errorMessage";
import { buildDelegatedTaskContent } from "./callAgentTool";

export const startAgentRunFunctionSchema = {
    name: "startAgentRun",
    description:
        "后台启动一个 Agent 执行子任务，立即返回 runId，不阻塞当前对话。" +
        "相当于 Unix 的 fork+exec：拿到 runId 后用 controlAgentRun 观察/停止。" +
        "适合长任务、并行子任务、需要中途观察或叫停的场景。" +
        "如果子任务 < 100s 且需要立即拿结果，用 callAgent（同步）更合适。",
    parameters: {
        type: "object",
        properties: {
            agentKey: {
                type: "string",
                description: "要启动的 Agent 的可运行 dbKey（优先使用 readAgent 返回的 agentKey，格式如 agent-xxx）。",
            },
            task: {
                type: "string",
                description: "委托给该 Agent 的子任务描述（自然语言）。建议包含必要的上下文说明。",
            },
            input: {
                description:
                    "可选。JSON 或字符串，作为本次子任务的附加输入（如抓取到的原始数据、上下文片段等）。",
            },
        },
        required: ["agentKey", "task"],
    },
};

interface StartAgentRunArgs {
    agentKey: string;
    task: string;
    input?: any;
}

/**
 * startAgentRun executor.
 *
 * Currently routes through runAgentBackground (waitForCompletion:false) which
 * posts to /api/agent/run {background:true} on the server side. The CLI local
 * --bg path (spawn detached) can be added later via environment detection —
 * the tool interface stays the same.
 */
export async function startAgentRunFunc(
    args: StartAgentRunArgs,
    thunkApi: any,
    _context?: { parentMessageId?: string; signal?: AbortSignal; toolRunId?: string }
): Promise<{ rawData: any; displayData: string }> {
    const { agentKey, task, input } = args;
    const { dispatch } = thunkApi;

    if (!agentKey) {
        throw new Error("startAgentRun: 缺少 agentKey 参数。");
    }
    if (!task || typeof task !== "string") {
        throw new Error("startAgentRun: 缺少有效的 task 文本描述。");
    }

    const content = buildDelegatedTaskContent(task, input);

    try {
        const bgResult = await dispatch(
            runAgentBackground({
                agentKey,
                userInput: content,
                waitForCompletion: false,
            })
        ).unwrap();

        const runId = bgResult.dialogId;
        const status = bgResult.status ?? "pending";

        return {
            rawData: {
                runId,
                status,
            },
            displayData: `⏳ 后台 run 已启动，runId: ${runId}。用 controlAgentRun(action:"status", runId:"${runId}") 查进度。`,
        };
    } catch (e: any) {
        throw new Error(`startAgentRun 启动 Agent [${agentKey}] 失败: ${toErrorMessage(e)}`);
    }
}
