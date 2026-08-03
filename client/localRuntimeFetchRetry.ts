/**
 * Fetch with transient-error retry + loopback bypass.
 *
 * Extracted from localRuntimeAdapter.ts for maintainability. All functions
 * here are pure (no shared module state) so they can be unit-tested in
 * isolation via fetchWithTransientRetry.test.ts.
 *
 * Re-exported through localRuntimeAdapter.ts (barrel) so existing imports
 * from "./localRuntimeAdapter" continue to work without changes.
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { CliFetchImpl } from "../cliFetch";
import { toErrorMessage } from "../core/errorMessage";
import {
  createDrainExhaustedResponse,
  isCoreDrainingBody,
} from "../core/drainReason";
import { isLoopbackHostname } from "../core/localOrigins";
import {
  normalizeNonNegativeMs,
  parseRetryAfterHeaderMs,
} from "../core/retryAfterMs";

export type FetchInput = string | URL | Request;
export type FetchInit = RequestInit;

const TRANSIENT_FETCH_MAX_ATTEMPTS = 3;
const TRANSIENT_FETCH_RETRY_BASE_DELAY_MS = 250;
// 仅对结构化 `503 core_draining`（服务端明示可重试的 drain 窗口）使用长预算，
// 普通 429/503 与网络错误保持 TRANSIENT_FETCH_MAX_ATTEMPTS，避免一次容量抖动
// 或持续限流把客户端拖住近 5 分钟。
const CORE_DRAINING_MAX_ATTEMPTS = 30;

/**
 * 上游明确表示「我没受理」的状态码，与服务端 chatUpstreamRetry 的 GENTLE_RETRY_STATUSES
 * 保持同一口径：重试不会产生重复 token、不会重复计费。
 * 502/504 不在内——那两个可能意味着请求已被处理，重试有副作用风险。
 * 幂等写路径（如 evidence `customKey` 覆盖写）可经 `retryableStatuses` 显式放宽。
 */
const RETRYABLE_HTTP_STATUSES = new Set([429, 503]);

function isTransientFetchError(error: unknown) {
  const message = toErrorMessage(error);
  return /certificate|handshake|network|socket|timed out|timeout|ECONNRESET/i.test(
    message,
  );
}

async function defaultSleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function transientFetchRetryDelayMs(attempt: number) {
  return Math.min(attempt * TRANSIENT_FETCH_RETRY_BASE_DELAY_MS, 2_000);
}

/**
 * 从一个可重试响应里读出建议等待时长。
 *
 * nolo 服务端在排空/限流时会明确给出信号，例如
 * 503 {"error":"Server draining","reason":"core_draining","retryable":true,"retryAfterMs":1500}
 * 以前客户端完全不看这些字段——`fetchWithTransientRetry` 只在**抛异常**时重试，
 * 而 503 是一次成功的 HTTP 交换，于是服务端说「可以重试、等我 1.5 秒」，
 * 客户端却直接把它当成终局失败上报给用户。
 *
 * 优先级：标准 `Retry-After` 头（复用 core/retryAfterMs，支持秒与 HTTP-date）
 * > 响应体 `retryAfterMs` > 既有退避。读体前先 clone，避免把调用方要用的 body 消费掉。
 */
const MAX_RETRY_DELAY_MS = 10_000;

async function resolveRetryAfterMs(
  response: Response,
  attempt: number,
): Promise<number> {
  const headerMs = parseRetryAfterHeaderMs(
    response.headers.get("retry-after"),
  );
  if (headerMs !== null) {
    return Math.min(headerMs, MAX_RETRY_DELAY_MS);
  }
  try {
    const body = await response.clone().text();
    const parsed = JSON.parse(body) as { retryAfterMs?: unknown };
    const ms = normalizeNonNegativeMs(parsed?.retryAfterMs, 0);
    if (ms > 0) return Math.min(ms, MAX_RETRY_DELAY_MS);
  } catch {
    // 非 JSON 或 body 不可读：退回既有退避。
  }
  return transientFetchRetryDelayMs(attempt);
}

/**
 * Loopback URL check for fetch inputs (string | URL | Request).
 * Reuses core/localOrigins `isLoopbackHostname` so loopback detection stays
 * single-source. Request objects are unwrapped via `.url`.
 */
export function isLoopbackUrl(input: FetchInput) {
  try {
    const target =
      typeof input === "string" || input instanceof URL
        ? new URL(String(input))
        : new URL(input.url);
    return isLoopbackHostname(target.hostname);
  } catch {
    return false;
  }
}

function toNodeRequestBody(body: FetchInit["body"]) {
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  return null;
}

