/**
 * Shared SSE usage extraction for the platform chat proxy wire.
 *
 * Single source of truth for "which SSE frame carries real token usage and
 * how to read it". Both the server-side billing accumulator
 * (chatProxyBilling.createSseUsageAccumulator) and the client-side stream
 * parser (platformChatProvider.processPlatformChatSseEvent) must agree on
 * this — the previous drift (server only looked at top-level `usage`, client
 * only at `response.completed.response.usage`) silently dropped token counts
 * on one side of the wire.
 *
 * Wire contract (kept here so it cannot drift):
 *   - chat.completions SSE: terminal frame carries top-level `usage`
 *     (`prompt_tokens` / `completion_tokens` …), usually the last data frame
 *     before [DONE].
 *   - Responses SSE: the `response.completed` event carries
 *     `response.usage` (`input_tokens` / `output_tokens` …).
 *   - Billing metadata frames MUST NOT occupy the top-level `usage` key —
 *     they are emitted as a separate `billing` object (see
 *     chatBillingSse.formatBillingUsageEvent). A frame whose top-level
 *     `usage` holds no token fields is therefore NOT a real usage frame and
 *     must not be treated as one.
 */

const TOKEN_FIELDS = [
  "prompt_tokens",
  "completion_tokens",
  "input_tokens",
  "output_tokens",
  "total_tokens",
] as const;

/** Whether a parsed object actually carries token usage (not billing-only metadata). */
export function hasUsageTokens(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  // 语义对齐旧 accumulator（asOptionalFiniteNumber !== undefined）：只要存在
  // 至少一个 token 字段且为有限数（>= 0 即可，不要求 > 0）就算真实 usage 帧。
  // 全零帧 {prompt_tokens:0,...} 是合法 usage，不能被误判成 billing 元数据；
  // legacy billing 帧不含任何 token 字段，天然被排除。
  return TOKEN_FIELDS.some(
    (field) => typeof record[field] === "number" && Number.isFinite(record[field]),
  );
}

/**
 * Extract the real token usage from one parsed SSE data payload, or undefined
 * when the frame carries none (content delta, billing metadata, [DONE] …).
 *
 * Handles both wire shapes:
 *   - top-level `usage` (chat.completions; also the Responses terminal chunk
 *     when a proxy re-emits it top-level) — only when it holds token fields,
 *     so billing-only `usage` lookalikes are ignored;
 *   - `response.completed.response.usage` (Responses SSE).
 */
export function extractUsageFromSsePayload(parsed: unknown): Record<string, unknown> | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const payload = parsed as Record<string, unknown>;

  const topLevel = payload.usage;
  if (topLevel && typeof topLevel === "object" && hasUsageTokens(topLevel)) {
    return topLevel as Record<string, unknown>;
  }

  if (payload.type === "response.completed") {
    const response = payload.response;
    if (response && typeof response === "object") {
      const nested = (response as Record<string, unknown>).usage;
      if (nested && typeof nested === "object" && hasUsageTokens(nested)) {
        return nested as Record<string, unknown>;
      }
    }
  }

  return undefined;
}
