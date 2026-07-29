// 文件路径: ai/chat/streamReader.ts
// Web 版流式读取器 - 使用 fetch Response + ReadableStream

import { isAbortError } from "../../core/abortError";
import type { SSEClientOptions } from './sseClient';

export interface StreamReaderOptions {
    response: Response;
    signal?: AbortSignal;
    onChunk: (chunk: string) => void;
    onError: (error: Error) => void;
    onComplete: () => void;
}

export function createAbortError(
  message = "The operation was aborted.",
): DOMException {
  return new DOMException(message, "AbortError");
}

/** Matches reader.read()'s result regardless of which TS stream lib is active. */
type StreamChunkReadResult = Awaited<
  ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>
>;

/**
 * Read one stream chunk, optionally racing AbortSignal and/or a stall timeout.
 *
 * Why this exists: some desktop webviews do not promptly reject `reader.read()`
 * when the parent fetch AbortSignal aborts after headers were already received.
 * Without racing the signal (and cancelling the reader), the stop button appears
 * to do nothing while chunks keep arriving.
 */
export async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
    timeoutErrorMessage?: string;
  },
): Promise<StreamChunkReadResult> {
  const signal = options?.signal;
  if (signal?.aborted) {
    throw createAbortError();
  }

  const timeoutMs = options?.timeoutMs;
  if (!signal && !(timeoutMs && timeoutMs > 0)) {
    return reader.read();
  }

  let settled = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  return new Promise<StreamChunkReadResult>((resolve, reject) => {
    const finish = (cb: () => void) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (onAbort && signal) signal.removeEventListener("abort", onAbort);
      cb();
    };

    onAbort = () => {
      void reader.cancel().catch(() => {});
      finish(() => reject(createAbortError()));
    };
    signal?.addEventListener("abort", onAbort);

    if (timeoutMs && timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        finish(() =>
          reject(
            new Error(
              options?.timeoutErrorMessage ??
                `Stream stalled for ${Math.round(timeoutMs / 1000)}s`,
            ),
          ),
        );
      }, timeoutMs);
    }

    reader.read().then(
      (result) => finish(() => resolve(result)),
      (err) => finish(() => reject(err)),
    );
  });
}

/**
 * Web 版流式读取器
 * 从 fetch Response 的 ReadableStream 读取数据
 */
export async function readStream(options: StreamReaderOptions): Promise<void> {
    const { response, onChunk, onError, onComplete, signal } = options;

    const reader = response.body?.getReader();
    if (!reader) {
        onError(new Error('Response body is not readable'));
        return;
    }

    const decoder = new TextDecoder();

    try {
        while (true) {
            const { done, value } = await readStreamChunk(reader, { signal });

            if (done) {
                onComplete();
                break;
            }

            const chunk = decoder.decode(value, { stream: true });
            onChunk(chunk);
        }
    } catch (error: any) {
        if (isAbortError(error)) {
            onComplete();
        } else {
            onError(error instanceof Error ? error : new Error(String(error)));
        }
    } finally {
        try {
            await reader.cancel();
        } catch (_e) {
            // ignore
        }
    }
}

/**
 * 检查当前环境是否支持 ReadableStream
 * Web 环境返回 true，React Native 返回 false
 */
export function supportsReadableStream(): boolean {
    return true;
}
