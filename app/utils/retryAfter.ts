import {
  normalizeNonNegativeMs,
  parseRetryAfterHeaderMs,
} from "../../core/retryAfterMs";

type HeaderLike = Pick<Headers, "get"> | null | undefined;

/** Re-export core pure seam so app callers keep a stable import path. */
export { parseRetryAfterHeaderMs };

export const resolveRetryAfterMs = (
  headers: HeaderLike,
  fallbackMs: number,
  bodyRetryAfterMs?: unknown
) => {
  const headerDelayMs = parseRetryAfterHeaderMs(headers?.get("Retry-After"));
  if (headerDelayMs !== null) return headerDelayMs;
  return normalizeNonNegativeMs(bodyRetryAfterMs, fallbackMs);
};
