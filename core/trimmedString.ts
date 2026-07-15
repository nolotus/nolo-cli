/**
 * Shared pure trimmed-string normalizer for unknown policy fields.
 *
 * Machine runtime bindings, agent-draft tool args, runtime system-message
 * identity fields, and similar readers coerce the same way: keep strings as
 * trim(), drop non-strings as "". Keep one definition so whitespace and
 * non-string handling cannot drift across server/agent modules.
 *
 * Dependency-free so pure unit tests do not pull server/agent modules.
 * For non-empty optional fields, prefer `asOptionalTrimmedString`.
 */
export function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
