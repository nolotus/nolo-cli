export const MAX_INITIAL_STREAM_RETRIES = 1;
export const DEFAULT_INITIAL_STREAM_RETRY_AFTER_MS = 1_500;

const normalizeInitialStreamRetryAfterMs = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.round(parsed)
    : DEFAULT_INITIAL_STREAM_RETRY_AFTER_MS;
};

export const isRetryableInitialStreamError = (error: unknown) => {
  if (!error || (error as any)?.name === "AbortError") return false;
  const message =
    typeof (error as any)?.message === "string"
      ? (error as any).message
      : String(error);
  return /ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|network error|failed to fetch|fetch failed|load failed|connection closed|stream ended before first visible delta|response stream ended before first visible delta|模型响应流 .* 秒内没有返回新内容/i.test(
    message
  );
};

export const waitForInitialStreamRetry = async (
  retryAfterMs: number,
  signal?: AbortSignal
) => {
  if (signal?.aborted) {
    const abortError = new Error("Aborted");
    abortError.name = "AbortError";
    throw abortError;
  }

  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", onAbort);
      const abortError = new Error("Aborted");
      abortError.name = "AbortError";
      reject(abortError);
    };
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, normalizeInitialStreamRetryAfterMs(retryAfterMs));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
};
