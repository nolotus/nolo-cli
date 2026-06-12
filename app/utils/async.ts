// 文件路径: app/utils/async.ts

/*
 * ==================================================================
 *  /app/utils/async.ts
 * ==================================================================
 */

const isAbortError = (err: unknown, signal?: AbortSignal) =>
  (err as any)?.name === "AbortError" ||
  (typeof signal !== "undefined" && !!signal?.aborted);

/**
 * 吞掉非 abort 错误，保留 AbortError。
 */
export function swallowNonAbortError<T>(
  promise: Promise<T>,
  fallback: T,
  signal?: AbortSignal
): Promise<T> {
  return promise.catch((err) => {
    if (isAbortError(err, signal)) {
      throw err;
    }
    console.error("Non-abort error in async op:", err);
    return fallback;
  });
}
