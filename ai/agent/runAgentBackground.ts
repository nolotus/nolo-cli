// packages/ai/agent/runAgentBackground.ts
// 后台运行 agent 并通过 SSE 监听结果
//
// 使用方式（在组件/thunk 中）：
//   dispatch(runAgentBackground({
//     agentKey: "agent-xxx",
//     userInput: "帮我搜索...",
//     spaceId: "space-yyy",       // 可选，写入 space 索引
//     onStatusChange: (s) => ..., // 可选，实时更新 UI 状态
//     onDone: (result) => ...,    // 可选，成功回调
//     onFailed: (error) => ...,   // 可选，失败回调
//   }));

import { createAsyncThunk } from "@reduxjs/toolkit";
import type { RootState } from "../../app/store";
import { selectCurrentServer } from "../../app/settings/settingSlice";
import { resolveRetryAfterMs } from "../../app/utils/retryAfter";
import { selectIdentityToken } from "identity/selectors";
import { isAbortError } from "../../core/abortError";
import { waitForAbortableDelay } from "../../core/abortableDelay";
import { CORE_DRAIN_REASON, DRAIN_EXHAUSTED_USER_MESSAGE } from "../../core/drainReason";
import { isDeployWindowRetrySignal } from "../../core/deployWindowRetrySignal";
import { isGatewayHttpStatus } from "../../core/gatewayHttpStatus";
import { normalizeServerOrigin } from "../../core/serverOrigin";
import { createSSEParser } from "../chat/parseMultilineSSE";

export type DialogStatus = "pending" | "running" | "done" | "failed" | "cancelled" | "reconnecting";

export interface RunAgentBackgroundResult {
    dialogId: string;
    content?: string;
    usage?: unknown;
    status?: string;
}

export interface RunAgentBackgroundArgs {
    agentKey: string;
    userInput: string;
    serverBase?: string;
    spaceId?: string;
    /** 任务状态变化时触发（pending → running → done/failed） */
    onStatusChange?: (status: DialogStatus) => void;
    /** agent 成功完成时触发 */
    onDone?: (result: { dialogId: string; content?: string; usage?: unknown }) => void;
    /** agent 失败时触发 */
    onFailed?: (error: string) => void;
    /** 外部取消信号 */
    signal?: AbortSignal;
    /** 是否等待 SSE 完成事件；false 时拿到 dialogId 立即返回（用于 callAgent background 模式） */
    waitForCompletion?: boolean;
    /**
     * 父对话 id。非空时透传给服务端 /api/agent/run 的 parentDialogId，
     * 让后台子对话（如 review）记录父子关系，供侧边栏折叠。
     */
    parentDialogId?: string;
    /**
     * Ephemeral run: do not persist the dialog or its turns. Used for
     * one-shot reviews where leaving a dialog record is noise. The server
     * handler skips createPendingDialog/finalizeDialog when this is true.
     */
    ephemeral?: boolean;
}

const MAX_SSE_RETRIES = 3;
// 部署窗口（core_draining / 502/503/504 / 事件流意外关闭）走专属长预算，
// 与 run start 及 TUI/Web chat 的 30 次预算对齐：1.5s/次 × 30 ≈ 45s > drain 窗口。
const MAX_SSE_CORE_DRAINING_RETRIES = 30;
const SSE_RETRY_DELAY_MS = 1500;
// 普通可重试错误：只重试 1 次。
// 结构化 `core_draining`（服务端明示的 deploy drain 窗口，最长 30s）走专属长预算，
// 与 TUI/Web chat 的 30 次预算对齐：1.5s/次 × 30 ≈ 45s > drain 窗口，不会中途放弃。
const MAX_RUN_START_RETRIES = 1;
const MAX_RUN_START_CORE_DRAINING_RETRIES = 30;

type RetryableError = Error & {
    retryable?: boolean;
    retryAfterMs?: number;
    /** HTTP 响应状态（订阅握手失败时携带，用于部署窗口信号分类） */
    status?: number;
    /** 服务端 drain reason（如 core_draining） */
    reason?: string;
};

function createRetryableError(message: string, retryAfterMs?: number): RetryableError {
    return Object.assign(new Error(message), {
        retryable: true,
        retryAfterMs,
    });
}

