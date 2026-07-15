/**
 * Shared pure plain-object (record) detector.
 *
 * JSON-shaped payloads, config bags, and evidence projections treat values as
 * records when they are non-null objects that are not arrays. Keep one
 * definition so Array vs object handling cannot drift across agent-run,
 * workspace policy, and similar readers.
 *
 * Dependency-free so pure unit tests do not pull server/agent modules.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
