/**
 * Pure SSE `data:` line JSON parse.
 *
 * Locality: one seam for "SSE data line → JSON value" so OpenAI-compatible,
 * Codex Responses, and Antigravity Cloud Code stream readers share the same
 * empty / [DONE] / malformed fallback and cannot drift.
 *
 * Returns null for non-data lines, blank payloads, the stream-end marker
 * `[DONE]`, or invalid JSON. Successful parse may still yield any JSON value
 * (object, array, primitive).
 */
export function parseSseDataLineJson(line: string): unknown | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
}

/**
 * Object-only variant used by Codex Responses aggregation.
 * Arrays and non-null objects both pass (matches prior extractSseEvent).
 */
export function parseSseDataLineObject(
  line: string,
): Record<string, unknown> | null {
  const parsed = parseSseDataLineJson(line);
  return parsed && typeof parsed === "object"
    ? (parsed as Record<string, unknown>)
    : null;
}
