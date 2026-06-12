export const TRANSIENT_READ_RETRY_STATUSES = new Set([502, 503, 504]);

type RetryFetchOptions = {
  delaysMs?: number[];
  fetchImpl?: typeof fetch;
  retryStatuses?: Set<number>;
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_RETRY_DELAYS_MS = [300, 1000];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const getRequestMethod = (input: RequestInfo | URL, init?: RequestInit): string => {
  if (init?.method) return init.method.toUpperCase();
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.method.toUpperCase();
  }
  return "GET";
};

const isRetryableReadMethod = (method: string): boolean =>
  method === "GET" || method === "HEAD";

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";

export const fetchWithTransientReadRetry = async (
  input: RequestInfo | URL,
  init?: RequestInit,
  options: RetryFetchOptions = {}
): Promise<Response> => {
  const method = getRequestMethod(input, init);
  const canRetry = isRetryableReadMethod(method);
  const delaysMs = options.delaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const retryStatuses = options.retryStatuses ?? TRANSIENT_READ_RETRY_STATUSES;
  const fetchImpl = options.fetchImpl ?? fetch;
  const wait = options.sleep ?? sleep;

  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetchImpl(input, init);
      const shouldRetry =
        canRetry &&
        retryStatuses.has(response.status) &&
        attempt < delaysMs.length;

      if (!shouldRetry) return response;
    } catch (error) {
      const shouldRetry = canRetry && !isAbortError(error) && attempt < delaysMs.length;
      if (!shouldRetry) throw error;
    }

    await wait(delaysMs[attempt]);
  }
};
