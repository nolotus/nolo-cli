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
import { formatListRunsCard, formatStatusRunCard, formatStopRunCard, resolveRunLabel } from "./agentRunDisplayHelpers";

export const controlAgentRunFunctionSchema = {
    name: "controlAgentRun",
    description:
        "观察和控制后台 agent run。一个工具三个 action：" +
        "list（列出 run，支持按批次/状态过滤与分页）、status（查单条 + 可选日志）、stop（取消 run）。" +
        "相当于 Unix 的 wait + signal + /proc。" +
        "用 startAgentRun 拿到 runId 后，用本工具跟进度或叫停。" +
        "list 默认只返回最近 20 条，避免全量冲爆上下文；用 status/batchId/limit/offset 取所需分页。",
    parameters: {
        type: "object",
        properties: {
            action: {
                type: "string",
                enum: ["list", "status", "stop", "todo"],
                description:
                    "要执行的操作：list=列出 run（省略 runId）；" +
                    "status=查单条 run 状态 + 可选日志；stop=取消 run；" +
                    "todo=列出 runtime todo（由 startAgentRun 的 batchId/trackTodo 产生，状态由关联 run 推导）。",
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
            batchId: {
                type: "string",
                description:
                    "可选。action=list 时只返回该批次的 run（startAgentRun 返回值或入参中的 batchId）。",
            },
            status: {
                type: "string",
                description:
                    "可选。action=list 时按状态过滤，支持单值或逗号分隔多值（如 'running,orphaned'）。" +
                    "与 statusFilter 同义，status 优先；取值包含 orphaned（pid 已死但记录仍 running 的孤儿 run）。" +
                    "默认 all（不过滤）。",
            },
            statusFilter: {
                type: "string",
                enum: ["running", "done", "failed", "cancelled", "orphaned", "all"],
                description:
                    "可选。action=list 时按状态过滤，默认 all。与 status 同义（status 优先，且 status 支持多值）。",
            },
            limit: {
                type: "number",
                description:
                    "可选。action=list 时限制返回数量，默认 20，上限 200。不带任何参数不会返回全量。",
            },
            offset: {
                type: "number",
                description:
                    "可选。action=list 时跳过前 N 条，配合 limit 翻页。默认 0。",
            },
        },
        required: ["action"],
    },
};

interface ControlAgentRunArgs {
    action: "list" | "status" | "stop" | "todo";
    runId?: string;
    tailLines?: number;
    batchId?: string;
    status?: string;
    statusFilter?: string;
    limit?: number;
    offset?: number;
}

/**
 * controlAgentRun executor.
 */
export async function controlAgentRunFunc(
    args: ControlAgentRunArgs,
    thunkApi: any,
    _context?: { parentMessageId?: string; signal?: AbortSignal; toolRunId?: string }
): Promise<{ rawData: any; displayData: string }> {
    const { action, runId, tailLines, batchId, status, statusFilter, limit, offset } = args;

    if (action === "list") {
        return handleList(thunkApi, { batchId, status, statusFilter, limit, offset });
    }

    if (action === "todo") {
        return handleTodo(thunkApi, { status });
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
    opts: { batchId?: string; status?: string; statusFilter?: string; limit?: number; offset?: number }
): Promise<{ rawData: any; displayData: string }> {
    try {
        const body: Record<string, any> = { action: "list" };
        // `status` supports multi-value ("running,orphaned") and takes precedence
        // over `statusFilter` (single enum value); both map to the server's
        // statusFilter param. The server handler currently filters on exact
        // status match, so multi-value is sent as-is for forward compatibility
        // and the CLI local path splits it in queryRunRecords.
        const statusVal = opts.status ?? opts.statusFilter;
        if (statusVal) body.statusFilter = statusVal;
        if (opts.batchId) body.batchId = opts.batchId;
        if (opts.limit !== undefined) body.limit = opts.limit;
        if (opts.offset !== undefined) body.offset = opts.offset;

        const data = await callToolApi(
            thunkApi,
            "/api/agent/runs/control",
            body,
            { withAuth: true }
        );

        const resData = data?.data ?? data;
        const runs = resData?.runs ?? [];
        // total/hasMore come from the server (and the CLI local path). Fall back
        // to count/length for older servers that don't return pagination fields.
        const total = typeof resData?.total === "number" ? resData.total : runs.length;
        const hasMore = typeof resData?.hasMore === "boolean" ? resData.hasMore : false;

        return {
            rawData: { runs, count: runs.length, total, hasMore },
            displayData: formatListRunsCard(runs),
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
                displayData: `Run status\n  ? not_found`,
            };
        }

        const run = resData.run;
        const logLines: string[] | undefined = resData.logLines;
        const name = resolveRunLabel(run);

        return {
            rawData: { found: true, ...run, ...(logLines ? { logLines } : {}) },
            displayData: formatStatusRunCard(name, run.status, {
                runId: opts.runId,
                lastToolNames: run.lastToolNames,
                toolCallCount: run.toolCallCount,
                lastAssistantText: run.lastAssistantText,
                errorMessage: run.errorMessage,
                timing: { startedAt: run.startedAt, finishedAt: run.finishedAt },
                logLines,
            }),
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
        const status = result?.status ?? "cancelled";

        return {
            rawData: { runId: opts.runId, status, wasActive: result?.wasActive ?? false },
            displayData: formatStopRunCard(status),
        };
    } catch (e: any) {
        throw new Error(`controlAgentRun(stop) 失败: ${toErrorMessage(e)}`);
    }
}

// ── todo ───────────────────────────────────────────────────────────────────
//
// todo 是 runtime 级状态（"还有什么没做完"），由 startAgentRun 的 batchId/
// trackTodo 产生，状态由关联 run + review 结论推导。工具层走 callToolApi
// 转发到 /api/agent/runs/control { action: "todo" }；CLI 本地 executor 直接
// 读 ~/.nolo/todos.json 并调共享层 deriveTodoStatus 刷新（见
// cliAgentRunToolExecutors）。两端共用共享层 runtimeTodo.ts 的推导逻辑，
// 不平行定义第二套 todo 语义。

async function handleTodo(
    thunkApi: any,
    opts: { status?: string }
): Promise<{ rawData: any; displayData: string }> {
    try {
        const body: Record<string, any> = { action: "todo" };
        if (opts.status) body.status = opts.status;
        const data = await callToolApi(
            thunkApi,
            "/api/agent/runs/control",
            body,
            { withAuth: true }
        );
        const resData = data?.data ?? data;
        const todos = resData?.todos ?? [];
        return {
            rawData: { todos, count: todos.length },
            displayData: formatListRunsCard(
                todos.map((t: any) => ({ agentName: t?.title ?? t?.id, status: t?.status })),
            ),
        };
    } catch (e: any) {
        throw new Error(`controlAgentRun(todo) 失败: ${toErrorMessage(e)}`);
    }
}
