/**
 * Shared pure optional non-empty trimmed string normalizer.
 *
 * Agent-run projections, parent-dialog wake, task evidence, and similar
 * readers coerce unknown field values the same way: keep non-empty trimmed
 * strings, drop everything else as `undefined`.
 *
 * Keep one definition so whitespace-only / non-string handling cannot drift
 * across server and runtime modules.
 *
 * Dependency-free so pure unit tests do not pull server/agent modules.
 */
export function asOptionalTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
