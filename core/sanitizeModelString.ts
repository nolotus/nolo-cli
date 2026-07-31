/**
 * Defensive sanitizer for optional model/provider string fields.
 *
 * Some non-form creation or serialization paths can persist the literal string
 * "undefined"/"null"/"NaN" (truthy, bypasses `|| ""` fallbacks) into agent
 * records. This helper treats those pseudo-strings — case-insensitively — the
 * same as empty/whitespace, returning a clean trimmed string.
 *
 * Dependency-free so pure unit tests do not pull server/agent modules.
 */
export const sanitizeOptionalModelString = (value: unknown): string => {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) return "";
  const lower = s.toLowerCase();
  if (lower === "undefined" || lower === "null" || lower === "nan") return "";
  return s;
};