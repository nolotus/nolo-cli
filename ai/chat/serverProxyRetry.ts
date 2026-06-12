const RETRYABLE_SERVER_PROXY_STATUSES = new Set([502, 503, 504]);
const DEFAULT_SERVER_PROXY_RETRY_AFTER_MS = 1_500;
const MAX_SERVER_PROXY_RETRIES = 1;

const normalizeServerProxyRetryAfterMs = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.round(parsed)
    : DEFAULT_SERVER_PROXY_RETRY_AFTER_MS;
};

const resolveServerProxyRetryAfterMs = (response: Response) => {
  const retryAfterHeader = response.headers.get("Retry-After");
  if (!retryAfterHeader) {
    return DEFAULT_SERVER_PROXY_RETRY_AFTER_MS;
  }
  const seconds = Number(retryAfterHeader);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000);
  }
  return DEFAULT_SERVER_PROXY_RETRY_AFTER_MS;
};

const isRetryableServerProxyFetchError = (error: unknown) => {
  if (!error || (error as any)?.name === "AbortError") return false;
  const message =
    typeof (error as any)?.message === "string"
      ? (error as any).message
      : String(error);
  return /ECONNREFUSED|ECONNRESET|EPIPE|socket hang up|network error|failed to fetch|fetch failed|connection closed|load failed|502|503|504/i.test(
    message
  );
};

const waitForServerProxyRetry = async (
  retryAfterMs: number,
  signal?: AbortSignal
) => {
  if (retryAfterMs <= 0) return;
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
    }, normalizeServerProxyRetryAfterMs(retryAfterMs));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
};

export const performServerProxyFetchWithRetry = async ({
  execute,
  signal,
  logPrefix = "[fetchWithServerProxy]",
}: {
  execute: () => Promise<Response>;
  signal?: AbortSignal;
  logPrefix?: string;
}): Promise<Response> => {
  for (let attempt = 0; attempt <= MAX_SERVER_PROXY_RETRIES; attempt += 1) {
    try {
      const response = await execute();
      if (
        attempt < MAX_SERVER_PROXY_RETRIES &&
        RETRYABLE_SERVER_PROXY_STATUSES.has(response.status)
      ) {
        const retryAfterMs = resolveServerProxyRetryAfterMs(response);
        console.warn(
          `${logPrefix} 检测到${response.status}状态，${retryAfterMs}ms后重试一次...`
        );
        await waitForServerProxyRetry(retryAfterMs, signal);
        continue;
      }
      return response;
    } catch (error: any) {
      if (
        attempt < MAX_SERVER_PROXY_RETRIES &&
        isRetryableServerProxyFetchError(error)
      ) {
        console.warn(
          `${logPrefix} 检测到网络瞬断，${DEFAULT_SERVER_PROXY_RETRY_AFTER_MS}ms后重试一次...`,
          error
        );
        await waitForServerProxyRetry(DEFAULT_SERVER_PROXY_RETRY_AFTER_MS, signal);
        continue;
      }
      throw error;
    }
  }

  throw new Error("server proxy retry exhausted unexpectedly");
};
