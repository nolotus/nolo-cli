import { isAbortError } from "../../core/abortError";
import { waitForAbortableDelay } from "../../core/abortableDelay";
import {
  createDrainExhaustedResponse,
  isCoreDrainingBody,
} from "../../core/drainReason";
import { isGatewayHttpStatus } from "../../core/gatewayHttpStatus";
import {
  normalizeNonNegativeMs,
  parseRetryAfterHeaderMs,
} from "../../core/retryAfterMs";

const DEFAULT_SERVER_PROXY_RETRY_AFTER_MS = 1_500;
const MAX_SERVER_PROXY_RETRIES = 2;
const MAX_STATUS_RETRIES = 1;
const MAX_SERVER_DRAIN_STATUS_RETRIES = 30;

const readRetryableResponseBody = async (response: Response) => {
  try {
    return (await response.clone().json()) as {
      reason?: unknown;
      retryAfterMs?: unknown;
    };
  } catch {
    return null;
  }
};

const resolveServerProxyRetryAfterMs = (
  response: Response,
  body: Awaited<ReturnType<typeof readRetryableResponseBody>>,
) =>
  parseRetryAfterHeaderMs(response.headers.get("Retry-After")) ??
  normalizeNonNegativeMs(
    body?.retryAfterMs,
    DEFAULT_SERVER_PROXY_RETRY_AFTER_MS,
  );

const isRetryableServerProxyFetchError = (error: unknown) => {
  if (!error || isAbortError(error)) return false;
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
  const delayMs = normalizeNonNegativeMs(
    retryAfterMs,
    DEFAULT_SERVER_PROXY_RETRY_AFTER_MS,
  );
  if (delayMs <= 0) return;
  await waitForAbortableDelay(delayMs, signal);
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
  let networkRetries = 0;
  let statusRetries = 0;

  while (true) {
    try {
      const response = await execute();
      const responseBody =
        response.status === 503
          ? await readRetryableResponseBody(response)
          : null;
      const isCoreDraining =
        response.status === 503 && isCoreDrainingBody(responseBody);
      const maxStatusRetries = isCoreDraining
        ? MAX_SERVER_DRAIN_STATUS_RETRIES
        : MAX_STATUS_RETRIES;
      if (
        statusRetries < maxStatusRetries &&
        isGatewayHttpStatus(response.status)
      ) {
        statusRetries += 1;
        const retryAfterMs = resolveServerProxyRetryAfterMs(
          response,
          responseBody,
        );
        console.warn(
          `${logPrefix} 检测到${response.status}状态，${retryAfterMs}ms后重试...`
        );
        await waitForServerProxyRetry(retryAfterMs, signal);
        continue;
      }
      // retry 预算耗尽：core_draining 换成用户可读提示，不暴露 raw JSON。
      if (isCoreDraining) {
        console.warn(`${logPrefix} core_draining 重试耗尽，返回友好提示`);
        return createDrainExhaustedResponse(response);
      }
      return response;
    } catch (error: any) {
      if (
        networkRetries < MAX_SERVER_PROXY_RETRIES &&
        isRetryableServerProxyFetchError(error)
      ) {
        networkRetries += 1;
        const retryDelay = networkRetries * 1000;
        console.warn(
          `${logPrefix} 检测到网络瞬断，${retryDelay}ms后重试(第${networkRetries}次)...`,
          error
        );
        await waitForServerProxyRetry(retryDelay, signal);
        continue;
      }
      throw error;
    }
  }
};
