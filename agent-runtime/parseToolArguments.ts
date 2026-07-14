/**
 * Pure JSON-object parse for tool-call argument payloads.
 *
 * Locality: one seam for "arguments string → plain object" so providers and
 * the local loop do not each own a slightly different empty/invalid fallback.
 * Invalid, empty, array, or non-object JSON always returns {}.
 */
export function parseToolArgumentsJson(
  raw: string | undefined | null,
): Record<string, unknown> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
