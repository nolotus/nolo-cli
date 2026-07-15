/**
 * Shared pure optional positive-integer normalizer.
 *
 * Agent thread admission limits, repo/list/code-search maxResults/maxFiles
 * parsers, and similar readers coerce unknown field values the same way: keep
 * positive integers, drop everything else as `undefined` (including 0, floats,
 * NaN / ±Infinity, and non-numbers).
 *
 * Keep one definition so integer vs float / zero handling cannot drift across
 * runtime and server request parsers.
 *
 * Dependency-free so pure unit tests do not pull server/agent modules.
 */
export function asOptionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}
