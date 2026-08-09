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
import { formatStartRunCard, resolveRunLabel, TASK_PREVIEW_MAX } from "./agentRunDisplayHelpers";
import { getActiveDialogKey } from "../../../chat/dialog/dialogRuntimeStore";
import { extractCustomId } from "../../../core/prefix";

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
                description: "要启动的 Agent 的可运行 dbKey（优先用 readAgent 解析出 agentKey，格式如 agent-xxx；readAgent 接受 dbKey/id/alias/URL，不要自己拼 key）。如果已通过 listAgents/readAgent 获取名称，请同时传 agentName。",
            },
            task: {
                type: "string",
                description: "委托给该 Agent 的子任务描述（自然语言）。建议包含必要的上下文说明。",
            },
            input: {
                description:
                    "可选。JSON 或字符串，作为本次子任务的附加输入（如抓取到的原始数据、上下文片段等）。",
            },
            agentName: {
                type: "string",
                description: "可选。由 listAgents/readAgent 得到的可读 Agent 名称，用于 TUI 运行卡片展示。",
            },
            ephemeral: {
                type: "boolean",
                description:
                    "可选。为 true 时本次 run 不持久化 dialog（不留记录）。用于一次性审查（review）等不需留痕的场景。默认 false。",
            },
            batchId: {
                type: "string",
                description:
                    "可选。批次 id，用于把多个并行 run 归为一组，便于后续 controlAgentRun(list, batchId=...) 按批查询。" +
                    "未传时自动生成一个并在返回值中带回，调用方无需先创建。",
            },
            trackTodo: {
                type: "boolean",
                description:
                    "可选。为 true 时本次 run 会被记录进 runtime todo（~/.nolo/todos.json）。" +
                    "传了 batchId 时默认即记录（每批对应一项 todo）。" +
                    "todo 状态由关联 run 状态 + review 结论推导，用 controlAgentRun(action:\"todo\") 查询。",
            },
        },
        required: ["agentKey", "task"],
    },
};

interface StartAgentRunArgs {
    agentKey: string;
    task: string;
    input?: any;
    agentName?: string;
    ephemeral?: boolean;
    batchId?: string;
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
    const { agentKey, task, input, agentName, ephemeral, batchId } = args;
    const { dispatch } = thunkApi;

    // A batch id is always present on the return value. The caller may supply
    // one to group parallel runs; otherwise we mint a fresh one here so the
    // server path (runAgentBackground, which does not currently carry batchId)
    // still gives the caller a stable handle to filter on later via list.
    // The CLI local path receives the same id and persists it on the run record.
    const effectiveBatchId =
        typeof batchId === "string" && batchId.trim()
            ? batchId.trim()
            : `batch-${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;

    if (!agentKey) {
        throw new Error("startAgentRun: 缺少 agentKey 参数。");
    }
    if (!task || typeof task !== "string") {
        throw new Error("startAgentRun: 缺少有效的 task 文本描述。");
    }

    const content = buildDelegatedTaskContent(task, input);

    // 从模块级单例取当前对话 key，提取 id 作为 parentDialogId 透传给服务端，
    // 让后台子对话记录父子关系，供侧边栏折叠。无当前对话时不传。
    const activeDialogKey = getActiveDialogKey();
    const parentDialogId = activeDialogKey ? extractCustomId(activeDialogKey) : undefined;

    try {
        const bgResult = await dispatch(
            runAgentBackground({
                agentKey,
                userInput: content,
                waitForCompletion: false,
                ...(parentDialogId ? { parentDialogId } : {}),
                ...(ephemeral ? { ephemeral: true } : {}),
            })
        ).unwrap();

        const runId = bgResult.dialogId;
        const status = bgResult.status ?? "pending";
        // rawData carries only real identity fields; the display fallback chain
        // lives in resolveRunLabel so a key never masquerades as a name.
        const resolvedName = agentName?.trim() || bgResult.agentName || bgResult.name;
        const identity = { agentName: resolvedName, agentKey, runId };
        // A clipped copy of the task rides along so every renderer can say what
        // this run is *for*. Without it two concurrent runs are indistinguishable
        // on screen — same card, same status, different work. Clipped rather than
        // full: this is display text, and the caller already holds the original.
        const taskPreview = task.replace(/\s+/g, " ").trim().slice(0, TASK_PREVIEW_MAX);

        return {
            rawData: {
                runId,
                status,
                agentKey,
                // batchId is always returned — minted above when the caller didn't
                // supply one — so controlAgentRun(list, batchId=...) works on every
                // host. On the server path the id lives in the tool return; on the
                // CLI local path it is also persisted on the run record.
                batchId: effectiveBatchId,
                ...(resolvedName ? { agentName: resolvedName } : {}),
                ...(taskPreview ? { taskPreview } : {}),
            },
            displayData: formatStartRunCard(resolveRunLabel(identity), status, {
                task: taskPreview,
                runId,
            }),
        };
    } catch (e: any) {
        throw new Error(`startAgentRun 启动 Agent [${agentKey}] 失败: ${toErrorMessage(e)}`);
    }
}
