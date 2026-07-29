// packages/ai/agent/streamTurnStreamConsumer.ts
//
// 共享的 agent-run stream 消费器。
// 从 streamAgentChatTurn.ts 提取——把 machine-bound / CLI / remote 三处
// 几乎一样的 "read chunk → 解析 → 处理 payload → 检查 abort" 循环收敛到一处。
//
// 关键修复点:当 reader.read() 返回 done:true 时,只有真正收到过完成信号
// (done 事件) 才算"正常结束";否则视为连接被静默中断。

import { isAbortError } from "../../core/abortError";

export type AgentRunStreamConsumeOutcome =
    | { outcome: "aborted" }
    | { outcome: "rejected"; message: string }
    | { outcome: "streamEnded"; sawDone: boolean };

export interface AgentRunStreamHandlers {
    reader: ReadableStreamDefaultReader<Uint8Array>;
    decoder: TextDecoder;
    /** 解码后的原始 chunk → 一组 payload(machine/remote 用 parseSSE,CLI 用手工行解析)。 */
    parseChunk: (raw: string) => any[];
    /** 处理单条 payload 的副作用;返回值用于控制流。可以是 async(允许 await 副作用)。 */
    onPayload: (
        payload: any,
    ) =>
        | void
        | { reject?: string; abort?: true }
        | Promise<void | { reject?: string; abort?: true }>;
    /** 判断 payload 是否是"完成信号",用于区分正常结束 vs 截断。 */
    isDoneEvent: (payload: any) => boolean;
    /** 是否已被中止(loopController / thunkApi signal)。 */
    isAborted: () => boolean;
    /**
     * Optional AbortSignal used to wake a blocked reader.read().
     * Desktop webviews may not reject the body reader when fetch aborts after
     * headers — racing the signal cancels the reader immediately on stop.
     */
    signal?: AbortSignal;
    /** 中止时要执行的清理(如持久化已累积内容)。 */
    onAbort: () => Promise<void>;
}

export async function readAgentRunStreamChunk(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal: AbortSignal | undefined,
    isAborted: () => boolean,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>> {
    if (isAborted() || signal?.aborted) {
        void reader.cancel().catch(() => {});
        throw new DOMException("The operation was aborted.", "AbortError");
    }
    if (!signal) {
        return reader.read();
    }

    let settled = false;
    return new Promise((resolve, reject) => {
        const finish = (cb: () => void) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", onAbort);
            cb();
        };
        const onAbort = () => {
            void reader.cancel().catch(() => {});
            finish(() =>
                reject(new DOMException("The operation was aborted.", "AbortError")),
            );
        };
        signal.addEventListener("abort", onAbort);
        reader.read().then(
            (result) => finish(() => resolve(result)),
            (err) => finish(() => reject(err)),
        );
    });
}

export async function consumeAgentRunStream(
    handlers: AgentRunStreamHandlers,
): Promise<AgentRunStreamConsumeOutcome> {
    const {
        reader,
        decoder,
        parseChunk,
        onPayload,
        isDoneEvent,
        isAborted,
        signal,
        onAbort,
    } = handlers;
    let sawDone = false;

    try {
        while (true) {
            let done: boolean;
            let value: Uint8Array | undefined;
            try {
                ({ done, value } = await readAgentRunStreamChunk(
                    reader,
                    signal,
                    isAborted,
                ));
            } catch (error) {
                if (isAbortError(error) || isAborted() || signal?.aborted) {
                    await onAbort();
                    return { outcome: "aborted" };
                }
                throw error;
            }
            // abort 检测必须在 done 判断之前:用户主动取消时,流可能恰好在此刻自然结束,
            // 此时应当走"用户取消"分支,而不是被误判为"连接异常截断"。
            if (isAborted() || signal?.aborted) {
                await onAbort();
                return { outcome: "aborted" };
            }
            if (done) {
                return { outcome: "streamEnded", sawDone };
            }

            const payloads = parseChunk(
                decoder.decode(value as Uint8Array, { stream: true }),
            );
            for (const payload of payloads) {
                if (isAborted() || signal?.aborted) {
                    await onAbort();
                    return { outcome: "aborted" };
                }
                const directive = await onPayload(payload);
                if (directive?.reject !== undefined) {
                    return { outcome: "rejected", message: directive.reject };
                }
                if (directive?.abort) {
                    await onAbort();
                    return { outcome: "aborted" };
                }
                if (isDoneEvent(payload)) {
                    sawDone = true;
                }
            }
        }
    } catch (error) {
        if (isAbortError(error) || isAborted() || signal?.aborted) {
            await onAbort();
            return { outcome: "aborted" };
        }
        throw error;
    }
}