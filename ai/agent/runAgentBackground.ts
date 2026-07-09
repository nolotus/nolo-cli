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
import { selectCurrentToken } from "../../auth/authSlice";
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
}

const MAX_SSE_RETRIES = 3;
const SSE_RETRY_DELAY_MS = 1500;
const MAX_RUN_START_RETRIES = 1;

type RetryableError = Error & { retryable?: boolean; retryAfterMs?: number };

function createRetryableError(message: string, retryAfterMs?: number): RetryableError {
    return Object.assign(new Error(message), {
        retryable: true,
        retryAfterMs,
    });
}

function createSubscriptionError(
    status: number,
    hasBody: boolean,
    retryAfterMs?: number
): RetryableError {
    const message = !hasBody
        ? `事件流响应缺少 body (${status})`
        : `无法订阅事件流 (${status})`;

    if (status === 401 || status === 403) {
        return new Error(message);
    }

    return createRetryableError(message, retryAfterMs);
}

async function waitForRetryDelay(retryAfterMs: number, signal: AbortSignal) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    await new Promise<void>((resolve, reject) => {
        let timeoutId: ReturnType<typeof setTimeout>;
        const onAbort = () => {
            clearTimeout(timeoutId);
            signal.removeEventListener("abort", onAbort);
            reject(new DOMException("Aborted", "AbortError"));
        };
        timeoutId = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, retryAfterMs);
        signal.addEventListener("abort", onAbort, { once: true });
    });
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
        if (e instanceof Error && e.name === "AbortError") throw e;
        throw createRetryableError("事件流连接失败");
    }

    if (!eventsRes.ok || !eventsRes.body) {
        throw createSubscriptionError(
            eventsRes.status,
            !!eventsRes.body,
            resolveRetryAfterMs(eventsRes.headers, SSE_RETRY_DELAY_MS)
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
                if (e instanceof Error && e.name === "AbortError") {
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
    const { agentKey, userInput, serverBase, spaceId, onStatusChange, onDone, onFailed } = args;

    const state = getState();
    const currentServer = serverBase?.trim().replace(/\/+$/, "") || selectCurrentServer(state);
    const token = selectCurrentToken(state);
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

    for (let attempt = 0; attempt <= MAX_RUN_START_RETRIES; attempt++) {
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
                runtimeContext: {
                    surface: "web",
                    host: "browser",
                    runtime: "react",
                    entrypoint: "background-agent-run",
                    capabilities: ["background", "sse-events"],
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
        const retryable =
            payload?.retryable === true ||
            payload?.reason === "core_draining" ||
            runRes.status === 502 ||
            runRes.status === 503 ||
            runRes.status === 504;

        if (retryable && attempt < MAX_RUN_START_RETRIES) {
            await waitForRetryDelay(retryAfterMs, effectiveSignal);
            continue;
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

    // ── Step 2: 订阅 SSE 事件流（含断线重连，最多 3 次）────────────────────────
    let lastError: Error | undefined;

    const eventServer =
        typeof routedServerBase === "string" && routedServerBase.trim()
            ? routedServerBase.trim().replace(/\/+$/, "")
            : currentServer;

    for (let attempt = 0; attempt <= MAX_SSE_RETRIES; attempt++) {
        try {
            return await listenToDialogEvents(
                dialogId, eventServer, authHeader, effectiveSignal,
                onStatusChange, onDone, onFailed,
            );
        } catch (e: any) {
            if (e?.name === "AbortError") throw e;          // 用户主动取消，不重试
            if (!e?.retryable || attempt >= MAX_SSE_RETRIES) throw e; // 非可重试错误或超限
            lastError = e;
            onStatusChange?.("reconnecting");
            await waitForRetryDelay(e?.retryAfterMs ?? SSE_RETRY_DELAY_MS, effectiveSignal);
        }
    }

    throw lastError ?? new Error("事件流重连失败");
});