export async function defaultLoopbackRequest(
  input: FetchInput,
  init?: FetchInit,
) {
  const target =
    typeof input === "string" || input instanceof URL
      ? new URL(String(input))
      : new URL(input.url);
  const headers = new Headers(init?.headers);
  const body = toNodeRequestBody(init?.body);
  if (body && !headers.has("Content-Length")) {
    headers.set("Content-Length", String(body.byteLength));
  }
  return await new Promise<Response>((resolve, reject) => {
    const requestImpl = target.protocol === "https:" ? httpsRequest : httpRequest;
    const req = requestImpl(
      target,
      {
        method: init?.method ?? "GET",
        headers: Object.fromEntries(headers.entries()),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) =>
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
        );
        res.on("end", () => {
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode ?? 500,
              headers: res.headers as Record<string, string>,
            }),
          );
        });
      },
    );
    req.on("error", reject);
    init?.signal?.addEventListener(
      "abort",
      () => {
        req.destroy(
          init.signal?.reason instanceof Error
            ? init.signal.reason
            : new Error("request aborted"),
        );
        reject(init.signal?.reason ?? new Error("request aborted"));
      },
      { once: true },
    );
    if (body) req.write(body);
    req.end();
  });
}

export type FetchWithTransientRetryOptions = {
  sleep?: (ms: number) => Promise<void>;
  loopbackRequest?: (input: FetchInput, init?: FetchInit) => Promise<Response>;
  /**
   * Bounded attempt budget. Callers that know a longer, explicitly retryable
   * maintenance window can raise this without changing every other fetch.
   *
   * Note: this budget applies to all retryable statuses (429/503) and transient
   * network errors. It does **not** gate the dedicated core-draining budget —
   * structured `503 core_draining` responses always use `coreDrainingMaxAttempts`
   * (default 30) so a deploy drain window can be waited through regardless of
   * the general budget.
   */
  maxAttempts?: number;
  /**
   * Dedicated attempt budget for structured `503 core_draining` responses.
   * Defaults to `CORE_DRAINING_MAX_ATTEMPTS` (30). Ordinary 429/503 and network
   * errors never consume this budget.
   */
  coreDrainingMaxAttempts?: number;
  /**
   * 显式重试状态码集合。默认 `RETRYABLE_HTTP_STATUSES`（{429,503}），
   * 刻意不含 502/504。幂等写路径可传入含 502 的集合以放宽重试。
   */
  retryableStatuses?: ReadonlySet<number>;
};

/**
 * 判断响应是否为服务端明示可重试的 `503 core_draining`。
 * 复用 clone 读 body，避免消费调用方要用的响应体。
 */
async function isCoreDrainingResponse(response: Response): Promise<boolean> {
  if (response.status !== 503) return false;
  try {
    const body = await response.clone().json();
    return isCoreDrainingBody(body);
  } catch {
    return false;
  }
}

export async function fetchWithTransientRetry(
  fetchImpl: CliFetchImpl,
  input: FetchInput,
  init?: FetchInit,
  options: FetchWithTransientRetryOptions = {},
) {
  const retryableStatuses = options.retryableStatuses ?? RETRYABLE_HTTP_STATUSES;
  const requestedMaxAttempts = Number(options.maxAttempts);
  const maxAttempts = Number.isFinite(requestedMaxAttempts)
    ? Math.min(100, Math.max(1, Math.floor(requestedMaxAttempts)))
    : TRANSIENT_FETCH_MAX_ATTEMPTS;
  const requestedCoreDrainingMaxAttempts = Number(options.coreDrainingMaxAttempts);
  const coreDrainingMaxAttempts = Number.isFinite(requestedCoreDrainingMaxAttempts)
    ? Math.min(100, Math.max(1, Math.floor(requestedCoreDrainingMaxAttempts)))
    : CORE_DRAINING_MAX_ATTEMPTS;
  // 循环上限取两者较大值，具体预算在每次响应后按类型裁决。
  const loopMaxAttempts = Math.max(maxAttempts, coreDrainingMaxAttempts);
  let lastError: unknown;
  for (let attempt = 1; attempt <= loopMaxAttempts; attempt += 1) {
    try {
      if (options.loopbackRequest && isLoopbackUrl(input)) {
        return await options.loopbackRequest(input, init);
      }
      const response = await fetchImpl(input, init);
      // 429/503 是一次**成功的** HTTP 交换，不会走到下面的 catch。以前这里直接
      // 把它返回给调用方，于是服务端 `retryable: true, retryAfterMs: 1500` 这类
      // 明示信号被完全无视，一次容量抖动就成了用户可见的终局失败。
      // 结构化 `503 core_draining` 使用专属长预算（默认 30 次）等待 drain 窗口；
      // 其余可重试状态码走通用预算（默认 3 次）。
      if (retryableStatuses.has(response.status) && !init?.signal?.aborted) {
        const coreDraining = await isCoreDrainingResponse(response);
        const attemptBudget = coreDraining
          ? coreDrainingMaxAttempts
          : maxAttempts;
        if (attempt < attemptBudget) {
          const delayMs = await resolveRetryAfterMs(response, attempt);
          await (options.sleep ?? defaultSleep)(delayMs);
          continue;
        }
        // retry 预算耗尽：core_draining 换成用户可读提示，不暴露 raw JSON。
        if (coreDraining) {
          return createDrainExhaustedResponse(response);
        }
      }
      return response;
    } catch (error) {
      if (init?.signal?.aborted) throw error;
      if (!isTransientFetchError(error)) throw error;
      lastError = error;
      if (attempt < maxAttempts) {
        await (options.sleep ?? defaultSleep)(transientFetchRetryDelayMs(attempt));
      }
    }
  }
  throw lastError;
}
