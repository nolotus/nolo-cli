/**
 * Shared pure optional finite-number normalizer.
 *
 * Agent config projections, desktop request snapshots, token rating math, and
 * similar readers coerce unknown field values the same way: keep finite
 * numbers, drop everything else as `undefined` (including NaN / ±Infinity).
 *
 * Keep one definition so non-number / non-finite handling cannot drift across
 * runtime and AI modules.
 *
 * Dependency-free so pure unit tests do not pull server/agent modules.
 */
export function asOptionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
