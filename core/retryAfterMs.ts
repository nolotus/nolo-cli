/**
 * Shared pure Retry-After delay parsers for outbound HTTP clients.
 *
 * Email providers (Resend, Cloudflare Email), SSE reconnect, and connector
 * probes all coerce HTTP `Retry-After` the same way: delta-seconds → ms, or
 * HTTP-date → delay from `now`. Keep one definition so empty/whitespace,
 * fractional seconds, and date-based values cannot drift across adapters.
 *
 * Dependency-free so pure unit tests do not pull provider/network modules.
 */

/**
 * Coerce unknown delay values to a non-negative integer millisecond budget.
 * Non-finite / negative inputs fall back to `fallbackMs` (also rounded).
 */
export function normalizeNonNegativeMs(
  value: unknown,
  fallbackMs: number,
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.round(parsed)
    : Math.round(Number(fallbackMs)) || 0;
}

/**
 * Parse an HTTP `Retry-After` header value to a non-negative delay in ms.
 * Returns `null` when the header is missing, blank, or unparseable.
 *
 * @param value Header string (or null/undefined when absent)
 * @param nowMs Clock for HTTP-date absolute deadlines (injectable for tests)
 */
export function parseRetryAfterHeaderMs(
  value: string | null | undefined,
  nowMs = Date.now(),
): number | null {
  if (typeof value !== "string" || !value.trim()) return null;

  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    // Negative delta-seconds are invalid Retry-After; do not Date.parse them.
    if (seconds < 0) return null;
    return Math.round(seconds * 1_000);
  }

  const parsedDateMs = Date.parse(trimmed);
  if (Number.isFinite(parsedDateMs)) {
    return Math.max(0, parsedDateMs - nowMs);
  }

  return null;
}
