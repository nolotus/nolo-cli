type HeaderLike = Pick<Headers, "get"> | null | undefined;

const normalizePositiveMs = (value: unknown, fallbackMs: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : fallbackMs;
};

export const parseRetryAfterHeaderMs = (
  value: string | null | undefined,
  nowMs = Date.now()
) => {
  if (typeof value !== "string" || !value.trim()) return null;

  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000);
  }

  const parsedDateMs = Date.parse(trimmed);
  if (Number.isFinite(parsedDateMs)) {
    return Math.max(0, parsedDateMs - nowMs);
  }

  return null;
};

export const resolveRetryAfterMs = (
  headers: HeaderLike,
  fallbackMs: number,
  bodyRetryAfterMs?: unknown
) => {
  const headerDelayMs = parseRetryAfterHeaderMs(headers?.get("Retry-After"));
  if (headerDelayMs !== null) return headerDelayMs;
  return normalizePositiveMs(bodyRetryAfterMs, fallbackMs);
};
