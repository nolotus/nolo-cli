/**
 * Shared pure non-empty string-array extractors for unknown policy fields.
 *
 * Agent runtime tool policy, hosted workspace leases, dialog artifacts, and
 * thread checkpoints all need the same membership shape: keep strings with
 * non-whitespace content, drop scalars / empty / whitespace-only entries as [].
 * Keep one definition so array vs scalar handling cannot drift across
 * agent-run modules.
 *
 * - asNonEmptyStringArray: preserve original string content (including padding).
 * - asTrimmedNonEmptyStringArray: return trim() forms (allowed tool/agent keys,
 *   machine writable roots, memory filter lists, normalizeStringList clones).
 *
 * Dependency-free so pure unit tests do not pull server/agent modules.
 */
export function asNonEmptyStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === "string" && !!item.trim(),
  );
}

/**
 * Shared pure trimmed non-empty string-array extractor.
 *
 * Same membership as asNonEmptyStringArray, but each kept entry is trim()'d.
 * Prefer asNonEmptyStringArray when callers must preserve original whitespace.
 */
export function asTrimmedNonEmptyStringArray(value: unknown): string[] {
  return asNonEmptyStringArray(value).map((item) => item.trim());
}
