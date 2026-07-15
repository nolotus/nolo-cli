/**
 * Shared pure coerced trimmed-string normalizer.
 *
 * Agent-create tool args and agent-card display readers coerce unknown field
 * values the same way: keep strings as trim(), map null/undefined to "", and
 * String()-coerce other non-null values then trim. Keep one definition so
 * number/boolean/object form values cannot drift between tool and card UIs.
 *
 * Differs from `asTrimmedString`, which drops non-strings as "" without
 * String() coercion. Dependency-free so pure unit tests do not pull
 * ai/chat modules.
 */
export function toTrimmedString(value: unknown): string {
  return typeof value === "string"
    ? value.trim()
    : value == null
      ? ""
      : String(value).trim();
}
