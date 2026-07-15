/**
 * Shared pure unknown → plain-object (record) coercer with empty fallback.
 *
 * Agent-run checkpoint / trace readers, machine permission policy bags, and
 * similar surfaces treat non-null non-array objects as records and everything
 * else as `{}`. Keep one definition so Array vs null vs primitive handling
 * cannot drift across server and AI modules.
 *
 * Differs from `isRecord` (predicate only) and from optional JSON-record
 * parsers that reject non-objects as `undefined`. Dependency-free so pure
 * unit tests do not pull server/agent modules.
 */
export function asRecordOrEmpty(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}