function createSubscriptionError(
    status: number,
    hasBody: boolean,
    retryAfterMs?: number,
    reason?: string
): RetryableError {
    const message = !hasBody
        ? `事件流响应缺少 body (${status})`
        : `无法订阅事件流 (${status})`;

    if (status === 401 || status === 403) {
        return new Error(message);
    }

    const err = createRetryableError(message, retryAfterMs);
    err.status = status;
    if (reason) err.reason = reason;
    return err;
}

async function waitForRetryDelay(retryAfterMs: number, signal: AbortSignal) {
    await waitForAbortableDelay(retryAfterMs, signal);
}

function parseRetryableJson(text: string) {
    try {
        return JSON.parse(text) as {
            error?: string;
            reason?: string;
            retryable?: boolean;
            retryAfterMs?: number;
        };
    } catch {
        return null;
    }
}

/**
 * 订阅单次 dialog 事件流，收到 done/failed 则 resolve/reject，
 * 流意外关闭时 reject 并标记 retryable=true 供上层重试。
 */
async function listenToDialogEvents(
    dialogId: string,
    currentServer: string,
    authHeader: string,
    signal: AbortSignal,
    onStatusChange?: (status: DialogStatus) => void,
    onDone?: (result: { dialogId: string; content?: string; usage?: unknown }) => void,
    onFailed?: (error: string) => void,
): Promise<RunAgentBackgroundResult> {
    let eventsRes: Response;
    try {
        eventsRes = await fetch(
            `${currentServer}/api/events/dialog-${dialogId}`,
            {
                method: "GET",
                headers: {
                    Accept: "text/event-stream",
                    ...(authHeader && { Authorization: authHeader }),
                },
                signal,
            }
        );
    } catch (e) {
        if (isAbortError(e)) throw e;
        throw createRetryableError("事件流连接失败");
    }

    if (!eventsRes.ok || !eventsRes.body) {
        // 读取 body 解析服务端结构化信息（reason / retryAfterMs），供上层裁决预算。
        // 解析失败时故意降级为空字符串：retry 仍可基于 header/status 继续，
        // 不因 body 读取异常而中断重试分类。
        const errText = await eventsRes.text().catch(() => "");
        const payload = parseRetryableJson(errText);
        throw createSubscriptionError(
            eventsRes.status,
            !!eventsRes.body,
            resolveRetryAfterMs(eventsRes.headers, SSE_RETRY_DELAY_MS, payload?.retryAfterMs),
            payload?.reason
        );
    }

    const reader = eventsRes.body.getReader();
    const decoder = new TextDecoder();
    const parseSSE = createSSEParser();

    return new Promise<RunAgentBackgroundResult>((resolve, reject) => {
        const processStream = async () => {
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    const chunk = decoder.decode(value, { stream: true });
                    const events = parseSSE(chunk);

                    for (const event of events) {
                        const type = event.type as string;

                        if (type === "status") {
                            onStatusChange?.(event.status as DialogStatus);
                        } else if (type === "done") {
                            const result = {
                                dialogId,
                                content: event.content as string | undefined,
                                usage: event.usage,
                            };
                            onStatusChange?.("done");
                            onDone?.(result);
                            reader.cancel().catch(() => { });
                            resolve(result);
                            return;
                        } else if (type === "failed") {
                            const errMsg = (event.error as string) ?? "未知错误";
                            onStatusChange?.("failed");
                            onFailed?.(errMsg);
                            reader.cancel().catch(() => { });
                            reject(new Error(errMsg));
                            return;
                        }
                    }
                }
                // 流正常关闭但未收到 done/failed（服务重启等），标记可重试
                const err = createRetryableError("事件流意外关闭");
                reject(err);
            } catch (e: unknown) {
                if (isAbortError(e)) {
                    resolve({ dialogId });
                } else {
                    reject(e);
                }
            }
        };

        processStream();
    });
}

export const runAgentBackground = createAsyncThunk<
    RunAgentBackgroundResult,
    RunAgentBackgroundArgs,
    { state: RootState }
