// packages/ai/tools/agent/controlAgentRunTool.ts
//
// controlAgentRun tool — observe and control background agent runs.
//
// Unix analogy: wait + signal + /proc. One tool, four actions:
// - list: list runs → POST /api/agent/runs/control { action: "list" }
// - status: single run + log tail → POST /api/agent/runs/control { action: "status" }
// - stop: cancel a run → POST /api/agent/runs/control { action: "stop" }
// - wait: block until the run reaches a terminal state and return its result.
//   The server control plane has no wait endpoint, so wait is implemented
//   client-side: subscribe the dialog SSE stream at /api/events/dialog-<runId>
//   until done/failed (same endpoint runAgentBackground uses), after a quick
//   status pre-check that returns immediately for already-terminal runs.

import { callToolApi, getToolRequestContext } from "../toolApiClient";
import { listenToDialogEvents } from "../../agent/runAgentBackground";
import { isAbortError } from "../../../core/abortError";
import { toErrorMessage } from "../../../core/errorMessage";
import { formatListRunsCard, formatStatusRunCard, formatStopRunCard, resolveRunLabel } from "./agentRunDisplayHelpers";

export const controlAgentRunFunctionSchema = {
    name: "controlAgentRun",
    description:
        "观察和控制后台 agent run。一个工具四个核心 action：" +
        "list（列出 run，支持按批次/状态过滤与分页）、status（查单条 + 可选日志）、stop（取消 run）、" +
        "wait（同步等待 run 到达终态并返回结果，Unix wait 语义；另有 todo 查询 runtime todo）。" +
        "相当于 Unix 的 wait + signal + /proc。" +
        "用 startAgentRun 拿到 runId 后，用本工具跟进度、等结果或叫停。" +
        "异步派发后禁止轮询查询——不要反复调 status 等结果，用户界面已在实时显示每条 run 的状态；" +
        "要同步结果直接用 startAgentRun(wait:true) 或本工具 wait action。" +
        "list 默认只返回最近 20 条，避免全量冲爆上下文；用 status/batchId/limit/offset 取所需分页。" +
        "注意：用户界面已经在独立实时显示每条 run 的状态，本工具是给你自己做决策用的，" +
        "不是用来给用户汇报进度的——不必为了「让用户看到状态」而轮询，也不要把返回值复述给用户。",
    parameters: {
        type: "object",
        properties: {
            action: {
                type: "string",
                enum: ["list", "status", "stop", "todo", "wait"],
                description:
                    "要执行的操作：list=列出 run（省略 runId）；" +
                    "status=查单条 run 状态 + 可选日志；stop=取消 run；" +
                    "wait=同步等待 run 到达终态并返回结果（Unix wait 语义；客户端订阅该 dialog 的 SSE 事件流等 done/failed，已终态立即返回）；" +
                    "todo=列出 runtime todo（由 startAgentRun 的 batchId/trackTodo 产生，状态由关联 run 推导）。",
            },
            runId: {
                type: "string",
                description:
                    "目标 run 的 ID（startAgentRun 返回的 runId）。action=list 时省略。",
            },
            timeoutMs: {
                type: "number",
                description:
                    "可选。action=wait 的等待上限（毫秒），默认 100000（100s）。" +
                    "超过上限仍未到达终态时返回 status=\"timeout\"（不是失败），可稍后再 wait 或改用 status/stop。",
                default: 100000,
            },
            tailLines: {
                type: "number",
                description:
                    "可选。action=status 时：0=只返回状态摘要，>0=同时返回最近 N 行日志（默认 0）。" +
                    "本地 run 的状态摘要里带 progress（toolCalls/llmCalls/fileEdits、inFlight=此刻在执行什么、" +
                    "idleMs=距上次事件多久），足以判断「在干活」还是「卡住了」——先看它，" +
                    "只有确实可疑或已失败时才 tailLines>0 拉日志。",
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
    action: "list" | "status" | "stop" | "todo" | "wait";
    runId?: string;
    tailLines?: number;
    timeoutMs?: number;
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
    const { action, runId, tailLines, timeoutMs, batchId, status, statusFilter, limit, offset } = args;

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

    if (action === "wait") {
        if (!runId) throw new Error('controlAgentRun(action:"wait"): 缺少 runId。');
        return handleWait(thunkApi, { runId, timeoutMs, signal: _context?.signal });
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

// ── wait ───────────────────────────────────────────────────────────────────
//
// 后端 control 平面（agentRunControlHandler 的 ControlAction）只有 list/status/
// stop，没有 wait 端点，因此 wait 在客户端实现，语义等同 Unix wait：
//   1) 先经 status 预检：run 已终态（done/failed/cancelled/orphaned）或不存在
//      时直接返回，不挂 SSE（已终态立即返回，避免空等事件流）；
//   2) 否则订阅该 dialog 的 SSE 事件流（/api/events/dialog-<runId>，复用
//      runAgentBackground 的 listenToDialogEvents，与 startAgentRun(wait:true)
//      是同一事件端点）等 done/failed；
//   3) 超过 timeoutMs（默认 100s）返回 status="timeout"，调用方可稍后再
//      wait 或改用 status/stop——wait 是一次阻塞等终态，不是轮询。
//
// 中断语义：超时或外部 AbortSignal 触发时，内部 AbortController 会被 abort，
// 从而关闭底层 SSE 订阅（listenToDialogEvents 的 reader.read() 抛 AbortError），
// 避免事件流泄漏；「正常 done/failed 事件」与「abort/超时中断」严格区分——
// 只有真正的 done/failed 事件才走成功/失败路径，abort 一律按中断错误抛出，
// 绝不误报为 done。

const WAIT_TERMINAL_STATUSES = new Set(["done", "failed", "cancelled", "orphaned"]);
const DEFAULT_WAIT_TIMEOUT_MS = 100_000;
const WAIT_INTERRUPTED_ERROR_NAME = "AgentWaitInterruptedError";

function createWaitInterruptedError(): Error {
    const err = new Error(
        "等待被中止：SSE 订阅已中断（外部取消或连接清理），未收到 done/failed 事件，不是成功完成"
    );
    err.name = WAIT_INTERRUPTED_ERROR_NAME;
    return err;
}

// handleWait 的内部结局：只有「真正的 done 事件」或「超时」会 resolve；
// failed、中断、事件流意外关闭一律 reject（由外层 catch 转成错误抛出）。
type WaitOutcome =
    | { kind: "done"; dialogId: string; content?: string }
    | { kind: "timeout"; waitedMs: number };

async function handleWait(
    thunkApi: any,
    opts: { runId: string; timeoutMs?: number; signal?: AbortSignal }
): Promise<{ rawData: any; displayData: string }> {
    const timeoutMs =
        opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_WAIT_TIMEOUT_MS;
    const { currentServer, token } = getToolRequestContext(thunkApi);
    const authHeader = token ? `Bearer ${token}` : "";

    // 内部 AbortController 链到外部 signal：超时或外部 abort 时 abort 它，
    // 从而关闭 listenToDialogEvents 的底层 SSE fetch 连接（reader.read() 抛
    // AbortError）——超时后绝不能留着事件流继续订阅（资源泄漏）。
    const abortController = new AbortController();
    const externalSignal = opts.signal;
    const onExternalAbort = () => abortController.abort();
    if (externalSignal) {
        if (externalSignal.aborted) {
            abortController.abort();
        } else {
            externalSignal.addEventListener("abort", onExternalAbort, { once: true });
        }
    }
    const sseSignal = abortController.signal;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        // 外部 signal 在进入时已被中止：直接按中断处理，不做无谓的预检/订阅。
        if (sseSignal.aborted) throw createWaitInterruptedError();

        // 1) 预检终态（顺带校验 run 存在性）。
        const data = await callToolApi(
            thunkApi,
            "/api/agent/runs/control",
            { action: "status", runId: opts.runId },
            { withAuth: true }
        );
        const resData = data?.data ?? data;
        if (!resData || resData.found === false || !resData.run) {
            throw new Error(`run ${opts.runId} 不存在或不可见`);
        }
        const run = resData.run;
        if (WAIT_TERMINAL_STATUSES.has(run.status)) {
            return {
                rawData: { runId: opts.runId, status: run.status, content: run.lastAssistantText ?? "" },
                displayData: `✅ controlAgentRun(wait) 完成，run ${opts.runId} 已处于终态 ${run.status}`,
            };
        }
        // 预检期间外部 signal 被中止：不再挂 SSE。
        if (sseSignal.aborted) throw createWaitInterruptedError();

        // 2) 订阅该 dialog 的 SSE 事件流等 done/failed。server/token 与
        //    callToolApi 同源（getToolRequestContext），保证与其它 action 一致。
        const outcome = await new Promise<WaitOutcome>((resolve, reject) => {
            let settled = false;
            const settle = (fn: () => void) => {
                if (settled) return;
                settled = true;
                fn();
            };

            // done/failed 只通过回调判定：onDone/onFailed 只有真正的
            // done/failed 事件才触发，SSE abort/中断不会误触发。
            listenToDialogEvents(
                opts.runId,
                currentServer,
                authHeader,
                sseSignal,
                undefined,
                (result) =>
                    settle(() => resolve({ kind: "done", dialogId: result.dialogId, content: result.content })),
                (errMsg) => settle(() => reject(new Error(errMsg))),
            ).then(
                (r) => {
                    // SSE 流结束但没触发 done/failed 回调：
                    // - 超时：timeout 分支已 settle，忽略；
                    // - 外部 abort：即便监听器把 AbortError 吞成 resolve({dialogId})，
                    //   也必须识别为中断而不是 done；
                    // - 事件流意外关闭：按失败处理（可稍后再 wait）。
                    if (settled) return;
                    if (sseSignal.aborted) {
                        settle(() => reject(createWaitInterruptedError()));
                    } else if (r && ("content" in r || "usage" in r)) {
                        // 兼容：真实 done 事件总会带 content/usage 字段；某些
                        // 调用方/旧 mock 直接 resolve 结果而不走 onDone 回调。
                        settle(() => resolve({ kind: "done", dialogId: r.dialogId, content: r.content }));
                    } else {
                        settle(() => reject(new Error("事件流意外关闭，未收到 done/failed 事件")));
                    }
                },
                (e) => {
                    if (settled) return;
                    if (isAbortError(e)) {
                        // 用户主动取消/外部中止：AbortError 原样透传，保持取消语义
                        settle(() => reject(e));
                    } else if (sseSignal.aborted) {
                        settle(() => reject(createWaitInterruptedError()));
                    } else {
                        settle(() => reject(e));
                    }
                },
            );

            // 超时：先 abort 底层 SSE（关闭连接、释放资源），再落定时结果。
            timer = setTimeout(() => {
                abortController.abort();
                settle(() => resolve({ kind: "timeout", waitedMs: timeoutMs }));
            }, timeoutMs);
        });

        if (outcome.kind === "timeout") {
            return {
                rawData: { runId: opts.runId, status: "timeout", waitedMs: outcome.waitedMs },
                displayData: `⏳ controlAgentRun(wait) 已等待 ${Math.round(outcome.waitedMs / 1000)}s 仍未完成，未达终态；可稍后再 wait，或改用 status/stop。`,
            };
        }

        return {
            rawData: { runId: opts.runId, status: "done", content: outcome.content ?? "" },
            displayData: `✅ controlAgentRun(wait) 完成，dialogId: ${outcome.dialogId}`,
        };
    } catch (e: any) {
        // 中断/取消保持原样抛出（含 AbortError），不包成普通失败——否则上层
        // 会把「取消」误当成工具执行失败。
        if (isAbortError(e) || e?.name === WAIT_INTERRUPTED_ERROR_NAME) throw e;
        throw new Error(`controlAgentRun(wait) 失败: ${toErrorMessage(e)}`);
    } finally {
        if (timer) clearTimeout(timer);
        if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
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
