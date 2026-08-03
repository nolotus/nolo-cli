/**
 * Shared wire-protocol drain reason.
 *
 * During a single-origin deploy the server rejects new stateful admissions with
 * `503 {"error":"Server draining","reason":"core_draining","retryable":true}`.
 * Both sides of the wire must agree on the exact `reason` string:
 * - server producers: `serverDraining.ts` (drain response), `serverProxyRetry.ts`
 *   (503 classification for upstream retry)
 * - client consumers: TUI platform proxy (`localRuntimeFetchRetry.ts`), Web
 *   background run start (`runAgentBackground.ts`)
 *
 * Keep one definition so the drain protocol string cannot drift across
 * packages. Dependency-free so pure unit tests do not pull CLI/AI modules.
 */
export const CORE_DRAIN_REASON = "core_draining";

/** Server-side alias matching the historical `SERVER_DRAIN_REASON` naming. */
export const SERVER_DRAIN_REASON = CORE_DRAIN_REASON;

/**
 * 用户可见的 drain 耗尽提示（retry 预算用完后给用户看，而非 raw JSON）。
 *
 * 三个入口（web serverProxyRetry / CLI localRuntimeFetchRetry / background
 * runAgentBackground）各自重试 30 次 × 1.5s ≈ 45s 后仍遇到 core_draining，
 * 说明服务端 drain 窗口异常长（正常 deploy ≤ 30s）。此时不应把
 * `{"error":"Server draining",...}` 原样抛给用户，换成一句人话。
 */
export const DRAIN_EXHAUSTED_USER_MESSAGE =
  "服务正在重启中，请稍后重试";

/**
 * 判断一个 503 响应体是否为 core_draining 结构。
 * 供 retry 耗尽后的友好替换逻辑复用，避免各调用方各自 parse。
 */
export function isCoreDrainingBody(body: unknown): body is { reason: string } {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { reason?: unknown }).reason === CORE_DRAIN_REASON
  );
}

/**
 * 构造 drain 耗尽后的友好 503 Response（替换 raw JSON body）。
 * 只保留 Retry-After（重试节奏信号），丢弃 Content-Length/Content-Type 等
 * 指向旧 body 的字段——新 body 长度与旧 JSON 不同，继承会导致客户端按旧
 * Content-Length 截断，读到残缺或乱码。
 */
export function createDrainExhaustedResponse(original: Response): Response {
  const retryAfter = original.headers.get("Retry-After");
  const headers: Record<string, string> = { "Content-Type": "text/plain; charset=utf-8" };
  if (retryAfter) headers["Retry-After"] = retryAfter;
  return new Response(DRAIN_EXHAUSTED_USER_MESSAGE, {
    status: 503,
    headers,
  });
}
