/**
 * Shared helper: extract the set of tool function names declared in the
 * current request's `tools` array, for `sanitizeOutboundHistory`.
 *
 * Returns an EMPTY Set (not undefined) when `tools` is an empty array — that
 * means "this request declares no tools", so every history tool_call must be
 * downgraded. Returning undefined would make sanitize treat it as "no
 * filtering" and replay structural tool_calls, which is the exact `/switch`
 * 400 root cause this layer exists to fix.
 *
 * Returns undefined only when `tools` is not an array (the caller didn't pass
 * a tools array at all — a provider path with no tools concept), preserving
 * pass-through behavior for those callers.
 */
export function extractDeclaredToolNames(
  tools?: unknown[] | undefined,
): Set<string> | undefined {
  if (!Array.isArray(tools)) return undefined;
  const names = new Set<string>();
  for (const t of tools) {
    const fn = (t as Record<string, any>)?.function;
    if (fn && typeof fn.name === "string" && fn.name) names.add(fn.name);
  }
  return names;
}