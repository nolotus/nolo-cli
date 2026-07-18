// 文件路径: ai/chat/sseClient.ts
// Web 版 SSE 客户端实现 - 使用 fetch + ReadableStream

import { isAbortError } from "../../core/abortError";

export interface SSEClientOptions {
    url: string;
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
    onMessage: (data: string) => void;
    onError: (error: Error) => void;
    onComplete: () => void;
}

/**
 * Web 版 SSE 客户端
 * 使用 fetch + ReadableStream.getReader() 实现流式读取
 */
export async function createSSEClient(options: SSEClientOptions): Promise<void> {
    const { url, method, headers, body, signal, onMessage, onError, onComplete } = options;

    try {
        const response = await fetch(url, {
            method,
            headers,
            body,
            signal,
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const reader = response.body?.getReader();
        if (!reader) {
            throw new Error('Response body is not readable');
        }

        const decoder = new TextDecoder();

        try {
            while (true) {
                const { done, value } = await reader.read();

                if (done) {
                    onComplete();
                    break;
                }

                const chunk = decoder.decode(value, { stream: true });
                onMessage(chunk);
            }
        } finally {
            try {
                await reader.cancel();
            } catch (_e) {
                // ignore cancel errors
            }
        }
    } catch (error: any) {
        if (isAbortError(error)) {
            onComplete();
        } else {
            onError(error instanceof Error ? error : new Error(String(error)));
        }
    }
}
