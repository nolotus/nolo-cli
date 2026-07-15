/**
 * Shared pure trimmed-lowercase string normalizer for unknown policy fields.
 *
 * Email addresses / local-parts, invite payloads, shell / tool user-input
 * gates, and search text all coerce the same way: keep strings as
 * trim().toLowerCase(), drop non-strings as "". Keep one definition so
 * case-fold + whitespace handling cannot drift across auth, email, and
 * agent-runtime modules.
 *
 * Dependency-free so pure unit tests do not pull server/agent modules.
 */
export function asTrimmedLowercaseString(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