>("agent/runBackground", async (args, { getState, signal: thunkSignal }) => {
    const { agentKey, userInput, serverBase, spaceId, parentDialogId, ephemeral, onStatusChange, onDone, onFailed } = args;

    const state = getState();
    const currentServer = normalizeServerOrigin(serverBase) || selectCurrentServer(state);
    const token = selectIdentityToken(state);
    if (!currentServer) throw new Error("未配置服务器地址");

    const authHeader = token ? `Bearer ${token}` : "";

    // ── Step 1: 触发后台运行，获取 dialogId ──────────────────────────────────
    const effectiveSignal = args.signal ?? thunkSignal;
    let runResponse:
        | {
            dialogId: string;
            status: string;
            serverBase?: string;
        }
        | null = null;

    // core_draining 走 drain 专属长预算（30 次），其余可重试错误保持默认 1 次。
    // 预算在每次失败响应后按类型裁决，循环上限也按预算走。
    let maxRunStartRetries = MAX_RUN_START_RETRIES;

    for (let attempt = 0; attempt <= maxRunStartRetries; attempt++) {
        const runRes = await fetch(`${currentServer}/api/agent/run`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(authHeader && { Authorization: authHeader }),
            },
            body: JSON.stringify({
                agentKey,
                userInput,
                spaceId,
                background: true,
                ...(parentDialogId ? { parentDialogId } : {}),
                ...(ephemeral ? { ephemeral: true } : {}),
                runtimeContext: {
                    surface: "web",
                    host: "browser",
                    runtime: "react",
                    entrypoint: "background-agent-run",
                    capabilities: ["background", "sse-events"],
                    ...(parentDialogId ? { parentThreadId: parentDialogId } : {}),
                },
            }),
            signal: effectiveSignal,
        });

        if (runRes.ok) {
            runResponse = (await runRes.json()) as {
                dialogId: string;
                status: string;
                serverBase?: string;
            };
            break;
        }

        const errText = await runRes.text();
        const payload = parseRetryableJson(errText);
        const retryAfterMs = resolveRetryAfterMs(
            runRes.headers,
            SSE_RETRY_DELAY_MS,
            payload?.retryAfterMs
        );
        const isCoreDraining = payload?.reason === CORE_DRAIN_REASON;
        const retryable =
            payload?.retryable === true ||
            isCoreDraining ||
            isGatewayHttpStatus(runRes.status);
        if (isCoreDraining) {
            maxRunStartRetries = MAX_RUN_START_CORE_DRAINING_RETRIES;
        }

        if (retryable && attempt < maxRunStartRetries) {
            await waitForRetryDelay(retryAfterMs, effectiveSignal);
            continue;
        }

        // retry 耗尽：core_draining 换成用户可读提示，不暴露 raw JSON。
        if (isCoreDraining) {
            throw new Error(DRAIN_EXHAUSTED_USER_MESSAGE);
        }
        throw new Error(`启动后台任务失败 (${runRes.status}): ${errText}`);
    }

    if (!runResponse) {
        throw new Error("启动后台任务失败：未收到可用的后台运行响应");
    }

    const {
        dialogId,
        serverBase: routedServerBase,
    } = runResponse;
    onStatusChange?.("pending");

    if (args.waitForCompletion === false) {
        return { dialogId, status: runResponse.status };
    }

    // ── Step 2: 订阅 SSE 事件流（含断线重连）───────────────────────────────────
    // 预算按错误类型动态裁决：部署窗口信号（503 core_draining / 502/503/504 /
    // 事件流意外关闭）提升到 30 次长预算（≈45s > drain 窗口，不会中途放弃，
    // 与 run start 及 TUI/Web chat 对齐）；其余 retryable 错误保持默认 3 次。
    let lastError: Error | undefined;
    let maxSseRetries = MAX_SSE_RETRIES;

    const eventServer = normalizeServerOrigin(routedServerBase) || currentServer;

    for (let attempt = 0; attempt <= maxSseRetries; attempt++) {
        try {
            return await listenToDialogEvents(
                dialogId, eventServer, authHeader, effectiveSignal,
                onStatusChange, onDone, onFailed,
            );
        } catch (e: any) {
            if (isAbortError(e)) throw e;          // 用户主动取消，不重试
            if (!e?.retryable || attempt >= maxSseRetries) throw e; // 非可重试错误或超限
            if (isDeployWindowRetrySignal(e)) {
                maxSseRetries = MAX_SSE_CORE_DRAINING_RETRIES;
            }
            lastError = e;
            onStatusChange?.("reconnecting");
            await waitForRetryDelay(e?.retryAfterMs ?? SSE_RETRY_DELAY_MS, effectiveSignal);
        }
    }

    throw lastError ?? new Error("事件流重连失败");
});
