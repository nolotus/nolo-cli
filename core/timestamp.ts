/**
 * Shared pure timestamp coercer.
 *
 * DB patch updatedAt inference, user-preference registers, space membership
 * dedupe, and similar writers coerce unknown date field values the same way:
 * keep finite numbers, Date.parse strings, drop everything else as `0`.
 *
 * Keep one definition so number vs ISO-string vs garbage handling cannot drift
 * across database and create modules.
 *
 * Dependency-free so pure unit tests do not pull server/agent modules.
 */
export function toTimestampMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
