// packages/ai/tools/agent/controlAgentRunTool.ts
//
// controlAgentRun tool — observe and control background agent runs.
//
// Unix analogy: wait + signal + /proc. One tool, three actions:
// - list: list runs → POST /api/agent/runs/control { action: "list" }
// - status: single run + log tail → POST /api/agent/runs/control { action: "status" }
// - stop: cancel a run → POST /api/agent/runs/control { action: "stop" }

import { callToolApi } from "../toolApiClient";
import { toErrorMessage } from "../../../core/errorMessage";

export const controlAgentRunFunctionSchema = {
    name: "controlAgentRun",
    description:
        "观察和控制后台 agent run。一个工具三个 action：" +
        "list（列出所有 run）、status（查单条 + 可选日志）、stop（取消 run）。" +
        "相当于 Unix 的 wait + signal + /proc。" +
        "用 startAgentRun 拿到 runId 后，用本工具跟进度或叫停。",
    parameters: {
        type: "object",
        properties: {
            action: {
                type: "string",
                enum: ["list", "status", "stop"],
                description:
                    "要执行的操作：list=列出所有 run（省略 runId）；" +
                    "status=查单条 run 状态 + 可选日志；stop=取消 run。",
            },
            runId: {
                type: "string",
                description:
                    "目标 run 的 ID（startAgentRun 返回的 runId）。action=list 时省略。",
            },
            tailLines: {
                type: "number",
                description:
                    "可选。action=status 时：0=只返回状态摘要，>0=同时返回最近 N 行日志（默认 0）。",
                default: 0,
            },
            statusFilter: {
                type: "string",
                enum: ["running", "done", "failed", "cancelled", "all"],
                description: "可选。action=list 时按状态过滤，默认 all。",
            },
            limit: {
                type: "number",
                description: "可选。action=list 时限制返回数量，默认 20。",
            },
        },
        required: ["action"],
    },
};

interface ControlAgentRunArgs {
    action: "list" | "status" | "stop";
    runId?: string;
    tailLines?: number;
    statusFilter?: string;
    limit?: number;
}

/**
 * controlAgentRun executor.
 */
export async function controlAgentRunFunc(
    args: ControlAgentRunArgs,
    thunkApi: any,
    _context?: { parentMessageId?: string; signal?: AbortSignal; toolRunId?: string }
): Promise<{ rawData: any; displayData: string }> {
    const { action, runId, tailLines, statusFilter, limit } = args;

    if (action === "list") {
        return handleList(thunkApi, { statusFilter, limit });
    }

    if (action === "status") {
        if (!runId) throw new Error('controlAgentRun(action:"status"): 缺少 runId。');
        return handleStatus(thunkApi, { runId, tailLines: tailLines ?? 0 });
    }

    if (action === "stop") {
        if (!runId) throw new Error('controlAgentRun(action:"stop"): 缺少 runId。');
        return handleStop(thunkApi, { runId });
    }

    throw new Error(`controlAgentRun: 未知 action "${action}"。`);
}

// ── list ──────────────────────────────────────────────────────────────────

async function handleList(
    thunkApi: any,
    opts: { statusFilter?: string; limit?: number }
): Promise<{ rawData: any; displayData: string }> {
    try {
        const body: Record<string, any> = { action: "list" };
        if (opts.statusFilter) body.statusFilter = opts.statusFilter;
        if (opts.limit !== undefined) body.limit = opts.limit;

        const data = await callToolApi(
            thunkApi,
            "/api/agent/runs/control",
            body,
            { withAuth: true }
        );

        const resData = data?.data ?? data;
        const runs = resData?.runs ?? [];
        const count = resData?.count ?? runs.length;

        const summary = runs
            .map((t: any) => `${t.runId} [${t.status}] ${t.agentKey ?? "unknown"}`)
            .join("\n");

        return {
            rawData: { runs, count },
            displayData:
                runs.length > 0
                    ? `📋 找到 ${runs.length} 个 run：\n${summary}`
                    : "📋 没有找到 run。",
        };
    } catch (e: any) {
        throw new Error(`controlAgentRun(list) 失败: ${toErrorMessage(e)}`);
    }
}

// ── status ─────────────────────────────────────────────────────────────────

async function handleStatus(
    thunkApi: any,
    opts: { runId: string; tailLines: number }
): Promise<{ rawData: any; displayData: string }> {
    try {
        const data = await callToolApi(
            thunkApi,
            "/api/agent/runs/control",
            { action: "status", runId: opts.runId, tailLines: opts.tailLines },
            { withAuth: true }
        );

        const resData = data?.data ?? data;
        if (!resData || resData.found === false || !resData.run) {
            return {
                rawData: { runId: opts.runId, found: false },
                displayData: `❓ run ${opts.runId} 未找到。可能已完成并被清理，或 ID 错误。`,
            };
        }

        const run = resData.run;
        const logLines: string[] | undefined = resData.logLines;

        const displayParts = [
            `📊 run ${run.runId}`,
            `  状态: ${run.status}`,
            `  Agent: ${run.agentKey ?? "unknown"}`,
            ...(run.lastToolNames?.length ? [`  最近工具: ${run.lastToolNames.join(", ")}`] : []),
            ...(run.toolCallCount !== undefined ? [`  工具调用数: ${run.toolCallCount}`] : []),
            ...(run.lastAssistantText ? [`  最近输出: ${run.lastAssistantText.slice(0, 200)}`] : []),
            ...(run.errorMessage ? [`  错误: ${run.errorMessage}`] : []),
            ...(logLines?.length ? [`  日志(最近 ${logLines.length} 行):`, ...logLines.map((l: string) => `  ${l}`)] : []),
        ];

        return {
            rawData: { found: true, ...run, ...(logLines ? { logLines } : {}) },
            displayData: displayParts.join("\n"),
        };
    } catch (e: any) {
        throw new Error(`controlAgentRun(status) 失败: ${toErrorMessage(e)}`);
    }
}

// ── stop ───────────────────────────────────────────────────────────────────

async function handleStop(
    thunkApi: any,
    opts: { runId: string }
): Promise<{ rawData: any; displayData: string }> {
    try {
        const data = await callToolApi(
            thunkApi,
            "/api/agent/runs/control",
            { action: "stop", runId: opts.runId },
            { withAuth: true }
        );

        const result = data?.data ?? data;
        const wasActive = result?.wasActive ?? false;
        const status = result?.status ?? "cancelled";

        let statusText: string;
        if (status === "cancelling") {
            statusText = `🛑 已发出取消信号，run ${opts.runId} 正在中止。`;
        } else if (status === "cancelled" && !wasActive) {
            statusText = `🛑 run ${opts.runId} 没有活跃进程，已标记为已取消。`;
        } else if (status === "cancelled") {
            statusText = `🛑 run ${opts.runId} 已成功取消。`;
        } else {
            statusText = `ℹ️ run ${opts.runId} 已处于状态 "${status}"。${wasActive ? "执行已停止。" : "没有活跃进程。"}`;
        }

        return {
            rawData: { runId: opts.runId, status, wasActive },
            displayData: statusText,
        };
    } catch (e: any) {
        throw new Error(`controlAgentRun(stop) 失败: ${toErrorMessage(e)}`);
    }
}
